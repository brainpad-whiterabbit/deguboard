// config のリモートの名前（git.remote）だけを読む（t770）。Stop のフックが dg の外の変更を確かめるために、ストアを開かずに使う。
// Store.open と同じ読み方（config-file.ts）で、チームの config.yaml を既定値に、個人の config.yaml を重ねる（読めない値の警告は捨てる）。
// チケット・Plan・Epic・Iteration・Run のファイルは読まない。
// ストアを開かずにリモートを決めるのはここの resolveConfigRemote だけ。今の経路（commands/context.ts の storelessContext）は静的に、
// 速い経路（fast-hook.ts）は yaml・zod を静的に読まないように動的に読む（t803）

import path from "node:path";
import { resolveRemote, type RepoPaths } from "../git/repo.js";
import { overlayLocalConfig } from "../model/config.js";
import { loadLocalConfig, loadTeamConfig } from "./config-file.js";
import { CONFIG_FILE, LOCAL_CONFIG_FILE } from "./paths.js";

/** config のリモートの名前（個人 > チーム > 既定 の順。git.remote は個人で上書きできる項目）。ストアを開かずに読む */
export async function readRemoteName(dataDir: string, localDir: string): Promise<string> {
  const [team, local] = await Promise.all([
    loadTeamConfig(path.join(dataDir, CONFIG_FILE)),
    loadLocalConfig(path.join(localDir, LOCAL_CONFIG_FILE)),
  ]);
  return overlayLocalConfig(team.config, local.raw).config.git.remote;
}

/** config のリモートの名前を読み、git にそのリモートがあれば名前、なければ null（openContext の repo.remote と同じ決め方）。ストアを開かずに読む */
export async function resolveConfigRemote(paths: RepoPaths): Promise<string | null> {
  return resolveRemote(paths, await readRemoteName(paths.dataDir, paths.localDir));
}
