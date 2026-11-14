// やめた Project の残り（projects/ と config.yaml の default_project）を、dg が同期か書き込みのときに一度だけ消す（ADR-034）。
// 書き込みのロックの中で、dg の外の変更を確かめた後に呼ぶ。消したものは dg の印（DG_COMMIT_TRAILER）の付いたコミットにするので、
// dg の外の変更として止まらない。commit.mode が batch・manual でもここだけはコミットする（残すと、まとめ待ちの変更に混ざる）。
// チケット・Epic・Iteration・Plan の project は、それぞれを書くときに消える（Store の retired）ので、ここでは触らない

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
import { requireIdentity, type GitRepo } from "./repo.js";
import { runGit } from "./run.js";
import { commitPaths } from "./sync.js";

const MESSAGE = "Remove projects/ (Projects are retired; default_workflow takes their place)";

/**
 * projects/ があれば消してコミットする。消したら true。なければ何もしない（2 回目からはここで抜ける）。
 * 消す前後でチケットの Workflow が変わらないように、
 *   - 既定の Project の Workflow を config の default_workflow に移す（default_workflow がまだなく、スキーマの既定と違うとき）
 *   - 既定でない Project のチケットで、その Project の Workflow が default_workflow と違い、自分の workflow を持たないものに workflow を書く
 */
export async function retireProjects(repo: GitRepo, store: Store): Promise<boolean> {
  const dir = path.join(store.root, RETIRED_PROJECTS_DIR);
  if (!(await pathExists(dir))) return false;
  await requireIdentity(repo);
  const projects = await readRetiredProjects(store.root);
  const paths: string[] = [];

  // config.yaml：default_project を消し、既定の Project の Workflow を default_workflow に移す
  const raw = await store.readTeamConfigRaw();
  const moved = retiredDefaultWorkflow(raw, projects);
  const patch: Record<string, unknown> = {};
  if (raw[RETIRED_DEFAULT_PROJECT_KEY] !== undefined)
    patch[RETIRED_DEFAULT_PROJECT_KEY] = undefined;
  if (moved !== undefined && moved !== defaultConfig().default_workflow)
    patch["default_workflow"] = moved;
  if (Object.keys(patch).length > 0) {
    await store.writeConfig(patch);
    paths.push(CONFIG_FILE);
  }

  // 既定でない Project のチケット：Project の Workflow が既定と違えば、チケットに書いて残す
  const fallback = store.teamConfig.default_workflow;
  // update は同じ ID の値を置き換えるだけで、索引に足したり消したりしないので、回しながら書いてよい
  for (const doc of store.tickets.values()) {
    const project = doc.raw["project"];
    const workflow = typeof project === "string" ? projects.get(project) : undefined;
    if (workflow === undefined || workflow === fallback || doc.data.workflow !== undefined)
      continue;
    await store.update("ticket", doc.id, { workflow });
    paths.push(doc.path);
  }

  await rm(dir, { recursive: true, force: true });
  // Git が追っているファイルがあるときだけ projects/ をコミットに入れる（追っていないパスは git add が失敗する）
  const tracked = await runGit(repo.dataDir, ["ls-files", "--", RETIRED_PROJECTS_DIR], {
    localDir: repo.localDir,
  });
  if (tracked.stdout.trim().length > 0) paths.push(RETIRED_PROJECTS_DIR);
  if (paths.length > 0) await commitPaths(repo, paths, MESSAGE);
  return true;
}
