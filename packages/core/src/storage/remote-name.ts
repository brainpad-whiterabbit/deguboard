// config のリモートの名前（git.remote）だけを読む（t770）。Stop のフックが dg の外の変更を確かめるために、ストアを開かずに使う。
// Store.open と同じ規則で読む（チームの config.yaml を既定値に、個人の config.yaml を重ねる。読めない・スキーマに合わない値は無視する）。
// チケット・Plan・Epic・Iteration・Run のファイルは読まない。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { configSchema, overlayLocalConfig } from "../model/config.js";
import { parseYamlDocument } from "./yaml.js";
import { CONFIG_FILE, LOCAL_CONFIG_FILE } from "./paths.js";

/** チームの config.yaml を読む。読めなければ（YAML・スキーマの誤り）既定値（Store.open と同じ） */
async function readTeamConfig(dataDir: string) {
  const text = await readFile(path.join(dataDir, CONFIG_FILE), "utf8").catch(() => "");
  const { doc, errors } = parseYamlDocument(text);
  if (errors.length > 0) return configSchema.parse({});
  const parsed = configSchema.safeParse(doc.toJS() ?? {});
  return parsed.success ? parsed.data : configSchema.parse({});
}

/** 個人の config.yaml の中身。ファイルがない・YAML として読めない・マップでなければ上書きなし（undefined） */
async function readLocalRaw(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8").catch(() => "");
  const { doc, errors } = parseYamlDocument(text);
  if (errors.length > 0) return undefined;
  const raw: unknown = doc.toJS() ?? {};
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : undefined;
}

/** config のリモートの名前（個人 > チーム > 既定 の順。git.remote は個人で上書きできる項目）。ストアを開かずに読む */
export async function readRemoteName(dataDir: string, localDir: string): Promise<string> {
  const team = await readTeamConfig(dataDir);
  const local = await readLocalRaw(path.join(localDir, LOCAL_CONFIG_FILE));
  return overlayLocalConfig(team, local).config.git.remote;
}
