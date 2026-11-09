// dg guide <topic>：エージェント向けの手順を出す（CL-5）。本文を組むのは Core の composeGuide（ADR-030）。ここは config を読んで Core の結果を写すだけ

import {
  ACTION_NAMES,
  composeGuide,
  DeguboardError,
  defaultConfig,
  openContext,
  type Config,
  type GuideTopic,
} from "@deguboard/core";

export { GUIDE_TOPICS, fillPlaceholders, readGuide, readGuideMeta } from "@deguboard/core";
export type { GuideMeta, GuideTopic } from "@deguboard/core";

/** 初期化前でも読めるよう、config が取れなければ既定値で埋める。repoTop は guide.notes の相対パスの基準（初期化前は cwd） */
async function loadGuideConfig(
  cwd: string,
): Promise<{ config: Config; repoTop: string; initialized: boolean }> {
  try {
    const ctx = await openContext({ cwd, actions: ACTION_NAMES });
    return { config: ctx.config, repoTop: ctx.repo.topLevel, initialized: true };
  } catch (error) {
    if (
      error instanceof DeguboardError &&
      (error.code === "NOT_INITIALIZED" || error.code === "GIT_ERROR")
    ) {
      return { config: defaultConfig(), repoTop: cwd, initialized: false };
    }
    throw error;
  }
}

/**
 * section を省くとトピック全体。指定すると、その節の本文だけ（見出しの文言か「（…）」を除いた名前）。
 * warnings は guide.notes の文書を差し込めなかった理由（guide は差し込まずに出す）
 */
export async function renderGuide(
  topic: string,
  cwd: string,
  section?: string,
): Promise<{
  topic: GuideTopic;
  section: string | null;
  text: string;
  initialized: boolean;
  warnings: string[];
}> {
  const { config, repoTop, initialized } = await loadGuideConfig(cwd);
  return { ...(await composeGuide(topic, config, repoTop, section)), initialized };
}
