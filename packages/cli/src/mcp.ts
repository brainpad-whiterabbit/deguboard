// dg mcp：core の commands を MCP のツールに写し、stdio で配信する（AG-4、ADR-033）。ロジックはここに書かない。
//   - ツールの一覧と入力スキーマは、コマンド定義（名前・要約・Zod の入力・write）から生成する。コマンドを足せばツールも増える
//   - 実行は core の createLocalClient（文脈の管理・再走査・直列化・入力の検証・human_only の検査）に任せる
//   - 主体は常に agent（<ユーザ>/agent）。結果は CLI の --json と同じ形（ok・data・warnings・write / error）

import type { Readable, Writable } from "node:stream";
import {
  ACTION_NAMES,
  createLocalClient,
  toCommandFailure,
  type AnyCommand,
  type UserSource,
} from "@deguboard/core";
import { describeCommands } from "@deguboard/server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export interface McpOptions {
  /** 対象のリポジトリ */
  cwd: string;
  /** 主体のユーザ名。省略時は git config の deguboard.user、git の user.name、OS のユーザ名の順 */
  user?: string | undefined;
  /** user の出どころ（flag か env）。省けば flag */
  userSource?: UserSource | undefined;
  version: string;
  commands?: readonly AnyCommand[] | undefined;
  /** sync の前に登録するマージドライバのコマンド（dg serve と同じ） */
  mergeDriver?: readonly string[] | undefined;
  /** テスト用：既定は process.stdin / process.stdout */
  stdin?: Readable | undefined;
  stdout?: Writable | undefined;
}

const INSTRUCTIONS = [
  "Operations for deguboard (Git-native ticket management). The tools map 1 to 1 to the dg CLI; a tool name is the command name with the `.` in `ticket.create` replaced by `_`.",
  "Writes are recorded with <user>/agent as the actor. The result is the same as dg --json: { ok, data, warnings, write } or { ok: false, error }.",
  "If Bash is available, read the work steps (from claim to PR) with `dg guide work`. If it is not, limit yourself to creating tickets, viewing them, and updating Status, and leave branches, commits, and PRs to the human.",
].join("\n");

/** MCP のツール名。Claude などの API はツール名に `.` を許さないので `_` にする */
export function toolName(commandName: string): string {
  return commandName.replaceAll(".", "_");
}

/** コマンド定義から MCP のツール定義を作る */
export function toTools(commands: readonly AnyCommand[]): Tool[] {
  return describeCommands(commands).map((d) => {
    const { $schema: _schema, ...inputSchema } = d.input as Record<string, unknown>;
    return {
      name: toolName(d.name),
      title: `dg ${d.name.replaceAll(".", " ")}`,
      description: d.summary,
      inputSchema: { type: "object", ...inputSchema },
      // 定義から決まるのは書き込むかどうかだけ（削除や push の有無は注釈しない）
      annotations: { readOnlyHint: !d.write },
    };
  });
}

/** MCP サーバーを stdio で起動する。標準入力が閉じるか SIGINT / SIGTERM で止まり、そのとき解決する */
export async function serveMcp(options: McpOptions): Promise<void> {
  const client = createLocalClient({
    cwd: options.cwd,
    user: options.user,
    userSource: options.userSource,
    actor: "agent",
    commands: options.commands,
    mergeDriver: options.mergeDriver,
    actions: ACTION_NAMES,
  });
  const tools = toTools(client.commands);
  const byTool = new Map(client.commands.map((c) => [toolName(c.name), c.name]));

  const server = new Server(
    { name: "deguboard", version: options.version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const inflight = new Set<Promise<unknown>>();
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = byTool.get(req.params.name) ?? req.params.name;
    const call = client.run(name, req.params.arguments ?? {}).then(
      (result) => ({
        content: [
          text({
            ok: true,
            data: result.data,
            warnings: result.warnings,
            write: result.write ?? null,
          }),
        ],
      }),
      (error: unknown) => ({
        content: [text({ ok: false, error: toCommandFailure(error) })],
        isError: true,
      }),
    );
    inflight.add(call);
    try {
      return await call;
    } finally {
      inflight.delete(call);
    }
  });

  const stdin = options.stdin ?? process.stdin;
  const transport = new StdioServerTransport(stdin, options.stdout ?? process.stdout);
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  // 標準入力が閉じたら、受け付け済みの呼び出しの応答を返してから止まる。
  // SDK は要求の処理と応答の送信を Promise の後続で行うので、前後を 1 tick ずらして取りこぼさない
  const stop = () => {
    setImmediate(() => {
      void Promise.allSettled(inflight).then(() => setImmediate(() => void server.close()));
    });
  };
  stdin.once("end", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await server.connect(transport);
    await closed;
  } finally {
    stdin.off("end", stop);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function text(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}
