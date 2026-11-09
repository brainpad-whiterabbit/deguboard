// guide の本文（guide-*.md・同じフォルダ）の読み込み（ADR-030）。frontmatter の分離・{{choices}} の差し込み・config の値の埋め込みと、
// 節の本文の取り出しを Core が行う。dg guide（CLI）・dg next・dg brief・dg flow next はここを写す。
// 読む場所は import.meta.url からの相対。ビルドでは core の dist/ に guide-*.md をコピーし（root の package.json の build）、
// 束ねた拡張（VS Code）は bundle（dist/extension.cjs）の隣に置く（packages/vscode/package.json の build）。ずれると読めないので両方を直す

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { UsageError } from "../errors.js";
import { type Config } from "../model/config.js";
import { findGuideSection } from "./sections.js";

/** 流れの順に並べる。frontmatter に description を持つトピックは dg<トピック> の Skill として配る（AG-2）。overview・run・parallel・review は Skill を持たず、ほかのトピックから読む */
export const GUIDE_TOPICS = [
  "overview",
  "import",
  "assign",
  "check",
  "plan",
  "work",
  "run",
  "parallel",
  "review",
  "audit",
  "release",
  "done",
  "all",
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

/** guide の frontmatter。Skill の説明と引数の案内の正本 */
export interface GuideMeta {
  description?: string;
  "argument-hint"?: string;
}

function isGuideTopic(topic: string): topic is GuideTopic {
  return (GUIDE_TOPICS as readonly string[]).includes(topic);
}

/** `{{git.base_branch}}` のような項目を config の値で埋める。配列は `, ` でつなぎ、空の配列と空の文字列は「なし」 */
export function fillPlaceholders(text: string, config: Config): string {
  return text.replace(/\{\{([a-z_.]+)\}\}/g, (whole, key: string) => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (cur, k) =>
          cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined,
        config,
      );
    if (value === undefined || value === null) return whole;
    if (Array.isArray(value)) return value.length === 0 ? "なし" : value.map(String).join(", ");
    if (value === "") return "なし";
    return String(value);
  });
}

/** 先頭の frontmatter を外し、メタデータと本文に分ける */
function splitFrontmatter(raw: string): { meta: GuideMeta; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n+/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  return { meta: (parseYaml(match[1]!) ?? {}) as GuideMeta, body: raw.slice(match[0].length) };
}

async function readGuideFile(topic: string): Promise<{ meta: GuideMeta; body: string }> {
  if (!isGuideTopic(topic)) {
    throw new UsageError(`guide のトピック ${topic} はない。${GUIDE_TOPICS.join(" / ")} のどれか`);
  }
  return splitFrontmatter(await readFile(new URL(`./guide-${topic}.md`, import.meta.url), "utf8"));
}

/** 本文を返す。`{{choices}}` の行は共通の「選択肢で聞く」の節（guide-choices.md）に置き換える */
export async function readGuide(topic: string): Promise<string> {
  const { body } = await readGuideFile(topic);
  if (!/^\{\{choices\}\}$/m.test(body)) return body;
  const choices = (await readFile(new URL("./guide-choices.md", import.meta.url), "utf8")).trim();
  return body.replace(/^\{\{choices\}\}$/m, () => choices);
}

export async function readGuideMeta(topic: string): Promise<GuideMeta> {
  return (await readGuideFile(topic)).meta;
}

/**
 * トピックの 1 節を、config の値（`{{…}}` の項目）を埋めて返す。text は見出しの行から始まり、heading は見出しの文言。
 * dg guide --section・dg next・dg brief・dg flow next が同じ本文を返すよう、この関数を写す
 */
export async function guideSectionText(
  topic: string,
  section: string,
  config: Config,
): Promise<{ heading: string; text: string }> {
  const picked = findGuideSection(topic, await readGuide(topic), section);
  return { heading: picked.heading, text: fillPlaceholders(picked.text, config).trimEnd() };
}
