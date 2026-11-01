import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  commands,
  commit,
  defineCommand,
  emptyUsage,
  init,
  ok,
  openContext,
  runCommand,
  ticketCreate,
} from "@deguboard/core";
import { createFixture, type Fixture } from "../../core/test/helpers/git-fixture.js";
import { toTools } from "./mcp.js";
import { run } from "./program.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function initialized(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
  return f;
}

/** テスト用に足すコマンド。定義を足すだけでツールが増えることを確かめる */
const echo = defineCommand({
  name: "demo.echo",
  group: "demo",
  summary: "受け取った文字列を返す",
  input: z.object({ text: z.string().describe("返す文字列") }),
  write: false,
  needs: "store",
  run: async (_ctx, input) => ok({ echoed: input.text }),
});

interface RpcResponse {
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

/**
 * dg mcp を標準入出力（改行区切りの JSON-RPC）で動かす。
 * 要求を 1 つずつ送って応答を待ち、最後に標準入力を閉じて終了コードを返す
 */
async function session(argv: string[], requests: Array<{ method: string; params?: unknown }>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const err: string[] = [];
  const responses: RpcResponse[] = [];
  let buffer = "";
  let waiting: ((r: RpcResponse) => void) | undefined;
  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const message = JSON.parse(line) as RpcResponse;
      responses.push(message);
      waiting?.(message);
    }
  });
  const exit = run([...argv, "mcp"], {
    stdio: { stdin, stdout },
    streams: { out: () => {}, err: (t) => err.push(t) },
    commands: [...commands, echo],
  });
  const send = (message: object) => stdin.write(`${JSON.stringify(message)}\n`);
  const request = (id: number, method: string, params?: unknown) =>
    new Promise<RpcResponse>((resolve) => {
      waiting = resolve;
      send({ jsonrpc: "2.0", id, method, params });
    });

  await request(0, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const results: RpcResponse[] = [];
  for (const [i, r] of requests.entries()) results.push(await request(i + 1, r.method, r.params));
  stdin.end();
  return { code: await exit, results, responses, err };
}

/** tools/call の結果から、CLI の --json と同じ形の本文を取り出す */
function body(response: RpcResponse): any {
  return JSON.parse(response.result.content[0].text as string);
}

describe("dg mcp", () => {
  it("ツールの一覧と入力スキーマはコマンド定義から生成し、init は出さず、足したコマンドもそのまま出る", () => {
    const tools = toTools([...commands, echo]);
    const names = tools.map((t) => t.name);
    const expected = commands.filter((c) => c.needs === "store").map((c) => c.name);
    expect(names).toEqual([...expected, "demo.echo"].map((n) => n.replaceAll(".", "_")));
    expect(names).not.toContain("init");
    for (const t of tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(tools.find((t) => t.name === "demo_echo")).toMatchObject({
      description: "受け取った文字列を返す",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "返す文字列" } },
        required: ["text"],
      },
      annotations: { readOnlyHint: true },
    });
    expect(tools.find((t) => t.name === "ticket_create")?.annotations?.readOnlyHint).toBe(false);
  });

  it("stdio で起動してツールを呼び、結果は CLI の --json と同じ形で、書き込みの主体は <ユーザ>/agent", async () => {
    const f = await initialized();
    const { code, results, err } = await session(
      ["-C", f.cloneA, "--user", "eiki"],
      [
        { method: "tools/list" },
        {
          method: "tools/call",
          params: { name: "ticket_create", arguments: { title: "MCP から" } },
        },
        { method: "tools/call", params: { name: "ticket_claim", arguments: { ticket: "t1" } } },
        { method: "tools/call", params: { name: "ticket_show", arguments: { ticket: "t9" } } },
        { method: "tools/call", params: { name: "ticket_create", arguments: {} } },
        { method: "tools/call", params: { name: "demo_echo", arguments: { text: "やあ" } } },
      ],
    );
    expect(err).toEqual([]);
    expect(code).toBe(0);
    const [list, created, claimed, missing, invalid, echoed] = results as [
      RpcResponse,
      RpcResponse,
      RpcResponse,
      RpcResponse,
      RpcResponse,
      RpcResponse,
    ];
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("ticket_create");

    const createdBody = body(created);
    expect(Object.keys(createdBody).sort()).toEqual(["data", "ok", "warnings", "write"]);
    expect(createdBody).toMatchObject({
      ok: true,
      data: { id: "t1", created_by: "eiki/agent" },
      write: { committed: true, pushed: true },
    });
    expect(body(claimed).data).toMatchObject({ status: "in_progress", assignee: "eiki/agent" });

    // 失敗は { ok: false, error: { code, message } } で、isError が付く
    expect(missing.result.isError).toBe(true);
    expect(body(missing)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(body(invalid)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(body(echoed)).toEqual({ ok: true, data: { echoed: "やあ" }, warnings: [], write: null });

    // 同じチケットを CLI の --json で読んだ結果と、MCP の結果が一致する
    const out: string[] = [];
    await run(["-C", f.cloneA, "--json", "ticket", "show", "t1"], {
      streams: { out: (t) => out.push(t), err: () => {} },
    });
    const viaMcp = await session(
      ["-C", f.cloneA],
      [{ method: "tools/call", params: { name: "ticket_show", arguments: { ticket: "t1" } } }],
    );
    expect(body(viaMcp.results[0]!)).toEqual(JSON.parse(out.join("\n")));
  });

  it("metrics show は CLI の --json と MCP で同じ集計を返し、--help に出る", async () => {
    const f = await initialized();
    const ctx = await openContext({ cwd: f.cloneA });
    await runCommand(ticketCreate, ctx, { title: "集計の対象" });
    await ctx.store.create("run", {
      id: "r20261031-040000-0001",
      ticket: "t1",
      step: "implement",
      agent: "claude-code",
      model: null,
      started_at: "2026-10-31T04:00:00Z",
      finished_at: "2026-10-31T04:01:00Z",
      result: "success",
      error: null,
      retries: 0,
      usage: { ...emptyUsage(), input: 10 },
    });
    await runCommand(commit, ctx, {});

    const out: string[] = [];
    const code = await run(["-C", f.cloneA, "--json", "metrics", "show", "--by", "agent"], {
      streams: { out: (t) => out.push(t), err: () => {} },
    });
    expect(code).toBe(0);
    const viaCli = JSON.parse(out.join("\n"));
    expect(viaCli).toMatchObject({
      ok: true,
      data: { by: "agent", total: { runs: 1, input: 10, output: null, missing: { output: 1 } } },
      write: null,
    });
    const viaMcp = await session(
      ["-C", f.cloneA],
      [{ method: "tools/call", params: { name: "metrics_show", arguments: { by: "agent" } } }],
    );
    expect(body(viaMcp.results[0]!)).toEqual(viaCli);

    const help: string[] = [];
    await run(["--help"], { streams: { out: (t) => help.push(t), err: () => {} } });
    expect(help.join("\n")).toContain("metrics");
  });

  it("run_start・run_list・run_finish で CLI と同じく Run を記録できる", async () => {
    const f = await initialized();
    await run(["-C", f.cloneA, "ticket", "create", "A"], {
      streams: { out: () => {}, err: () => {} },
    });
    const call = (name: string, args: object) => ({
      method: "tools/call",
      params: { name, arguments: args },
    });
    const first = await session(
      ["-C", f.cloneA],
      [
        call("run_start", { ticket: "t1", step: "review", agent: "codex" }),
        call("run_start", { ticket: "t1", step: "review", agent: "codex" }),
      ],
    );
    const started = body(first.results[0]!);
    expect(started).toMatchObject({ ok: true, data: { ticket: "t1", step: "review" } });
    expect(body(first.results[1]!)).toMatchObject({
      ok: false,
      error: { code: "ALREADY_EXISTS" },
    });
    const second = await session(
      ["-C", f.cloneA],
      [
        call("run_list", { running: true }),
        call("run_finish", { run: started.data.id, result: "success" }),
        call("run_list", {}),
      ],
    );
    const [listed, finished, all] = second.results.map(body);
    expect(listed.data.map((r: { id: string }) => r.id)).toEqual([started.data.id]);
    expect(finished).toMatchObject({ ok: true, data: { result: "success" } });
    expect(all.data).toMatchObject([{ id: started.data.id, running: false }]);
  });
});
