// dg guide <topic>：エージェント向けの手順を出す（CL-5）。正本は隣の guide-*.md で、config.yaml の値を埋める。
// ビルドでは guide-*.md を dist/ にコピーする（package.json の build）

import { readFile } from "node:fs/promises";
import { DeguboardError, defaultConfig, openContext, type Config } from "@deguboard/core";
import { UsageError } from "@deguboard/core";
import { parse as parseYaml } from "yaml";

/** 流れの順に並べる。frontmatter に description を持つトピックは dg<トピック> の Skill として配る（AG-2） */
export const GUIDE_TOPICS = [
  "overview",
  "import",
  "assign",
  "check",
  "plan",
  "work",
  "audit",
  "release",
  "done",
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

/** guide の frontmatter。Skill の説明と引数の案内の正本 */
export interface GuideMeta {
  description?: string;
  "argument-hint"?: string;
}

export function isGuideTopic(topic: string): topic is GuideTopic {
  return (GUIDE_TOPICS as readonly string[]).includes(topic);
}

/** `{{git.base_branch}}` のような項目を config の値で埋める。配列は `, ` でつなぎ、空なら「なし」 */
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

/** 初期化前でも読めるよう、config が取れなければ既定値で埋める */
export async function loadGuideConfig(
  cwd: string,
): Promise<{ config: Config; initialized: boolean }> {
  try {
    const ctx = await openContext({ cwd });
    return { config: ctx.config, initialized: true };
  } catch (error) {
    if (
      error instanceof DeguboardError &&
      (error.code === "NOT_INITIALIZED" || error.code === "GIT_ERROR")
    ) {
      return { config: defaultConfig(), initialized: false };
    }
    throw error;
  }
}

export async function renderGuide(
  topic: string,
  cwd: string,
): Promise<{ topic: GuideTopic; text: string; initialized: boolean }> {
  const raw = await readGuide(topic);
  const { config, initialized } = await loadGuideConfig(cwd);
  return { topic: topic as GuideTopic, text: fillPlaceholders(raw, config).trimEnd(), initialized };
}
