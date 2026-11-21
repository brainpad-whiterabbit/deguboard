// コードのリモートがあっても、カンバンのデータを手元だけに置く（git.data_remote: none・dg init --no-data-remote。t1206）。
// 判定の組み合わせは data-remote-none.test.ts が網羅し、ここは git を通す経路の代表を bare リモート付きの一時リポジトリで確かめる

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addDataRemote, git, type Fixture } from "../../test/helpers/git-fixture.js";
import {
  fixture,
  initializedBothFixture,
  openForInit,
  reopenInitialized,
  runCleanups,
} from "../../test/helpers/commands-context.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { iterationCreate, iterationStart } from "./iteration.js";
import { createLocalClient } from "./local.js";
import { configSet, configUnset, init, sync } from "./setup.js";
import { ticketClaim, ticketCreate, ticketMove, ticketUpdate } from "./ticket.js";

afterEach(runCleanups);

const actor = { kind: "human" as const, user: "eiki" };

/** bare リモートのブランチの先端。なければ undefined */
async function tipOf(bare: string, branch: string): Promise<string | undefined> {
  const r = await git(bare, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]);
  return r.stdout.trim() || undefined;
}

const headOf = async (ctx: CommandContext) =>
  (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();

const clean = async (ctx: CommandContext) =>
  (await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout;

/** init の知らせ。openForInit が init の前に置いた土台の Workflow（まとめ待ち）を先にコミットした知らせは、テストの準備の分なので除く */
const notesOf = (warnings: string[]) =>
  warnings.filter((w) => w !== "Committed the pending changes first");

/** clone で dg init --no-data-remote し、init の結果と、その後の文脈を返す */
async function initLocalOnly(cwd: string) {
  const first = await openForInit({ cwd, initialize: { noDataRemote: true }, actor });
  const made = await runCommand(init, first, { no_data_remote: true });
  return { first, made, ctx: await openContext({ cwd, actor }) };
}

/** チームの config の git.data_remote を none にしたコミットを、dg を通さずに origin へ push する（手で書かれた値。dg config set は共有しているボードで拒む） */
async function pushTeamNone(ctx: CommandContext): Promise<void> {
  await ctx.store.writeConfig({ git: { ...ctx.store.teamConfig.git, data_remote: "none" } });
  await git(ctx.repo.dataDir, ["add", "-A"]);
  await git(ctx.repo.dataDir, ["commit", "-q", "-m", "データのリモートをなしにする（手で）"]);
  await git(ctx.repo.dataDir, ["push", "-q", "origin", "deguboard:deguboard"]);
}

describe("データを手元だけに置く（git.data_remote: none）", () => {
  it("init --no-data-remote の後、起票・claim・iteration start はローカルにコミットして成功し、データは fetch も push もされず、作業ブランチの照合はコードのリモートで動く", async () => {
    const f = await fixture();
    const { first, made, ctx } = await initLocalOnly(f.cloneA);
    expect(made.data).toMatchObject({ worktree: "orphan", remote: "origin", data_remote: null });
    expect(made.write).toMatchObject({ committed: true, pushed: false });
    expect(first.store.teamConfig.git).toMatchObject({ remote: "origin", data_remote: "none" });
    // 出力：人の git push --all・--mirror では出ることと、共有に戻す方法
    expect(notesOf(made.warnings)).toEqual([
      expect.stringMatching(
        /git push --all and git push --mirror still send.*dg config set git\.data_remote "".*then dg sync/,
      ),
    ]);
    expect(await tipOf(f.remoteDir, "deguboard")).toBeUndefined();

    expect(ctx.repo).toMatchObject({ codeRemote: "origin", dataRemote: null });
    const created = await runCommand(ticketCreate, ctx, { title: "A" });
    expect(created.write).toMatchObject({ committed: true, pushed: false, provisional: false });
    expect(created.warnings).toEqual([]);
    await runCommand(iterationCreate, ctx, { name: "S1" });
    const started = await runCommand(iterationStart, ctx, { iteration: "s1" });
    expect(started.write).toMatchObject({ committed: true, pushed: false });
    // 作業ブランチの起点はコードのリモートの main
    const mainTip = await tipOf(f.remoteDir, "main");
    const claimed = await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "t1-work" });
    expect(claimed.write).toMatchObject({ committed: true, pushed: false });
    expect(claimed.data.branch_base).toBe(mainTip);
    expect(await tipOf(f.remoteDir, "deguboard")).toBeUndefined();

    // コードのリモートに、別のカンバンのデータのブランチが現れる（ほかの clone が既定のまま init した）。
    // sync はコードのリモートの全ブランチを取り込むが、データとしては取り込まず（履歴の違いでも止まらず）、push もしない
    // orphan の根は作者と秒が同じだと同じ SHA になり、共通の祖先になる。別の人が作ったカンバンにして、根を必ず別にする
    await git(f.cloneB, ["config", "user.name", "別の人"]);
    const other = await openForInit({ cwd: f.cloneB, initialize: {}, actor });
    await runCommand(init, other, {});
    const otherTip = await tipOf(f.remoteDir, "deguboard");
    expect(otherTip).toBe(await headOf(other));

    // 作業ブランチをコードのリモートに push して main にマージすると、照合が done にする（結果は手元にだけコミットする）
    const work = claimed.data.worktree!;
    await git(work, ["commit", "-q", "--allow-empty", "-m", "実装"]);
    await git(work, ["push", "-q", "origin", "t1-work"]);
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "review" });
    await git(f.cloneA, ["merge", "-q", "--ff-only", "t1-work"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "main が進む"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);
    const before = await headOf(ctx);
    const synced = await runCommand(sync, ctx, {});
    expect(synced.data.reconciled).toMatchObject([
      { id: "t1", from: "review", to: "done", when: ["branch_merged"] },
    ]);
    expect(synced.data).toMatchObject({ integrated: false, pushed: false, conflicts: [] });
    expect(synced.data.status).toMatchObject({ remote: null });
    expect(synced.warnings.filter((w) => /data remote|Cannot/.test(w))).toEqual([]);
    // 手元は自分のコミット（まとめ待ちの review と照合）だけ進み、コードのリモートのデータのブランチ（別のカンバン）は履歴に入らず、元のまま
    const added = (await git(ctx.repo.dataDir, ["log", "--format=%s", `${before}..HEAD`])).stdout;
    expect(added.trim().split("\n")).toHaveLength(2);
    expect(added).toMatch(/^Reconcile t1: review → done/);
    expect(await tipOf(f.remoteDir, "deguboard")).toBe(otherTip);
    expect([...ctx.store.tickets.keys()]).toEqual(["t1"]);

    // リモートに別のボードがあるのに none で始めたボードは、共有に戻すと別のカンバンの履歴として止まる
    await runCommand(configSet, ctx, { key: "git.data_remote", value: "" });
    const shared = await openContext({ cwd: f.cloneA, actor });
    expect(shared.repo.dataRemote).toBe("origin");
    await expect(runCommand(sync, shared, {})).rejects.toMatchObject({
      code: "DATA_HISTORY_UNRELATED",
    });
    expect(await tipOf(f.remoteDir, "deguboard")).toBe(otherTip);
  });

  it("init --no-data-remote は、データのリモートに届くかを確かめずに手元にボードを作る（届かなければ、付けない init は止まる）", async () => {
    const f = await fixture();
    await git(f.cloneA, ["remote", "set-url", "origin", path.join(f.root, "nonexistent.git")]);
    await expect(openContext({ cwd: f.cloneA, initialize: {}, actor })).rejects.toMatchObject({
      code: "GIT_ERROR",
    });
    const { made, ctx } = await initLocalOnly(f.cloneA);
    expect(made.data).toMatchObject({ worktree: "orphan", data_remote: null });
    expect(ctx.store.teamConfig.git.data_remote).toBe("none");
    expect((await runCommand(ticketCreate, ctx, { title: "A" })).write).toMatchObject({
      committed: true,
      pushed: false,
    });
    // --data-remote との併用は、何も作る前に止める
    const g = await fixture();
    await expect(
      openContext({
        cwd: g.cloneA,
        initialize: { noDataRemote: true, dataRemote: "origin" },
        actor,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await git(g.cloneA, ["branch", "--list", "deguboard"])).stdout).toBe("");
  });

  it("付けない init が新しいボードをリモートへ push したら、読める人と --no-data-remote を伝える。push したブランチを消せば、チームの値を none にでき、その変更は push しない", async () => {
    const f = await fixture();
    const first = await openForInit({ cwd: f.cloneA, initialize: {}, actor });
    const made = await runCommand(init, first, {});
    expect(made.write).toMatchObject({ committed: true, pushed: true });
    expect(notesOf(made.warnings)).toEqual([
      expect.stringMatching(
        /pushed to origin\/deguboard: anyone who can read origin can read.*dg init --no-data-remote/,
      ),
    ]);
    // 取り込んだ 2 人目の clone と、2 回目の init には出さない
    const second = await openForInit({ cwd: f.cloneB, initialize: {}, actor });
    expect((await runCommand(init, second, {})).warnings).toEqual([]);
    const again = await openContext({ cwd: f.cloneA, initialize: {}, actor });
    expect((await runCommand(init, again, {})).warnings).toEqual([]);

    // 案内どおり：リモートのブランチを消してから none にする
    await git(f.cloneA, ["push", "-q", "origin", "--delete", "deguboard"]);
    const ctx = await openContext({ cwd: f.cloneA, actor });
    const changed = await runCommand(configSet, ctx, { key: "git.data_remote", value: "none" });
    expect(changed.write).toMatchObject({ committed: true, pushed: false });
    expect(changed.warnings).toEqual([expect.stringContaining("git push --all")]);
    expect(await tipOf(f.remoteDir, "deguboard")).toBeUndefined();
    const local = await openContext({ cwd: f.cloneA, actor });
    expect(local.repo.dataRemote).toBeNull();
    expect((await runCommand(ticketCreate, local, { title: "A" })).write).toMatchObject({
      committed: true,
      pushed: false,
    });
    expect(await tipOf(f.remoteDir, "deguboard")).toBeUndefined();
  });

  it("none を名前に、次に空に戻して dg sync すると、それまでのデータの履歴がそのリモートに push される", async () => {
    const f = await fixture();
    const dataDir = await addDataRemote(f, [f.cloneA]);
    const { ctx } = await initLocalOnly(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    const history = async (dir: string, rev: string) =>
      (await git(dir, ["log", "--format=%H", rev])).stdout;

    // リモートの名前に戻す：設定の変更は手元にコミットし（まだデータのリモートがない）、次の sync が丸ごと送る
    const named = await runCommand(configSet, ctx, { key: "git.data_remote", value: "data" });
    expect(named.write).toMatchObject({ committed: true, pushed: false });
    const toData = await openContext({ cwd: f.cloneA, actor });
    expect(toData.repo.dataRemote).toBe("data");
    const first = await runCommand(sync, toData, {});
    expect(first.data).toMatchObject({ pushed: true });
    expect(first.data.status).toMatchObject({ ahead: 0, behind: 0, remote: "data" });
    expect(await history(dataDir, "deguboard")).toBe(await history(toData.repo.dataDir, "HEAD"));
    expect(await tipOf(f.remoteDir, "deguboard")).toBeUndefined();

    // 空（コードのリモート）に戻す
    await runCommand(configSet, toData, { key: "git.data_remote", value: "" });
    const toOrigin = await openContext({ cwd: f.cloneA, actor });
    expect(toOrigin.repo.dataRemote).toBe("origin");
    const second = await runCommand(sync, toOrigin, {});
    expect(second.data).toMatchObject({ pushed: true });
    expect(await history(f.remoteDir, "deguboard")).toBe(
      await history(toOrigin.repo.dataDir, "HEAD"),
    );
    // 起票した 2 件の履歴が含まれる
    expect((await git(f.remoteDir, ["ls-tree", "-r", "--name-only", "deguboard"])).stdout).toMatch(
      /tickets\/t1\.md[\s\S]*tickets\/t2\.md/,
    );
  });
});

describe("共有しているボード（データのブランチがデータのリモートにある）での none", () => {
  async function shared(): Promise<{ f: Fixture; a: CommandContext; b: CommandContext }> {
    const f = await initializedBothFixture();
    const a = await reopenInitialized(f);
    const b = await reopenInitialized(f, { cwd: f.cloneB });
    await runCommand(ticketCreate, a, { title: "A" });
    await runCommand(sync, b, {});
    return { f, a, b };
  }

  it("チームの値を none にする config set は拒んで --local を案内し、何もコミットしない。--local は通して警告し、リモートのデータのブランチは消えない", async () => {
    const { f, a, b } = await shared();
    const tip = await tipOf(f.remoteDir, "deguboard");
    const head = await headOf(a);
    await expect(
      runCommand(configSet, a, { key: "git.data_remote", value: "none" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("origin/deguboard"),
      detail: expect.stringContaining("dg config set git.data_remote none --local"),
    });
    expect(await headOf(a)).toBe(head);
    expect(await clean(a)).toBe("");
    expect(a.store.teamConfig.git.data_remote).toBe("");
    expect(await tipOf(f.remoteDir, "deguboard")).toBe(tip);

    // B だけ個人の設定でなしにする
    const left = await runCommand(configSet, b, {
      key: "git.data_remote",
      value: "none",
      local: true,
    });
    expect(left.warnings.join("\n")).toMatch(
      /does not keep the others from claiming the same ticket[\s\S]*dg config unset git\.data_remote --local, then dg sync/,
    );
    const alone = await openContext({ cwd: f.cloneB, actor });
    expect(alone.repo).toMatchObject({ codeRemote: "origin", dataRemote: null });
    expect(alone.store.teamConfig.git.data_remote).toBe("");
    // 警告のとおり、B の claim は A を排他しない：同じチケットを両方が取れる
    const mine = await runCommand(ticketClaim, alone, { ticket: "t1", no_worktree: true });
    expect(mine.write).toMatchObject({ committed: true, pushed: false });
    expect(await tipOf(f.remoteDir, "deguboard")).toBe(tip);
    const theirs = await runCommand(ticketClaim, a, { ticket: "t1", no_worktree: true });
    expect(theirs.write).toMatchObject({ pushed: true });
    // なしのままもう一度 --local で none にしても、チームのボードから離れていることを警告する
    const repeated = await runCommand(configSet, alone, {
      key: "git.data_remote",
      value: "none",
      local: true,
    });
    expect(repeated.warnings.join("\n")).toMatch(/does not keep the others from claiming/);
  });

  it("--local の none を消して dg sync すると、その間に手元でコミットした履歴がリモートに push される", async () => {
    const { f, b } = await shared();
    await runCommand(configSet, b, { key: "git.data_remote", value: "none", local: true });
    const alone = await openContext({ cwd: f.cloneB, actor });
    await runCommand(ticketUpdate, alone, { ticket: "t1", priority: "high" });
    const offline = await runCommand(sync, alone, {});
    expect(offline.data).toMatchObject({ pushed: false });
    expect(offline.data.status).toMatchObject({ remote: null });
    const tip = await tipOf(f.remoteDir, "deguboard");
    expect(tip).not.toBe(await headOf(alone));

    await runCommand(configUnset, alone, { key: "git.data_remote", local: true });
    const back = await openContext({ cwd: f.cloneB, actor });
    expect(back.repo.dataRemote).toBe("origin");
    const synced = await runCommand(sync, back, {});
    expect(synced.data).toMatchObject({ pushed: true });
    expect(synced.data.status).toMatchObject({ ahead: 0, behind: 0, remote: "origin" });
    expect(await tipOf(f.remoteDir, "deguboard")).toBe(await headOf(back));
  });

  it("プロセス内の CommandClient（画面・MCP）は、--local で none にした後の書き込みを push せず、同期の状態にリモートを出さない", async () => {
    const { f } = await shared();
    const tip = await tipOf(f.remoteDir, "deguboard");
    const client = createLocalClient({ cwd: f.cloneB, user: "eiki" });
    expect((await client.status()).remote).toBe("origin");
    await client.run("config.set", { key: "git.data_remote", value: "none", local: true });
    const created = await client.run<{ id: string }>("ticket.create", { title: "B" });
    expect(created.write).toMatchObject({ committed: true, pushed: false });
    expect((await client.status()).remote).toBeNull();
    expect(await tipOf(f.remoteDir, "deguboard")).toBe(tip);
  });

  it("取り込んだ config がデータのリモートをなしにしていたら、書き込みは書かず・push せずに止まり、もう一度の実行は手元にだけ書く", async () => {
    const { f, a, b } = await shared();
    await pushTeamNone(a);
    const tip = await tipOf(f.remoteDir, "deguboard");
    await expect(runCommand(ticketCreate, b, { title: "B" })).rejects.toMatchObject({
      code: "DATA_REMOTE_CHANGED",
      message: expect.stringMatching(/turned the data remote off.*Run the command again/),
    });
    // 取り込んだ設定の変更だけが手元にあり、自分のコミットはない
    expect(await headOf(b)).toBe(tip);
    expect(await clean(b)).toBe("");
    expect([...b.store.tickets.keys()]).toEqual(["t1"]);
    expect(await tipOf(f.remoteDir, "deguboard")).toBe(tip);

    const b2 = await openContext({ cwd: f.cloneB, actor });
    expect(b2.repo.dataRemote).toBeNull();
    const created = await runCommand(ticketCreate, b2, { title: "B" });
    expect(created.write).toMatchObject({ committed: true, pushed: false });
    expect(await tipOf(f.remoteDir, "deguboard")).toBe(tip);
  });

  it("push が拒否された後の取り込み直しで config がデータのリモートをなしにしていたら、自分のコミットを捨てて止め、再実行で変更が二重に入らない", async () => {
    const { f, a, b } = await shared();
    // B は書き込みのたびにコミットして push する（cas でない書き込みが push まで進む）
    await runCommand(configSet, b, { key: "commit.mode", value: "each", local: true });
    // B が自分の変更をコミットして push する直前に、A の側でチームの値が none になる
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await pushTeamNone(a);
      },
    };
    const racer = await openContext({ cwd: f.cloneB, actor, hooks });
    await expect(
      runCommand(ticketUpdate, racer, { ticket: "t1", priority: "high" }),
    ).rejects.toMatchObject({ code: "DATA_REMOTE_CHANGED" });
    const tip = await tipOf(f.remoteDir, "deguboard");
    // 自分のコミットは捨て、取り込んだ設定の変更は残る（手元はリモートの先端と同じ）
    expect(await headOf(racer)).toBe(tip);
    expect(await clean(racer)).toBe("");
    expect(racer.store.tickets.get("t1")?.data.priority).not.toBe("high");
    expect(racer.store.teamConfig.git.data_remote).toBe("none");

    // もう一度の実行は手元にだけ書き、同じ変更のコミットは 1 つだけ
    const b2 = await openContext({ cwd: f.cloneB, actor });
    const updated = await runCommand(ticketUpdate, b2, { ticket: "t1", priority: "high" });
    expect(updated.write).toMatchObject({ committed: true, pushed: false });
    const subjects = (await git(b2.repo.dataDir, ["log", "--format=%s"])).stdout.split("\n");
    expect(subjects.filter((s) => s === subjects[0])).toHaveLength(1);
    expect(await tipOf(f.remoteDir, "deguboard")).toBe(tip);
  });
});
