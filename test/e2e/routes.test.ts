// E2E：CLI・HTTP・Webview（postMessage）の 3 経路から同じコマンドを通し、結果の JSON と deguboard ブランチのコミットが一致することを確かめる（NF-2、ADR-007）。
// 経路ごとに bare リモート付きの一時リポジトリを作り、同じ手順を流して最後に比べる。
// 手順を足すときは STEPS に input（HTTP・Webview に渡す形）と argv（CLI に渡す形）の両方を書く

import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { run as runCli } from "../../packages/cli/src/program.js";
import {
  createLocalClient,
  init,
  openContext,
  runCommand,
  type CommandClient,
} from "../../packages/core/src/index.js";
import { createFixture, git, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import { startServer } from "../../packages/server/src/index.js";
import { createWebviewClient } from "../../packages/web/src/client/webview.js";
import { handleRequest, isWebviewRequest } from "../../packages/vscode/src/webview.js";

const ACTOR_ID = "e2e@pc";

/** 1 手順。input は HTTP と Webview に渡す形、argv は CLI に渡す形 */
interface Step {
  name: string;
  input: Record<string, unknown>;
  argv: string[];
}

const STEPS: Step[] = [
  {
    name: "ticket.create",
    input: { title: "ログイン", labels: ["auth", "web"], priority: "high", acceptance: ["a", "b"] },
    argv: [
      "ticket",
      "create",
      "ログイン",
      "--label",
      "auth,web",
      "--priority",
      "high",
      "--acceptance",
      "a",
      "--acceptance",
      "b",
    ],
  },
  { name: "ticket.create", input: { title: "API" }, argv: ["ticket", "create", "API"] },
  { name: "epic.create", input: { title: "最初の版" }, argv: ["epic", "create", "最初の版"] },
  {
    name: "epic.add",
    input: { epic: "e1", tickets: ["t1", "t2"] },
    argv: ["epic", "add", "e1", "t1", "t2"],
  },
  {
    name: "iteration.create",
    input: { name: "第 1 週", start: "2026-11-02", end: "2026-11-06" },
    argv: ["iteration", "create", "第 1 週", "--start", "2026-11-02", "--end", "2026-11-06"],
  },
  {
    name: "iteration.add",
    input: { iteration: "s1", tickets: ["t1"] },
    argv: ["iteration", "add", "s1", "t1"],
  },
  {
    name: "ticket.update",
    input: { ticket: "t2", priority: "low", depends_on: ["t1"] },
    argv: ["ticket", "update", "t2", "--priority", "low", "--depends-on", "t1"],
  },
  // 依存先が終わっていないので拒否される（失敗も 3 経路で同じ形）
  {
    name: "ticket.move",
    input: { ticket: "t2", status: "in_progress" },
    argv: ["ticket", "move", "t2", "in_progress"],
  },
  {
    name: "ticket.claim",
    input: { ticket: "t1", branch: "feat/login" },
    argv: ["ticket", "claim", "t1", "--branch", "feat/login"],
  },
  {
    name: "ticket.move",
    input: { ticket: "t1", status: "review" },
    argv: ["ticket", "move", "t1", "review"],
  },
  {
    name: "ticket.move",
    input: { ticket: "t1", status: "done" },
    argv: ["ticket", "move", "t1", "done"],
  },
  {
    name: "ticket.move",
    input: { ticket: "t2", status: "in_progress" },
    argv: ["ticket", "move", "t2", "in_progress"],
  },
  { name: "sync", input: {}, argv: ["sync"] },
  {
    name: "ticket.list",
    input: { include_abandoned: true },
    argv: ["ticket", "list", "--include-abandoned"],
  },
  { name: "ticket.show", input: { ticket: "t1" }, argv: ["ticket", "show", "t1"] },
  { name: "epic.show", input: { epic: "e1" }, argv: ["epic", "show", "e1"] },
  { name: "iteration.show", input: { iteration: "s1" }, argv: ["iteration", "show", "s1"] },
];

/** 経路が返す 1 手順の結果。HTTP の本文・CLI の --json・Webview の応答（id を除く）は同じ形 */
type Envelope = Record<string, unknown>;
type Route = (
  cwd: string,
) => Promise<{ call(step: Step): Promise<Envelope>; close(): Promise<void> }>;

const cli: Route = async (cwd) => ({
  async call(step) {
    const out: string[] = [];
    await runCli(["--json", "--actor-id", ACTOR_ID, ...step.argv], {
      cwd,
      streams: { out: (t) => out.push(t), err: () => {} },
    });
    return JSON.parse(out.join("\n")) as Envelope;
  },
  async close() {},
});

const http: Route = async (cwd) => {
  const server = await startServer({ cwd, port: 0, actorId: ACTOR_ID });
  return {
    async call(step) {
      const res = await fetch(`${server.url}api/commands/${step.name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: step.input }),
      });
      return (await res.json()) as Envelope;
    },
    close: server.close,
  };
};

/** 拡張ホスト（createLocalClient + handleRequest）と Webview（createWebviewClient）を MessageChannel でつなぐ */
const webview: Route = async (cwd) => {
  const { port1, port2 } = new MessageChannel();
  const hostClient = createLocalClient({ cwd, actorId: ACTOR_ID });
  port2.addEventListener("message", (event) => {
    const message = (event as MessageEvent<unknown>).data;
    if (isWebviewRequest(message))
      void handleRequest(hostClient, message).then((r) => port2.postMessage(r));
  });
  const client: CommandClient = createWebviewClient(
    port1,
    port1 as unknown as Pick<Window, "addEventListener">,
  );
  return {
    async call(step) {
      try {
        const result = await client.run(step.name, step.input);
        return {
          ok: true,
          data: result.data,
          warnings: result.warnings,
          write: result.write ?? null,
        };
      } catch (error) {
        const { code, message, detail } = error as {
          code: string;
          message: string;
          detail?: string;
        };
        return { ok: false, error: { code, message, ...(detail ? { detail } : {}) } };
      }
    },
    async close() {
      port1.close();
      port2.close();
    },
  };
};

const ROUTES: Record<string, Route> = { CLI: cli, HTTP: http, Webview: webview };

/** 時刻・コミットの SHA・一時ディレクトリのパスは経路ごとに違うので揃える */
function normalize(value: unknown, root: string): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll(root, "<root>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>")
      .replace(/\b[0-9a-f]{40}\b/g, "<sha>"),
  );
}

interface Trace {
  results: unknown[];
  commits: string[];
  files: Record<string, unknown>;
}

async function runRoute(route: Route, f: Fixture): Promise<Trace> {
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
  const r = await route(f.cloneA);
  const results: unknown[] = [];
  try {
    for (const step of STEPS) results.push(normalize(await r.call(step), f.root));
  } finally {
    await r.close();
  }
  // deguboard ブランチの事実：リモートに届いたコミットの題と、ファイルの中身
  const dataDir = `${f.cloneA}/.git/deguboard`;
  const commits = (await git(dataDir, ["log", "--format=%s", "origin/deguboard"])).stdout
    .trim()
    .split("\n");
  const names = (await git(dataDir, ["ls-tree", "-r", "--name-only", "origin/deguboard"])).stdout
    .trim()
    .split("\n");
  const files: Record<string, unknown> = {};
  for (const name of names) {
    files[name] = normalize(
      (await git(dataDir, ["show", `origin/deguboard:${name}`])).stdout,
      f.root,
    );
  }
  return { results, commits, files };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

describe("3 経路の E2E", () => {
  it("CLI・HTTP・Webview から同じ手順を流すと、結果の JSON と deguboard ブランチのコミットとファイルが一致する", async () => {
    const traces: Record<string, Trace> = {};
    for (const [label, route] of Object.entries(ROUTES)) {
      const f = await createFixture();
      cleanups.push(f.cleanup);
      traces[label] = await runRoute(route, f);
    }
    const base = traces["CLI"]!;
    // 手順が意図どおり進んだこと（成功・拒否・最終状態）
    expect(base.results.map((r) => (r as Envelope)["ok"])).toEqual(STEPS.map((s, i) => !(i === 7)));
    expect(base.results[7]).toMatchObject({ error: { code: "TRANSITION_REJECTED" } });
    expect(
      (base.results[13] as { data: { id: string; status: string }[] }).data.map(
        (t) => `${t.id}:${t.status}`,
      ),
    ).toEqual(["t1:done", "t2:in_progress"]);
    expect(base.commits.length).toBeGreaterThan(3);
    expect(Object.keys(base.files)).toContain("tickets/t1.md");
    // 経路の間で一致する
    for (const label of ["HTTP", "Webview"]) {
      expect(traces[label]!.results, `${label} の結果`).toEqual(base.results);
      expect(traces[label]!.commits, `${label} のコミット`).toEqual(base.commits);
      expect(traces[label]!.files, `${label} のファイル`).toEqual(base.files);
    }
  }, 120_000);
});
