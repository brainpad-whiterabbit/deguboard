// カンバンのデータを、コードとは別のリポジトリ（git.data_remote）に置く（t904）。コード用（origin）とデータ用の 2 つの bare リモートで試す

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDataRemote, git, type Fixture } from "../../test/helpers/git-fixture.js";
import { fixture, runCleanups } from "../../test/helpers/commands-context.js";
import { fastHook } from "../fast-hook.js";
import { checkOutside } from "../git/outside.js";
import { DATA_REMOTE_NAME, dataRemoteRef } from "../git/repo.js";
import { dropRebasedTip, fetchData } from "../git/sync.js";
import { Store } from "../storage/store.js";
import { openContext, openContextFor } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { hook, type HookView } from "./hook.js";
import { createLocalClient } from "./local.js";
import { commit, configSet, init, sync } from "./setup.js";
import { ticketClaim, ticketCreate, ticketList, ticketMove, ticketUpdate } from "./ticket.js";

afterEach(runCleanups);

const actor = { kind: "human" as const, user: "eiki" };

/** bare リモートのブランチの先端。なければ undefined */
async function tipOf(bare: string, branch: string): Promise<string | undefined> {
  const r = await git(bare, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]);
  return r.stdout.trim() || undefined;
}

const headOf = async (ctx: CommandContext) =>
  (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();

/** clone で、データのリモート name を指して init する（init の後の文脈を返す） */
async function initWith(cwd: string, dataRemote: string): Promise<CommandContext> {
  const first = await openContext({ cwd, initialize: { dataRemote }, actor });
  await runCommand(init, first, { template: "software-development", data_remote: dataRemote });
  return openContext({ cwd, actor });
}

/** clone A と B がデータのリモート data で init 済みの形 */
async function twoClones(): Promise<{
  f: Fixture;
  dataDir: string;
  a: CommandContext;
  b: CommandContext;
}> {
  const f = await fixture();
  const dataDir = await addDataRemote(f, [f.cloneA, f.cloneB]);
  const a = await initWith(f.cloneA, "data");
  const b = await initWith(f.cloneB, "data");
  return { f, dataDir, a, b };
}

describe("データを別のリポジトリに置く（git.data_remote）", () => {
  it("init・起票・claim・sync はデータをデータのリモートに送り、作業ブランチの起点と照合はコードのリモートを使う", async () => {
    const f = await fixture();
    const dataDir = await addDataRemote(f, [f.cloneA]);
    const first = await openContext({ cwd: f.cloneA, initialize: { dataRemote: "data" }, actor });
    const made = await runCommand(init, first, {
      template: "software-development",
      data_remote: "data",
    });
    expect(made.data).toMatchObject({ worktree: "orphan", remote: "origin", data_remote: "data" });
    expect(made.write).toMatchObject({ committed: true, pushed: true });
    expect(first.store.teamConfig.git).toMatchObject({ remote: "origin", data_remote: "data" });

    const ctx = await openContext({ cwd: f.cloneA, actor });
    expect(ctx.repo).toMatchObject({ codeRemote: "origin", dataRemote: "data" });
    const created = await runCommand(ticketCreate, ctx, { title: "A" });
    expect(created.write).toMatchObject({ pushed: true });
    // 作業ブランチの起点はコードのリモートの main。claim の push はデータのリモートへ
    const mainTip = await tipOf(f.remoteDir, "main");
    const claimed = await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "feat/t1-work" });
    expect(claimed.write).toMatchObject({ pushed: true });
    expect(claimed.data.branch_base).toBe(mainTip);
    expect(await tipOf(dataDir, "deguboard")).toBe(await headOf(ctx));
    expect(await tipOf(f.remoteDir, "deguboard")).toBeUndefined();

    // 作業ブランチをコードのリモートに push して main にマージすると、照合が done にし、結果をデータのリモートに送る
    const work = claimed.data.worktree!;
    await git(work, ["commit", "-q", "--allow-empty", "-m", "実装"]);
    await git(work, ["push", "-q", "origin", "feat/t1-work"]);
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "review" });
    await git(f.cloneA, ["merge", "-q", "--ff-only", "feat/t1-work"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "main が進む"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);
    const synced = await runCommand(sync, ctx, {});
    expect(synced.data.reconciled).toMatchObject([
      { id: "t1", from: "review", to: "done", when: ["branch_merged"] },
    ]);
    expect(synced.data).toMatchObject({ fetched: true, pushed: true });
    expect(synced.data.status).toMatchObject({ ahead: 0, behind: 0, remote: "data" });
    expect(await tipOf(dataDir, "deguboard")).toBe(await headOf(ctx));
    // データはコードのリモートに、作業ブランチはデータのリモートに入らない
    expect(await tipOf(f.remoteDir, "deguboard")).toBeUndefined();
    expect(await tipOf(dataDir, "feat/t1-work")).toBeUndefined();
    expect(await tipOf(dataDir, "main")).toBeUndefined();
  });

  it("init --data-remote に URL を渡すと、リモートを足して取り込み、config と違う名前はそのクローンの個人の設定に書く", async () => {
    const f = await fixture();
    const dataDir = await addDataRemote(f, [f.cloneA]);
    const a = await initWith(f.cloneA, "data");
    await runCommand(ticketCreate, a, { title: "A" });

    // clone B はデータのリモートを持たない。URL を渡すと dg がリモートを足して、そこから取り込む
    const first = await openContext({ cwd: f.cloneB, initialize: { dataRemote: dataDir }, actor });
    expect(first.worktree).toBe("from_remote");
    expect((await git(f.cloneB, ["remote", "get-url", DATA_REMOTE_NAME])).stdout.trim()).toBe(
      dataDir,
    );
    const joined = await runCommand(init, first, { data_remote: dataDir });
    expect(joined.data).toMatchObject({ created: [], data_remote: DATA_REMOTE_NAME });
    // チームの値（data）は書き換えず、このクローンの個人の設定で上書きする
    const b = await openContext({ cwd: f.cloneB, actor });
    expect(b.store.teamConfig.git.data_remote).toBe("data");
    expect(b.repo.dataRemote).toBe(DATA_REMOTE_NAME);
    expect([...b.store.tickets.keys()]).toEqual(["t1"]);
    expect((await runCommand(ticketCreate, b, { title: "B" })).write).toMatchObject({
      pushed: true,
    });
    await runCommand(sync, a, {});
    expect([...a.store.tickets.keys()].sort()).toEqual(["t1", "t2"]);

    // 同じ URL をもう一度渡しても、リモートを足し直さない。新しいボードは足した名前を config に書く
    const again = await openContext({ cwd: f.cloneB, initialize: { dataRemote: dataDir }, actor });
    expect(again.repo.dataRemote).toBe(DATA_REMOTE_NAME);
    const g = await fixture();
    const fresh = path.join(g.root, "fresh.git");
    await git(g.root, ["init", "--quiet", "--bare", fresh]);
    const started = await openContext({ cwd: g.cloneA, initialize: { dataRemote: fresh }, actor });
    await runCommand(init, started, { data_remote: fresh });
    expect(started.store.teamConfig.git.data_remote).toBe(DATA_REMOTE_NAME);
    expect(await tipOf(fresh, "deguboard")).toBe(await headOf(started));
    // ない名前は、黙って同期なしにせずエラーにする
    await expect(
      openContext({ cwd: g.cloneB, initialize: { dataRemote: "nowhere" }, actor }),
    ).rejects.toMatchObject({
      code: "DATA_REMOTE_MISSING",
      message: expect.stringContaining("git remote add nowhere"),
    });
  });

  it("設定したデータのリモートがクローンにないとき、push の要る操作はエラーで git remote add を案内し、読むだけの操作は警告で続く", async () => {
    const f = await fixture();
    await addDataRemote(f, [f.cloneA]);
    const a = await initWith(f.cloneA, "data");
    await runCommand(ticketCreate, a, { title: "A" });
    await git(f.cloneA, ["remote", "remove", "data"]);

    const ctx = await openContext({ cwd: f.cloneA, actor });
    expect(ctx.repo).toMatchObject({ codeRemote: "origin", dataRemote: null });
    const listed = await runCommand(ticketList, ctx, {});
    expect(listed.data.map((t) => t.id)).toEqual(["t1"]);
    expect(listed.warnings).toEqual([expect.stringContaining("git remote add data <URL")]);
    const missing = {
      code: "DATA_REMOTE_MISSING",
      message: expect.stringContaining("git remote add data <URL"),
    };
    const head = await headOf(ctx);
    await expect(runCommand(sync, ctx, {})).rejects.toMatchObject(missing);
    await expect(runCommand(ticketCreate, ctx, { title: "B" })).rejects.toMatchObject(missing);
    await expect(
      runCommand(ticketClaim, ctx, { ticket: "t1", no_worktree: true }),
    ).rejects.toMatchObject(missing);
    // 止めた操作は手元にも書かない
    expect(await headOf(ctx)).toBe(head);
    expect((await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
    // push しない操作（まとめ待ちの更新）は手元に書き、同期していないことを警告する。push する dg commit は止まる
    const updated = await runCommand(ticketUpdate, ctx, { ticket: "t1", priority: "high" });
    expect(updated.warnings).toEqual([expect.stringContaining("is not synced")]);
    await expect(runCommand(commit, ctx, {})).rejects.toMatchObject(missing);

    // リモートを足し直せば、そのまま送れる
    await git(f.cloneA, ["remote", "add", "data", path.join(f.root, "data.git")]);
    const back = await openContext({ cwd: f.cloneA, actor });
    const synced = await runCommand(sync, back, {});
    expect(synced.data).toMatchObject({ pushed: true });
    expect(synced.warnings.filter((w) => w.includes("data remote"))).toEqual([]);
  });

  /** A がデータを data から data2 へ移す：新しいリポジトリへ push → config の変更を元のリモートと新しいリモートの両方へ */
  async function moved() {
    const { f, dataDir, a, b } = await twoClones();
    await runCommand(ticketCreate, a, { title: "A" });
    await runCommand(sync, b, {});
    const newDir = path.join(f.root, "data2.git");
    await git(f.root, ["init", "--quiet", "--bare", newDir]);
    for (const clone of [f.cloneA, f.cloneB]) await git(clone, ["remote", "add", "data2", newDir]);
    await git(f.cloneA, ["push", "-q", "data2", "deguboard"]);
    // 設定の変更は commit.mode（既定は batch）によらずすぐコミットして、今の（元の）リモートへ push する
    const changed = await runCommand(configSet, a, { key: "git.data_remote", value: "data2" });
    expect(changed.write).toMatchObject({ committed: true, pushed: true });
    expect(await tipOf(dataDir, "deguboard")).toBe(await headOf(a));
    // 次のコマンドは新しいリモートを使い、設定の変更を新しいリモートにも送る
    const a2 = await openContext({ cwd: f.cloneA, actor });
    expect(a2.repo.dataRemote).toBe("data2");
    expect((await runCommand(sync, a2, {})).data).toMatchObject({ pushed: true });
    expect(await tipOf(newDir, "deguboard")).toBe(await headOf(a2));
    return { f, dataDir, newDir, a: a2, b };
  }

  it("取り込んだ config でデータのリモートが変わったら、書き込みは push せずに止めて再実行を案内し、再実行は新しいリモートへ送る", async () => {
    const { f, dataDir, newDir, b } = await moved();
    const oldTip = await tipOf(dataDir, "deguboard");
    const newTip = await tipOf(newDir, "deguboard");
    // B は元のリモートを使う文脈のまま起票する：元のリモートから設定の変更を取り込み、書かず・push せずに止まる
    await expect(runCommand(ticketCreate, b, { title: "B" })).rejects.toMatchObject({
      code: "DATA_REMOTE_CHANGED",
      message: expect.stringMatching(/changed the data remote to data2.*Run the command again/),
    });
    expect(await tipOf(dataDir, "deguboard")).toBe(oldTip);
    expect(await tipOf(newDir, "deguboard")).toBe(newTip);
    expect([...b.store.tickets.keys()]).toEqual(["t1"]);
    // もう一度の実行は新しいリモートを使う
    const b2 = await openContext({ cwd: f.cloneB, actor });
    expect(b2.repo.dataRemote).toBe("data2");
    const created = await runCommand(ticketCreate, b2, { title: "B" });
    expect(created.data.id).toBe("t2");
    expect(created.write).toMatchObject({ pushed: true });
    expect(await tipOf(newDir, "deguboard")).toBe(await headOf(b2));
    expect(await tipOf(dataDir, "deguboard")).toBe(oldTip);
  });

  it("sync も、取り込んだ config でデータのリモートが変わったら手元のコミットを push せずに止め、再実行で新しいリモートへ送る", async () => {
    const { f, dataDir, newDir, b } = await moved();
    const oldTip = await tipOf(dataDir, "deguboard");
    // B に未 push のコミットを作る（まとめ待ちの更新。sync がコミットして送ろうとする）
    await runCommand(ticketUpdate, b, { ticket: "t1", priority: "high" });
    await expect(runCommand(sync, b, {})).rejects.toMatchObject({ code: "DATA_REMOTE_CHANGED" });
    expect(await tipOf(dataDir, "deguboard")).toBe(oldTip);
    // 手元のコミットは残り、もう一度の実行が新しいリモートへ送る
    const b2 = await openContext({ cwd: f.cloneB, actor });
    const synced = await runCommand(sync, b2, {});
    expect(synced.data).toMatchObject({ pushed: true });
    expect(synced.data.status).toMatchObject({ ahead: 0, behind: 0, remote: "data2" });
    expect(await tipOf(newDir, "deguboard")).toBe(await headOf(b2));
    expect(b2.store.tickets.get("t1")?.data.priority).toBe("high");
    expect(await tipOf(dataDir, "deguboard")).toBe(oldTip);
  });

  it("プロセス内の CommandClient（画面・MCP）は、データのリモートが変わって止まった後の呼び出しで文脈を開き直す", async () => {
    const { f, newDir } = await moved();
    const client = createLocalClient({ cwd: f.cloneB, user: "eiki" });
    await expect(client.run("ticket.create", { title: "B" })).rejects.toMatchObject({
      code: "DATA_REMOTE_CHANGED",
    });
    const created = await client.run<{ id: string }>("ticket.create", { title: "B" });
    expect(created.write).toMatchObject({ pushed: true });
    expect((await tipOf(newDir, "deguboard")) !== undefined).toBe(true);
    expect((await client.status()).remote).toBe("data2");
  });

  it("push が拒否された後の取り込み直しでデータのリモートが変わったら、自分のコミットを捨てて止め、再実行で変更が二重に入らない", async () => {
    const { f, dataDir, a, b } = await twoClones();
    await runCommand(ticketCreate, a, { title: "A" });
    await runCommand(sync, b, {});
    const newDir = path.join(f.root, "data2.git");
    await git(f.root, ["init", "--quiet", "--bare", newDir]);
    for (const clone of [f.cloneA, f.cloneB]) await git(clone, ["remote", "add", "data2", newDir]);
    await git(f.cloneA, ["push", "-q", "data2", "deguboard"]);
    // B は書き込みのたびにコミットして push する（cas でない書き込みが push まで進む）
    await runCommand(configSet, b, { key: "commit.mode", value: "each", local: true });
    // B が自分の変更をコミットして push する直前に、A がデータを data2 へ移す（設定の変更を元のリモートと新しいリモートへ）
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await runCommand(configSet, a, { key: "git.data_remote", value: "data2" });
        await runCommand(sync, await openContext({ cwd: f.cloneA, actor }), {});
      },
    };
    const racer = await openContext({ cwd: f.cloneB, actor, hooks });
    const oldTip = async () => tipOf(dataDir, "deguboard");
    await expect(
      runCommand(ticketUpdate, racer, { ticket: "t1", priority: "high" }),
    ).rejects.toMatchObject({ code: "DATA_REMOTE_CHANGED" });
    // 自分のコミットは捨て、取り込んだ設定の変更は残る（手元は元のリモートの先端と同じ）
    expect(await headOf(racer)).toBe(await oldTip());
    expect(racer.store.tickets.get("t1")?.data.priority).not.toBe("high");
    expect(racer.store.config.git.data_remote).toBe("data2");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");

    // 案内どおりのもう一度の実行は新しいリモートへ送り、同じ変更のコミットは 1 つだけ
    const b2 = await openContext({ cwd: f.cloneB, actor });
    const updated = await runCommand(ticketUpdate, b2, { ticket: "t1", priority: "high" });
    expect(updated.write).toMatchObject({ committed: true, pushed: true });
    expect(await tipOf(newDir, "deguboard")).toBe(await headOf(b2));
    const subjects = (await git(b2.repo.dataDir, ["log", "--format=%s"])).stdout.split("\n");
    expect(subjects.filter((s) => s === subjects[0])).toHaveLength(1);
    expect(await oldTip()).not.toBe(await headOf(b2));
  });

  it("積み直しで自分のコミットが空になって落ちたとき、同じ秒・同じメッセージの前からの手元のコミットを捨てない", async () => {
    const { a, b } = await twoClones();
    await runCommand(ticketCreate, a, { title: "A" });
    await runCommand(sync, b, {});
    const dir = b.repo.dataDir;
    const base = await headOf(b);
    // 作者の時刻とメッセージが同じコミットを 2 つ作る（同じ操作を続けて実行した形）
    const twin = async (file: string, cwd = dir) => {
      await writeFile(path.join(cwd, file), `${file}\n`);
      await git(cwd, ["add", "--", file]);
      await git(cwd, ["commit", "-q", "--date=2026-01-01T00:00:00Z", "-m", "同じ操作"]);
    };
    // 2 つ目と同じ変更を、A がリモートへ送っておく（B の 2 つ目は積み直しで空になる）
    await twin("second.txt", a.repo.dataDir);
    await git(a.repo.dataDir, ["push", "-q", "data", "deguboard"]);
    await twin("first.txt");
    const first = await headOf(b);
    await twin("second.txt");
    const mine = await headOf(b);

    // 2 つとも残っていれば、先頭（自分のコミット）だけを捨てる
    expect(await headOf(b)).not.toBe(base);
    expect(await dropRebasedTip(b.repo, mine)).toBe(true);
    expect(await headOf(b)).toBe(first);
    // 自分のコミットが落ちたら、先頭に残った前からのコミットは捨てない
    await git(dir, ["reset", "-q", "--hard", mine]);
    expect((await fetchData(b.repo)).ok).toBe(true);
    await git(dir, ["rebase", "-q", "--no-keep-empty", dataRemoteRef(b.repo)]);
    const subjects = (await git(dir, ["log", "--format=%s", `${dataRemoteRef(b.repo)}..HEAD`]))
      .stdout;
    expect(subjects.trim()).toBe("同じ操作");
    const rebased = await headOf(b);
    expect(await dropRebasedTip(b.repo, mine)).toBe(false);
    expect(await headOf(b)).toBe(rebased);
    expect((await git(dir, ["show", "--format=", "--name-only", "HEAD"])).stdout.trim()).toBe(
      "first.txt",
    );
  });

  it("プロセス内の CommandClient は、データのリモートがなくて止まった後に git remote add すると、次の書き込みが push まで進む", async () => {
    const f = await fixture();
    const dataDir = await addDataRemote(f, [f.cloneA]);
    const a = await initWith(f.cloneA, "data");
    await runCommand(ticketCreate, a, { title: "A" });
    await git(f.cloneA, ["remote", "remove", "data"]);

    const client = createLocalClient({ cwd: f.cloneA, user: "eiki" });
    await expect(client.run("ticket.create", { title: "B" })).rejects.toMatchObject({
      code: "DATA_REMOTE_MISSING",
    });
    // git remote add は config を変えないので、リモートの名前の比較では開き直さない。エラーの後に開き直す
    await git(f.cloneA, ["remote", "add", "data", dataDir]);
    const created = await client.run<{ id: string }>("ticket.create", { title: "B" });
    expect(created.write).toMatchObject({ pushed: true });
    expect(created.warnings.filter((w) => w.includes("git remote add"))).toEqual([]);
    expect((await client.status()).remote).toBe("data");
    const tip = (await git(a.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    expect(await tipOf(dataDir, "deguboard")).toBe(tip);
  });

  it("プロセス内の CommandClient は、同じプロセスで git.data_remote を変えた後の書き込みと sync を新しいリモートへ送る（--local を含む）", async () => {
    const { f, dataDir } = await twoClones();
    const newDir = path.join(f.root, "data2.git");
    await git(f.root, ["init", "--quiet", "--bare", newDir]);
    await git(f.cloneA, ["remote", "add", "data2", newDir]);
    const client = createLocalClient({ cwd: f.cloneA, user: "eiki" });
    await client.run("ticket.create", { title: "A" });
    await git(f.cloneA, ["push", "-q", "data2", "deguboard"]);
    // チームの値の変更は、今の（元の）リモートへ push する
    const changed = await client.run("config.set", { key: "git.data_remote", value: "data2" });
    expect(changed.write).toMatchObject({ committed: true, pushed: true });
    const oldTip = await tipOf(dataDir, "deguboard");
    // 続く sync は設定の変更を新しいリモートへ送り、以後の書き込みも新しいリモートへ行く（元のリモートは進まない）
    expect((await client.run<{ pushed: boolean }>("sync", {})).data).toMatchObject({
      pushed: true,
    });
    expect((await client.status()).remote).toBe("data2");
    expect(await tipOf(newDir, "deguboard")).toBe(oldTip);
    expect((await client.run("ticket.create", { title: "B" })).write).toMatchObject({
      pushed: true,
    });
    expect(await tipOf(newDir, "deguboard")).not.toBe(oldTip);
    expect(await tipOf(dataDir, "deguboard")).toBe(oldTip);

    // 個人の設定（--local）で変えても、次の呼び出しから従う
    await client.run("config.set", { key: "git.data_remote", value: "data", local: true });
    expect((await client.status()).remote).toBe("data");
    await client.run("config.unset", { key: "git.data_remote", local: true });
    expect((await client.status()).remote).toBe("data2");
  });

  it("データのリモートから取り込んだコミットは、印がなくても dg の外の変更とみなさない（Stop のフックの今の経路と速い経路を含む）", async () => {
    const { f, a, b } = await twoClones();
    await runCommand(ticketCreate, a, { title: "A" });
    await runCommand(sync, b, {});
    // B のデータに印のないコミットを作って、データのリモートへ送る（書いたマシンの dg が確かめたもの）
    await git(b.repo.dataDir, ["commit", "-q", "--allow-empty", "-m", "印のないコミット"]);
    await git(b.repo.dataDir, ["push", "-q", "data", "deguboard"]);
    // A は基準を記録した後、dg を通さずにデータのリモートの先端へ進む（HEAD が基準から動く）
    expect(await checkOutside(a.repo)).toEqual({ kind: "clean", initial: false });
    await git(a.repo.dataDir, ["fetch", "-q", "data", "deguboard:refs/remotes/data/deguboard"]);
    await git(a.repo.dataDir, ["merge", "-q", "--ff-only", "refs/remotes/data/deguboard"]);
    expect(await checkOutside(a.repo)).toEqual({ kind: "clean", initial: false });
    // コードのリモートを見ていたら（データのリモートを分ける前の決め方）、同じコミットを外の変更と取り違える
    const byCode = await checkOutside({ ...a.repo, dataRemote: a.repo.codeRemote });
    expect(byCode.kind === "found" && byCode.changes.commits.map((c) => c.subject)).toEqual([
      "印のないコミット",
    ]);

    // Stop のフック：ストアを開かない今の経路と、速い経路。どちらも config のデータのリモートの名前を読む
    const stopInput = { event: "Stop", payload: { session_id: "s", stop_hook_active: false } };
    const openSpy = vi.spyOn(Store, "open");
    try {
      const light = await openContextFor(hook, stopInput, { cwd: f.cloneA, actor });
      expect(light.repo.dataRemote).toBe("data");
      expect(() => light.repo.codeRemote).toThrow("storeless");
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
    // 手元で作った印のないコミットは、今までどおり見つける
    await git(a.repo.dataDir, ["commit", "-q", "--allow-empty", "-m", "手元の外のコミット"]);
    const found = await fastHook({
      eventName: "Stop",
      cwd: f.cloneA,
      payload: stopInput.payload,
      env: {},
    });
    expect(found?.output).toContain("手元の外のコミット");
  });
});
