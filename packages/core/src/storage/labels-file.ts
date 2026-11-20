// labels.yaml（ラベルの語彙）の読み方。形の検査は model/labels.ts。
// YAML として読めない・最上位がマッピングでなければ語彙なしにして誤りを返し、読めない項目はその項目だけを外して誤りを返す（DT-1）

import { readFile } from "node:fs/promises";
import { parseVocabulary, type LabelEntry } from "../model/labels.js";
import type { Issue } from "./issue.js";
import { LABELS_FILE } from "./paths.js";
import { parseYamlDocument } from "./yaml.js";

/** 読みの結果。Store のキャッシュ（JSON）に残すので、Map でなく名前と項目の組の配列で持つ */
export interface LoadedLabels {
  entries: Array<[string, LabelEntry]>;
  issues: Issue[];
}

export async function loadLabels(file: string): Promise<LoadedLabels> {
  const failed = (code: string, message: string, detail: string): LoadedLabels => ({
    entries: [],
    issues: [{ severity: "error", code, path: LABELS_FILE, message, detail }],
  });
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return failed("read_error", "Cannot read the file", String(error));
  }
  // 同じ名前を 2 回書いた（軸が違っても）ファイルは、YAML のキーの重複としてここで読めない
  const { doc, errors } = parseYamlDocument(text);
  if (errors.length > 0) return failed("yaml_error", "Cannot parse YAML", errors.join("\n"));
  const parsed = parseVocabulary(doc.toJS());
  return {
    entries: parsed.entries,
    issues: parsed.errors.map((e) => ({
      severity: "error",
      code: "schema_error",
      path: LABELS_FILE,
      message:
        e.name === undefined
          ? "Does not match the schema"
          : `The label ${e.name} does not match the schema, so it is not read as vocabulary`,
      detail: e.detail,
    })),
  };
}
