// やめた Project の残り（projects/ と config.yaml の default_project）を、dg が同期か書き込みのときに一度だけ消す（ADR-034）。
// 書き込みのロックの中で、dg の外の変更を確かめた後に呼ぶ。消したものは dg の印（DG_COMMIT_TRAILER）の付いたコミットにするので、
// dg の外の変更として止まらない。commit.mode が batch・manual でもここだけはコミットする（残すと、まとめ待ちの変更に混ざる）。
// ここで書き換えるファイル（config.yaml・workflow を書くチケット・.gitattributes）にまとめ待ちの変更があるときは、その変更が消すコミットに
// 混ざるので、何も触らずに見送る（projects/ が残る間も読める。まとめ待ちがコミットされた後の同期か書き込みで消す。dg commit は先にまとめ待ちをコミットする）。
// チケット・Epic・Iteration・Plan の project は、それぞれを書くときに消える（Store の retired）ので、ここでは触らない。
// チケットの project だけは、projects/ が残る間は書いても消えない（Store.update）：見送った間に書いたチケットも、後でここが workflow を書けるように

import { rm } from "node:fs/promises";
import path from "node:path";
import { defaultConfig } from "../model/config.js";
import { pathExists } from "../storage/exists.js";
import { CONFIG_FILE } from "../storage/paths.js";
import {
  readRetiredProjects,
  RETIRED_DEFAULT_PROJECT_KEY,
  RETIRED_PROJECTS_DIR,
  retiredDefaultWorkflow,
} from "../storage/retired-projects.js";
import type { Store } from "../storage/store.js";
import { dropGitattributesPattern } from "./merge.js";
import { requireIdentity, type GitRepo } from "./repo.js";
import { runGit } from "./run.js";
import { commitPaths } from "./sync.js";

const MESSAGE = "Remove projects/ (Projects are retired; default_workflow takes their place)";
const GITATTRIBUTES = ".gitattributes";

/**
 * projects/ があれば消してコミットする。消したら true。なければ何もしない（2 回目からはここで抜ける）。
 * 消す前後でチケットの Workflow が変わらないように、
 *   - 既定の Project の Workflow を config の default_workflow に移す（default_workflow がまだなく、スキーマの既定と違うとき）
 *   - 既定でない Project のチケットで、その Project の Workflow が default_workflow と違い、自分の workflow を持たないものに workflow を書く
 * 前の dg が .gitattributes に書いた projects/*.yaml の行（マージドライバを当てるパス）も、同じコミットで消す。
 * 書き換えるファイルにまとめ待ちの変更があれば、何も触らずに false を返す（ファイルの冒頭）
 */
export async function retireProjects(repo: GitRepo, store: Store): Promise<boolean> {
  const dir = path.join(store.root, RETIRED_PROJECTS_DIR);
  if (!(await pathExists(dir))) return false;
  await requireIdentity(repo);
  const projects = await readRetiredProjects(store.root);

  // config.yaml：default_project を消し、既定の Project の Workflow を default_workflow に移す
  const raw = await store.readTeamConfigRaw();
  const moved = retiredDefaultWorkflow(raw, projects);
  const patch: Record<string, unknown> = {};
  if (raw[RETIRED_DEFAULT_PROJECT_KEY] !== undefined)
    patch[RETIRED_DEFAULT_PROJECT_KEY] = undefined;
  if (moved !== undefined && moved !== defaultConfig().default_workflow)
    patch["default_workflow"] = moved;
  const writesConfig = Object.keys(patch).length > 0;

  // 既定でない Project のチケット：Project の Workflow が既定と違えば、チケットに書いて残す。
  // 既定（default_workflow）は config を書いた後の値で比べる（上で移す値があればその値）
  const fallback = patch["default_workflow"] ?? store.teamConfig.default_workflow;
  const rewrites: { id: string; path: string; workflow: string }[] = [];
  for (const doc of store.tickets.values()) {
    const project = doc.raw["project"];
    const workflow = typeof project === "string" ? projects.get(project) : undefined;
    if (workflow === undefined || workflow === fallback || doc.data.workflow !== undefined)
      continue;
    rewrites.push({ id: doc.id, path: doc.path, workflow });
  }

  // 書き換えるファイルにまとめ待ちの変更があれば見送る（書く前に確かめ、途中まで書いた状態を残さない）
  const touched = [...(writesConfig ? [CONFIG_FILE] : []), ...rewrites.map((r) => r.path)];
  const pending = await runGit(
    repo.dataDir,
    ["status", "--porcelain", "--", ...touched, GITATTRIBUTES],
    { localDir: repo.localDir },
  );
  if (pending.stdout.trim().length > 0) return false;

  const paths = [...touched];
  if (writesConfig) await store.writeConfig(patch);
  // projects/ が残る間、Store はチケットの project を消さないので、workflow を書くのと同じ書き込みで明示して消す
  for (const r of rewrites)
    await store.update("ticket", r.id, { workflow: r.workflow, project: undefined });
  if (await dropGitattributesPattern(repo.dataDir, `${RETIRED_PROJECTS_DIR}/*.yaml`))
    paths.push(GITATTRIBUTES);

  await rm(dir, { recursive: true, force: true });
  // Git が追っているファイルがあるときだけ projects/ をコミットに入れる（追っていないパスは git add が失敗する）
  const tracked = await runGit(repo.dataDir, ["ls-files", "--", RETIRED_PROJECTS_DIR], {
    localDir: repo.localDir,
  });
  if (tracked.stdout.trim().length > 0) paths.push(RETIRED_PROJECTS_DIR);
  if (paths.length > 0) await commitPaths(repo, paths, MESSAGE);
  return true;
}
