// やめた Project（カンバンの中の区切り。ADR-034）の残りの読み方。前の dg は projects/<slug>.yaml に Project ごとの既定の Workflow を、
// config.yaml の default_project に既定の Project を書いていた。projects/ は dg が同期か書き込みのときに消し（git/retire-projects.ts）、
// 消すまでの読みは、既定の Project の Workflow を default_workflow として読む（消す前後でチケットの Workflow が変わらないように）

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseYamlValue } from "./yaml.js";

/** 前の dg が Project を置いていたディレクトリ（worktree からの相対パス） */
export const RETIRED_PROJECTS_DIR = "projects";
/** 前の dg が config.yaml に書いていた、既定の Project のキー */
export const RETIRED_DEFAULT_PROJECT_KEY = "default_project";
/** default_project を省いたときの既定の Project */
const RETIRED_DEFAULT_PROJECT = "default";

/** projects/ に残る Project の既定の Workflow（Project の slug → Workflow の ID）。ディレクトリがない・読めないファイルは入らない */
export async function readRetiredProjects(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let files: string[];
  try {
    files = await readdir(path.join(root, RETIRED_PROJECTS_DIR));
  } catch {
    return found;
  }
  for (const file of files.filter((f) => f.endsWith(".yaml")).sort()) {
    const text = await readFile(path.join(root, RETIRED_PROJECTS_DIR, file), "utf8").catch(
      () => "",
    );
    const { value, errors } = parseYamlValue(text);
    if (errors.length > 0 || typeof value !== "object" || value === null) continue;
    const workflow = (value as Record<string, unknown>)["workflow"];
    if (typeof workflow === "string" && workflow.length > 0) found.set(file.slice(0, -5), workflow);
  }
  return found;
}

/**
 * config.yaml の中身（raw）が default_workflow を持たないときに、既定の Project の Workflow を返す。
 * default_workflow があるか、既定の Project が projects/ になければ undefined
 */
export function retiredDefaultWorkflow(
  raw: unknown,
  projects: ReadonlyMap<string, string>,
): string | undefined {
  const config = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (config["default_workflow"] !== undefined) return undefined;
  const project = config[RETIRED_DEFAULT_PROJECT_KEY];
  return projects.get(typeof project === "string" ? project : RETIRED_DEFAULT_PROJECT);
}
