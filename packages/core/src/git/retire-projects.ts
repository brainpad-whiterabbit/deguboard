// やめた Project の残り（projects/ と config.yaml の default_project）を、dg が同期か書き込みのときに一度だけ消す（ADR-034）。
// 書き込みのロックの中で、dg の外の変更を確かめた後に呼ぶ。消したものは dg の印（DG_COMMIT_TRAILER）の付いたコミットにするので、
// dg の外の変更として止まらない。commit.mode が batch・manual でもここだけはコミットする（残すと、まとめ待ちの変更に混ざる）。
// ここで書き換えるファイル（config.yaml・.gitattributes）にまとめ待ちの変更があるときは、その変更が消すコミットに
// 混ざるので、何も触らずに見送る（projects/ が残る間も読める。まとめ待ちがコミットされた後の同期か書き込みで消す。dg commit は先にまとめ待ちをコミットする）。
// チケット・Epic・Iteration・Plan の project は、それぞれを書くときに消える（Store の retired）ので、ここでは触らない

import { rm } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../storage/exists.js";
import { CONFIG_FILE } from "../storage/paths.js";
import { RETIRED_DEFAULT_PROJECT_KEY, RETIRED_PROJECTS_DIR } from "../storage/retired-projects.js";
import type { Store } from "../storage/store.js";
import { dropGitattributesPattern } from "./merge.js";
import { requireIdentity, type GitRepo } from "./repo.js";
import { runGit } from "./run.js";
import { commitPaths } from "./sync.js";

const MESSAGE = "Remove projects/ (Projects are retired)";
const GITATTRIBUTES = ".gitattributes";

/**
 * projects/ があれば消してコミットする。消したら true。なければ何もしない（2 回目からはここで抜ける）。
 * config の default_project と、前の dg が .gitattributes に書いた projects/*.yaml の行（マージドライバを当てるパス）も、同じコミットで消す。
 * Project が指していた Workflow は移さない（Workflow はカンバンに 1 つ）。
 * 書き換えるファイルにまとめ待ちの変更があれば、何も触らずに false を返す（ファイルの冒頭）
 */
export async function retireProjects(repo: GitRepo, store: Store): Promise<boolean> {
  const dir = path.join(store.root, RETIRED_PROJECTS_DIR);
  if (!(await pathExists(dir))) return false;
  await requireIdentity(repo);

  const raw = await store.readTeamConfigRaw();
  const writesConfig = raw[RETIRED_DEFAULT_PROJECT_KEY] !== undefined;

  // 書き換えるファイルにまとめ待ちの変更があれば見送る（書く前に確かめ、途中まで書いた状態を残さない）
  const touched = writesConfig ? [CONFIG_FILE] : [];
  const pending = await runGit(
    repo.dataDir,
    ["status", "--porcelain", "--", ...touched, GITATTRIBUTES],
    { localDir: repo.localDir },
  );
  if (pending.stdout.trim().length > 0) return false;

  const paths = [...touched];
  // やめたキー（default_project）は config を書くと消える（Store.writeConfig）
  if (writesConfig) await store.writeConfig({});
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
