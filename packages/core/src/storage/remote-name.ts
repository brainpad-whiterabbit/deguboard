// config のリモートの名前（git.remote）だけを読む（t770）。Stop のフックが dg の外の変更を確かめるために、ストアを開かずに使う。
// Store.open と同じ読み方（config-file.ts）で、チームの config.yaml を既定値に、個人の config.yaml を重ねる（読めない値の警告は捨てる）。
// チケット・Plan・Epic・Iteration・Run のファイルは読まない。

import path from "node:path";
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
