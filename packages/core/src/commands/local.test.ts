import { afterEach, describe, expect, it } from "vitest";
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
    expect(await client.status()).toMatchObject({ ahead: 0, behind: 0, dirty: false, issues: 0 });
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
});
