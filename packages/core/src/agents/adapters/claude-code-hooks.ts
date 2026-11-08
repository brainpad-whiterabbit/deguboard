// Claude Code のフック（AG-5、ADR-012）。入力の JSON を製品によらない出来事（HookEvent）に変え、dg hooks install が書くイベントを決める。
//   - SessionStart：session_id・transcript_path と、以後の Bash の環境に export を書くファイル（環境変数 CLAUDE_ENV_FILE）
//   - PostToolUse（matcher は Agent）：tool_input.prompt と tool_response.agentId・resolvedModel。サブエージェントの記録は
//     <親の記録のディレクトリ>/<session_id>/subagents/agent-<agentId>.jsonl（SubagentStop の agent_transcript_path と同じ形）。
//     バックグラウンドの起動は起動の直後に返り（status: async_launched）、SubagentStop が後に来る。前景の起動は終わってから返り
//     （status: completed）、SubagentStop はこれより先に来る
//   - SubagentStop：agent_id・agent_transcript_path（last_assistant_message も来るが使わない。見直しの成否は結果の記録で決める。ADR-013）
//     サブエージェントが親に質問を返して止まったときも発火する。親が SendMessage で続きを頼むと、同じ agent_id で SubagentStart と
//     SubagentStop がもう一度発火し、記録は同じファイルに追記される。発火の瞬間には最後の応答（assistant の行と使用量）がまだ書かれて
//     おらず（最後は api-request の行）、0.5 秒以内に書かれる（ADR-014）
//   - SubagentStart：agent_id と親の transcript_path。Run は開かない（並べて起動すると、その時点では親の記録にも、サブエージェントの
//     記録にも呼び出しがない）。再開を続きとして扱い、止まって待っている印を消すのにだけ使う
//   - PreToolUse（matcher は Bash と書くツール）：tool_name・tool_input（command・file_path）・cwd。拒むときは標準出力に
//     hookSpecificOutput.permissionDecision: deny を書き、permissionDecisionReason がエージェントに返る
//   - SessionEnd：session_id
//   （2026-11-07 に Claude Code 2.1.318 で確かめた。SessionStart で入れた環境変数は親の Bash にだけ届き、サブエージェントの Bash には
//   届かない（2026-11-08 に 2.1.319 で確かめた）。サブエージェントのセッションは Adapter の sessionFromEnv が補う。ADR-016）

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

/** ファイルを書くツール（PreToolUse で .git/deguboard/ への書き込みを拒む。t532） */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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
    case "SubagentStart": {
      const agentId = str(d["agent_id"]);
      if (!agentId) return undefined;
      return {
        kind: "subagent_started",
        session,
        agentId,
        transcript: transcript ? subagentTranscript(transcript, session, agentId) : null,
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
    case "PreToolUse": {
      const name = d["tool_name"];
      const toolInput = obj(d["tool_input"]);
      const cwd = str(d["cwd"]);
      if (name === "Bash")
        return {
          kind: "tool_requested",
          session,
          tool: "bash",
          command: str(toolInput["command"]),
          path: null,
          cwd,
        };
      if (WRITE_TOOLS.has(String(name)))
        return {
          kind: "tool_requested",
          session,
          tool: "write",
          command: null,
          path: str(toolInput["file_path"]) ?? str(toolInput["notebook_path"]),
          cwd,
        };
      return undefined;
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

/**
 * 記録が書き終わっているか：最後の api-request の行の後に、使用量（message.usage）付きの assistant の行がある。
 * 応答が複数のブロックの行に分かれても、実機（2026-11-07、2.1.318）では最後の応答の行は止まってから 0.5 秒以内にまとめて書かれ、
 * その後は増えないので、最初の使用量付きの行で書き終わりとみなす（stop_reason は行ごとに付くかを確かめていないので見ない）。
 * api-request の行がなければ待つものがないので true。読めなければ true
 */
async function transcriptSettled(transcript: string): Promise<boolean> {
  const input = createReadStream(transcript);
  let settled = true;
  try {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let d: Record<string, unknown>;
      try {
        d = obj(JSON.parse(line));
      } catch {
        continue;
      }
      if (d["type"] === "api-request") settled = false;
      else if (
        d["type"] === "assistant" &&
        obj(obj(d["message"])["usage"])["output_tokens"] !== undefined
      )
        settled = true;
    }
    return settled;
  } catch {
    return true;
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

/**
 * 入力のうち parseHook が読む項目（t542）。PreToolUse はツールごとに違い、Bash は command、書くツールは file_path（NotebookEdit は notebook_path）。
 * ここと parseHook の読み方は同じにする（テストで、項目を外すと parseHook の結果が変わることを確かめる）
 */
function inputFieldsOf(event: string, input: Record<string, unknown>): readonly string[] {
  const base = ["session_id"];
  switch (event) {
    case "SessionStart":
      return [...base, "transcript_path"];
    case "PostToolUse":
      return [
        ...base,
        "transcript_path",
        "tool_name",
        "tool_input.prompt",
        "tool_response.agentId",
      ];
    case "SubagentStart":
      return [...base, "transcript_path", "agent_id"];
    case "SubagentStop":
      return [...base, "agent_id", "agent_transcript_path"];
    case "PreToolUse": {
      const name = input["tool_name"];
      const tool =
        name === "Bash"
          ? ["tool_input.command"]
          : name === "NotebookEdit"
            ? ["tool_input.notebook_path"]
            : WRITE_TOOLS.has(String(name))
              ? ["tool_input.file_path"]
              : [];
      return [...base, "tool_name", "cwd", ...tool];
    }
    case "SessionEnd":
      return base;
    default:
      return [];
  }
}

export const claudeCodeHooks: HookSupport = {
  events: [
    { event: "SessionStart" },
    { event: "PostToolUse", matcher: "Agent" },
    { event: "SubagentStart" },
    // gh pr merge・ready を品質ゲートで止め、.git/deguboard/ への書き込みを拒む（t532）
    { event: "PreToolUse", matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit" },
    { event: "SubagentStop" },
    { event: "SessionEnd" },
  ],
  settings: {
    project: (topLevel) => path.join(topLevel, ".claude", "settings.json"),
    personal: (env) => path.join(claudeConfigDir(env), "settings.json"),
  },
  inputFields: inputFieldsOf,
  parse: parseHook,
  firstPrompt,
  selfOpenedRunIds,
  transcriptSettled,
  // PreToolUse の hookSpecificOutput で拒む。理由はエージェントに返る
  denyOutput: (event, reason) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  transcriptRoot: (env) => path.join(claudeConfigDir(env), "projects"),
};
