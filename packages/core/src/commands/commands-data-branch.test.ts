// データのブランチ名を設定で変える（git.data_branch、t905）。1 つのデータのリモートに、リポジトリごとのブランチでカンバンを並べる

import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDataRemote, git } from "../../test/helpers/git-fixture.js";
import { fixture, runCleanups } from "../../test/helpers/commands-context.js";
import { fastHook } from "../fast-hook.js";
import { checkOutside } from "../git/outside.js";
import { Store } from "../storage/store.js";
import { openContext, openContextFor } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { hook, type HookView } from "./hook.js";
import { createLocalClient } from "./local.js";
import { configSet, init, sync } from "./setup.js";
import { ticketCreate, ticketList, ticketUpdate } from "./ticket.js";

afterEach(runCleanups);

const actor = { kind: "human" as const, user: "eiki" };

/** bare リモートのブランチの先端。なければ undefined */
async function tipOf(bare: string, branch: string): Promise<string | undefined> {
  const r = await git(bare, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]);
  return r.stdout.trim() || undefined;
}

/** bare リモートのブランチの一覧 */
async function headsOf(bare: string): Promise<string[]> {
  const r = await git(bare, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return r.stdout.trim().split("\n").filter(Boolean).sort();
}

const headOf = async (ctx: CommandContext) =>
  (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();

const titlesOf = (ctx: CommandContext) =>
  [...ctx.store.tickets.values()].map((t) => `${t.data.id}:${t.data.title}`).sort();

/** clone で、データのリモート dataRemote のブランチ dataBranch を指して init する（init の後の文脈を返す） */
async function initWith(
  cwd: string,
  dataRemote: string,
  dataBranch: string,
): Promise<CommandContext> {
  const first = await openContext({ cwd, initialize: { dataRemote, dataBranch }, actor });
  await runCommand(init, first, {
    template: "software-development",
    data_remote: dataRemote,
    data_branch: dataBranch,
  });
  return openContext({ cwd, actor });
}

describe("データのブランチ名を変える（git.data_branch）", () => {
  it("init・起票・sync・外の変更の検出はそのブランチだけを使い、同じリモートのほかのデータのブランチを取り込まない", async () => {
    const f = await fixture();
    const dataDir = await addDataRemote(f, [f.cloneA, f.cloneB]);
    // 同じデータのリモートに、ほかのカンバン（既定の deguboard ブランチ）を先に置く
    const other = await initWith(f.cloneB, "data", "deguboard");
    await runCommand(ticketCreate, other, { title: "ほかのカンバン" });
    const otherTip = await tipOf(dataDir, "deguboard");

    const first = await openContext({
      cwd: f.cloneA,
      initialize: { dataRemote: "data", dataBranch: "deguboard-webapp" },
      actor,
    });
    // ほかのブランチがあっても、名指ししたブランチがなければ新しく始める
    expect(first.worktree).toBe("orphan");
    const made = await runCommand(init, first, {
      template: "software-development",
      data_remote: "data",
      data_branch: "deguboard-webapp",
    });
    expect(made.data).toMatchObject({ data_branch: "deguboard-webapp" });
    expect(made.write).toMatchObject({ committed: true, pushed: true });
    expect(first.store.teamConfig.git).toMatchObject({ data_branch: "deguboard-webapp" });

    const a = await openContext({ cwd: f.cloneA, actor });
    expect(a.repo).toMatchObject({ dataRemote: "data", dataBranch: "deguboard-webapp" });
    const created = await runCommand(ticketCreate, a, { title: "webapp の作業" });
    expect(created.data.id).toBe("t1");
    expect(created.write).toMatchObject({ pushed: true });
    const synced = await runCommand(sync, a, {});
    expect(synced.data).toMatchObject({ fetched: true });
    expect(synced.data.status).toMatchObject({ ahead: 0, behind: 0, remote: "data" });
    expect(await tipOf(dataDir, "deguboard-webapp")).toBe(await headOf(a));
    // ほかのブランチは進まず、取り込みもしない（追跡 ref も作らない）
    expect(await tipOf(dataDir, "deguboard")).toBe(otherTip);
    expect(titlesOf(a)).toEqual(["t1:webapp の作業"]);
    const tracked = await git(a.repo.dataDir, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes/data",
    ]);
    expect(tracked.stdout.trim()).toBe("refs/remotes/data/deguboard-webapp");
    // 手元の worktree のブランチは名前によらず deguboard で、上流はデータのブランチ
    const upstream = await git(a.repo.dataDir, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
    expect(upstream.stdout.trim()).toBe("data/deguboard-webapp");

    // 外の変更の検出：データのブランチから取り込んだ印のないコミットは外の変更とみなさない（今の経路・Stop の今の経路・速い経路）
    const g = await fixture();
    await git(g.cloneA, ["remote", "add", "data", dataDir]);
    const peer = await initWith(g.cloneA, "data", "deguboard-webapp");
    await git(peer.repo.dataDir, ["commit", "-q", "--allow-empty", "-m", "印のないコミット"]);
    await git(peer.repo.dataDir, ["push", "-q", "data", "deguboard:deguboard-webapp"]);
    expect(await checkOutside(a.repo)).toEqual({ kind: "clean", initial: false });
    await git(a.repo.dataDir, [
      "fetch",
      "-q",
      "data",
      "deguboard-webapp:refs/remotes/data/deguboard-webapp",
    ]);
    await git(a.repo.dataDir, ["merge", "-q", "--ff-only", "refs/remotes/data/deguboard-webapp"]);
    expect(await checkOutside(a.repo)).toEqual({ kind: "clean", initial: false });
    // 既定のブランチ名で見ていたら、同じコミットを外の変更と取り違える
    const byDefault = await checkOutside({ ...a.repo, dataBranch: "deguboard" });
    expect(byDefault.kind).toBe("found");
    const stopInput = { event: "Stop", payload: { session_id: "s", stop_hook_active: false } };
    const openSpy = vi.spyOn(Store, "open");
    try {
      const light = await openContextFor(hook, stopInput, { cwd: f.cloneA, actor });
      expect(light.repo.dataBranch).toBe("deguboard-webapp");
      expect(((await runCommand(hook, light, stopInput)).data as HookView).output).toBeUndefined();
      const fast = await fastHook({
        eventName: "Stop",
        cwd: f.cloneA,
        payload: stopInput.payload,
        env: {},
      });
      expect(fast).toMatchObject({ warnings: [] });
      expect(fast?.output).toBeUndefined();
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("コードのリモートにデータも置くとき、sync が全ブランチを取り込んでも、取り込むのは自分のデータのブランチだけ", async () => {
    const f = await fixture();
    const other = await initWith(f.cloneB, "origin", "deguboard");
    await runCommand(ticketCreate, other, { title: "ほかのカンバン" });
    const a = await initWith(f.cloneA, "origin", "deguboard-webapp");
    await runCommand(ticketCreate, a, { title: "webapp の作業" });
    await runCommand(ticketCreate, other, { title: "ほかのカンバン 2" });
    const synced = await runCommand(sync, a, {});
    expect(synced.data).toMatchObject({ fetched: true });
    expect(titlesOf(a)).toEqual(["t1:webapp の作業"]);
    expect(await tipOf(f.remoteDir, "deguboard-webapp")).toBe(await headOf(a));
    expect(await headsOf(f.remoteDir)).toEqual(["deguboard", "deguboard-webapp", "main"]);
  });

  it("1 つのデータのリモートに 2 つのコードのリポジトリが別々のブランチ名で init・起票・sync しても、カンバンは混ざらない", async () => {
    const web = await fixture();
    const api = await fixture();
    const dataDir = await addDataRemote(web, [web.cloneA, web.cloneB]);
    for (const clone of [api.cloneA, api.cloneB])
      await git(clone, ["remote", "add", "data", dataDir]);

    const webA = await initWith(web.cloneA, "data", "deguboard-webapp");
    const apiA = await initWith(api.cloneA, "data", "deguboard-api");
    await runCommand(ticketCreate, webA, { title: "画面を直す" });
    await runCommand(ticketCreate, apiA, { title: "API を足す" });
    await runCommand(ticketCreate, apiA, { title: "API の文書" });
    await runCommand(ticketCreate, webA, { title: "画面の文言" });
    // 2 人目のクローンも、同じブランチ名で init すると自分のリポジトリのカンバンだけを取り込む
    const webB = await initWith(web.cloneB, "data", "deguboard-webapp");
    const apiB = await initWith(api.cloneB, "data", "deguboard-api");
    await runCommand(ticketCreate, webB, { title: "画面の試験" });
    for (const ctx of [webA, apiA, webB, apiB]) await runCommand(sync, ctx, {});

    expect(titlesOf(webA)).toEqual(["t1:画面を直す", "t2:画面の文言", "t3:画面の試験"]);
    expect(titlesOf(webB)).toEqual(titlesOf(webA));
    expect(titlesOf(apiA)).toEqual(["t1:API を足す", "t2:API の文書"]);
    expect(titlesOf(apiB)).toEqual(titlesOf(apiA));
    expect(await headsOf(dataDir)).toEqual(["deguboard-api", "deguboard-webapp"]);
    expect(await tipOf(dataDir, "deguboard-webapp")).toBe(await headOf(webB));
    expect(await tipOf(dataDir, "deguboard-api")).toBe(await headOf(apiB));
    // コードのリモートにはデータが入らない
    expect(await headsOf(web.remoteDir)).toEqual(["main"]);
    expect(await headsOf(api.remoteDir)).toEqual(["main"]);
    const listed = await runCommand(ticketList, apiB, {});
    expect(listed.data.map((t) => t.title)).not.toContain("画面を直す");
  });

  it("/ を含むブランチ名は init でも config set でも、理由と勧める名前を出して拒む", async () => {
    const f = await fixture();
    await addDataRemote(f, [f.cloneA]);
    const rejected = {
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/contains "\/".*clashes.*such as deguboard-webapp/),
    };
    await expect(
      openContext({
        cwd: f.cloneA,
        initialize: { dataRemote: "data", dataBranch: "deguboard/webapp" },
        actor,
      }),
    ).rejects.toMatchObject(rejected);
    // 拒んだ init は何も作らない
    await expect(openContext({ cwd: f.cloneA, actor })).rejects.toMatchObject({
      code: "NOT_INITIALIZED",
    });
    await expect(
      openContext({ cwd: f.cloneA, initialize: { dataBranch: "-x" }, actor }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("deguboard-<name>"),
    });

    const a = await initWith(f.cloneA, "data", "deguboard-webapp");
    await expect(
      runCommand(configSet, a, { key: "git.data_branch", value: "deguboard/webapp" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      detail: expect.stringContaining("such as deguboard-webapp"),
    });
    expect(a.store.config.git.data_branch).toBe("deguboard-webapp");
  });

  it("init --data-branch で取り込んだ config が別のブランチ名を指すときは、そのクローンの個人の設定に書く", async () => {
    const f = await fixture();
    const dataDir = await addDataRemote(f, [f.cloneA, f.cloneB]);
    // 既定のブランチ名で始めたカンバンを、人が手で別のブランチ名へ写した（config はまだ既定のまま）
    const a = await initWith(f.cloneA, "data", "deguboard");
    await runCommand(ticketCreate, a, { title: "A" });
    await git(f.cloneA, ["push", "-q", "data", "deguboard:deguboard-webapp"]);
    const b = await initWith(f.cloneB, "data", "deguboard-webapp");
    expect(b.store.teamConfig.git.data_branch).toBe("deguboard");
    expect(b.repo.dataBranch).toBe("deguboard-webapp");
    expect(titlesOf(b)).toEqual(["t1:A"]);
    await runCommand(ticketCreate, b, { title: "B" });
    expect(await tipOf(dataDir, "deguboard-webapp")).toBe(await headOf(b));
    expect(await tipOf(dataDir, "deguboard")).toBe(await headOf(a));
  });

  /** A がデータのブランチを deguboard から deguboard-webapp へ移す：設定の変更を元のブランチへ、続く sync で新しいブランチへ */
  async function moved() {
    const f = await fixture();
    const dataDir = await addDataRemote(f, [f.cloneA, f.cloneB]);
    const a = await initWith(f.cloneA, "data", "deguboard");
    const b = await initWith(f.cloneB, "data", "deguboard");
    await runCommand(ticketCreate, a, { title: "A" });
    await runCommand(sync, b, {});
    // 設定の変更は commit.mode（既定は batch）によらずすぐコミットして、今の（元の）ブランチへ push する
    const changed = await runCommand(configSet, a, {
      key: "git.data_branch",
      value: "deguboard-webapp",
    });
    expect(changed.write).toMatchObject({ committed: true, pushed: true });
    expect(await tipOf(dataDir, "deguboard")).toBe(await headOf(a));
    // 次のコマンドは新しいブランチを使い、まだないブランチを作って送る
    const a2 = await openContext({ cwd: f.cloneA, actor });
    expect(a2.repo.dataBranch).toBe("deguboard-webapp");
    expect((await runCommand(sync, a2, {})).data).toMatchObject({ pushed: true });
    expect(await tipOf(dataDir, "deguboard-webapp")).toBe(await headOf(a2));
    return { f, dataDir, a: a2, b };
  }

  it("取り込んだ config でデータのブランチ名が変わったら、書き込みは push せずに止めて再実行を案内し、再実行は新しいブランチへ送る", async () => {
    const { f, dataDir, b } = await moved();
    const oldTip = await tipOf(dataDir, "deguboard");
    const newTip = await tipOf(dataDir, "deguboard-webapp");
    await expect(runCommand(ticketCreate, b, { title: "B" })).rejects.toMatchObject({
      code: "DATA_REMOTE_CHANGED",
      message: expect.stringMatching(
        /changed the data branch to data\/deguboard-webapp.*nothing was pushed to data\/deguboard.*Run the command again/,
      ),
    });
    expect(await tipOf(dataDir, "deguboard")).toBe(oldTip);
    expect(await tipOf(dataDir, "deguboard-webapp")).toBe(newTip);
    expect(titlesOf(b)).toEqual(["t1:A"]);
    // もう一度の実行は新しいブランチを使う
    const b2 = await openContext({ cwd: f.cloneB, actor });
    expect(b2.repo.dataBranch).toBe("deguboard-webapp");
    const created = await runCommand(ticketCreate, b2, { title: "B" });
    expect(created.data.id).toBe("t2");
    expect(created.write).toMatchObject({ pushed: true });
    expect(await tipOf(dataDir, "deguboard-webapp")).toBe(await headOf(b2));
    expect(await tipOf(dataDir, "deguboard")).toBe(oldTip);
  });

  it("sync も、取り込んだ config でデータのブランチ名が変わったら手元のコミットを push せずに止め、再実行で新しいブランチへ送る", async () => {
    const { f, dataDir, b } = await moved();
    const oldTip = await tipOf(dataDir, "deguboard");
    await runCommand(ticketUpdate, b, { ticket: "t1", priority: "high" });
    await expect(runCommand(sync, b, {})).rejects.toMatchObject({ code: "DATA_REMOTE_CHANGED" });
    expect(await tipOf(dataDir, "deguboard")).toBe(oldTip);
    const b2 = await openContext({ cwd: f.cloneB, actor });
    const synced = await runCommand(sync, b2, {});
    expect(synced.data).toMatchObject({ pushed: true });
    expect(synced.data.status).toMatchObject({ ahead: 0, behind: 0 });
    expect(await tipOf(dataDir, "deguboard-webapp")).toBe(await headOf(b2));
    expect(b2.store.tickets.get("t1")?.data.priority).toBe("high");
    expect(await tipOf(dataDir, "deguboard")).toBe(oldTip);
  });

  it("1 回の取り込みでデータのリモートとブランチ名の両方が変わっても、取り込んだ config で止まる", async () => {
    const f = await fixture();
    const dataDir = await addDataRemote(f, [f.cloneA, f.cloneB]);
    const a = await initWith(f.cloneA, "origin", "deguboard");
    const b = await initWith(f.cloneB, "origin", "deguboard");
    await runCommand(ticketCreate, a, { title: "A" });
    await runCommand(sync, b, {});
    await git(f.cloneA, ["push", "-q", "data", "deguboard:deguboard-webapp"]);
    // A の同じ文脈（元の置き場所のまま）で 2 つの値を変え、どちらも元のブランチへ push する（B は 1 回の取り込みで両方を受ける）
    await runCommand(configSet, a, { key: "git.data_remote", value: "data" });
    await runCommand(configSet, a, { key: "git.data_branch", value: "deguboard-webapp" });
    await expect(runCommand(ticketCreate, b, { title: "B" })).rejects.toMatchObject({
      code: "DATA_REMOTE_CHANGED",
      message: expect.stringContaining(
        "changed the data remote and the data branch to data/deguboard-webapp",
      ),
    });
    const b2 = await openContext({ cwd: f.cloneB, actor });
    expect(b2.repo).toMatchObject({ dataRemote: "data", dataBranch: "deguboard-webapp" });
    expect((await runCommand(ticketCreate, b2, { title: "B" })).write).toMatchObject({
      pushed: true,
    });
    expect(await tipOf(dataDir, "deguboard-webapp")).toBe(await headOf(b2));
  });

  it("プロセス内の CommandClient（画面・MCP）は、データのブランチ名が変わった後の呼び出しで文脈を開き直す", async () => {
    const { f, dataDir } = await moved();
    const client = createLocalClient({ cwd: f.cloneB, user: "eiki" });
    await expect(client.run("ticket.create", { title: "B" })).rejects.toMatchObject({
      code: "DATA_REMOTE_CHANGED",
    });
    const created = await client.run<{ id: string }>("ticket.create", { title: "B" });
    expect(created.write).toMatchObject({ pushed: true });
    // 同じプロセスの config set でブランチ名を変えても、次の呼び出しから従う（--local を含む）
    const before = await tipOf(dataDir, "deguboard-webapp");
    await client.run("config.set", { key: "git.data_branch", value: "deguboard-x", local: true });
    expect((await client.run("ticket.create", { title: "C" })).write).toMatchObject({
      pushed: true,
    });
    expect(await tipOf(dataDir, "deguboard-webapp")).toBe(before);
    expect(await tipOf(dataDir, "deguboard-x")).toBeDefined();
  });
});

describe("データのリモートやブランチが別のカンバンの履歴を指す（DATA_HISTORY_UNRELATED）", () => {
  /**
   * B が共有のデータのリポジトリの既定のブランチ（data/deguboard）に別のカンバンを置き、A はコードのリモートに自分のカンバンを持つ。
   * A が git.data_remote を data に変えると、A のカンバンは共通の祖先のない B のカンバンのブランチを指す
   */
  async function pointedAtOther() {
    const f = await fixture();
    const dataDir = await addDataRemote(f, [f.cloneA, f.cloneB]);
    // orphan の根は作者と秒が同じだと同じ SHA になり、共通の祖先になる。別の人が作ったカンバンにして、根を必ず別にする
    await git(f.cloneA, ["config", "user.name", "別の人"]);
    const other = await initWith(f.cloneB, "data", "deguboard");
    await runCommand(ticketCreate, other, { title: "ほかのカンバン" });
    const first = await initWith(f.cloneA, "origin", "deguboard");
    await runCommand(ticketCreate, first, { title: "自分のカンバン" });
    await runCommand(configSet, first, { key: "git.data_remote", value: "data" });
    const a = await openContext({ cwd: f.cloneA, actor });
    expect(a.repo).toMatchObject({ dataRemote: "data", dataBranch: "deguboard" });
    return { f, dataDir, a, otherTip: await tipOf(dataDir, "deguboard") };
  }

  const unrelated = {
    code: "DATA_HISTORY_UNRELATED",
    message: expect.stringMatching(
      /data\/deguboard share no history, and both hold data.*another kanban.*Nothing was taken in or pushed.*dg init --data-branch <branch> \(for example deguboard-<repository>.*git\.data_branch <branch>.*dg guide overview/,
    ),
  };

  /** rebase を始めていない（途中の rebase も、dg の置く印もない）ことと、手元が動いていないこと */
  async function expectUntouched(ctx: CommandContext, head: string) {
    expect(await headOf(ctx)).toBe(head);
    const status = await git(ctx.repo.dataDir, ["status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      const p = (await git(ctx.repo.dataDir, ["rev-parse", "--git-path", dir])).stdout.trim();
      expect(existsSync(path.resolve(ctx.repo.dataDir, p))).toBe(false);
    }
    expect(titlesOf(ctx)).toEqual(["t1:自分のカンバン"]);
  }

  it("sync と書き込みは rebase を始めずに専用のエラーで止まり、案内どおり dg init --data-branch で自分のブランチに分けると送れる", async () => {
    const { f, dataDir, a, otherTip } = await pointedAtOther();
    const head = await headOf(a);

    await expect(runCommand(sync, a, {})).rejects.toMatchObject(unrelated);
    await expectUntouched(a, head);
    await expect(runCommand(sync, a, { resolve: "local" })).rejects.toMatchObject(unrelated);
    await expectUntouched(a, head);
    // 即時の書き込み（起票）も、変更を書く前に止まる
    await expect(runCommand(ticketCreate, a, { title: "止まる" })).rejects.toMatchObject(unrelated);
    await expectUntouched(a, head);
    expect(await tipOf(dataDir, "deguboard")).toBe(otherTip);

    // 戻し方：このクローンを自分のブランチに向け、sync で送り、チームの config に書く
    const a2 = await initWith(f.cloneA, "data", "deguboard-webapp");
    expect(a2.repo).toMatchObject({ dataRemote: "data", dataBranch: "deguboard-webapp" });
    const synced = await runCommand(sync, a2, {});
    expect(synced.data).toMatchObject({ pushed: true });
    const set = await runCommand(configSet, a2, {
      key: "git.data_branch",
      value: "deguboard-webapp",
    });
    expect(set.write).toMatchObject({ pushed: true });
    expect(await tipOf(dataDir, "deguboard-webapp")).toBe(await headOf(a2));
    expect(a2.store.teamConfig.git).toMatchObject({ data_branch: "deguboard-webapp" });
    expect(titlesOf(a2)).toEqual(["t1:自分のカンバン"]);
    // 別のカンバンのブランチは動かない
    expect(await tipOf(dataDir, "deguboard")).toBe(otherTip);
  });

  it("最初の取り込みの後に別のカンバンがデータのブランチを作って push が拒まれたら、自分のコミットを捨ててから専用のエラーで止まる", async () => {
    const f = await fixture();
    const dataDir = await addDataRemote(f, [f.cloneA, f.cloneB]);
    await git(f.cloneA, ["config", "user.name", "別の人"]);
    const first = await initWith(f.cloneA, "origin", "deguboard");
    await runCommand(ticketCreate, first, { title: "自分のカンバン" });
    // CAS でない書き込み（自分のコミットを残したまま取り込み直す経路）をすぐコミットして push させる
    await runCommand(configSet, first, { key: "commit.mode", value: "each", local: true });
    await runCommand(configSet, first, { key: "git.data_remote", value: "data" });
    // A が自分の変更をコミットして push する直前に、B がまだなかった data/deguboard に別のカンバンを置く
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        const other = await initWith(f.cloneB, "data", "deguboard");
        await runCommand(ticketCreate, other, { title: "ほかのカンバン" });
      },
    };
    const racer = await openContext({ cwd: f.cloneA, actor, hooks });
    expect(racer.repo).toMatchObject({ dataRemote: "data", dataBranch: "deguboard" });
    expect(await tipOf(dataDir, "deguboard")).toBeUndefined();
    const head = await headOf(racer);

    await expect(
      runCommand(ticketUpdate, racer, { ticket: "t1", priority: "high" }),
    ).rejects.toMatchObject(unrelated);
    // 変更は書かれていない（残ると、戻した後のもう一度の実行が同じ変更を二重に入れる）
    await expectUntouched(racer, head);
    expect(racer.store.tickets.get("t1")?.data.priority).not.toBe("high");
    const otherTip = await tipOf(dataDir, "deguboard");
    expect(otherTip).toBeDefined();
    expect(otherTip).not.toBe(head);
  });

  it("手元が作ったばかりで空（orphan の根だけ）のときは止めず、今までどおりリモートのカンバンを取り込む", async () => {
    const f = await fixture();
    await addDataRemote(f, [f.cloneA, f.cloneB]);
    await git(f.cloneA, ["config", "user.name", "別の人"]);
    // A は data/deguboard がまだないうちに手元のブランチ（空の根）を作る。その後に B が同じブランチへカンバンを置く
    const first = await openContext({
      cwd: f.cloneA,
      initialize: { dataRemote: "data", dataBranch: "deguboard" },
      actor,
    });
    expect(first.worktree).toBe("orphan");
    const other = await initWith(f.cloneB, "data", "deguboard");
    await runCommand(ticketCreate, other, { title: "先にあるカンバン" });
    await runCommand(init, first, { template: "software-development", data_remote: "data" });
    const a = await openContext({ cwd: f.cloneA, actor });
    await runCommand(sync, a, {});
    expect(titlesOf(a)).toEqual(["t1:先にあるカンバン"]);
    expect(await headOf(a)).toBe(await headOf(other));
  });
});
