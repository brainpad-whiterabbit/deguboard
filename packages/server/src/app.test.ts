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
  const running = await startServer({ cwd, port: 0, staticDir, actorId: "ui@pc" });
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
    expect(claimed.body.data).toMatchObject({ status: "in_progress", claimed_by: "ui@pc" });
    // 画面の操作は常に人なので abandoned にできる
    const abandoned = await post(s, "ticket.move", { ticket: "t1", status: "abandoned" });
    expect(abandoned.body.data.status).toBe("abandoned");
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
    const rejected = await post(s, "ticket.move", { ticket: "t1", status: "done" });
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
