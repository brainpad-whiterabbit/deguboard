// 1 ファイルの読み書き。読みは Zod で検証し、失敗は Issue にする

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OperationError } from "../errors.js";
import { writeFileAtomic } from "./atomic.js";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter.js";
import type { Issue } from "./issue.js";
import {
  cloneYamlDocument,
  newYamlDocument,
  parseYamlDocument,
  patchYamlDocument,
  stringifyYaml,
  type YamlDocument,
} from "./yaml.js";

export type DocFormat = "markdown" | "yaml";

/** 読み込んだ 1 ファイル。yaml はコメントとキー順を保つための Document */
export interface Doc<T> {
  id: string;
  /** worktree からの相対パス */
  path: string;
  format: DocFormat;
  data: T;
  /** Markdown の本文。YAML のファイルでは空 */
  body: string;
  yaml: YamlDocument;
}

export type ReadResult<T> = { ok: true; doc: Doc<T> } | { ok: false; issue: Issue };

export async function readDoc<T extends { id: string }>(
  root: string,
  relPath: string,
  format: DocFormat,
  schema: z.ZodType<T>,
  expectedId: string,
): Promise<ReadResult<T>> {
  const fail = (code: string, message: string, detail?: string): ReadResult<T> => ({
    ok: false,
    issue: {
      severity: "error",
      code,
      path: relPath,
      id: expectedId,
      message,
      ...(detail ? { detail } : {}),
    },
  });
  let text: string;
  try {
    text = await readFile(path.join(root, relPath), "utf8");
  } catch (error) {
    return fail("read_error", "ファイルを読めない", String(error));
  }
  let yamlText = text;
  let body = "";
  if (format === "markdown") {
    const split = splitFrontmatter(text);
    if (split === undefined) return fail("frontmatter_missing", "先頭に frontmatter（---）がない");
    if (split === "unterminated")
      return fail("frontmatter_unterminated", "frontmatter を閉じる --- がない");
    yamlText = split.yaml;
    body = split.body;
  }
  const { doc, errors } = parseYamlDocument(yamlText);
  if (errors.length > 0) return fail("yaml_error", "YAML を読めない", errors.join("\n"));
  const parsed = schema.safeParse(doc.toJS() ?? {});
  if (!parsed.success)
    return fail("schema_error", "スキーマに合わない", z.prettifyError(parsed.error));
  if (parsed.data.id !== expectedId) {
    return fail("id_mismatch", `ファイル名の ID ${expectedId} と中の id ${parsed.data.id} が違う`);
  }
  return {
    ok: true,
    doc: { id: expectedId, path: relPath, format, data: parsed.data, body, yaml: doc },
  };
}

function render(format: DocFormat, yaml: YamlDocument, body: string): string {
  const y = stringifyYaml(yaml);
  return format === "markdown" ? joinFrontmatter(y, body) : y;
}

/** patch を Document に当て、検証してから原子的に書く。失敗したらファイルは変わらない */
export async function writeDoc<T extends { id: string }>(
  root: string,
  doc: Doc<T>,
  schema: z.ZodType<T>,
  patch: Partial<Record<string, unknown>>,
  body?: string,
): Promise<Doc<T>> {
  // 元の Document を壊さないよう複製してから当てる
  const yaml = cloneYamlDocument(doc.yaml);
  patchYamlDocument(yaml, patch);
  const parsed = schema.safeParse(yaml.toJS() ?? {});
  if (!parsed.success) {
    throw new OperationError(
      "VALIDATION_FAILED",
      `${doc.path} の更新がスキーマに合わない`,
      z.prettifyError(parsed.error),
    );
  }
  const nextBody = body ?? doc.body;
  await writeFileAtomic(path.join(root, doc.path), render(doc.format, yaml, nextBody));
  return { ...doc, data: parsed.data, body: nextBody, yaml };
}

/** 新しいファイルを書く。既にあれば失敗する */
export async function createDoc<T extends { id: string }>(
  root: string,
  relPath: string,
  format: DocFormat,
  schema: z.ZodType<T>,
  data: Record<string, unknown>,
  body = "",
): Promise<Doc<T>> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new OperationError(
      "VALIDATION_FAILED",
      `${relPath} の内容がスキーマに合わない`,
      z.prettifyError(parsed.error),
    );
  }
  const yaml = newYamlDocument(data);
  await writeFileAtomic(path.join(root, relPath), render(format, yaml, body));
  return { id: parsed.data.id, path: relPath, format, data: parsed.data, body, yaml };
}
