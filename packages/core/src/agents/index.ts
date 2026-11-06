// Agent Adapter の一覧と、Run の使用量の取り込み（AG-5・MT-1・MT-2、ADR-005・ADR-007）。
// Core の汎用部分はここだけを import し、Run の agent の値で Adapter を選ぶ。adapters/ を直接 import しない（.oxlintrc.json）

import type { Config } from "../model/config.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { copilotAdapter } from "./adapters/copilot.js";
import type {
  AgentAdapter,
  AgentEnv,
  CollectedUsage,
  SkillDirs,
  SkillQuery,
  UsageQuery,
} from "./define.js";

export type * from "./define.js";

const ADAPTERS: readonly AgentAdapter[] = [claudeCodeAdapter, codexAdapter, copilotAdapter];

/** Adapter のある agent の名前 */
export function agentNames(): string[] {
  return ADAPTERS.map((a) => a.name);
}

/** Adapter が Skill を読むディレクトリをまとめたもの。ask が形式の既定を決めるのに使う（ADR-010） */
export function agentSkillDirs(query: SkillQuery): string[] {
  return ADAPTERS.flatMap((a) =>
    a.skillDirs ? [a.skillDirs.project(query.topLevel), a.skillDirs.personal(query.env)] : [],
  );
}

/** agent の Skill の置き場所。dg skill install が書く先を決めるのに使う。Skill のない agent は undefined */
export function skillDirsOf(agent: string): SkillDirs | undefined {
  return findAdapter(agent)?.skillDirs;
}

/** 環境変数から判定した agent。agent は 1 つの Adapter だけが自分と判定したときの名前で、それ以外は null */
export interface AgentDetection {
  agent: string | null;
  /** 自分と判定した Adapter の名前。2 つ以上なら（エージェントの中から別のエージェントを呼んだなど）どれとも決めない */
  matched: string[];
}

/**
 * dg を呼んだプロセスの環境変数から agent を判定する（AG-5・RN-1）。run start と ticket claim が --agent を省いたときに使い、
 * 判定できなければ（判定する Adapter がないか、2 つ以上が自分と判定した）agent は null
 */
export function detectAgent(env: AgentEnv): AgentDetection {
  const matched = ADAPTERS.filter((a) => a.detect?.(env) === true).map((a) => a.name);
  return { agent: matched.length === 1 ? matched[0]! : null, matched };
}

function findAdapter(agent: string): AgentAdapter | undefined {
  return ADAPTERS.find((a) => a.name === agent);
}

/** DEGUBOARD_NO_TRANSCRIPTS が空でも 0 でもなければ、そのマシンでは会話記録を読まない */
function refusedOnThisMachine(env: UsageQuery["env"]): boolean {
  const v = env["DEGUBOARD_NO_TRANSCRIPTS"];
  return v !== undefined && v !== "" && v !== "0";
}

/**
 * finish の前に、Run の agent の Adapter で使用量を取り込む。取れない値は null のまま警告を返し、例外にしない（RN-2）。
 * 読む許可は config の metrics.read_transcripts（チームの方針）と DEGUBOARD_NO_TRANSCRIPTS（個人の拒否）の両方で確かめる
 */
export async function collectRunUsage(
  config: Pick<Config, "metrics">,
  query: UsageQuery,
): Promise<CollectedUsage> {
  const skipped = (reason: string): CollectedUsage => ({
    usage: { input: null, output: null, cache_read: null, cache_write: null },
    model: null,
    tools: null,
    warnings: [`${reason}。使用量は null で残す`],
  });
  const adapter = findAdapter(query.run.agent);
  if (!adapter) {
    return skipped(
      `agent ${query.run.agent} の Adapter がない（${agentNames().join("・")} だけ取り込める）`,
    );
  }
  if (!config.metrics.read_transcripts) {
    return skipped("metrics.read_transcripts が false なので会話記録を読まない");
  }
  if (refusedOnThisMachine(query.env)) {
    return skipped("DEGUBOARD_NO_TRANSCRIPTS が設定されているので会話記録を読まない");
  }
  try {
    return await adapter.readTranscriptUsage(query);
  } catch (e) {
    // メッセージはパスや中身を含みうるので、コード（なければ例外の名前）だけを出す
    const code = (e as { code?: unknown } | null)?.code;
    const reason = typeof code === "string" ? code : e instanceof Error ? e.name : "unknown";
    return skipped(`${adapter.name} の会話記録を読めない（${reason}）`);
  }
}
