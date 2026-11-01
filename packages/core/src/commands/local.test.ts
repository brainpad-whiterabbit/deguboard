import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFixture,
  createLocalOnlyRepo,
  type Fixture,
} from "../../test/helpers/git-fixture.js";
import { OperationError } from "../errors.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { createLocalClient, toCommandFailure } from "./local.js";
import { commands } from "./registry.js";
import { init } from "./setup.js";
import { Store } from "../storage/store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function initialized(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
  return f;
}

describe("プロセス内の CommandClient", () => {
  it("名前でコマンドを引いて実行し、主体は人。init は出さず、知らない名前は UNKNOWN_COMMAND", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA, user: "ui" });
    expect(client.commands.some((c) => c.name === "init")).toBe(false);
    const created = await client.run<{ id: string }>("ticket.create", { title: "画面から" });
    expect(created.data.id).toBe("t1");
    expect(created.write).toMatchObject({ pushed: true });
    const claimed = await client
      .run<{ assignee: string }>("sprint.list")
      .then(() => client.run<{ assignee: string }>("ticket.claim", { ticket: "t1" }));
    expect(claimed.data.assignee).toBe("ui");
    await expect(client.run("ticket.nope")).rejects.toMatchObject({ code: "UNKNOWN_COMMAND" });
    await expect(client.run("init")).rejects.toMatchObject({ code: "UNKNOWN_COMMAND" });
  });

  it("他のプロセスの変更を呼び出しごとに取り込み、status が同期の状態を返す", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA });
    expect((await client.run<unknown[]>("ticket.list")).data).toEqual([]);
    const cli = await openContext({ cwd: f.cloneA });
    await runCommand(
      commands.find((c) => c.name === "ticket.create")!,
      cli,
      { title: "CLI から" },
    );
    expect((await client.run<{ id: string }[]>("ticket.list")).data.map((t) => t.id)).toEqual([
      "t1",
    ]);
    expect(await client.status()).toMatchObject({
      ahead: 0,
      behind: 0,
      dirty: false,
      issues: 0,
      // fixture のリモートはローカルのパスなので Web の URL に直せない
      web_url: null,
    });
  });

  it("初期化前は NOT_INITIALIZED で失敗し、toCommandFailure が code と message に写す", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const client = createLocalClient({ cwd: local.dir });
    const error = await client.run("ticket.list").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationError);
    expect(toCommandFailure(error)).toMatchObject({ code: "NOT_INITIALIZED" });
    expect(toCommandFailure(new Error("x"))).toEqual({ code: "INTERNAL", message: "x" });
  });
  it("データが変わっていなければ、続けて呼んだコマンドはファイルを読み直さない", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA });
    await client.run("ticket.create", { title: "一" });
    await client.run("ticket.create", { title: "二" });
    const rescan = vi.spyOn(Store.prototype, "rescan");
    const lastScan = () => (rescan.mock.contexts.at(-1) as Store).lastScan;
    // 自分の書き込みの分（t2）を一度読み直したあとは、どのコマンドも読み直さない
    await client.run("ticket.list");
    for (const name of ["project.list", "config.show", "ticket.list", "epic.list", "plan.list"]) {
      await client.run(name);
      expect(lastScan()).toMatchObject({ read: 0 });
    }
    await client.status();
    expect(lastScan()).toMatchObject({ read: 0 });
    expect(lastScan().reused).toBeGreaterThan(0);
  });

  it("別のプロセス（CLI）が書き込んだチケットの変更は、次のコマンドの結果に出る", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA });
    await client.run("ticket.create", { title: "画面から" });
    await client.run("ticket.list");
    const rescan = vi.spyOn(Store.prototype, "rescan");
    // CLI と同じく、別に開いた文脈（別の Store）から書く
    const cli = await openContext({ cwd: f.cloneA });
    const run = (name: string, input: unknown) =>
      runCommand(
        commands.find((c) => c.name === name)!,
        cli,
        input,
      );
    await run("ticket.update", { ticket: "t1", title: "CLI で直した" });
    await run("ticket.create", { title: "CLI から" });
    rescan.mockClear();
    const list = await client.run<{ id: string; title: string }[]>("ticket.list");
    expect(list.data.map((t) => [t.id, t.title])).toEqual([
      ["t1", "CLI で直した"],
      ["t2", "CLI から"],
    ]);
    // 読み直したのは書き換わった t1 と増えた t2 だけ
    expect((rescan.mock.contexts.at(-1) as Store).lastScan).toMatchObject({ read: 2 });
  });
});
