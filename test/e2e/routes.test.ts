// E2E：CLI・HTTP・Webview（postMessage）の 3 経路から同じコマンドを通し、結果の JSON と deguboard ブランチのコミットが一致することを確かめる（NF-2、ADR-007）。
// 経路ごとに bare リモート付きの一時リポジトリを作り、同じ手順を流して最後に比べる。
// 手順を足すときは STEPS に input（HTTP・Webview に渡す形）と argv（CLI に渡す形）の両方を書く。
// 前の手順の結果（run.start が返した Run の ID）を使う手順は、input と argv を Vars を受ける関数にする

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
import { cliEnv } from "../../packages/core/test/helpers/env.js";
import { createFixture, git, type Fixture } from "../../packages/core/test/helpers/git-fixture.js";
import { startServer } from "../../packages/server/src/index.js";
import { createWebviewClient } from "../../packages/web/src/client/webview.js";
import { handleRequest, isWebviewRequest } from "../../packages/vscode/src/webview.js";

const USER = "e2e";

/** 前の手順の結果から取る値。run は最後に run.start が返した Run の ID */
interface Vars {
  run: string;
}

/** 経路に渡す 1 回の呼び出し。input は HTTP と Webview に渡す形、argv は CLI に渡す形 */
interface Call {
  name: string;
  input: Record<string, unknown>;
  argv: string[];
}

/** 1 手順。input・argv は前の手順の結果を使うなら Vars を受ける関数にする */
interface Step {
  name: string;
  input: Call["input"] | ((vars: Vars) => Call["input"]);
  argv: Call["argv"] | ((vars: Vars) => Call["argv"]);
  /** 拒否されるはずの手順なら、そのエラーコード */
  rejected?: string;
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
    name: "iteration.update",
    input: { iteration: "s1", goal: "ログインを出す", end: "2026-11-07" },
    argv: ["iteration", "update", "s1", "--goal", "ログインを出す", "--end", "2026-11-07"],
  },
  {
    name: "ticket.update",
    input: { ticket: "t2", priority: "low", depends_on: ["t1"] },
    argv: ["ticket", "update", "t2", "--priority", "low", "--depends-on", "t1"],
  },
  // 受け入れ条件の印：画面が読んだ本文（base）と今の本文が違えば 3 経路とも拒否し、書かない
  {
    name: "ticket.check",
    input: { ticket: "t1", items: [2], base: "古い本文" },
    argv: ["ticket", "check", "t1", "2", "--base", "古い本文"],
    rejected: "REJECTED",
  },
  {
    name: "ticket.check",
    input: { ticket: "t1", items: [2] },
    argv: ["ticket", "check", "t1", "2"],
  },
  {
    name: "ticket.create",
    input: { title: "画面", depends_on: ["t2"] },
    argv: ["ticket", "create", "画面", "--depends-on", "t2"],
  },
  // config：段階（tier）に対応させるモデルを設定する。CLI は文字列で受け、core が形に直す
  {
    name: "config.set",
    input: { key: "models.light", value: "e2e-light-model" },
    argv: ["config", "set", "models.light", "e2e-light-model"],
  },
  { name: "config.show", input: {}, argv: ["config", "show"] },
  // Plan：段階（tier）を details に記録する。不正な段階は 3 経路とも入力の形の誤り
  {
    name: "plan.create",
    input: { tickets: ["t2"], tier: { t2: "huge" } },
    argv: ["plan", "create", "t2", "--tier", "t2=huge"],
    rejected: "INVALID_INPUT",
  },
  {
    name: "plan.create",
    input: {
      tickets: ["t2", "t3"],
      after: { t3: ["t2"] },
      scope: { t2: "API だけ" },
      tier: { t2: "standard", t3: "light" },
    },
    argv: [
      "plan",
      "create",
      "t2",
      "t3",
      "--after",
      "t3=t2",
      "--scope",
      "t2=API だけ",
      "--tier",
      "t2=standard",
      "--tier",
      "t3=light",
    ],
  },
  { name: "plan.show", input: { plan: "p1" }, argv: ["plan", "show", "p1"] },
  // 失敗も 3 経路で同じ形になること（見つからない・入力の形の誤り）
  {
    name: "ticket.show",
    input: { ticket: "t99" },
    argv: ["ticket", "show", "t99"],
    rejected: "NOT_FOUND",
  },
  {
    name: "ticket.create",
    input: { title: "" },
    argv: ["ticket", "create", ""],
    rejected: "INVALID_INPUT",
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
  // 操作している主体（画面が担当者を自分かで見分けるのに使う）
  { name: "whoami", input: {}, argv: ["whoami"] },
  { name: "sync", input: {}, argv: ["sync"] },
  {
    name: "ticket.list",
    input: { include_abandoned: true },
    argv: ["ticket", "list", "--include-abandoned"],
  },
  { name: "ticket.show", input: { ticket: "t1" }, argv: ["ticket", "show", "t1"] },
  { name: "epic.show", input: { epic: "e1" }, argv: ["epic", "show", "e1"] },
  { name: "iteration.show", input: { iteration: "s1" }, argv: ["iteration", "show", "s1"] },
  // Run：実行中の記録は deguboard-local/ に置き、finish が runs/ に集計を書く。metrics.show はその集計を読む
  {
    name: "run.start",
    input: { ticket: "t2", step: "implement", agent: "e2e-agent", model: "e2e-model" },
    argv: ["run", "start", "t2", "implement", "--agent", "e2e-agent", "--model", "e2e-model"],
  },
  {
    name: "run.start",
    input: { ticket: "t2", step: "implement", agent: "e2e-agent" },
    argv: ["run", "start", "t2", "implement", "--agent", "e2e-agent"],
    rejected: "ALREADY_EXISTS",
  },
  {
    name: "run.start",
    input: { ticket: "t2", step: "deploy", agent: "e2e-agent" },
    argv: ["run", "start", "t2", "deploy", "--agent", "e2e-agent"],
    rejected: "VALIDATION_FAILED",
  },
  { name: "run.list", input: { running: true }, argv: ["run", "list", "--running"] },
  // 一覧の run_agent は実行中の Run の agent（RN-1）
  { name: "ticket.list", input: {}, argv: ["ticket", "list"] },
  {
    name: "run.finish",
    input: (v) => ({
      run: v.run,
      result: "failure",
      error: "テストが落ちた",
      retries: 1,
      retry_reasons: ["型の検査が落ちた"],
    }),
    argv: (v) => [
      "run",
      "finish",
      v.run,
      "--result",
      "failure",
      "--error",
      "テストが落ちた",
      "--retries",
      "1",
      "--retry-reason",
      "型の検査が落ちた",
    ],
  },
  {
    name: "run.finish",
    input: (v) => ({ run: v.run, result: "success" }),
    argv: (v) => ["run", "finish", v.run, "--result", "success"],
    rejected: "REJECTED",
  },
  { name: "commit", input: {}, argv: ["commit"] },
  { name: "run.list", input: { ticket: "t2" }, argv: ["run", "list", "--ticket", "t2"] },
  // 終わった Run だけになっても、最後の Run の agent が載る
  { name: "ticket.list", input: {}, argv: ["ticket", "list"] },
  {
    name: "metrics.show",
    input: { epic: "e1", by: "agent" },
    argv: ["metrics", "show", "--epic", "e1", "--by", "agent"],
  },
  {
    name: "metrics.show",
    input: { ticket: "e1" },
    argv: ["metrics", "show", "--ticket", "e1"],
    rejected: "INVALID_INPUT",
  },
];

/** 経路が返す 1 手順の結果。HTTP の本文・CLI の --json・Webview の応答（id を除く）は同じ形 */
type Envelope = Record<string, unknown>;
type Route = (
  cwd: string,
) => Promise<{ call(step: Call): Promise<Envelope>; close(): Promise<void> }>;

const cli: Route = async (cwd) => ({
  async call(step) {
    const out: string[] = [];
    await runCli(["--json", "--user", USER, ...step.argv], {
      cwd,
      env: cliEnv(),
      streams: { out: (t) => out.push(t), err: () => {} },
    });
    return JSON.parse(out.join("\n")) as Envelope;
  },
  async close() {},
});

const http: Route = async (cwd) => {
  const server = await startServer({ cwd, port: 0, user: USER });
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
  const hostClient = createLocalClient({ cwd, user: USER });
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

/** 時刻・コミットの SHA・一時ディレクトリのパス・Run の ID と実行時間は経路ごとに違うので揃える */
function normalize(value: unknown, root: string): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll(root, "<root>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>")
      .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
      .replace(/\br\d{8}-\d{6}-[0-9a-f]{4}\b/g, "<run>")
      .replace(/"duration_seconds":\d+/g, '"duration_seconds":"<seconds>"'),
  );
}

function resolveStep(step: Step, vars: Vars): Call {
  return {
    name: step.name,
    input: typeof step.input === "function" ? step.input(vars) : step.input,
    argv: typeof step.argv === "function" ? step.argv(vars) : step.argv,
  };
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
  const vars: Vars = { run: "" };
  try {
    for (const step of STEPS) {
      const result = await r.call(resolveStep(step, vars));
      if (step.name === "run.start" && result["ok"] === true) {
        vars.run = (result["data"] as { id: string }).id;
      }
      results.push(normalize(result, f.root));
    }
  } finally {
    await r.close();
  }
  // deguboard ブランチの事実：リモートに届いたコミットの題と、ファイルの中身
  const dataDir = `${f.cloneA}/.git/deguboard`;
  const commits = normalize(
    (await git(dataDir, ["log", "--format=%s", "origin/deguboard"])).stdout.trim().split("\n"),
    f.root,
  ) as string[];
  const names = (await git(dataDir, ["ls-tree", "-r", "--name-only", "origin/deguboard"])).stdout
    .trim()
    .split("\n");
  const files: Record<string, unknown> = {};
  for (const name of names) {
    files[normalize(name, f.root) as string] = normalize(
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
    STEPS.forEach((step, k) => {
      const r = base.results[k] as Envelope;
      expect(r["ok"], `${k}: ${step.name}`).toBe(step.rejected === undefined);
      if (step.rejected) expect(r).toMatchObject({ error: { code: step.rejected } });
    });
    const list = base.results[STEPS.findIndex((s) => s.name === "ticket.list")] as {
      data: { id: string; status: string; deps_done: boolean }[];
    };
    // 一覧の各行に deps_done が載る（t2 の依存先 t1 は done、t3 の依存先 t2 は作業中）
    expect(list.data.map((t) => `${t.id}:${t.status}:${t.deps_done}`)).toEqual([
      "t1:done:true",
      "t2:in_progress:true",
      "t3:todo:false",
    ]);
    // run_agent は Run がなければ null、実行中か最後の Run があればその agent（3 経路で同じ値になることは下で比べる）
    const agents = (n: number) =>
      (
        base.results[
          STEPS.map((s, k) => [s.name, k] as const).filter(([s]) => s === "ticket.list")[n]![1]
        ] as { data: { id: string; run_agent: string | null }[] }
      ).data.map((t) => `${t.id}:${t.run_agent}`);
    expect(agents(0)).toEqual(["t1:null", "t2:null", "t3:null"]);
    expect(agents(1)).toEqual(["t1:null", "t2:e2e-agent", "t3:null"]);
    expect(agents(2)).toEqual(["t1:null", "t2:e2e-agent", "t3:null"]);
    expect(base.commits.length).toBeGreaterThan(3);
    expect(Object.keys(base.files)).toContain("tickets/t1.md");
    // Run は finish の集計だけが Git に入り、run.list・metrics.show が読む
    expect(Object.keys(base.files)).toContain("runs/<run>.json");
    const at = (name: string, n = 0) =>
      base.results[
        STEPS.map((s, k) => [s.name, k] as const).filter(([s]) => s === name)[n]![1]
      ] as {
        data: unknown;
      };
    expect(at("run.list", 0).data).toMatchObject([
      { id: "<run>", ticket: "t2", model: "e2e-model", running: true, duration_seconds: null },
    ]);
    expect(at("run.list", 1).data).toMatchObject([
      {
        id: "<run>",
        result: "failure",
        error: "テストが落ちた",
        retries: 1,
        retry_reasons: ["型の検査が落ちた"],
        running: false,
      },
    ]);
    // iteration update で直した目標と期間が show に出る
    expect(at("iteration.show").data).toMatchObject({
      goal: "ログインを出す",
      start: "2026-11-02",
      end: "2026-11-07",
    });
    // config.set した models.light が config.show と config.yaml に残る
    expect(at("config.show").data).toMatchObject({ models: { light: "e2e-light-model" } });
    expect(base.files["config.yaml"]).toContain("light: e2e-light-model");
    // plan.create の段階（tier）が details に記録され、plans/p1.yaml に書かれる。進捗はチケットの状態から求める（PL-2）
    expect(at("plan.create", 1).data).toMatchObject({
      id: "p1",
      tickets: ["t2", "t3"],
      after: { t3: ["t2"] },
      details: { t2: { scope: "API だけ", tier: "standard" }, t3: { tier: "light" } },
    });
    expect(at("plan.show").data).toMatchObject({
      details: { t2: { tier: "standard" }, t3: { tier: "light" } },
      progress: { total: 2, done: 0 },
    });
    expect(base.files["plans/p1.yaml"]).toContain("tier: light");
    expect(at("whoami").data).toEqual({
      id: USER,
      user: USER,
      user_source: "flag",
      kind: "human",
      own_ids: [USER, `${USER}/agent`],
    });
    expect(at("metrics.show").data).toMatchObject({
      filter: { epic: "e1" },
      by: "agent",
      total: { runs: 1, retries: 1, results: { failure: 1 } },
      groups: [{ key: "e2e-agent", runs: 1 }],
    });
    // 経路の間で一致する
    for (const label of ["HTTP", "Webview"]) {
      expect(traces[label]!.results, `${label} の結果`).toEqual(base.results);
      expect(traces[label]!.commits, `${label} のコミット`).toEqual(base.commits);
      expect(traces[label]!.files, `${label} のファイル`).toEqual(base.files);
    }
  }, 120_000);
});
