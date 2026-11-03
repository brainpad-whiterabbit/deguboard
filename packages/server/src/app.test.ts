import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commands, openContext, runCommand, init } from "@deguboard/core";
import {
  createFixture,
  createLocalOnlyRepo,
  type Fixture,
} from "../../core/test/helpers/git-fixture.js";
import { describeCommands } from "./app.js";
import { startServer, type RunningServer } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

async function serve(cwd: string, staticDir?: string): Promise<RunningServer> {
  const running = await startServer({ cwd, port: 0, staticDir, user: "ui" });
  cleanups.push(running.close);
  return running;
}

async function post(s: RunningServer, name: string, input: unknown) {
  const res = await fetch(`${s.url}api/commands/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("HTTP サーバー", () => {
  it("GET /api/commands が store の要るコマンドの一覧と入力の JSON Schema を返す", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    const res = await fetch(`${s.url}api/commands`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Array<{ name: string; input: { properties: object } }>;
    };
    expect(body.data.map((c) => c.name)).toEqual(
      commands.filter((c) => c.needs === "store").map((c) => c.name),
    );
    const create = body.data.find((c) => c.name === "ticket.create")!;
    expect(Object.keys(create.input.properties)).toContain("title");
    expect(Object.keys(create.input.properties)).toContain("acceptance");
    expect(describeCommands(commands).some((c) => c.name === "init")).toBe(false);
  });

  it("POST /api/commands/<name> がコマンドを実行し、CLI の --json と同じ形を返す", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    const created = await post(s, "ticket.create", { title: "画面から", labels: ["ui"] });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      ok: true,
      data: { id: "t1", labels: ["ui"] },
      warnings: [],
      write: { pushed: true },
    });
    const claimed = await post(s, "ticket.claim", { ticket: "1" });
    expect(claimed.body.data).toMatchObject({ status: "in_progress", assignee: "ui" });
    // 画面の操作は常に人として扱われる（既定では遷移に制約がないので abandoned にもできる）
    const abandoned = await post(s, "ticket.move", { ticket: "t1", status: "abandoned" });
    expect(abandoned.body.data.status).toBe("abandoned");
  });

  it("DEGUBOARD_USER に当たる user と userSource env で起動すると、whoami の user_source が env になる", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await startServer({ cwd: f.cloneA, port: 0, user: "eiki", userSource: "env" });
    cleanups.push(s.close);
    const me = await post(s, "whoami", {});
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ id: "eiki", user: "eiki", user_source: "env" });
  });

  it("Plan のコマンドも HTTP に写り、PL-3 の拒否は 409 になる", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    await post(s, "ticket.create", { title: "A" });
    await post(s, "ticket.create", { title: "B" });
    // 段階（tier）は light / standard / heavy だけ。それ以外は入力の形の誤り（400・INVALID_INPUT）
    const invalid = await post(s, "plan.create", { tickets: ["t1"], tier: { t1: "huge" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    const created = await post(s, "plan.create", {
      tickets: ["t1", "t2"],
      after: { t2: ["t1"] },
      approach: { t1: "小さく" },
      tier: { t1: "light", t2: "heavy" },
    });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ id: "p1", after: { t2: ["t1"] } });
    expect(created.body.data.details).toEqual({
      t1: { approach: "小さく", tier: "light" },
      t2: { tier: "heavy" },
    });
    const dup = await post(s, "plan.create", { tickets: ["t2"] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("REJECTED");
    const approved = await post(s, "plan.approve", { plan: "p1" });
    expect(approved.body.data).toMatchObject({ pending_approval: false, approved_by: "ui" });
    const shown = await post(s, "plan.show", { plan: "p1" });
    expect(shown.body.data.progress).toMatchObject({ total: 2, done: 0 });
    const closed = await post(s, "plan.close", { plan: "p1" });
    expect(closed.body.data.closed_at).toBeDefined();
  });

  it("run.list も HTTP に写り、Project で絞って実行時間 duration_seconds を返す", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    await post(s, "ticket.create", { title: "A" });
    const started = await post(s, "run.start", { ticket: "t1", step: "implement", agent: "codex" });
    const running = await post(s, "run.list", { project: "default" });
    expect(running.body.data).toMatchObject([
      { id: started.body.data.id, running: true, duration_seconds: null },
    ]);
    await post(s, "run.finish", { run: started.body.data.id, result: "success" });
    const finished = await post(s, "run.list", { project: "default" });
    expect(finished.body.data).toMatchObject([{ id: started.body.data.id, running: false }]);
    expect(typeof finished.body.data[0].duration_seconds).toBe("number");
    expect((await post(s, "run.list", { project: "other" })).body.data).toEqual([]);
  });

  it("metrics.show も HTTP に写り、step で絞り込み・集計できる", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    await post(s, "ticket.create", { title: "A" });
    // 集計するのは閉じた Run なので、始めてから閉じる
    for (const step of ["implement", "review"]) {
      const started = await post(s, "run.start", { ticket: "t1", step, agent: "codex" });
      await post(s, "run.finish", { run: started.body.data.id, result: "success" });
    }
    const byStep = await post(s, "metrics.show", { by: "step" });
    expect(byStep.status).toBe(200);
    expect(
      byStep.body.data.groups.map((g: { key: string; runs: number }) => [g.key, g.runs]),
    ).toEqual([
      ["implement", 1],
      ["review", 1],
    ]);
    const review = await post(s, "metrics.show", { step: "review" });
    expect(review.body.data).toMatchObject({ filter: { step: "review" }, total: { runs: 1 } });
  });

  it("workflow.set も HTTP に写り、定義そのものを受けて書き、誤りは 409 で何も書かない", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    const rejected = await post(s, "workflow.set", {
      workflow: "general",
      definition: { id: "general", name: "G", transitions: [{ from: "todo", to: "todo" }] },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(
      (await post(s, "workflow.show", { workflow: "general" })).body.data.definition.name,
    ).toBe("General");
    const set = await post(s, "workflow.set", {
      workflow: "general",
      definition: { id: "general", name: "画面から" },
    });
    expect(set.status).toBe(200);
    expect(set.body.data).toMatchObject({
      before: { name: "General" },
      after: { name: "画面から" },
    });
    const back = await post(s, "workflow.set", { workflow: "general", template: "general" });
    expect(back.body.data.after.name).toBe("General");
  });

  it("エラーは HTTP の状態に写る：入力の誤り 400、見つからない 404、拒否 409、未知のコマンド 404", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    expect((await post(s, "ticket.create", { title: "" })).status).toBe(400);
    const missing = await post(s, "ticket.show", { ticket: "t99" });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    await post(s, "ticket.create", { title: "A" });
    // todo のチケットは unclaim できない
    const rejected = await post(s, "ticket.unclaim", { ticket: "t1" });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("TRANSITION_REJECTED");
    expect((await post(s, "ticket.nope", {})).status).toBe(404);
    expect((await post(s, "init", {})).status).toBe(404);
    const badJson = await fetch(`${s.url}api/commands/ticket.list`, { method: "POST", body: "{" });
    expect(badJson.status).toBe(400);
  });

  it("他のプロセス（CLI）の変更をリクエストごとに取り込み、初期化前は 503", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    expect((await post(s, "ticket.list", {})).body.data).toEqual([]);
    const cli = await openContext({ cwd: f.cloneA });
    await runCommand(
      commands.find((c) => c.name === "ticket.create")!,
      cli,
      { title: "CLI から" },
    );
    expect((await post(s, "ticket.list", {})).body.data.map((t: { id: string }) => t.id)).toEqual([
      "t1",
    ]);

    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const s2 = await serve(local.dir);
    expect((await post(s2, "ticket.list", {})).status).toBe(503);
  });

  it("GET /api/status が同期の状態を返し、静的ファイルは index.html に落ちる", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const web = path.join(f.root, "web");
    await mkdir(path.join(web, "assets"), { recursive: true });
    await writeFile(path.join(web, "index.html"), "<!doctype html><title>deguboard</title>");
    await writeFile(path.join(web, "assets", "app.js"), "console.log(1)");
    const s = await serve(f.cloneA, web);
    const status = (await (await fetch(`${s.url}api/status`)).json()) as {
      data: { ahead: number; dirty: boolean; issues: number };
    };
    expect(status.data).toMatchObject({ ahead: 0, dirty: false, issues: 0 });
    expect(await (await fetch(`${s.url}`)).text()).toContain("<title>deguboard</title>");
    expect(await (await fetch(`${s.url}tickets/t1`)).text()).toContain("<title>deguboard</title>");
    const js = await fetch(`${s.url}assets/app.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect((await fetch(`${s.url}..%2F..%2Fetc%2Fpasswd`)).status).toBe(404); // ルートの外は拒否する
    expect((await fetch(`${s.url}api/nope`)).status).toBe(404);
    expect(s.host).toBe("127.0.0.1");
  });
});
