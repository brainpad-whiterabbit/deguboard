import { execFile } from "node:child_process";
import { readdir, utimes } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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

  it("user と userSource env を渡すと、whoami の user_source が env になる", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA, user: "eiki", userSource: "env" });
    const me = await client.run<{ id: string; user: string; user_source: string }>("whoami");
    expect(me.data).toMatchObject({ id: "eiki", user: "eiki", user_source: "env" });
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
    // 時計を進め、どのファイルも更新が十分に古いものとして覚えさせる
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const rescan = vi.spyOn(Store.prototype, "rescan");
    const lastScan = () => (rescan.mock.contexts.at(-1) as Store).lastScan;
    // 一度読み直して覚えたあとは、どのコマンドも読み直さない
    await client.run("ticket.list");
    for (const name of ["project.list", "config.show", "ticket.list", "epic.list", "plan.list"]) {
      await client.run(name);
      expect(lastScan()).toMatchObject({ read: 0 });
    }
    await client.status();
    expect(lastScan()).toMatchObject({ read: 0 });
    expect(lastScan().reused).toBeGreaterThan(0);
  });

  it("CLI と同じ経路（openContext）で開き直すと、前の呼び出しが残した結果を使い、変わっていないファイルを読み直さない", async () => {
    const f = await initialized();
    const cli = () => openContext({ cwd: f.cloneA, actions: ["run_tests"] });
    const create = commands.find((c) => c.name === "ticket.create")!;
    await runCommand(create, await cli(), { title: "一" });
    await runCommand(create, await cli(), { title: "二" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    // 1 回目の呼び出しが読んで残し、2 回目からは読み直さない
    const files = (await cli()).store.lastScan.read;
    expect(files).toBeGreaterThan(0);
    for (const [name, input] of [
      ["ticket.list", {}],
      ["ticket.show", { ticket: "t1" }],
    ] as const) {
      const ctx = await cli();
      expect(ctx.store.lastScan).toEqual({ read: 0, reused: files });
      await runCommand(
        commands.find((c) => c.name === name)!,
        ctx,
        input,
      );
    }
    const ctx = await cli();
    expect(await readdir(path.join(ctx.repo.localDir, "store-cache"))).toHaveLength(1);
    expect([...ctx.store.tickets.keys()]).toEqual(["t1", "t2"]);
  });

  /** データのチケットのファイルの更新時刻を古い値に揃える（後の書き込みで時刻が必ず変わるように） */
  async function ageTickets(client: ReturnType<typeof createLocalClient>): Promise<string> {
    const dir = path.join((await client.status()).data_dir, "tickets");
    const old = new Date("2020-01-01T00:00:00Z");
    for (const file of await readdir(dir)) {
      if (file.endsWith(".md")) await utimes(path.join(dir, file), old, old);
    }
    return dir;
  }

  it("別に開いた文脈（CLI と同じ経路）が書き込んだチケットの変更は、次のコマンドの結果に出る", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA });
    await client.run("ticket.create", { title: "画面から" });
    await ageTickets(client);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await client.run("ticket.list");
    const rescan = vi.spyOn(Store.prototype, "rescan");
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

  it("別のプロセスが同じ大きさに書き換えたチケットのファイルは、次のコマンドの結果に出る", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA });
    await client.run("ticket.create", { title: "画面から" });
    const dir = await ageTickets(client);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await client.run("ticket.list");
    // 子プロセスで、一時ファイルに書いて rename する（タイトルは同じバイト数）
    const script = `
      const fs = require("node:fs");
      const [file] = process.argv.slice(1);
      const text = fs.readFileSync(file, "utf8").replace("画面から", "外から来");
      fs.writeFileSync(file + ".tmp", text);
      fs.renameSync(file + ".tmp", file);
    `;
    await promisify(execFile)(process.execPath, ["-e", script, path.join(dir, "t1.md")]);
    const list = await client.run<{ id: string; title: string }[]>("ticket.list");
    expect(list.data.map((t) => [t.id, t.title])).toEqual([["t1", "外から来"]]);
  });

  it("同じ瞬間に届いた N 本の読みは、再走査を 1 回だけ行って結果を共有する", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA });
    await client.run("ticket.create", { title: "一" });
    const rescan = vi.spyOn(Store.prototype, "rescan");
    const results = await Promise.all([
      client.run<{ id: string }[]>("ticket.list"),
      client.run("epic.list"),
      client.run("project.list"),
      client.run("config.show", { fields: true }),
      client.status(),
    ]);
    expect(rescan).toHaveBeenCalledTimes(1);
    expect(results[0].data).toEqual([expect.objectContaining({ id: "t1" })]);
  });

  it("届く前に始まった再走査は使わず、届いた後の再走査で、要求の前に外で書いた変更が見える", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA });
    await client.run("ticket.create", { title: "画面から" });
    // 最初の再走査を読み終えたところで止め、そのあいだに要求を届けて外から書き換える
    const real = Store.prototype.rescan;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rescan = vi.spyOn(Store.prototype, "rescan").mockImplementationOnce(async function (
      this: Store,
    ) {
      await real.call(this);
      entered();
      await gate;
    });
    const first = client.run("ticket.list");
    await reached;
    const cli = await openContext({ cwd: f.cloneA });
    await runCommand(
      commands.find((c) => c.name === "ticket.create")!,
      cli,
      { title: "外から" },
    );
    const second = client.run<{ id: string }[]>("ticket.list");
    release();
    await first;
    expect((await second).data.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(rescan).toHaveBeenCalled();
  });

  it("書き込みのあとの読みは、使い回さずに新しく再走査する。書き込みは毎回自分で再走査する", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA });
    await client.run("ticket.create", { title: "一" });
    await client.run("ticket.list");
    const rescan = vi.spyOn(Store.prototype, "rescan");
    await client.run("ticket.create", { title: "二" });
    expect(rescan.mock.calls.length).toBeGreaterThanOrEqual(1);
    rescan.mockClear();
    const [first, second] = await Promise.all([
      client.run<{ id: string }[]>("ticket.list"),
      client.run<{ id: string }[]>("ticket.list"),
    ]);
    expect(rescan).toHaveBeenCalledTimes(1);
    expect(first.data).toHaveLength(2);
    expect(second.data).toHaveLength(2);
  });

  it("同時に届いた読みの 1 本が失敗しても、他の結果は返り、失敗はその呼び出しの失敗になる", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA });
    await client.run("ticket.create", { title: "一" });
    const [missing, list] = await Promise.allSettled([
      client.run("ticket.show", { ticket: "t99" }),
      client.run<{ id: string }[]>("ticket.list"),
    ]);
    expect(missing.status).toBe("rejected");
    expect(toCommandFailure((missing as PromiseRejectedResult).reason)).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(list).toMatchObject({ status: "fulfilled", value: { data: [{ id: "t1" }] } });
  });

  it("再走査が失敗すると、その要求だけが失敗し、次の要求は自分で再走査する", async () => {
    const f = await initialized();
    const client = createLocalClient({ cwd: f.cloneA });
    await client.run("ticket.create", { title: "一" });
    vi.spyOn(Store.prototype, "rescan").mockRejectedValueOnce(new Error("走査に失敗"));
    await expect(client.run("ticket.list")).rejects.toThrow("走査に失敗");
    const cli = await openContext({ cwd: f.cloneA });
    await runCommand(
      commands.find((c) => c.name === "ticket.create")!,
      cli,
      { title: "外から" },
    );
    const list = await client.run<{ id: string }[]>("ticket.list");
    expect(list.data.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});
