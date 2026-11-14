// チームと個人の config.yaml の読み方（t788）。Store と、ストアを開かずにリモートの名前だけを読む remote-name.ts が同じ規則で読む。
// チームの config.yaml は、読めない・スキーマに合わなければ既定値にして誤りを返す。
// 個人の config.yaml は、YAML として読めない・マップでなければ上書きなし（raw が undefined）にして警告を返す

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { configSchema, type Config } from "../model/config.js";
import type { Issue } from "./issue.js";
import { CONFIG_FILE, LOCAL_CONFIG_LABEL } from "./paths.js";
import {
  readRetiredProjects,
  RETIRED_DEFAULT_PROJECT_KEY,
  retiredDefaultWorkflow,
} from "./retired-projects.js";
import { parseYamlDocument } from "./yaml.js";

/** YAML のファイルを文書として読む。ファイルがなければ空の文書 */
export async function readYamlFile(file: string) {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    // なければ空（チームは既定値だけの config、個人は上書きなし）
  }
  return parseYamlDocument(text);
}

/** チームの config.yaml を既定で補って読む */
export async function loadTeamConfig(file: string): Promise<{ config: Config; issues: Issue[] }> {
  const { doc, errors } = await readYamlFile(file);
  if (errors.length > 0) {
    return {
      config: configSchema.parse({}),
      issues: [
        {
          severity: "error",
          code: "yaml_error",
          path: CONFIG_FILE,
          message: "Cannot parse YAML",
          detail: errors.join("\n"),
        },
      ],
    };
  }
  const raw = (doc.toJS() ?? {}) as Record<string, unknown>;
  // やめた Project の残り（retired-projects.ts）。default_project は値に出さず、projects/ を dg が消すまでは、
  // 既定の Project の Workflow を default_workflow として読む
  const { [RETIRED_DEFAULT_PROJECT_KEY]: _project, ...rest } = raw;
  const retired = retiredDefaultWorkflow(raw, await readRetiredProjects(path.dirname(file)));
  const parsed = configSchema.safeParse(
    retired === undefined ? rest : { ...rest, default_workflow: retired },
  );
  if (!parsed.success) {
    return {
      config: configSchema.parse({}),
      issues: [
        {
          severity: "error",
          code: "schema_error",
          path: CONFIG_FILE,
          message: "Does not match the schema",
          detail: z.prettifyError(parsed.error),
        },
      ],
    };
  }
  return { config: parsed.data, issues: [] };
}

/** 個人の config.yaml の中身を読む。読めなければ警告にして上書きなしで続ける（チームの値で動く） */
export async function loadLocalConfig(file: string): Promise<{ raw: unknown; issues: Issue[] }> {
  const { doc, errors } = await readYamlFile(file);
  if (errors.length > 0) {
    return {
      raw: undefined,
      issues: [
        {
          severity: "warning",
          code: "yaml_error",
          path: LOCAL_CONFIG_LABEL,
          message: "Cannot parse YAML, so the personal settings were ignored",
          detail: errors.join("\n"),
        },
      ],
    };
  }
  const raw: unknown = doc.toJS() ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      raw: undefined,
      issues: [
        {
          severity: "warning",
          code: "schema_error",
          path: LOCAL_CONFIG_LABEL,
          message: "Not a key-value map, so the personal settings were ignored",
        },
      ],
    };
  }
  return { raw, issues: [] };
}
