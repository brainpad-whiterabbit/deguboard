// チケットの流れのうち、起票・claim・照合と、それに付随して閉じる実装の Run

import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathExists } from "../storage/exists.js";
import { git } from "../../test/helpers/git-fixture.js";
import { OperationError, UsageError } from "../errors.js";
import type { RunId } from "../model/run.js";
import { resetGhCache } from "../git/facts.js";
import { recordBaseline } from "../git/outside.js";
import { closeRun, peekRunningRuns, startRun } from "../run/record.js";
import { DEFAULT_WORKFLOW } from "../workflow/resolve.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { runFinish } from "./run.js";
import { commit, configSet, sync } from "./setup.js";
import {
  ticketCheck,
  ticketClaim,
  ticketCreate,
  ticketMove,
  ticketShow,
  ticketUnclaim,
  ticketUpdate,
} from "./ticket.js";
import {
  initializedBothFixture,
  initializedFixture,
  reopenInitialized,
  agentWithRuns,
  fakeGh,
  runCleanups,
  writeOpenWorkflow,
  writeWorkflowYaml,
} from "../../test/helpers/commands-context.js";

// 照合の書き込みが閉じる直前に、別の文脈が先に閉じる形を作るための差し込み（通常は素通し）
const race = vi.hoisted(() => ({ beforeClose: undefined as undefined | (() => Promise<void>) }));
vi.mock("../run/record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run/record.js")>();
  return {
    ...actual,
    closeRun: async (...args: Parameters<typeof actual.closeRun>) => {
      const hook = race.beforeClose;
      race.beforeClose = undefined;
      if (hook) await hook();
      return actual.closeRun(...args);
    },
  };
});

afterEach(runCleanups);

/** 偽の gh を置き、`gh pr view <ブランチ名>` の応答を selector ごとの JSON で返す（応答のない selector は PR なし）。PATH に足すディレクトリを返す */
async function fakeGhPrs(root: string, responses: Record<string, string>): Promise<string> {
  const bin = path.join(root, "fake-bin");
  await mkdir(bin, { recursive: true });
  const cases = Object.entries(responses).map(
    ([selector, json]) => `  ${selector}) echo '${json}';;`,
  );
  await writeFile(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
      'case "$3" in',
      ...cases,
      '  *) echo "no pull requests found for branch $3" >&2; exit 1;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

describe("チケットの流れ（照合と claim）", () => {
  it("ticket show は作業ブランチの worktree のパスを git の一覧から引き、その worktree でも同じデータを読める（t381）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "Open worktree" });
    await runCommand(ticketCreate, ctx, { title: "No branch" });
    const claimed = await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1" });
    const branch = claimed.data.branch!;
    const worktreeOf = async () =>
      (await runCommand(ticketShow, ctx, { ticket: "t1" })).data.worktree;
    // ブランチを切っていない・ブランチのないチケットは null
    expect(await worktreeOf()).toBeNull();
    expect((await runCommand(ticketShow, ctx, { ticket: "t2" })).data.worktree).toBeNull();
    // config の worktree.root とは別の場所に作っても、git の一覧から見つかる
    const dir = path.join(f.root, "elsewhere", "wt");
    await mkdir(path.dirname(dir), { recursive: true });
    await git(f.cloneA, ["worktree", "add", "-q", "-b", branch, dir]);
    expect(await worktreeOf()).toBe(await realpath(dir));
    // その worktree から開いても common dir の deguboard を共有し、同じチケットが見える
    const inner = await openContext({ cwd: dir, actor: { kind: "human", user: "eiki" } });
    expect(inner.repo.dataDir).toBe(ctx.repo.dataDir);
    expect((await runCommand(ticketShow, inner, { ticket: "t1" })).data.worktree).toBe(
      await realpath(dir),
    );
    // ディレクトリが消えた登録は出さない
    await rm(dir, { recursive: true });
    expect(await worktreeOf()).toBeNull();
    // git の一覧を読めなくても null で、ticket show は落ちない
    const broken = { ...ctx, repo: { ...ctx.repo, topLevel: path.join(f.root, "not-a-repo") } };
    await mkdir(broken.repo.topLevel);
    expect((await runCommand(ticketShow, broken, { ticket: "t1" })).data.worktree).toBeNull();
  });

  it("起票 → claim → review → マージの照合で done になる（PR を使わない進め方：dg init が置いた既定の workflow.yaml のまま、ブランチのマージで進む）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    expect(ctx.store.workflow).toMatchObject({ exists: true, resolved: DEFAULT_WORKFLOW });
    const created = await runCommand(ticketCreate, ctx, {
      title: "Login validation",
      summary: "入力の検査",
      acceptance: ["a, b", "c"],
      labels: ["frontend"],
    });
    expect(created.data).toMatchObject({
      id: "t1",
      status: "todo",
      priority: "medium",
      labels: ["frontend"],
      created_by: "eiki",
    });
    expect(created.data.assignee).toBeUndefined();
    expect(created.data.body).toContain("## Summary\n\n入力の検査");
    expect(created.data.body).toContain("## Acceptance criteria\n\n- [ ] a, b\n- [ ] c\n");
    expect(created.write).toMatchObject({ pushed: true });

    const claimed = await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "1" });
    expect(claimed.data).toMatchObject({
      status: "in_progress",
      assignee: "eiki",
      branch: "t1-login-validation",
    });

    const review = await runCommand(ticketMove, ctx, { ticket: "t1", status: "review" });
    expect(review.data).toMatchObject({ status: "review", from: "in_progress" });
    // commit.mode は既定の batch なので作業ツリーに残る
    expect(review.write).toMatchObject({ committed: false });
    // 受け入れ条件は 1 項目だけ付けておく（照合が残りを警告する）
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });

    // 作業ブランチを作って main にマージする
    await git(f.cloneA, ["checkout", "-qb", "t1-login-validation"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "実装"]);
    await git(f.cloneA, ["checkout", "-q", "main"]);
    await git(f.cloneA, ["merge", "-q", "--ff-only", "t1-login-validation"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "main が進む"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);

    const synced = await runCommand(sync, ctx, {});
    expect(synced.data.reconciled).toEqual([
      { id: "t1", from: "review", to: "done", when: ["branch_merged"] },
    ]);
    expect(synced.warnings).toContain(
      "t1: acceptance criteria items 2 were left unchecked when the ticket became done",
    );
    expect(synced.data.pushed).toBe(true);
    expect(synced.data.status).toMatchObject({ ahead: 0, behind: 0, dirty: false });
    expect(ctx.store.tickets.get("t1")?.data.status).toBe("done");
    const log = (await git(ctx.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log[0]).toContain("Reconcile t1: review → done (branch_merged)");
    expect(log[1]).toBe("Commit batched changes");
  });

  /** claim が作った worktree で 1 コミット積んで push し、worktree のパスと push した先端を返す */
  async function claimedAndPushed(ctx: CommandContext, id: string, branch: string) {
    await runCommand(ticketCreate, ctx, { title: branch });
    const claimed = await runCommand(ticketClaim, ctx, { ticket: id, branch });
    const dir = claimed.data.worktree!;
    // 題をブランチごとに変える（同じ親・同じ秒の空のコミットは同じ SHA になり、別のブランチのマージで一緒にマージ済みに見える）
    await git(dir, ["commit", "-q", "--allow-empty", "-m", `作業 ${branch}`]);
    await git(dir, ["push", "-q", "origin", branch]);
    return { dir, head: (await git(dir, ["rev-parse", "HEAD"])).stdout.trim() };
  }

  /** 作業ブランチの残り方：worktree のディレクトリ・ローカルのブランチ・リモートのブランチがあるか */
  async function remaining(cwd: string, dir: string, branch: string) {
    const local = await git(cwd, ["branch", "--list", branch]);
    const remote = await git(cwd, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    return {
      worktree: existsSync(dir),
      local: local.stdout.trim() !== "",
      remote: remote.stdout.trim() !== "",
    };
  }

  it("merge.delete_branch が true のとき、照合が done にしたチケットの残りの worktree・ローカルとリモートのブランチを消して reconciled に添え、未コミットの変更や PR の先端と違う先端があれば消さずに理由と消し方を警告する（t849）", async () => {
    const f = await initializedFixture();
    const first = await reopenInitialized(f);
    await runCommand(configSet, first, { key: "merge.delete_branch", value: "true" });
    const ctx = await openContext({ cwd: f.cloneA, actor: first.actor });
    const clean = await claimedAndPushed(ctx, "t1", "t1-clean");
    const dirty = await claimedAndPushed(ctx, "t2", "t2-dirty");
    const ahead = await claimedAndPushed(ctx, "t3", "t3-ahead");
    // t2 は worktree にコミットしていないファイルが残り、t3 は PR の先端より後のコミットがローカルにある
    await writeFile(path.join(dirty.dir, "memo.txt"), "コミットしていない");
    await git(ahead.dir, ["commit", "-q", "--allow-empty", "-m", "マージの後の作業"]);
    // 人が GitHub の画面で squash マージした形：main には別のコミットが入り、作業ブランチはリモートにも残る
    await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", "squash マージ"]);
    await git(f.cloneB, ["push", "-q", "origin", "main"]);
    const mergedPr = (number: number, head: string) =>
      JSON.stringify({ number, state: "MERGED", isDraft: false, headRefOid: head });
    const restore = await fakeGh(f.root, {
      "t1-clean": mergedPr(11, clean.head),
      "t2-dirty": mergedPr(12, dirty.head),
      "t3-ahead": mergedPr(13, ahead.head),
    });
    try {
      const synced = await runCommand(sync, ctx, {});
      const kept = { worktree: null, local_branch: null, remote_branch: null };
      expect(synced.data.reconciled).toEqual([
        {
          id: "t1",
          from: "in_progress",
          to: "done",
          when: ["pr_merged"],
          removed: {
            worktree: clean.dir,
            local_branch: "t1-clean",
            remote_branch: "origin/t1-clean",
          },
        },
        { id: "t2", from: "in_progress", to: "done", when: ["pr_merged"], removed: kept },
        { id: "t3", from: "in_progress", to: "done", when: ["pr_merged"], removed: kept },
      ]);
      expect(await remaining(f.cloneA, clean.dir, "t1-clean")).toEqual({
        worktree: false,
        local: false,
        remote: false,
      });
      expect(synced.warnings.filter((w) => w.startsWith("t1:"))).toEqual([]);
      // 消さなかったものは何も消えていない。理由と、手で消すコマンドを警告する
      const all = { worktree: true, local: true, remote: true };
      expect(await remaining(f.cloneA, dirty.dir, "t2-dirty")).toEqual(all);
      expect(await remaining(f.cloneA, ahead.dir, "t3-ahead")).toEqual(all);
      const t2 = synced.warnings.filter((w) => w.startsWith("t2:"));
      expect(t2).toHaveLength(1);
      expect(t2[0]).toContain("the worktree and work branch t2-dirty were not deleted");
      expect(t2[0]).toContain(`worktree ${dirty.dir} has uncommitted changes`);
      expect(t2[0]).toContain(
        `git worktree remove --force ${dirty.dir}, git branch -D t2-dirty, git push origin --delete t2-dirty`,
      );
      const t3 = synced.warnings.filter((w) => w.startsWith("t3:"));
      expect(t3).toHaveLength(1);
      expect(t3[0]).toContain("the tip of the local branch");
      expect(t3[0]).toContain(`differs from the head of the merged PR (${ahead.head.slice(0, 7)})`);
      expect(t3[0]).toContain("git branch -D t3-ahead");
      // 片付けはデータを書かない（照合のコミットの後に、作業ツリーへ何も残さない）
      expect(synced.data.status).toMatchObject({ ahead: 0, dirty: false });
    } finally {
      restore();
    }
  });

  it("merge.delete_branch が false なら照合で done にしても何も消さず、true にすると PR のない（base に入った）作業ブランチも消す（t849）", async () => {
    const f = await initializedFixture();
    const first = await reopenInitialized(f);
    const keep = await claimedAndPushed(first, "t1", "t1-keep");
    const gone = await claimedAndPushed(first, "t2", "t2-gone");
    await git(f.cloneA, ["merge", "-q", "--no-ff", "--no-edit", "t1-keep"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);
    // 既定（false）では消さず、reconciled に removed も付けない
    const synced = await runCommand(sync, first, {});
    expect(synced.data.reconciled).toEqual([
      { id: "t1", from: "in_progress", to: "done", when: ["branch_merged"] },
    ]);
    expect(synced.warnings.filter((w) => w.startsWith("t1:"))).toEqual([]);
    expect(await remaining(f.cloneA, keep.dir, "t1-keep")).toEqual({
      worktree: true,
      local: true,
      remote: true,
    });

    await runCommand(configSet, first, { key: "merge.delete_branch", value: "true" });
    const ctx = await openContext({ cwd: f.cloneA, actor: first.actor });
    await git(f.cloneA, ["merge", "-q", "--no-ff", "--no-edit", "t2-gone"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);
    const again = await runCommand(sync, ctx, {});
    expect(again.data.reconciled).toEqual([
      {
        id: "t2",
        from: "in_progress",
        to: "done",
        when: ["branch_merged"],
        removed: {
          worktree: gone.dir,
          local_branch: "t2-gone",
          remote_branch: "origin/t2-gone",
        },
      },
    ]);
    expect(await remaining(f.cloneA, gone.dir, "t2-gone")).toEqual({
      worktree: false,
      local: false,
      remote: false,
    });
    // 前に done になったチケットの残りには触れない（消すのは、照合が done にしたときだけ）
    expect(await remaining(f.cloneA, keep.dir, "t1-keep")).toEqual({
      worktree: true,
      local: true,
      remote: true,
    });
  });

  it("コミットのない作業ブランチを push した後に main が進んでも done にせず、作業のあるブランチの ff マージと起点のない前からのチケットは done にする（t764）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    for (const title of ["Empty", "Work", "Legacy"]) await runCommand(ticketCreate, ctx, { title });
    const start = (await git(f.cloneA, ["rev-parse", "origin/main"])).stdout.trim();
    // claim が切った worktree のまま、コミットせずに push する
    const empty = await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "t1-empty" });
    expect(empty.data.branch_base).toBe(start);
    await git(empty.data.worktree!, ["push", "-q", "origin", "t1-empty"]);
    // 作業を積んで push し、main に ff マージする
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t2", branch: "t2-work" });
    await git(f.cloneA, ["checkout", "-qb", "t2-work", start]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "作業"]);
    await git(f.cloneA, ["push", "-q", "origin", "t2-work"]);
    await git(f.cloneA, ["checkout", "-q", "main"]);
    await git(f.cloneA, ["merge", "-q", "--ff-only", "t2-work"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);
    // 起点を記録していない前からのチケットの形（コミットのないブランチを push 済み）
    await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t3",
      branch: "t3-legacy",
    });
    await ctx.store.update("ticket", "t3", { branch_base: undefined });
    await recordBaseline(ctx.repo);
    await git(f.cloneA, ["push", "-q", "origin", `${start}:refs/heads/t3-legacy`]);
    // 別の作業が main に入る
    await git(f.cloneB, ["pull", "-q", "--ff-only", "origin", "main"]);
    await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", "main が進む"]);
    await git(f.cloneB, ["push", "-q", "origin", "main"]);

    const synced = await runCommand(sync, ctx, {});
    expect(synced.data.reconciled).toEqual([
      { id: "t2", from: "in_progress", to: "done", when: ["branch_merged"] },
      { id: "t3", from: "in_progress", to: "done", when: ["branch_merged"] },
    ]);
    expect(ctx.store.tickets.get("t1")?.data.status).toBe("in_progress");
    // unclaim で起点も消える
    await runCommand(ticketUnclaim, ctx, { ticket: "t1" });
    expect(ctx.store.tickets.get("t1")?.data.branch_base).toBeUndefined();
    // update でブランチを付け替えても外しても、前のブランチの起点を残さない
    const again = await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t1",
      branch: "t1-again",
    });
    expect(again.data.branch_base).toBe(
      (await git(f.cloneA, ["rev-parse", "origin/main"])).stdout.trim(),
    );
    await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "t1-other" });
    expect(ctx.store.tickets.get("t1")?.data.branch_base).toBeUndefined();
    await ctx.store.update("ticket", "t1", { branch_base: again.data.branch_base });
    await recordBaseline(ctx.repo);
    await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: null });
    expect(ctx.store.tickets.get("t1")?.data.branch_base).toBeUndefined();
  });

  it("照合は gh がブランチ名で見つけた PR の番号を pr に記録し、記録済みや PR のないチケットは書き換えない", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "With PR" });
    await runCommand(ticketCreate, ctx, { title: "Without PR" });
    await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t1",
      branch: "t1-with-pr",
    });
    await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t2",
      branch: "t2-without-pr",
    });
    for (const b of ["t1-with-pr", "t2-without-pr"]) {
      await git(f.cloneA, ["branch", b]);
    }

    // 偽の gh：t1 のブランチ（か記録した番号）には開いた PR #42 を返し、ほかは PR なし
    const bin = path.join(f.root, "fake-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        'case "$3" in',
        '  t1-with-pr|42) echo \'{"number":42,"state":"OPEN","isDraft":false,"mergedAt":null}\';;',
        '  *) echo "no pull requests found for branch $3" >&2; exit 1;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const savedPath = process.env["PATH"];
    process.env["PATH"] = bin + path.delimiter + (savedPath ?? "");
    resetGhCache();
    try {
      const first = await runCommand(sync, ctx, {});
      expect(first.data.reconciled).toEqual([
        { id: "t1", from: "in_progress", to: "review", when: ["pr_open", "!pr_draft"] },
      ]);
      expect(first.data.pr_recorded).toEqual([{ id: "t1", pr: 42 }]);
      expect(ctx.store.tickets.get("t1")?.data.pr).toBe(42);
      expect(ctx.store.tickets.get("t2")?.data.pr).toBeUndefined();
      const log = (await git(ctx.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim();
      expect(log).toBe(
        "Reconcile t1: in_progress → review (pr_open, !pr_draft). Record PR numbers: t1: #42",
      );

      // 2 回目は状態も pr も変わらず、コミットも増えない
      const second = await runCommand(sync, ctx, {});
      expect(second.data.reconciled).toEqual([]);
      expect(second.data.pr_recorded).toEqual([]);
      expect(ctx.store.tickets.get("t1")?.data.pr).toBe(42);
      expect((await git(ctx.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(log);
    } finally {
      process.env["PATH"] = savedPath;
      resetGhCache();
    }
  });

  // 止められた遷移の組み合わせ（満たさない requires・human_only・両方・PR を記録したチケットの pr_merged・gh のないとき）と
  // 警告の文は reconcile-judge.test.ts が git なしで見る。ここは workflow.yaml の境目が照合に届いて、止めた理由が warnings に出る経路を見る
  it("照合は workflow.yaml の越える境目の requires を満たさないチケットを進めず、止めた理由を警告する。見つけた PR の番号は記録する（ST-4）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await writeWorkflowYaml(ctx, [
      "boundaries:",
      "  - { from: in_progress, to: review, requires: [branch_pushed] }",
    ]);
    await runCommand(ticketCreate, ctx, { title: "Gated" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", branch: "t1-gated" });
    await recordBaseline(ctx.repo);
    // ブランチはローカルだけ（push していない）
    await git(f.cloneA, ["branch", "t1-gated"]);
    const restore = await fakeGh(f.root, {
      "t1-gated|42": JSON.stringify({
        number: 42,
        state: "OPEN",
        isDraft: false,
        createdAt: "2099-01-01T00:00:00Z",
        mergedAt: null,
      }),
    });
    try {
      // 下書きでない PR が開いた（きっかけ）が、in_progress → review の requires（branch_pushed）を満たさないので進めない
      const unmet = await runCommand(sync, ctx, {});
      expect(unmet.data.reconciled).toEqual([]);
      expect(unmet.data.pr_recorded).toEqual([{ id: "t1", pr: 42 }]);
      expect(ctx.store.tickets.get("t1")?.data).toMatchObject({ status: "in_progress", pr: 42 });
      expect(unmet.warnings).toContainEqual(
        expect.stringContaining(
          "t1: the facts (pr_open, !pr_draft) point from in_progress to review, but reconcile does not advance it, because the conditions are not met: branch_pushed (boundaries in_progress → review)",
        ),
      );
    } finally {
      restore();
    }
  });

  it("sync が gh を待っている間もほかの書き込みは待たずに通り、照合はその後の最新の状態で判定し直して書く（t758）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "Slow PR" });
    await runCommand(ticketCreate, ctx, { title: "Unclaimed" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", branch: "t1-slow" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t2", branch: "t2-gone" });
    for (const b of ["t1-slow", "t2-gone"]) await git(f.cloneA, ["branch", b]);
    await runCommand(commit, ctx, {});

    // 偽の gh：t1 のブランチは started を置いてから release が置かれるまで（上限 15 秒）答えない。t2 は開いた PR #43 を返す
    const started = path.join(f.root, "gh-started");
    const release = path.join(f.root, "gh-release");
    const bin = path.join(f.root, "fake-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        'case "$3" in',
        `  t1-slow) : > '${started}'; i=0; while [ ! -f '${release}' ] && [ $i -lt 300 ]; do sleep 0.05; i=$((i+1)); done; echo '{"number":42,"state":"OPEN","isDraft":false,"mergedAt":null}';;`,
        '  t2-gone) echo \'{"number":43,"state":"OPEN","isDraft":false,"mergedAt":null}\';;',
        '  *) echo "no pull requests found for branch $3" >&2; exit 1;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const savedPath = process.env["PATH"];
    process.env["PATH"] = bin + path.delimiter + (savedPath ?? "");
    resetGhCache();
    try {
      const syncing = runCommand(sync, ctx, {});
      // sync が t1 の PR を gh で調べ始めるまで待つ
      for (let i = 0; i < 300 && !(await pathExists(started)); i++) await sleep(50);
      expect(await pathExists(started)).toBe(true);

      // gh が答えない間に、別の文脈の起票と unclaim が通る（ロックを持たれていれば待ち時間の上限で落ちる）
      const other = await openContext({ cwd: f.cloneA, actor: { kind: "human", user: "eiki" } });
      const created = await runCommand(ticketCreate, other, { title: "During sync" });
      expect(created.data.id).toBe("t3");
      await runCommand(ticketClaim, other, {
        no_worktree: true,
        ticket: "t3",
        branch: "t3-new",
      });
      await runCommand(ticketUnclaim, other, { ticket: "t2" });
      expect(await pathExists(release)).toBe(false);
      await writeFile(release, "");

      const synced = await syncing;
      // t1 は PR で review に進む。t2 は集めた後に unclaim されたので、その PR の事実で書き戻さない
      expect(synced.data.reconciled).toEqual([
        { id: "t1", from: "in_progress", to: "review", when: ["pr_open", "!pr_draft"] },
      ]);
      expect(synced.data.pr_recorded).toEqual([{ id: "t1", pr: 42 }]);
      expect(ctx.store.tickets.get("t2")?.data).toMatchObject({ status: "todo" });
      expect(ctx.store.tickets.get("t2")?.data.pr).toBeUndefined();
      expect(ctx.store.tickets.get("t3")?.data.title).toBe("During sync");
      const log = (await git(ctx.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
      expect(log[0]).toBe(
        "Reconcile t1: in_progress → review (pr_open, !pr_draft). Record PR numbers: t1: #42",
      );
      // 集めたときに対象でなかった t3（ロックの間に claim した）は照合せずに次の sync に回す。unclaim で作業ブランチのなくなった t2 は対象でない
      expect(synced.warnings.filter((w) => /^t\d+:/.test(w))).toEqual([
        "t3: the facts of its work branch were not read for its current state, so it is reconciled at the next sync",
      ]);
      expect(ctx.store.tickets.get("t3")?.data).toMatchObject({ status: "in_progress" });
      // 照合のコミットは照合が書いたファイルだけを入れる。ロックを放していた間にまとめ待ち（batch）になった t2 の unclaim は、
      // 照合のメッセージでコミットせずに残す
      const files = (
        await git(ctx.repo.dataDir, ["show", "--name-only", "--format=", "HEAD"])
      ).stdout.trim();
      expect(files.split("\n")).toEqual([expect.stringContaining("t1")]);
      expect(synced.data.status).toMatchObject({ ahead: 0, dirty: true });
    } finally {
      await writeFile(release, "");
      process.env["PATH"] = savedPath;
      resetGhCache();
    }
  }, 30_000);

  // 対象のチケットの列がもう決めた Run を後ろの決定が飛ばすこと（reconcile-judge.ts の settledRuns）の経路。
  // どの Run が決めた Run かの組み合わせは reconcile-judge.test.ts が git なしで見る
  it("事実を集めた後に開いた手直しの Run は、チケットが今回 done に進んでも閉じずに 1 回だけ知らせ、次の sync で閉じる（RN-6）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    for (const title of ["Merged", "Done elsewhere"])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    for (const t of ["t1", "t2"]) {
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: t,
        branch: t,
      });
      await git(f.cloneA, ["branch", t]);
    }
    await agent.store.update("ticket", "t2", { pr: 42 });
    await recordBaseline(agent.repo);
    const restore = await fakeGh(f.root, {
      "t1|41":
        '{"number":41,"state":"OPEN","isDraft":false,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
    });
    try {
      clock = new Date("2026-11-06T00:30:00Z");
      await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      await runCommand(sync, agent, {});
      expect(agent.store.tickets.get("t1")!.data.status).toBe("review");
    } finally {
      restore();
    }
    // t2 は PR のある done に実装の Run が開いたまま残る形。sync は実行中の Run を読んだ後に、その PR の作成時刻を gh で読む
    await human.store.rescan();
    await runCommand(ticketMove, human, { ticket: "t2", status: "done", override: "PR なし" });
    await agent.store.rescan();

    // 偽の gh：t1 の PR #41 はマージ済み。t2 の PR #42 は started を置いてから release が置かれるまで（上限 15 秒）答えない
    const started = path.join(f.root, "gh-started");
    const release = path.join(f.root, "gh-release");
    const bin = path.join(f.root, "fake-bin");
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        'case "$3" in',
        '  t1|41) echo \'{"number":41,"state":"MERGED","isDraft":false,"mergedAt":"2026-11-06T04:00:00Z","createdAt":"2026-11-06T00:20:00Z"}\';;',
        `  42) : > '${started}'; i=0; while [ ! -f '${release}' ] && [ $i -lt 300 ]; do sleep 0.05; i=$((i+1)); done; echo "no pull requests found" >&2; exit 1;;`,
        '  *) echo "no pull requests found for branch $3" >&2; exit 1;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const savedPath = process.env["PATH"];
    process.env["PATH"] = bin + path.delimiter + (savedPath ?? "");
    resetGhCache();
    try {
      clock = new Date("2026-11-06T05:00:00Z");
      const syncing = runCommand(sync, agent, {});
      for (let i = 0; i < 300 && !(await pathExists(started)); i++) await sleep(50);
      expect(await pathExists(started)).toBe(true);
      // 最後の push を読むチケットを決めた後（実行中の Run を読んだ後）に、別の文脈がもう一度の claim で手直しの Run を開く
      const other = await agentWithRuns(f.cloneA, () => clock);
      const fix = (
        await runCommand(ticketClaim, other, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
          retry_reasons: ["A"],
        })
      ).data.run!;
      await writeFile(release, "");

      const synced = await syncing;
      expect(synced.data.reconciled).toEqual([
        { id: "t1", from: "review", to: "done", when: ["pr_merged"] },
      ]);
      // 対象のチケットの決定が知らせた Run を、終わったチケットの Run としてもう一度決めない（同じ警告を 2 つ出さない）
      expect(synced.warnings.filter((w) => w.includes(fix))).toEqual([
        `t1: the last push of its work branch was not read for its current state, so the fix Run ${fix} is closed at the next sync`,
      ]);
      expect(synced.data.runs_closed.map((r) => r.run)).not.toContain(fix);
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toContain(fix);

      // 次の sync は最後の push を読んでいるので、終わったチケットを区切りに閉じる
      clock = new Date("2026-11-06T06:00:00Z");
      const next = await runCommand(sync, agent, {});
      expect(next.data.runs_closed).toEqual([
        { id: "t1", run: fix, opener: "reclaim", result: "success" },
      ]);
      expect(await peekRunningRuns(agent.repo)).toEqual([]);
    } finally {
      await writeFile(release, "");
      process.env["PATH"] = savedPath;
      resetGhCache();
    }
  }, 30_000);

  it("sync が gh を待つ間に dg の外の変更が入ると、照合を書かずに取り込みの結果と照合を飛ばした理由を返す（t758）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "Slow PR" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", branch: "t1-slow" });
    await git(f.cloneA, ["branch", "t1-slow"]);
    await runCommand(commit, ctx, {});

    // 偽の gh：started を置いてから release が置かれるまで（上限 15 秒）答えず、開いた PR #42 を返す
    const started = path.join(f.root, "gh-started");
    const release = path.join(f.root, "gh-release");
    const bin = path.join(f.root, "fake-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        `: > '${started}'; i=0; while [ ! -f '${release}' ] && [ $i -lt 300 ]; do sleep 0.05; i=$((i+1)); done`,
        'echo \'{"number":42,"state":"OPEN","isDraft":false,"mergedAt":null}\'',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const savedPath = process.env["PATH"];
    process.env["PATH"] = bin + path.delimiter + (savedPath ?? "");
    resetGhCache();
    try {
      const syncing = runCommand(sync, ctx, {});
      for (let i = 0; i < 300 && !(await pathExists(started)); i++) await sleep(50);
      expect(await pathExists(started)).toBe(true);
      // gh が答えない間に、dg を通さずにデータのリポジトリへファイルを置く
      await writeFile(path.join(ctx.repo.dataDir, "stray.md"), "outside\n");
      await writeFile(release, "");

      const synced = await syncing;
      expect(synced.data.fetched).toBe(true);
      expect(synced.data.reconciled).toEqual([]);
      expect(synced.data.pr_recorded).toEqual([]);
      expect(synced.warnings).toContainEqual(
        expect.stringContaining("The pull was done, but the reconcile was skipped"),
      );
      expect(ctx.store.tickets.get("t1")?.data).toMatchObject({ status: "in_progress" });
    } finally {
      await writeFile(release, "");
      process.env["PATH"] = savedPath;
      resetGhCache();
    }
  }, 30_000);

  it("照合のロックを取った後に照合の書き込みが失敗すると、sync は照合を飛ばしたと言わずに失敗する（t758）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "Slow PR" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", branch: "t1-slow" });
    await git(f.cloneA, ["branch", "t1-slow"]);
    await runCommand(commit, ctx, {});

    // 偽の gh：started を置いてから release が置かれるまで（上限 15 秒）答えず、開いた PR #42 を返す
    const started = path.join(f.root, "gh-started");
    const release = path.join(f.root, "gh-release");
    const bin = path.join(f.root, "fake-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        `: > '${started}'; i=0; while [ ! -f '${release}' ] && [ $i -lt 300 ]; do sleep 0.05; i=$((i+1)); done`,
        'echo \'{"number":42,"state":"OPEN","isDraft":false,"mergedAt":null}\'',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const savedPath = process.env["PATH"];
    process.env["PATH"] = bin + path.delimiter + (savedPath ?? "");
    resetGhCache();
    const original = ctx.store.update.bind(ctx.store);
    const update = vi.spyOn(ctx.store, "update");
    try {
      const syncing = runCommand(sync, ctx, {});
      for (let i = 0; i < 300 && !(await pathExists(started)); i++) await sleep(50);
      expect(await pathExists(started)).toBe(true);
      // gh が答えない間に、照合の書き込みを「ファイルを書いてから OperationError で失敗する」ものに替える。
      // ロックの前の検査（外の変更・rebase）は通り、照合が t1 を書いた後に失敗する
      update.mockImplementation(async (...args) => {
        await original(...args);
        throw new OperationError("VALIDATION_FAILED", "injected failure after the write");
      });
      await writeFile(release, "");

      await expect(syncing).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "injected failure after the write",
      });
    } finally {
      update.mockRestore();
      await writeFile(release, "");
      process.env["PATH"] = savedPath;
      resetGhCache();
    }
  }, 30_000);

  // どの PR を前の作業とみなすか（開いたままの古い PR・閉じた PR・claim し直した後の新しい PR）は facts-judge.test.ts が、
  // 外した PR の状態（merged・closed）を出す警告の文は reconcile-judge.test.ts が、gh なしで見る。
  // ここは gh が返した前の作業の PR を外して警告する経路と、比べる時刻（branch_at、なければ created_at）を渡す経路を見る
  it("照合は claim より前にマージされた同じブランチ名の PR を根拠にせず、claim の後にマージした PR では done にして pr を記録する（t206）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-02T05:00:00Z");
    const ctx = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, ctx, { title: "Reused branch" });
    await runCommand(ticketCreate, ctx, { title: "Fresh PR" });
    await runCommand(ticketCreate, ctx, { title: "Legacy" });
    const claimed = await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t1",
      branch: "t1-reused",
    });
    expect(claimed.data.branch_at).toBe("2026-11-02T05:00:00Z");
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t2", branch: "t2-fresh" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t3", branch: "t3-legacy" });
    // branch_at のない古いチケットの形（created_at と比べる）
    await ctx.store.update("ticket", "t3", { branch_at: undefined });
    await recordBaseline(ctx.repo);
    // claim 直後に main から切った、commit のないブランチ（push はまだ）
    for (const b of ["t1-reused", "t2-fresh", "t3-legacy"]) {
      await git(f.cloneA, ["branch", b]);
    }

    // 偽の gh：t1-reused には前日にマージ済みの PR #105、t2-fresh には claim の後にマージした PR #200
    const bin = path.join(f.root, "fake-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        'case "$3" in',
        '  t1-reused|105) echo \'{"number":105,"state":"MERGED","isDraft":false,"createdAt":"2026-10-31T10:00:00Z","mergedAt":"2026-11-01T10:00:00Z"}\';;',
        '  t3-legacy|90) echo \'{"number":90,"state":"MERGED","isDraft":false,"createdAt":"2026-10-31T09:00:00Z","mergedAt":"2026-11-01T09:00:00Z"}\';;',
        '  t2-fresh|200) echo \'{"number":200,"state":"MERGED","isDraft":false,"createdAt":"2026-11-02T05:30:00Z","mergedAt":"2026-11-02T06:00:00Z"}\';;',
        '  *) echo "no pull requests found for branch $3" >&2; exit 1;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const savedPath = process.env["PATH"];
    process.env["PATH"] = bin + path.delimiter + (savedPath ?? "");
    resetGhCache();
    try {
      clock = new Date("2026-11-02T06:05:00Z");
      const synced = await runCommand(sync, ctx, {});
      expect(synced.data.reconciled).toEqual([
        { id: "t2", from: "in_progress", to: "done", when: ["pr_merged"] },
      ]);
      expect(synced.data.pr_recorded).toEqual([{ id: "t2", pr: 200 }]);
      // 前の作業の PR は根拠にしない：in_progress のまま、pr も記録せず、外した理由を警告する
      expect(ctx.store.tickets.get("t1")?.data).toMatchObject({ status: "in_progress" });
      expect(ctx.store.tickets.get("t1")?.data.pr).toBeUndefined();
      const t1Warnings = synced.warnings.filter((w) => w.startsWith("t1:"));
      expect(t1Warnings).toHaveLength(1);
      expect(t1Warnings[0]).toContain("PR #105");
      expect(t1Warnings[0]).toContain("2026-10-31T10:00:00Z");
      // このチケットの PR なら、ticket update で記録して sync を回し直す手を書く（前の作業の PR なら何もしない）
      expect(t1Warnings[0]).toContain("ticket update t1 --pr 105");
      expect(t1Warnings[0]).toContain("run sync again");
      expect(t1Warnings[0]).toContain("If it belongs to earlier work, do nothing");
      expect(ctx.store.tickets.get("t2")?.data).toMatchObject({ status: "done", pr: 200 });
      // branch_at のない古いチケットは created_at より前にマージされた PR を外す
      expect(ctx.store.tickets.get("t3")?.data).toMatchObject({ status: "in_progress" });
      expect(ctx.store.tickets.get("t3")?.data.pr).toBeUndefined();
      expect(synced.warnings.filter((w) => w.startsWith("t3:"))[0]).toContain("PR #90");

      // pr を記録すれば時刻を比べず、その PR で照合する
      await runCommand(ticketUpdate, ctx, { ticket: "t3", pr: 90 });
      const recorded = await runCommand(sync, ctx, {});
      expect(recorded.data.reconciled).toEqual([
        { id: "t3", from: "in_progress", to: "done", when: ["pr_merged"] },
      ]);
      expect(recorded.warnings.filter((w) => w.startsWith("t3:"))).toEqual([]);

      // unclaim で branch_at は消え、ブランチなしで claim し直しても付かない
      await runCommand(ticketUnclaim, ctx, { ticket: "t1" });
      expect(ctx.store.tickets.get("t1")?.data.branch_at).toBeUndefined();
      clock = new Date("2026-11-02T07:00:00Z");
      await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", without_branch: true });
      expect(ctx.store.tickets.get("t1")?.data.branch_at).toBeUndefined();
      // update の branch で付け、同じ値なら変えず、外せば消える
      clock = new Date("2026-11-02T07:10:00Z");
      await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "t1-reused" });
      expect(ctx.store.tickets.get("t1")?.data.branch_at).toBe("2026-11-02T07:10:00Z");
      clock = new Date("2026-11-02T07:20:00Z");
      await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "t1-reused" });
      expect(ctx.store.tickets.get("t1")?.data.branch_at).toBe("2026-11-02T07:10:00Z");
      await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: null });
      expect(ctx.store.tickets.get("t1")?.data.branch_at).toBeUndefined();
    } finally {
      process.env["PATH"] = savedPath;
      resetGhCache();
    }
  });

  it("照合は、マージされた PR の追加・削除の行数をチケットの lines に記録する。開いている PR の行数は記録せず、PR の番号を変えると消す（MT-6）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "Lines" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", branch: "t1-lines" });
    await recordBaseline(ctx.repo);
    await git(f.cloneA, ["branch", "t1-lines"]);
    const pr = (state: string, mergedAt: string | null) =>
      JSON.stringify({
        number: 300,
        state,
        isDraft: false,
        createdAt: "2099-01-01T00:00:00Z",
        mergedAt,
        additions: 120,
        deletions: 30,
      });
    const savedPath = process.env["PATH"];
    try {
      // 開いている間の行数は push のたびに変わるので記録しない
      const bin = await fakeGhPrs(f.root, { "t1-lines|300": pr("OPEN", null) });
      process.env["PATH"] = bin + path.delimiter + (savedPath ?? "");
      resetGhCache();
      const open = await runCommand(sync, ctx, {});
      expect(open.data.lines_recorded).toEqual([]);
      expect(ctx.store.tickets.get("t1")?.data).toMatchObject({ status: "review", pr: 300 });
      expect(ctx.store.tickets.get("t1")?.data.lines).toBeUndefined();

      // マージされたら、done に進めるのと同じ書き込みで行数を記録する
      await fakeGhPrs(f.root, { "t1-lines|300": pr("MERGED", "2099-01-02T00:00:00Z") });
      const mergedSync = await runCommand(sync, ctx, {});
      expect(mergedSync.data.lines_recorded).toEqual([{ id: "t1", additions: 120, deletions: 30 }]);
      expect(ctx.store.tickets.get("t1")?.data).toMatchObject({
        status: "done",
        lines: { additions: 120, deletions: 30 },
      });
      expect((await git(ctx.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
        "Reconcile t1: review → done (pr_merged). Record changed lines: t1: +120 -30",
      );

      // 同じ番号の記録では残し、別の番号に変えると前の PR の行数を残さない
      await runCommand(ticketUpdate, ctx, { ticket: "t1", pr: 300 });
      expect(ctx.store.tickets.get("t1")?.data.lines).toEqual({ additions: 120, deletions: 30 });
      await runCommand(ticketUpdate, ctx, { ticket: "t1", pr: 301 });
      expect(ctx.store.tickets.get("t1")?.data.lines).toBeUndefined();
    } finally {
      process.env["PATH"] = savedPath;
      resetGhCache();
    }
  });

  it("claim と update は、マージ済みのまま残った同じ名前のブランチと、終わっていない別のチケットが使う名前を拒否する（t216）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    for (const title of ["A", "B", "C", "D"]) await runCommand(ticketCreate, ctx, { title });
    // 前の作業：cloneB で t1-reused に積んで push し、main に ff マージした後で main が進む（ブランチは消さない）
    await git(f.cloneB, ["pull", "-q", "--ff-only", "origin", "main"]);
    await git(f.cloneB, ["checkout", "-qb", "t1-reused"]);
    await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", "前の作業"]);
    await git(f.cloneB, ["push", "-q", "origin", "t1-reused"]);
    await git(f.cloneB, ["checkout", "-q", "main"]);
    await git(f.cloneB, ["merge", "-q", "--ff-only", "t1-reused"]);
    await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", "次の作業"]);
    await git(f.cloneB, ["push", "-q", "origin", "main"]);
    // まだマージしていない作業のブランチ
    await git(f.cloneB, ["checkout", "-qb", "t3-wip"]);
    await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", "途中の作業"]);
    await git(f.cloneB, ["push", "-q", "origin", "t3-wip"]);

    // リモートに残ったマージ済みのブランチ（手元では一度も fetch していない）
    // 残ったブランチの拒否は、別の名前と、古いブランチを消すか base に揃える案内を返す
    const leftover = expect.objectContaining({
      code: "BRANCH_IN_USE",
      message: expect.stringMatching(
        /Give a different name, or delete the old branch or bring it up to base/,
      ),
    });
    // 検査は dg が組み立てた後の名前（t1-reused）で行う。渡すのは値（reused）だけ
    await expect(
      runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", branch: "reused" }),
    ).rejects.toEqual(leftover);
    expect(ctx.store.tickets.get("t1")?.data).toMatchObject({ status: "todo" });
    expect(ctx.store.tickets.get("t1")?.data.branch).toBeUndefined();
    await expect(runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "reused" })).rejects.toEqual(
      leftover,
    );

    // 手元に残ったマージ済みのブランチ
    await git(ctx.repo.dataDir, ["fetch", "-q", "origin"]);
    await git(f.cloneA, ["branch", "t1-local", "origin/main~1"]);
    await expect(
      runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", branch: "local" }),
    ).rejects.toEqual(leftover);

    // ref がない・切ったばかり・base にない作業があるときは通る
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", branch: "new" });
    await git(f.cloneA, ["branch", "t2-cut", "origin/main"]);
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t2", branch: "cut" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t3", branch: "wip" });
    expect(ctx.store.tickets.get("t3")?.data).toMatchObject({
      status: "in_progress",
      branch: "t3-wip",
    });

    // 終わっていない別のチケットが記録している名前は、使っているチケットと別の名前の案内を返す。
    // dg が ID を付けるので、別のチケットと名前が重なるのは、前の形で記録したデータ（ここでは t1 が t4-new を持つ）だけ
    await ctx.store.update("ticket", "t1", { branch: "t4-new" });
    await recordBaseline(ctx.repo);
    await expect(
      runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t4", branch: "new" }),
    ).rejects.toMatchObject({
      code: "BRANCH_IN_USE",
      message: expect.stringMatching(
        /t4-new is in use by t1 \(in_progress\)\. Give a different name/,
      ),
    });
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t4", branch: "new" }),
    ).rejects.toMatchObject({
      code: "BRANCH_IN_USE",
      message: expect.stringContaining("Give a different name"),
    });

    // リモートで消したブランチの古い追跡 ref は見ない
    await git(f.cloneB, ["push", "-q", "origin", "--delete", "t1-reused"]);
    await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "reused" });
    expect(ctx.store.tickets.get("t1")?.data.branch).toBe("t1-reused");

    // 終わったチケットが記録している名前は使える（前の形で記録した t5-cut を持つ t2 が done）
    await ctx.store.update("ticket", "t2", { branch: "t5-cut" });
    await recordBaseline(ctx.repo);
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "done", override: "PR なし" });
    await runCommand(ticketCreate, ctx, { title: "E" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t5", branch: "cut" });
    expect(ctx.store.tickets.get("t5")?.data.branch).toBe("t5-cut");
  });

  it("claim と update の branch は、値の前に <id>- を付けて記録し、自分の ID と - で始まる値はそのまま使う。別のチケットの ID・使えない文字・50 文字を超える値は拒む。branch を省いた claim は、title が ASCII だけなら <id>-<title の slug>、ほかの文字を含むなら <id> だけにする（ST-3・t966）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, ctx, { title });

    // 値の前に ID を付ける。ブランチからチケットを ID で探せるようにする
    const claimed = await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t1",
      branch: "fix-login",
    });
    expect(claimed.data.branch).toBe("t1-fix-login");
    // 自分の ID と - で始まる値は、ID を重ねずにそのまま使う
    const own = await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t2",
      branch: "t2-sync-warning",
    });
    expect(own.data.branch).toBe("t2-sync-warning");
    // 自分の ID だけの値も受けて、そのまま使う（英語の内容がないときの既定の名前と同じ形。t985）
    const idOnly = await runCommand(ticketUpdate, ctx, { ticket: "t2", branch: "t2" });
    expect(idOnly.data.branch).toBe("t2");
    await runCommand(ticketUpdate, ctx, { ticket: "t2", branch: "t2-sync-warning" });

    // update も同じ組み立て。組み立てた名前が記録済みと同じなら何も変えない
    const updated = await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "retry" });
    expect(updated.data.branch).toBe("t1-retry");
    const before = ctx.store.tickets.get("t1")?.data.branch_at;
    await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "retry" });
    await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "t1-retry" });
    expect(ctx.store.tickets.get("t1")?.data).toMatchObject({
      branch: "t1-retry",
      branch_at: before,
    });
    // t1 で始まっても t1- でなければ別のチケットの ID（t12 を t1 の名前と取り違えない）
    const rejected: [string, RegExp][] = [
      ["t2-other", /starts with another ticket's ID \(t2\)/],
      ["t12-other", /starts with another ticket's ID \(t12\)/],
      ["t9", /starts with another ticket's ID \(t9\)/],
      // 種類を前に付けた名前（feat/x）も、/ が使えないので拒む
      ["feat/login", /characters that cannot be used/],
      ["Fix-Login", /characters that cannot be used/],
      ["fix_login", /characters that cannot be used/],
      ["ログイン", /characters that cannot be used/],
      ["-fix", /characters that cannot be used/],
      ["a".repeat(51), /51 characters long.*up to 50 characters/],
    ];
    for (const [value, message] of rejected) {
      for (const run of [
        () => runCommand(ticketUpdate, ctx, { ticket: "t1", branch: value }),
        () => runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t3", branch: value }),
      ]) {
        const error = await run().catch((e: unknown) => e);
        expect(error, value).toBeInstanceOf(UsageError);
        expect((error as UsageError).message, value).toMatch(message);
      }
    }
    expect(ctx.store.tickets.get("t1")?.data.branch).toBe("t1-retry");
    expect(ctx.store.tickets.get("t3")?.data).toMatchObject({ status: "todo" });
    // 上限は ID を付ける前の値に掛かる（50 文字ちょうどは通る）
    const longest = await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "a".repeat(50) });
    expect(longest.data.branch).toBe(`t1-${"a".repeat(50)}`);

    // 前の形で記録した名前（feat/x）は、同じ値を渡しても拒まずにそのまま残す
    await ctx.store.update("ticket", "t2", { branch: "feat/legacy" });
    await recordBaseline(ctx.repo);
    const kept = await runCommand(ticketUpdate, ctx, { ticket: "t2", branch: "feat/legacy" });
    expect(kept.data.branch).toBe("feat/legacy");

    // branch を省いた claim は title から名前を作る（t4〜t7）
    const titles = [
      "Fix the Login form (v2)!",
      // 日本語の title から ASCII の断片（dg・id）を拾うと中身を誤って伝えるので、slug を作らない
      "dg が id を組み立てる",
      "!!!",
      // slug は 40 文字で切り、切り口のハイフンを残さない
      `${"a".repeat(39)} tail`,
    ];
    for (const title of titles) await runCommand(ticketCreate, ctx, { title });
    const branches: (string | undefined)[] = [];
    for (const ticket of ["t4", "t5", "t6", "t7"]) {
      branches.push(
        (await runCommand(ticketClaim, ctx, { no_worktree: true, ticket })).data.branch,
      );
    }
    expect(branches).toEqual(["t4-fix-the-login-form-v2", "t5", "t6", `t7-${"a".repeat(39)}`]);
  });

  it("PR の要らない作業は claim の without_branch で branch を持たず、照合で動かず警告も出ない。update の branch で付け外しできる", async () => {
    const f = await initializedFixture();
    // マージドライバの登録がないと sync が警告する（t759）ので、node を指す登録を渡す（このテストでは rebase がマージしない）
    const ctx = await reopenInitialized(f, { mergeDriver: [process.execPath, "merge-driver"] });
    await runCommand(ticketCreate, ctx, { title: "Data cleanup" });
    await expect(
      runCommand(ticketClaim, ctx, {
        no_worktree: true,
        ticket: "t1",
        without_branch: true,
        branch: "t1-x",
      }),
    ).rejects.toBeInstanceOf(UsageError);
    const claimed = await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t1",
      without_branch: true,
    });
    expect(claimed.data).toMatchObject({ status: "in_progress", assignee: "eiki" });
    expect(claimed.data.branch).toBeUndefined();

    await runCommand(ticketMove, ctx, { ticket: "t1", status: "review" });
    const synced = await runCommand(sync, ctx, {});
    expect(synced.data.reconciled).toEqual([]);
    expect(synced.warnings).toEqual([]);
    expect(ctx.store.tickets.get("t1")?.data.status).toBe("review");

    // 付けたブランチは照合の対象になり、none で外せば対象から外れる
    const attached = await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "t1-gone" });
    expect(attached.data.branch).toBe("t1-gone");
    expect((await runCommand(sync, ctx, {})).warnings).toContain(
      "t1: The work branch was not found locally or on the remote",
    );
    const detached = await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: null });
    expect(detached.data.branch).toBeUndefined();
    expect((await runCommand(sync, ctx, {})).warnings).toEqual([]);

    // 既定の Workflow の review → done の pr_merged は、ブランチなしで着手したチケットには当たらず、手で done にできる。
    // ブランチを付けている間は当たる
    await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "t1-gone" });
    await expect(
      runCommand(ticketMove, ctx, { ticket: "t1", status: "done" }),
    ).rejects.toMatchObject({ code: "TRANSITION_REJECTED" });
    await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: null });
    const done = await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    expect(done.data.status).toBe("done");
  });

  it("gh が PR がないと答えた review のチケットは閉じた PR と警告しない。閉じた PR には警告する", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "No PR yet" });
    await runCommand(ticketCreate, ctx, { title: "Closed PR" });
    await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t1",
      branch: "t1-no-pr",
    });
    await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t2",
      branch: "t2-closed",
    });
    for (const b of ["t1-no-pr", "t2-closed"]) await git(f.cloneA, ["branch", b]);
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "review" });
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "review" });

    const bin = path.join(f.root, "fake-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        'case "$3" in',
        '  t2-closed) echo \'{"number":7,"state":"CLOSED","isDraft":false,"mergedAt":null}\';;',
        '  *) echo "no pull requests found for branch $3" >&2; exit 1;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const savedPath = process.env["PATH"];
    process.env["PATH"] = bin + path.delimiter + (savedPath ?? "");
    resetGhCache();
    try {
      const synced = await runCommand(sync, ctx, {});
      expect(synced.warnings).toContain("t2: The PR was closed without being merged");
      expect(synced.warnings.filter((w) => w.startsWith("t1:"))).toEqual([]);
    } finally {
      process.env["PATH"] = savedPath;
      resetGhCache();
    }
  });

  it("agent の claim は実装の Run を開いて run に ID を出し、no_run と人の claim では開かず、agent を判定できなければ警告だけして claim は成功する。開く step は Core が決める implement で、workflow.yaml に前の形の steps（opens_on）を書いても変わらない（RN-5）", async () => {
    const f = await initializedFixture();
    const human = await reopenInitialized(f);
    for (const title of ["A", "B", "C", "D", "E"]) await runCommand(ticketCreate, human, { title });
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    agent.env = { CLAUDECODE: "1" };
    // 環境変数から判定した agent で、opens_on: claim の implement の Run が開く
    const claimed = await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t1",
    });
    expect(claimed.data).toMatchObject({ status: "in_progress", assignee: "eiki/agent" });
    expect(claimed.data.run).toMatch(/^r\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(claimed.warnings).toEqual([]);
    expect(await peekRunningRuns(agent.repo)).toEqual([
      expect.objectContaining({
        id: claimed.data.run,
        ticket: "t1",
        step: "implement",
        agent: "claude-code",
        model: null,
      }),
    ]);
    // without_branch でも開き、agent を渡せば判定より先に使う
    const noBranch = await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t2",
      without_branch: true,
      agent: "codex",
    });
    expect(noBranch.data.branch).toBeUndefined();
    expect((await peekRunningRuns(agent.repo)).find((r) => r.ticket === "t2")).toMatchObject({
      id: noBranch.data.run,
      step: "implement",
      agent: "codex",
    });
    // no_run と人の claim では開かない。no_run と agent は同時に指定できない
    expect(
      (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t3",
          no_run: true,
        })
      ).data.run,
    ).toBeNull();
    expect(
      (await runCommand(ticketClaim, human, { no_worktree: true, ticket: "t4" })).data.run,
    ).toBeNull();
    await expect(
      runCommand(ticketClaim, human, { no_worktree: true, ticket: "t5", agent: "codex" }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t5",
        no_run: true,
        agent: "codex",
      }),
    ).rejects.toBeInstanceOf(UsageError);
    // agent を判定できなければ開かずに警告し、claim 自体は成功する
    agent.env = {};
    const undetected = await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t5",
    });
    expect(undetected.data).toMatchObject({ status: "in_progress", run: null });
    expect(undetected.warnings).toEqual([
      expect.stringMatching(/^The implement Run is not open: .*--agent/),
    ]);
    expect((await peekRunningRuns(agent.repo)).map((r) => r.ticket).sort()).toEqual(["t1", "t2"]);

    // claim が開く step は Core が決める implement で、workflow.yaml に前の形の steps（opens_on）を書いても変わらない
    await writeFile(
      path.join(human.repo.dataDir, "workflow.yaml"),
      "steps:\n  - { id: build, opens_on: claim }\n  - { id: review }\n",
    );
    await recordBaseline(human.repo);
    await human.store.rescan();
    await runCommand(ticketCreate, human, { title: "F" });
    const later = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    later.env = { CLAUDECODE: "1" };
    const legacy = await runCommand(ticketClaim, later, {
      no_worktree: true,
      ticket: "t6",
      approved_by: "human",
    });
    expect(legacy.data.run).not.toBeNull();
    expect(
      (await peekRunningRuns(later.repo))
        .filter((r) => r.ticket === "t6")
        .map((r) => [r.ticket, r.step]),
    ).toEqual([["t6", "implement"]]);
  });

  it("ticket update --pr と照合の PR の発見は、実行中の実装の Run を success で閉じて finished_at を PR の作成時刻にし、閉じた Run への run finish は記録を変えない（RN-6）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    for (const title of ["With --pr", "Found by sync", "Reopened after PR"])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const runs = {
      t1: (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
          branch: "t1",
        })
      ).data.run!,
      t2: (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t2",
          branch: "t2",
        })
      ).data.run!,
      t3: (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t3",
          branch: "t3",
        })
      ).data.run!,
    };
    for (const b of ["t1", "t2", "t3"]) await git(f.cloneA, ["branch", b]);
    // t3 の PR は Run の開始（00:00）より前に作られている（PR の後に implement を開き直した形）
    const restore = await fakeGh(f.root, {
      "t1|41":
        '{"number":41,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T01:00:00Z"}',
      "t2|42":
        '{"number":42,"state":"OPEN","isDraft":false,"mergedAt":null,"createdAt":"2026-11-06T02:00:00Z"}',
      "t3|43":
        '{"number":43,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-05T23:00:00Z"}',
    });
    try {
      clock = new Date("2026-11-06T03:00:00Z");
      // --pr：PR の作成時刻で success に閉じ、チケットの更新と同じ書き込みに入る
      const updated = await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      expect(updated.data.pr).toBe(41);
      expect(updated.warnings[0]).toMatch(/^Closed the implementation Run r\S+ of t1 with success/);
      const closed = agent.store.runs.get(runs.t1)!.data;
      expect(closed).toMatchObject({
        ticket: "t1",
        step: "implement",
        result: "success",
        finished_at: "2026-11-06T01:00:00Z",
        error: null,
      });
      expect((await peekRunningRuns(agent.repo)).map((r) => r.ticket).sort()).toEqual(["t2", "t3"]);
      await runCommand(commit, agent, {});
      expect(
        (await git(agent.repo.dataDir, ["show", "--name-only", "--format=", "HEAD"])).stdout,
      ).toContain(`runs/${runs.t1}.json`);

      // 閉じた Run への run finish は記録を変えず、警告して返す
      const head = (await git(agent.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
      const again = await runCommand(runFinish, agent, { run: runs.t1, result: "failure" });
      expect(again.data).toMatchObject({ result: "success", finished_at: "2026-11-06T01:00:00Z" });
      expect(again.warnings).toEqual([
        `Run ${runs.t1} is already closed with success (finished_at 2026-11-06T01:00:00Z). The record is not changed`,
      ]);
      expect((await git(agent.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
      expect(agent.store.runs.get(runs.t1)!.data).toEqual(closed);

      // 照合：ブランチ名で見つけた PR（t2）で閉じ、Run の開始より前に作られた PR（t3）では閉じずに警告する。
      // 閉じ方の組み合わせ（記録済みの番号で引いた PR・作成時刻を読めない PR・閉じた PR）は reconcile-judge.test.ts が見る
      const synced = await runCommand(sync, agent, {});
      expect(synced.data.reconciled).toEqual([
        { id: "t2", from: "in_progress", to: "review", when: ["pr_open", "!pr_draft"] },
      ]);
      expect(synced.data.pr_recorded).toEqual([
        { id: "t2", pr: 42 },
        { id: "t3", pr: 43 },
      ]);
      expect(synced.data.runs_closed).toEqual([
        { id: "t2", run: runs.t2, opener: "claim", result: "success" },
      ]);
      expect(synced.warnings).toContainEqual(
        expect.stringMatching(
          /^t3: implementation Run r\S+ started after PR #43 was created \(2026-11-05T23:00:00Z\), so reconcile does not close it/,
        ),
      );
      expect(agent.store.runs.get(runs.t2)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T02:00:00Z",
      });
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([runs.t3]);
      expect((await git(agent.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
        `Reconcile t2: in_progress → review (pr_open, !pr_draft). Record PR numbers: t2: #42, t3: #43. Record implementation Runs: t2 ${runs.t2} success`,
      );
      // 2 回目は閉じるものがない（t3 は開いたまま）
      expect((await runCommand(sync, agent, {})).data.runs_closed).toEqual([]);
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([runs.t3]);
    } finally {
      restore();
    }
  });

  it("ticket update --pr は PR の作成時刻を取れなければ今の時刻で閉じて警告し、開いた Run がなければ閉じない（RN-6）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, human, { title: "No gh" });
    await runCommand(ticketCreate, human, { title: "No run" });
    await runCommand(ticketCreate, human, { title: "PR before run" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const run = (
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        branch: "t1",
      })
    ).data.run!;
    await runCommand(ticketClaim, human, { no_worktree: true, ticket: "t2", branch: "t2" });
    const reopened = (
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t3",
        branch: "t3",
      })
    ).data.run!;
    // gh は PR #9（Run の開始より前に作られた）だけを知っている
    const restore = await fakeGh(f.root, {
      "9": '{"number":9,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-05T23:00:00Z"}',
    });
    try {
      clock = new Date("2026-11-06T04:00:00Z");
      const updated = await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 7 });
      expect(updated.warnings[0]).toBe(
        "PR #7 not found, so the finished_at of the implementation Run is set to the current time",
      );
      expect(agent.store.runs.get(run)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T04:00:00Z",
      });
      // 開いた Run のないチケットでは何も閉じず、警告もない
      const plain = await runCommand(ticketUpdate, human, { ticket: "t2", pr: 8 });
      expect(plain.warnings).toEqual([]);
      expect(plain.data.pr).toBe(8);
      // PR が Run の開始より前なら、PR の作成時刻ではなく今の時刻で閉じる
      const late = await runCommand(ticketUpdate, agent, { ticket: "t3", pr: 9 });
      expect(late.warnings[0]).toBe(
        `PR #9 was created before Run ${reopened} started, so the finished_at of the implementation Run is set to the current time`,
      );
      expect(agent.store.runs.get(reopened)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T04:00:00Z",
      });
    } finally {
      restore();
    }
  });

  it("run finish は、見た後に別の文脈が閉じた Run や索引が古い Run でも、記録を変えずに警告して返す（RN-6）", async () => {
    const f = await initializedFixture();
    const human = await reopenInitialized(f);
    await runCommand(ticketCreate, human, { title: "Raced" });
    const stale = await agentWithRuns(f.cloneA, () => new Date("2026-11-06T00:00:00Z"));
    const run = (
      await runCommand(ticketClaim, stale, {
        no_worktree: true,
        ticket: "t1",
        branch: "t1",
        approved_by: "human",
      })
    ).data.run!;
    // 別の文脈（別のプロセスの dg に相当）が先に閉じる。stale の索引には集計がまだない
    const other = await agentWithRuns(f.cloneA, () => new Date("2026-11-06T01:00:00Z"));
    const first = await runCommand(runFinish, other, { run, result: "success" });
    expect(first.data).toMatchObject({ result: "success", finished_at: "2026-11-06T01:00:00Z" });
    expect(stale.store.runs.has(run)).toBe(false);

    const second = await runCommand(runFinish, stale, {
      run,
      result: "failure",
      error: "負けた方",
    });
    expect(second.data).toMatchObject({
      id: run,
      result: "success",
      error: null,
      finished_at: "2026-11-06T01:00:00Z",
    });
    expect(second.warnings).toEqual([
      `Run ${run} is already closed with success (finished_at 2026-11-06T01:00:00Z). The record is not changed`,
    ]);
    expect(await peekRunningRuns(stale.repo)).toEqual([]);
    // 知らない Run は変わらず見つからない
    await expect(
      runCommand(runFinish, stale, { run: "r20261031-000000-0000", result: "success" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("照合が閉じようとした実装の Run が別の文脈で先に閉じていても、sync は止まらずに警告し、ほかのチケットの照合と Run の閉じ方は変わらない（RN-6）", async () => {
    const f = await initializedFixture();
    const clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    for (const title of ["Raced", "Other"]) await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const raced = (
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        branch: "t1",
      })
    ).data.run!;
    const other = (
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t2",
        branch: "t2",
      })
    ).data.run!;
    for (const b of ["t1", "t2"]) await git(f.cloneA, ["branch", b]);
    const restore = await fakeGh(f.root, {
      "t1|41":
        '{"number":41,"state":"OPEN","isDraft":false,"mergedAt":null,"createdAt":"2026-11-06T01:00:00Z"}',
      "t2|42":
        '{"number":42,"state":"OPEN","isDraft":false,"mergedAt":null,"createdAt":"2026-11-06T02:00:00Z"}',
    });
    try {
      // 別の文脈（別のプロセスや別のマシンの sync に相当）が、照合が t1 の Run を閉じる直前に先に閉じる。
      // 閉じた後も実行中の記録が残っていた形にして、照合の閉じる操作が REJECTED を受ける
      const otherCtx = await agentWithRuns(f.cloneA, () => new Date("2026-11-06T00:30:00Z"));
      race.beforeClose = async () => {
        // 書き込みのロックは照合が持っているので、記録の書き出しだけを行う（finishRun の代わり）
        await closeRun(otherCtx.store, otherCtx.repo, raced, {
          result: "success",
          finishedAt: "2026-11-06T00:30:00Z",
          now: new Date("2026-11-06T00:30:00Z"),
        });
      };

      const synced = await runCommand(sync, agent, {});
      expect(race.beforeClose).toBeUndefined();
      expect(synced.warnings).toContain(
        `t1: the implementation Run ${raced} was already closed (another operation or another machine closed it first), so it is not closed in reconcile`,
      );
      expect(synced.data.runs_closed).toEqual([
        { id: "t2", run: other, opener: "claim", result: "success" },
      ]);
      expect(agent.store.runs.get(other)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T02:00:00Z",
      });
      expect(await peekRunningRuns(agent.repo)).toEqual([]);
    } finally {
      race.beforeClose = undefined;
      restore();
    }
  });

  // 1 回の照合が閉じる 3 通りの Run を通す：PR の発見による実装の Run（t1）、次の Run の開始を区切りにした手直しの Run（t2）、
  // 対象にならなかったチケット（別のマシンが todo に戻した t3）の実装の Run
  it("照合の結果の push が拒否されたら、コミットをローカルに残して警告し、次の sync が取り込み直して送る。取り込み直しが競合で止まっても、閉じた Run（PR の発見・手直し・対象外のチケット）の記録と実行中の記録の消去は二重にも欠けにもならない（RN-6）", async () => {
    const f = await initializedBothFixture();
    // t2 の実装は前の日に済ませる（手直しの Run と同じ秒に始まった Run は区切りに数えるので、実装の Run の開始を手直しより前にする）。
    // その後の時計は止めておく：照合が t1 に書く updated_at が claim のときと同じ値になり、B との競合が pr だけになる
    let clock = new Date("2026-11-05T23:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    for (const title of ["Rejected push", "Fix Run", "Back to todo"])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const claim = async (input: { ticket: string; branch?: string; without_branch?: boolean }) =>
      (await runCommand(ticketClaim, agent, { approved_by: "human", no_worktree: true, ...input }))
        .data.run!;
    await claim({ ticket: "t2", branch: "t2" });
    // gh はまだ置かないので、実装の Run は今の時刻で閉じる
    await runCommand(ticketUpdate, agent, { ticket: "t2", pr: 42 });
    clock = new Date("2026-11-06T00:00:00Z");
    const run = await claim({ ticket: "t1", branch: "t1" });
    const back = await claim({ ticket: "t3", without_branch: true });
    for (const branch of ["t1", "t2"]) await git(f.cloneA, ["branch", branch]);
    /** B が t1 の pr を書き換えて送る（照合が記録する pr: 41 と違う値なら、同じ項目の競合になる） */
    const pushFromB = async (pr: number) => {
      await runCommand(ticketUpdate, b, { ticket: "t1", pr });
      expect((await runCommand(sync, b, {})).data.pushed).toBe(true);
    };
    let b: CommandContext;
    let restore = () => {};
    try {
      // t2 はもう一度の claim で手直しの Run を開く。その後に見直しの Run が、手直しを閉じずに始まって終わった形
      // （別のマシン・前の版の dg）を startRun で作る。照合は、記録済みの見直しの Run の開始を区切りに手直しを閉じる
      const fix = await claim({ ticket: "t2" });
      const review = (
        await startRun(agent.repo, {
          ticket: "t2",
          step: "review",
          agent: "claude-code",
          now: clock,
        })
      ).id;
      await runCommand(runFinish, agent, { run: review, result: "success" });
      // ここまでの書き込みは、照合を通さずに先に送っておく（下の sync が送るのを照合の結果だけにして、その push の拒否を見る）
      await runCommand(commit, agent, {});
      await git(agent.repo.dataDir, [
        "push",
        agent.repo.dataRemote!,
        `HEAD:${agent.repo.dataBranch}`,
      ]);
      // 別のマシン（clone B）は claim までを取り込み、t3 を todo に戻して送る。A の t3 の実装の Run は開いたまま残る
      b = await reopenInitialized(f, { cwd: f.cloneB });
      await runCommand(sync, b, {});
      await runCommand(ticketUnclaim, b, { ticket: "t3" });
      await runCommand(sync, b, {});
      // gh はここから置く（B の上の sync が t1 の PR を先に見つけて記録しないように）
      restore = await fakeGh(f.root, {
        "t1|41":
          '{"number":41,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T01:00:00Z"}',
        "t2|42":
          '{"number":42,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T01:00:00Z"}',
      });
      const closedRuns = [run, fix, back];
      /** 閉じた Run の集計のコミットは 1 つで、どの Run の記録もそのコミットにだけあり、実行中の記録のファイルは残っていない */
      const closedOnce = async () => {
        const log = async (...args: string[]) =>
          (await git(agent.repo.dataDir, ["log", ...args])).stdout.trim().split("\n");
        expect((await log("--format=%s")).filter((s) => s.includes(` ${run} `))).toEqual([
          `Record PR numbers: t1: #41. Record implementation Runs: t1 ${run} success, t3 ${back} failure. Record fix Runs: t2 ${fix} success`,
        ]);
        const commits = await Promise.all(
          closedRuns.map((id) => log("--format=%H", "--", `runs/${id}.json`)),
        );
        expect(commits.map((c) => c.length)).toEqual([1, 1, 1]);
        expect(new Set(commits.flat()).size).toBe(1);
        const local = await readdir(path.join(agent.repo.localDir, "runs"));
        expect(local.filter((name) => closedRuns.some((id) => name.includes(id)))).toEqual([]);
        expect(await peekRunningRuns(agent.repo)).toEqual([]);
      };

      // 照合が取り込みを済ませた後（Run を閉じる直前）に、B が先にリモートへ送る。照合の結果の push は拒否される
      race.beforeClose = () => pushFromB(77);
      const rejected = await runCommand(sync, agent, {});
      expect(race.beforeClose).toBeUndefined();
      expect(rejected.warnings).toContainEqual(
        expect.stringContaining("Cannot push the reconcile result: "),
      );
      expect(rejected.warnings).toContainEqual(
        `t2: closed with start of the next Run ${review} as the boundary (time of the boundary, since there was no push before it)`,
      );
      expect(rejected.data.pushed).toBe(false);
      expect(rejected.data.status).toMatchObject({ ahead: 1, dirty: false });
      expect(rejected.data.pr_recorded).toEqual([{ id: "t1", pr: 41 }]);
      expect(rejected.data.runs_closed).toEqual([
        { id: "t1", run, opener: "claim", result: "success" },
        { id: "t2", run: fix, opener: "reclaim", result: "success" },
        { id: "t3", run: back, opener: "claim", result: "failure" },
      ]);
      const closed = closedRuns.map((id) => agent.store.runs.get(id)!.data);
      expect(closed).toMatchObject([
        { result: "success", finished_at: "2026-11-06T01:00:00Z" },
        // 手直しの Run の開始と同じ秒に始まった見直しの Run が区切り。push はないので区切りの時刻
        { result: "success", finished_at: agent.store.runs.get(review)!.data.started_at },
        { result: "failure", error: "Went back to todo during reconcile" },
      ]);
      const recorded = (ctx: CommandContext) =>
        closedRuns.map((id) => ctx.store.runs.get(id)?.data);
      await closedOnce();

      // 次の sync の取り込み直しは、B の pr: 77 と競合して止まる。閉じた Run はローカルのコミットに残り、閉じ直さない
      const stopped = await runCommand(sync, agent, {});
      expect(stopped.data.conflicts).toEqual(["tickets/t1.md"]);
      expect(stopped.data).toMatchObject({ pushed: false, runs_closed: [], pr_recorded: [] });
      expect(recorded(agent)).toEqual(closed);
      await closedOnce();

      // B が同じ値（pr: 41）にして競合がなくなると、次の sync が取り込み直して送る。Run の記録は 1 つのまま B にも届く
      await pushFromB(41);
      const resent = await runCommand(sync, agent, {});
      expect(resent.data).toMatchObject({
        conflicts: [],
        integrated: true,
        pushed: true,
        runs_closed: [],
        pr_recorded: [],
      });
      expect(resent.data.status).toMatchObject({ ahead: 0, behind: 0, dirty: false });
      expect(recorded(agent)).toEqual(closed);
      await closedOnce();
      await runCommand(sync, b, {});
      expect(recorded(b)).toEqual(closed);
      expect(b.store.tickets.get("t1")?.data.pr).toBe(41);
    } finally {
      race.beforeClose = undefined;
      restore();
    }
  });

  it("チケットの操作が付随して閉じる Run を別の文脈が先に閉じていても、move・unclaim・update --pr は止まらずに警告する（RN-6）", async () => {
    const f = await initializedFixture();
    const clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    for (const title of ["Move", "Unclaim", "PR"]) await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const runs = {
      t1: (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
          without_branch: true,
        })
      ).data.run!,
      t2: (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t2",
          branch: "t2",
        })
      ).data.run!,
      t3: (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t3",
          branch: "t3",
        })
      ).data.run!,
    };
    // 別の文脈（別のプロセスの dg や別のマシンの sync に相当）が、操作が Run を閉じる直前に先に閉じる
    const otherCtx = await agentWithRuns(f.cloneA, () => new Date("2026-11-06T00:30:00Z"));
    const closeFirst = (run: RunId) => {
      race.beforeClose = async () => {
        // 書き込みのロックは操作が持っているので、記録の書き出しだけを行う（finishRun の代わり）
        await closeRun(otherCtx.store, otherCtx.repo, run, {
          result: "success",
          finishedAt: "2026-11-06T00:30:00Z",
          now: new Date("2026-11-06T00:30:00Z"),
        });
      };
    };
    const rejected = (ticket: string, run: RunId) =>
      `${ticket}: the implementation Run ${run} was already closed (another operation or another machine closed it first), so it is not closed in this operation`;
    /** 別の文脈が閉じたとおりの記録が残り、操作は書き換えていない */
    const closedByOther = (run: RunId) =>
      expect(agent.store.runs.get(run)!.data).toMatchObject({
        result: "success",
        error: null,
        finished_at: "2026-11-06T00:30:00Z",
      });
    const restore = await fakeGh(f.root, {
      "43": '{"number":43,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T01:00:00Z"}',
    });
    try {
      closeFirst(runs.t1);
      const moved = await runCommand(ticketMove, agent, { ticket: "t1", status: "review" });
      expect(race.beforeClose).toBeUndefined();
      expect(moved.data.status).toBe("review");
      expect(moved.warnings.filter((w) => w.includes(runs.t1))).toEqual([rejected("t1", runs.t1)]);
      closedByOther(runs.t1);

      closeFirst(runs.t2);
      const unclaimed = await runCommand(ticketUnclaim, agent, { ticket: "t2" });
      expect(race.beforeClose).toBeUndefined();
      expect(unclaimed.data.status).toBe("todo");
      expect(unclaimed.warnings.filter((w) => w.includes(runs.t2))).toEqual([
        rejected("t2", runs.t2),
      ]);
      closedByOther(runs.t2);

      closeFirst(runs.t3);
      const updated = await runCommand(ticketUpdate, agent, { ticket: "t3", pr: 43 });
      expect(race.beforeClose).toBeUndefined();
      expect(updated.data.pr).toBe(43);
      expect(updated.warnings.filter((w) => w.includes(runs.t3))).toEqual([
        rejected("t3", runs.t3),
      ]);
      closedByOther(runs.t3);
      expect(await peekRunningRuns(agent.repo)).toEqual([]);
    } finally {
      race.beforeClose = undefined;
      restore();
    }
  });

  it("unclaim は実行中の実装の Run を failure で閉じ、branch のないチケットの move の review・done は success で閉じる。branch のあるチケットの move では閉じない。move の abandoned は開いたままの実装・手直しの Run を failure で閉じ、branch のあるチケットを PR なしで done にすると実装の Run を success で閉じる（RN-6）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    // agent が abandoned と PR なしの done に動かせる Workflow（既定は人に限り、done に pr_merged と人の承認を求める）
    await writeOpenWorkflow(human);
    /** 閉じた Run の知らせだけを取り出す（読み取りの警告は除く） */
    const closedWarnings = (warnings: string[]) =>
      warnings.filter((w) => /^Closed the .* with (failure|success)/.test(w));
    for (const title of [
      "Unclaim",
      "Review",
      "Done",
      "With branch",
      "Abandoned",
      "Abandoned after fix",
      "Done without PR",
    ])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const runs = {
      t1: (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
          branch: "t1",
        })
      ).data.run!,
      t2: (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t2",
          without_branch: true,
        })
      ).data.run!,
      t3: (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t3",
          without_branch: true,
        })
      ).data.run!,
      t4: (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t4",
          branch: "t4",
        })
      ).data.run!,
    };
    const implement = (
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t5",
        branch: "t5",
      })
    ).data.run!;
    const implement2 = (
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t6",
        branch: "t6",
      })
    ).data.run!;
    // PR の記録を直接書いてから claim し直し、手直しの Run を開く（PR の発見の代わり）
    await agent.store.update("ticket", "t6", { pr: 42 });
    await recordBaseline(agent.repo);
    const fix = (
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t6",
        retry_reasons: ["指摘 A"],
      })
    ).data.run!;
    const doneRun = (
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t7",
        branch: "t7",
      })
    ).data.run!;
    clock = new Date("2026-11-06T05:00:00Z");

    const unclaimed = await runCommand(ticketUnclaim, agent, { ticket: "t1" });
    expect(unclaimed.data.status).toBe("todo");
    expect(unclaimed.warnings[0]).toMatch(/^Closed the implementation Run r\S+ of t1 with failure/);
    expect(agent.store.runs.get(runs.t1)!.data).toMatchObject({
      result: "failure",
      error: "Returned to todo by ticket unclaim",
      finished_at: "2026-11-06T05:00:00Z",
    });

    const reviewed = await runCommand(ticketMove, agent, { ticket: "t2", status: "review" });
    expect(reviewed.warnings[0]).toMatch(/^Closed the implementation Run r\S+ of t2 with success/);
    expect(agent.store.runs.get(runs.t2)!.data).toMatchObject({
      result: "success",
      finished_at: "2026-11-06T05:00:00Z",
    });
    const done = await runCommand(ticketMove, agent, { ticket: "t3", status: "done" });
    expect(done.warnings[0]).toMatch(/^Closed the implementation Run r\S+ of t3 with success/);
    expect(agent.store.runs.get(runs.t3)!.data).toMatchObject({ result: "success" });

    // branch のあるチケットは PR の記録・発見が閉じるので、move では開いたまま。閉じた Run は実行中の記録から消えている
    const moved = await runCommand(ticketMove, agent, { ticket: "t4", status: "review" });
    expect(moved.warnings).toEqual([]);
    expect(agent.store.runs.has(runs.t4)).toBe(false);
    // t5〜t7 の Run は後の abandoned・done が閉じるので、ここでは t1〜t4 の Run だけを見る
    const firstFour: string[] = Object.values(runs);
    expect(
      (await peekRunningRuns(agent.repo)).map((r) => r.id).filter((id) => firstFour.includes(id)),
    ).toEqual([runs.t4]);

    const abandoned = await runCommand(ticketMove, agent, { ticket: "t5", status: "abandoned" });
    expect(closedWarnings(abandoned.warnings)).toEqual([
      expect.stringMatching(/^Closed the implementation Run r\S+ of t5 with failure/),
    ]);
    expect(agent.store.runs.get(implement)!.data).toMatchObject({
      result: "failure",
      finished_at: "2026-11-06T05:00:00Z",
    });

    // 手直しの Run も、実装の Run と同じく開いたままなら failure で閉じる
    const abandonedFix = await runCommand(ticketMove, agent, { ticket: "t6", status: "abandoned" });
    expect(closedWarnings(abandonedFix.warnings)).toEqual([
      expect.stringMatching(/^Closed the implementation Run r\S+ of t6 with failure/),
      expect.stringMatching(/^Closed the fix Run r\S+ of t6 with failure/),
    ]);
    expect(agent.store.runs.get(implement2)!.data).toMatchObject({ result: "failure" });
    expect(agent.store.runs.get(fix)!.data).toMatchObject({ result: "failure" });

    // branch のあるチケットを PR なしで done にすると、実装の Run を success で閉じる
    const finished = await runCommand(ticketMove, agent, { ticket: "t7", status: "done" });
    expect(closedWarnings(finished.warnings)).toEqual([
      expect.stringMatching(/^Closed the implementation Run r\S+ of t7 with success/),
    ]);
    expect(agent.store.runs.get(doneRun)!.data).toMatchObject({
      result: "success",
      finished_at: "2026-11-06T05:00:00Z",
    });
    // 閉じた Run は実行中の記録から消えている（残るのは branch のある move で開いたままの t4 だけ）
    expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([runs.t4]);
    // 閉じる Run のない unclaim は警告を出さない
    await runCommand(ticketClaim, human, {
      no_worktree: true,
      ticket: "t1",
      branch: "t1-again",
    });
    expect((await runCommand(ticketUnclaim, human, { ticket: "t1" })).warnings).toEqual([]);
  });
});
