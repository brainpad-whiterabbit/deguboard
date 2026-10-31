// dg guide <topic>：エージェント向けの手順を出す（CL-5）。正本は隣の guide-*.md で、config.yaml の値を埋める。
// ビルドでは guide-*.md を dist/ にコピーする（package.json の build）

import { readFile } from "node:fs/promises";
import { DeguboardError, defaultConfig, openContext, type Config } from "@deguboard/core";
import { UsageError } from "@deguboard/core";

export const GUIDE_TOPICS = ["overview", "create", "plan", "assign", "work", "finish"] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

export function isGuideTopic(topic: string): topic is GuideTopic {
  return (GUIDE_TOPICS as readonly string[]).includes(topic);
}

/** `{{git.base_branch}}` のような項目を config の値で埋める */
export function fillPlaceholders(text: string, config: Config): string {
  return text.replace(/\{\{([a-z_.]+)\}\}/g, (whole, key: string) => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (cur, k) =>
          cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined,
        config,
      );
    return value === undefined || value === null ? whole : String(value);
  });
}

export async function readGuide(topic: string): Promise<string> {
  if (!isGuideTopic(topic)) {
    throw new UsageError(`guide のトピック ${topic} はない。${GUIDE_TOPICS.join(" / ")} のどれか`);
  }
  return readFile(new URL(`./guide-${topic}.md`, import.meta.url), "utf8");
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
