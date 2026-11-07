// Claude Code のフック（AG-5、ADR-012）。入力の JSON を製品によらない出来事（HookEvent）に変え、dg hooks install が書くイベントを決める。
//   - SessionStart：session_id・transcript_path と、以後の Bash の環境に export を書くファイル（環境変数 CLAUDE_ENV_FILE）
//   - PostToolUse（matcher は Agent）：tool_input.prompt と tool_response.agentId・resolvedModel。サブエージェントの記録は
//     <親の記録のディレクトリ>/<session_id>/subagents/agent-<agentId>.jsonl（SubagentStop の agent_transcript_path と同じ形）。
//     バックグラウンドの起動は起動の直後に返り（status: async_launched）、SubagentStop が後に来る。前景の起動は終わってから返り
//     （status: completed）、SubagentStop はこれより先に来る
//   - SubagentStop：agent_id・agent_transcript_path（last_assistant_message も来るが使わない。見直しの成否は結果の記録で決める。ADR-013）
//   - SessionEnd：session_id
//   SubagentStart は使わない。並べて起動すると、その時点では親の記録にも、サブエージェントの記録にも呼び出しがない
//   （2026-11-07 に Claude Code 2.1.318 で確かめた。環境変数がサブエージェントの Bash に届くことも同じ日に確かめた）

import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentEnv, HookEvent, HookSupport } from "../define.js";
import { homeDir } from "./transcript.js";

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** 会話記録の置き場所の親。CLAUDE_CONFIG_DIR があればそこ、なければ ~/.claude */
export function claudeConfigDir(env: AgentEnv): string {
  return env["CLAUDE_CONFIG_DIR"] || path.join(homeDir(env), ".claude");
}

/** サブエージェントの記録のパス。親の記録の隣の <session>/subagents/agent-<id>.jsonl */
export function subagentTranscript(parent: string, session: string, agentId: string): string {
  return path.join(path.dirname(parent), session, "subagents", `agent-${agentId}.jsonl`);
}

/** フックの入力を出来事に変える。扱わないイベント・必要な項目のない入力は undefined */
function parseHook(event: string, input: unknown, env: AgentEnv): HookEvent | undefined {
  const d = obj(input);
  const session = str(d["session_id"]);
  if (!session) return undefined;
  const transcript = str(d["transcript_path"]);
  switch (event) {
    case "SessionStart":
      return { kind: "session_start", session, transcript, envFile: str(env["CLAUDE_ENV_FILE"]) };
    case "PostToolUse": {
      if (d["tool_name"] !== "Agent" && d["tool_name"] !== "Task") return undefined;
      const response = obj(d["tool_response"]);
      const agentId = str(response["agentId"]);
      const prompt = str(obj(d["tool_input"])["prompt"]);
      if (!agentId || !prompt) return undefined;
      // 前景の起動は終わってから返る（status: completed）。SubagentStop はこれより先に発火している
      const finished = response["status"] === "completed";
      return {
        kind: "subagent_launched",
        session,
        agentId,
        prompt,
        model: str(response["resolvedModel"]),
        transcript: transcript ? subagentTranscript(transcript, session, agentId) : null,
        finished,
        durationMs:
          finished && typeof response["totalDurationMs"] === "number"
            ? response["totalDurationMs"]
            : null,
      };
    }
    case "SubagentStop": {
      const agentId = str(d["agent_id"]);
      if (!agentId) return undefined;
      return {
        kind: "subagent_stopped",
        session,
        agentId,
        transcript: str(d["agent_transcript_path"]),
      };
    }
    case "SessionEnd":
      return { kind: "session_end", session };
    default:
      return undefined;
  }
}

/** サブエージェントの記録の最初の行の文（頼んだ文）。読めなければ undefined */
async function firstPrompt(transcript: string): Promise<string | undefined> {
  const input = createReadStream(transcript);
  try {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const content = obj(obj(JSON.parse(line))["message"])["content"];
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          const text = content.map((b) => str(obj(b)["text"])).find((t) => t !== null);
          if (text) return text;
        }
      } catch {
        // 書きかけの行
      }
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    input.destroy();
  }
}

const RUN_ID = /^r\d{8}-\d{6}-[0-9a-f]{4}$/;

/** dg の run start・ticket claim を呼んだ Bash のコマンドか（mise run dg -- や npx deguboard を前に付けた形も含む） */
const OPENS_RUN = /(^|[\s/])(dg|deguboard|dg\.js)\b.*\s(run\s+start|ticket\s+claim)(\s|$)/;

/** ツールの結果の中身を 1 つの文にする */
const resultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => str(obj(b)["text"]) ?? "").join("\n")
      : "";

/**
 * run start・ticket claim の結果から開いた Run の ID を取る。--json なら data.id（run start）か data.run（claim）、
 * 人向けの出力なら行の頭の id: か run:。警告の文は見ない
 */
function openedRunId(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const data = obj(obj(JSON.parse(text.slice(start)))["data"]);
      // claim は data.id がチケットの ID で data.run が Run の ID、run start は data.id が Run の ID
      const id = [str(data["run"]), str(data["id"])].find((v) => v !== null && RUN_ID.test(v));
      if (id) return id;
    } catch {
      // JSON でない（人向けの出力）
    }
  }
  const m = /^(?:id|run): (r\d{8}-\d{6}-[0-9a-f]{4})\s*$/m.exec(text);
  return m?.[1];
}

/** サブエージェントの記録の中で、dg run start・dg ticket claim を呼んだ Bash の結果に出た、開いた Run の ID */
async function selfOpenedRunIds(transcript: string): Promise<string[]> {
  const calls = new Set<string>();
  const ids: string[] = [];
  const input = createReadStream(transcript);
  try {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let content: unknown;
      try {
        content = obj(obj(JSON.parse(line))["message"])["content"];
      } catch {
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        const block = obj(b);
        if (block["type"] === "tool_use" && block["name"] === "Bash") {
          const command = str(obj(block["input"])["command"]) ?? "";
          const id = str(block["id"]);
          if (id && OPENS_RUN.test(command)) calls.add(id);
        } else if (block["type"] === "tool_result") {
          const id = str(block["tool_use_id"]);
          if (!id || !calls.has(id)) continue;
          const opened = openedRunId(resultText(block["content"]));
          if (opened && !ids.includes(opened)) ids.push(opened);
        }
      }
    }
  } catch {
    return ids;
  } finally {
    input.destroy();
  }
  return ids;
}

export const claudeCodeHooks: HookSupport = {
  events: [
    { event: "SessionStart" },
    { event: "PostToolUse", matcher: "Agent" },
    { event: "SubagentStop" },
    { event: "SessionEnd" },
  ],
  settings: {
    project: (topLevel) => path.join(topLevel, ".claude", "settings.json"),
    personal: (env) => path.join(claudeConfigDir(env), "settings.json"),
  },
  parse: parseHook,
  firstPrompt,
  selfOpenedRunIds,
  transcriptRoot: (env) => path.join(claudeConfigDir(env), "projects"),
};
