// 1 ファイルの読み書き。読みは Zod で検証し、失敗は Issue にする。
// 読みは parse で値にし、Doc に YAML の Document を持たせない（parse の中で作られる Document は読みの中で捨てる）。
// 書くときにだけ、読んだ文字列から Document を作って部分更新し、コメントとキー順を保つ。JSON（Run）は値に当てて書く

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OperationError } from "../errors.js";
import { writeFileAtomic } from "./atomic.js";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter.js";
import type { Issue } from "./issue.js";
import {
  newYamlDocument,
  parseYamlDocument,
  parseYamlValue,
  patchYamlDocument,
  stringifyYaml,
  type YamlDocument,
} from "./yaml.js";

export type DocFormat = "markdown" | "yaml" | "json";

/** 読み込んだ 1 ファイル。YAML の Document は持たない（書くときに source から作る） */
export interface Doc<T> {
  id: string;
  /** worktree からの相対パス */
  path: string;
  format: DocFormat;
  data: T;
  /** Markdown の本文。YAML・JSON のファイルでは空 */
  body: string;
  /** 読んだ値（Markdown は frontmatter の値）。スキーマにないキーも含む。JSON を書き直すときと、Run の項目を重ねるときの元 */
  raw: Record<string, unknown>;
  /** YAML の文字列（Markdown は frontmatter の中身）。書くときに Document を作る元で、コメントとキー順はここから保つ。JSON では空 */
  source: string;
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
  let value: unknown;
  let source = "";
  let body = "";
  if (format === "json") {
    try {
      value = JSON.parse(text);
    } catch (error) {
      return fail("json_error", "JSON を読めない", String(error));
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return fail("json_error", "JSON のオブジェクトでない");
  } else {
    let yamlText = text;
    if (format === "markdown") {
      const split = splitFrontmatter(text);
      if (split === undefined)
        return fail("frontmatter_missing", "先頭に frontmatter（---）がない");
      if (split === "unterminated")
        return fail("frontmatter_unterminated", "frontmatter を閉じる --- がない");
      yamlText = split.yaml;
      body = split.body;
    }
    const read = parseYamlValue(yamlText);
    if (read.errors.length > 0)
      return fail("yaml_error", "YAML を読めない", read.errors.join("\n"));
    value = read.value;
    source = yamlText;
  }
  const raw = (value ?? {}) as Record<string, unknown>;
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return fail("schema_error", "スキーマに合わない", z.prettifyError(parsed.error));
  if (parsed.data.id !== expectedId) {
    return fail("id_mismatch", `ファイル名の ID ${expectedId} と中の id ${parsed.data.id} が違う`);
  }
  return {
    ok: true,
    doc: { id: expectedId, path: relPath, format, data: parsed.data, body, raw, source },
  };
}

/** 書く文字列。YAML のときは Document を書き出した文字列（source に残す）、Markdown はそれに本文を足す */
function render(format: DocFormat, raw: Record<string, unknown>, source: string, body: string) {
  if (format === "json") return `${JSON.stringify(raw, null, 2)}\n`;
  return format === "markdown" ? joinFrontmatter(source, body) : source;
}

/** JSON の値に patch を当てる。yaml の Document と同じく、既存のキーは位置を保ち、undefined のキーは消す */
function patchRaw(raw: Record<string, unknown>, patch: Partial<Record<string, unknown>>) {
  const next = { ...raw };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * patch を当て、検証してから原子的に書く。失敗したらファイルは変わらない。
 * YAML は読んだ文字列から Document を作って当てる（書くときだけ作る）。元の Doc は変えない
 */
export async function writeDoc<T extends { id: string }>(
  root: string,
  doc: Doc<T>,
  schema: z.ZodType<T>,
  patch: Partial<Record<string, unknown>>,
  body?: string,
): Promise<Doc<T>> {
  let raw: Record<string, unknown>;
  let yaml: YamlDocument | undefined;
  if (doc.format === "json") {
    raw = patchRaw(doc.raw, patch);
  } else {
    yaml = parseYamlDocument(doc.source).doc;
    patchYamlDocument(yaml, patch);
    raw = (yaml.toJS() ?? {}) as Record<string, unknown>;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new OperationError(
      "VALIDATION_FAILED",
      `${doc.path} の更新がスキーマに合わない`,
      z.prettifyError(parsed.error),
    );
  }
  const nextBody = body ?? doc.body;
  const source = yaml ? stringifyYaml(yaml) : "";
  await writeFileAtomic(path.join(root, doc.path), render(doc.format, raw, source, nextBody));
  return { ...doc, data: parsed.data, body: nextBody, raw, source };
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
  const raw = (yaml.toJS() ?? {}) as Record<string, unknown>;
  const source = format === "json" ? "" : stringifyYaml(yaml);
  await writeFileAtomic(path.join(root, relPath), render(format, raw, source, body));
  return { id: parsed.data.id, path: relPath, format, data: parsed.data, body, raw, source };
}
