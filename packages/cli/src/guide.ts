// dg guide <topic>：エージェント向けの手順を出す（CL-5）。本文と読み込みは Core が持つ（ADR-030）。ここは config を読んで Core の節を写すだけ

import {
  ACTION_NAMES,
  DeguboardError,
  defaultConfig,
  fillPlaceholders,
  guideSectionText,
  openContext,
  readGuide,
  type Config,
  type GuideTopic,
} from "@deguboard/core";

export { GUIDE_TOPICS, fillPlaceholders, readGuide, readGuideMeta } from "@deguboard/core";
export type { GuideMeta, GuideTopic } from "@deguboard/core";

/** 初期化前でも読めるよう、config が取れなければ既定値で埋める */
async function loadGuideConfig(cwd: string): Promise<{ config: Config; initialized: boolean }> {
  try {
    const ctx = await openContext({ cwd, actions: ACTION_NAMES });
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

/** section を省くとトピック全体。指定すると、その節の本文だけ（見出しの文言か「（…）」を除いた名前） */
export async function renderGuide(
  topic: string,
  cwd: string,
  section?: string,
): Promise<{ topic: GuideTopic; section: string | null; text: string; initialized: boolean }> {
  const { config, initialized } = await loadGuideConfig(cwd);
  if (section === undefined) {
    const body = await readGuide(topic);
    return {
      topic: topic as GuideTopic,
      section: null,
      text: fillPlaceholders(body, config).trimEnd(),
      initialized,
    };
  }
  const picked = await guideSectionText(topic, section, config);
  return { topic: topic as GuideTopic, section: picked.heading, text: picked.text, initialized };
}
