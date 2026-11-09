// チケットの流れのうち、起票・claim・照合と、それに付随して閉じる実装の Run

import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "../../test/helpers/git-fixture.js";
import { UsageError } from "../errors.js";
import type { RunId } from "../model/run.js";
import { resetGhCache } from "../git/facts.js";
import { recordBaseline } from "../git/outside.js";
import { closeRun, peekRunningRuns } from "../run/record.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { runFinish } from "./run.js";
import { commit, sync } from "./setup.js";
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
  fixture,
  initialized,
  agentWithRuns,
  fakeGh,
  runCleanups,
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

describe("チケットの流れ（照合と claim）", () => {
  it("ticket show は作業ブランチの worktree のパスを git の一覧から引き、その worktree でも同じデータを読める（t381）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
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

  it("起票 → claim → review → マージの照合で done になる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
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
    expect(created.data.body).toContain("## 概要\n\n入力の検査");
    expect(created.data.body).toContain("## 受け入れ条件\n\n- [ ] a, b\n- [ ] c\n");
    expect(created.write).toMatchObject({ pushed: true });

    const claimed = await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "1" });
    expect(claimed.data).toMatchObject({
      status: "in_progress",
      assignee: "eiki",
      branch: "feature/t1-login-validation",
    });

    const review = await runCommand(ticketMove, ctx, { ticket: "t1", status: "review" });
    expect(review.data).toMatchObject({ status: "review", from: "in_progress" });
    // commit.mode は既定の batch なので作業ツリーに残る
    expect(review.write).toMatchObject({ committed: false });
    // 受け入れ条件は 1 項目だけ付けておく（照合が残りを警告する）
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });

    // 作業ブランチを作って main にマージする
    await git(f.cloneA, ["checkout", "-qb", "feature/t1-login-validation"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "実装"]);
    await git(f.cloneA, ["checkout", "-q", "main"]);
    await git(f.cloneA, ["merge", "-q", "--ff-only", "feature/t1-login-validation"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "main が進む"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);

    const synced = await runCommand(sync, ctx, {});
    expect(synced.data.reconciled).toEqual([
      { id: "t1", from: "review", to: "done", when: ["branch_merged"] },
    ]);
    expect(synced.warnings).toContain("t1: 受け入れ条件 2 が未チェックのまま done になった");
    expect(synced.data.pushed).toBe(true);
    expect(synced.data.status).toMatchObject({ ahead: 0, behind: 0, dirty: false });
    expect(ctx.store.tickets.get("t1")?.data.status).toBe("done");
    const log = (await git(ctx.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log[0]).toContain("照合で t1: review → done（branch_merged）");
    expect(log[1]).toBe("変更をまとめてコミット");
  });

  it("照合は gh がブランチ名で見つけた PR の番号を pr に記録し、記録済みや PR のないチケットは書き換えない", async () => {
    const f = await fixture();
    // software-development の Workflow だけが PR の事実（pr_*）を見る
    const ctx = await initialized(f.cloneA, {}, { template: "software-development" });
    await runCommand(ticketCreate, ctx, { title: "With PR" });
    await runCommand(ticketCreate, ctx, { title: "Without PR" });
    await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t1",
      branch: "feature/t1-with-pr",
    });
    await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t2",
      branch: "feature/t2-without-pr",
    });
    for (const b of ["feature/t1-with-pr", "feature/t2-without-pr"]) {
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
        '  feature/t1-with-pr|42) echo \'{"number":42,"state":"OPEN","isDraft":false,"mergedAt":null}\';;',
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
        "照合で t1: in_progress → review（pr_open, !pr_draft）。PR 番号を記録: t1: #42",
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

  it("照合は claim より前にマージされた同じブランチ名の PR を根拠にせず、claim の後にマージした PR では done にして pr を記録する（t206）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-02T05:00:00Z");
    const ctx = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    await runCommand(ticketCreate, ctx, { title: "Reused branch" });
    await runCommand(ticketCreate, ctx, { title: "Fresh PR" });
    await runCommand(ticketCreate, ctx, { title: "Legacy" });
    const claimed = await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t1",
      branch: "chore/reused",
    });
    expect(claimed.data.branch_at).toBe("2026-11-02T05:00:00Z");
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t2", branch: "chore/fresh" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t3", branch: "chore/legacy" });
    // branch_at のない古いチケットの形（created_at と比べる）
    await ctx.store.update("ticket", "t3", { branch_at: undefined });
    await recordBaseline(ctx.repo);
    // claim 直後に main から切った、commit のないブランチ（push はまだ）
    for (const b of ["chore/reused", "chore/fresh", "chore/legacy"]) {
      await git(f.cloneA, ["branch", b]);
    }

    // 偽の gh：chore/reused には前日にマージ済みの PR #105、chore/fresh には claim の後にマージした PR #200
    const bin = path.join(f.root, "fake-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        'case "$3" in',
        '  chore/reused|105) echo \'{"number":105,"state":"MERGED","isDraft":false,"mergedAt":"2026-11-01T10:00:00Z"}\';;',
        '  chore/legacy|90) echo \'{"number":90,"state":"MERGED","isDraft":false,"mergedAt":"2026-11-01T09:00:00Z"}\';;',
        '  chore/fresh|200) echo \'{"number":200,"state":"MERGED","isDraft":false,"mergedAt":"2026-11-02T06:00:00Z"}\';;',
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
      expect(t1Warnings[0]).toContain("2026-11-01T10:00:00Z");
      // このチケットの PR なら、ticket update で記録して sync を回し直す手を書く（前の作業の PR なら何もしない）
      expect(t1Warnings[0]).toContain("ticket update t1 --pr 105");
      expect(t1Warnings[0]).toContain("sync を回し直す");
      expect(t1Warnings[0]).toContain("前の作業のものなら何もしない");
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
      await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "chore/reused" });
      expect(ctx.store.tickets.get("t1")?.data.branch_at).toBe("2026-11-02T07:10:00Z");
      clock = new Date("2026-11-02T07:20:00Z");
      await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "chore/reused" });
      expect(ctx.store.tickets.get("t1")?.data.branch_at).toBe("2026-11-02T07:10:00Z");
      await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: null });
      expect(ctx.store.tickets.get("t1")?.data.branch_at).toBeUndefined();
    } finally {
      process.env["PATH"] = savedPath;
      resetGhCache();
    }
  });

  it("claim と update は、マージ済みのまま残った同じ名前のブランチと、終わっていない別のチケットが使う名前を拒否する（t216）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C", "D"]) await runCommand(ticketCreate, ctx, { title });
    // 前の作業：cloneB で chore/reused に積んで push し、main に ff マージした後で main が進む（ブランチは消さない）
    await git(f.cloneB, ["pull", "-q", "--ff-only", "origin", "main"]);
    await git(f.cloneB, ["checkout", "-qb", "chore/reused"]);
    await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", "前の作業"]);
    await git(f.cloneB, ["push", "-q", "origin", "chore/reused"]);
    await git(f.cloneB, ["checkout", "-q", "main"]);
    await git(f.cloneB, ["merge", "-q", "--ff-only", "chore/reused"]);
    await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", "次の作業"]);
    await git(f.cloneB, ["push", "-q", "origin", "main"]);
    // まだマージしていない作業のブランチ
    await git(f.cloneB, ["checkout", "-qb", "chore/wip"]);
    await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", "途中の作業"]);
    await git(f.cloneB, ["push", "-q", "origin", "chore/wip"]);

    // リモートに残ったマージ済みのブランチ（手元では一度も fetch していない）
    // 残ったブランチの拒否は、別の名前と、古いブランチを消すか base に揃える案内を返す
    const leftover = expect.objectContaining({
      code: "BRANCH_IN_USE",
      message: expect.stringMatching(/別の名前を指定する.*古いブランチを消すか base に揃えて/),
    });
    await expect(
      runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", branch: "chore/reused" }),
    ).rejects.toEqual(leftover);
    expect(ctx.store.tickets.get("t1")?.data).toMatchObject({ status: "todo" });
    expect(ctx.store.tickets.get("t1")?.data.branch).toBeUndefined();
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "chore/reused" }),
    ).rejects.toEqual(leftover);

    // 手元に残ったマージ済みのブランチ
    await git(ctx.repo.dataDir, ["fetch", "-q", "origin"]);
    await git(f.cloneA, ["branch", "chore/local", "origin/main~1"]);
    await expect(
      runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", branch: "chore/local" }),
    ).rejects.toEqual(leftover);

    // ref がない・切ったばかり・base にない作業があるときは通る
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", branch: "chore/new" });
    await git(f.cloneA, ["branch", "chore/cut", "origin/main"]);
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t2", branch: "chore/cut" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t3", branch: "chore/wip" });
    expect(ctx.store.tickets.get("t3")?.data).toMatchObject({
      status: "in_progress",
      branch: "chore/wip",
    });

    // 終わっていない別のチケットが記録している名前は、使っているチケットと別の名前の案内を返す
    await expect(
      runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t4", branch: "chore/new" }),
    ).rejects.toMatchObject({
      code: "BRANCH_IN_USE",
      message: expect.stringMatching(/t1（in_progress）が使っている。別の名前を指定する/),
    });
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t4", branch: "chore/cut" }),
    ).rejects.toMatchObject({
      code: "BRANCH_IN_USE",
      message: expect.stringContaining("別の名前を指定する"),
    });

    // リモートで消したブランチの古い追跡 ref は見ない
    await git(f.cloneB, ["push", "-q", "origin", "--delete", "chore/reused"]);
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t4", branch: "chore/reused" });
    expect(ctx.store.tickets.get("t4")?.data.branch).toBe("chore/reused");

    // 終わったチケットが記録している名前は使える
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "done" });
    await runCommand(ticketCreate, ctx, { title: "E" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t5", branch: "chore/cut" });
    expect(ctx.store.tickets.get("t5")?.data.branch).toBe("chore/cut");
  });

  it("PR の要らない作業は claim の without_branch で branch を持たず、照合で動かず警告も出ない。update の branch で付け外しできる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA, {}, { template: "software-development" });
    await runCommand(ticketCreate, ctx, { title: "Data cleanup" });
    await expect(
      runCommand(ticketClaim, ctx, {
        no_worktree: true,
        ticket: "t1",
        without_branch: true,
        branch: "feature/x",
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
    const attached = await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: "feature/gone" });
    expect(attached.data.branch).toBe("feature/gone");
    expect((await runCommand(sync, ctx, {})).warnings).toContain(
      "t1: 作業ブランチがローカルにもリモートにも見つからない",
    );
    const detached = await runCommand(ticketUpdate, ctx, { ticket: "t1", branch: null });
    expect(detached.data.branch).toBeUndefined();
    expect((await runCommand(sync, ctx, {})).warnings).toEqual([]);

    // agent は受け入れ条件を確かめたら自分で done にできる（Workflow の制約がなければ）
    const done = await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    expect(done.data.status).toBe("done");
  });

  it("gh が PR がないと答えた review のチケットは閉じた PR と警告しない。閉じた PR には警告する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA, {}, { template: "software-development" });
    await runCommand(ticketCreate, ctx, { title: "No PR yet" });
    await runCommand(ticketCreate, ctx, { title: "Closed PR" });
    await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t1",
      branch: "feature/t1-no-pr",
    });
    await runCommand(ticketClaim, ctx, {
      no_worktree: true,
      ticket: "t2",
      branch: "feature/t2-closed",
    });
    for (const b of ["feature/t1-no-pr", "feature/t2-closed"]) await git(f.cloneA, ["branch", b]);
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
        '  feature/t2-closed) echo \'{"number":7,"state":"CLOSED","isDraft":false,"mergedAt":null}\';;',
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
      expect(synced.warnings).toContain("t2: PR がマージされずに閉じている");
      expect(synced.warnings.filter((w) => w.startsWith("t1:"))).toEqual([]);
    } finally {
      process.env["PATH"] = savedPath;
      resetGhCache();
    }
  });

  it("agent の claim は実装の Run を開いて run に ID を出し、no_run と人の claim では開かず、agent を判定できなければ警告だけして claim は成功する（RN-5）", async () => {
    const f = await fixture();
    const human = await initialized(f.cloneA, {}, { template: "software-development" });
    for (const title of ["A", "B", "C", "D", "E"]) await runCommand(ticketCreate, human, { title });
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    agent.env = { CLAUDECODE: "1" };
    // 環境変数から判定した agent で、opens_on: claim の implement の Run が開く
    const claimed = await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t1" });
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
      (await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t3", no_run: true })).data
        .run,
    ).toBeNull();
    expect(
      (await runCommand(ticketClaim, human, { no_worktree: true, ticket: "t4" })).data.run,
    ).toBeNull();
    await expect(
      runCommand(ticketClaim, human, { no_worktree: true, ticket: "t5", agent: "codex" }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      runCommand(ticketClaim, agent, {
        no_worktree: true,
        ticket: "t5",
        no_run: true,
        agent: "codex",
      }),
    ).rejects.toBeInstanceOf(UsageError);
    // agent を判定できなければ開かずに警告し、claim 自体は成功する
    agent.env = {};
    const undetected = await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t5" });
    expect(undetected.data).toMatchObject({ status: "in_progress", run: null });
    expect(undetected.warnings).toEqual([
      expect.stringMatching(/^implement の Run を開いていない: .*--agent/),
    ]);
    expect((await peekRunningRuns(agent.repo)).map((r) => r.ticket).sort()).toEqual(["t1", "t2"]);
  });

  it("claim が開く step は Workflow の opens_on: claim の step、なければ implement。語彙になければ開かずに警告する（RN-5）", async () => {
    const f = await fixture();
    const human = await initialized(f.cloneA);
    const workflow = (id: string, steps: string) =>
      writeFile(
        path.join(human.repo.dataDir, `workflows/${id}.yaml`),
        `id: ${id}\nname: ${id}\nsteps:\n${steps}`,
      );
    await workflow("build", "  - { id: build, opens_on: claim }\n  - { id: review }\n");
    await workflow("plain", "  - { id: implement }\n  - { id: review }\n");
    await workflow("noimpl", "  - { id: research }\n");
    await recordBaseline(human.repo);
    await human.store.rescan();
    for (const wf of ["build", "plain", "noimpl"])
      await runCommand(ticketCreate, human, { title: wf, workflow: wf });
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    agent.env = { CLAUDECODE: "1" };
    expect(
      (await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t1" })).data.run,
    ).not.toBeNull();
    expect(
      (await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t2" })).data.run,
    ).not.toBeNull();
    const missing = await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t3" });
    expect(missing.data).toMatchObject({ status: "in_progress", run: null });
    expect(missing.warnings).toEqual([
      expect.stringMatching(
        /^implement の Run を開いていない: step implement は Workflow noimpl の steps にない/,
      ),
    ]);
    // 同じ秒に始めた Run の並びは ID の末尾の乱数で決まるので、並べ替えてから比べる
    expect((await peekRunningRuns(agent.repo)).map((r) => [r.ticket, r.step]).sort()).toEqual([
      ["t1", "build"],
      ["t2", "implement"],
    ]);
  });

  it("ticket update --pr と照合の PR の発見は、実行中の実装の Run を success で閉じて finished_at を PR の作成時刻にし、閉じた Run への run finish は記録を変えない（RN-6）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    for (const title of ["With --pr", "Found by sync", "Recorded before", "Reopened after PR"])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const runs = {
      t1: (
        await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t1", branch: "feat/t1" })
      ).data.run!,
      t2: (
        await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t2", branch: "feat/t2" })
      ).data.run!,
      t3: (
        await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t3", branch: "feat/t3" })
      ).data.run!,
      t4: (
        await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t4", branch: "feat/t4" })
      ).data.run!,
    };
    for (const b of ["feat/t1", "feat/t2", "feat/t3", "feat/t4"])
      await git(f.cloneA, ["branch", b]);
    // t3 は PR 番号を記録済み（この機能より前に記録した形）で、Run は開いたまま
    await agent.store.update("ticket", "t3", { pr: 43 });
    await recordBaseline(agent.repo);
    // t4 の PR は Run の開始（00:00）より前に作られている（PR の後に implement を開き直した形）
    const restore = await fakeGh(f.root, {
      "feat/t1|41":
        '{"number":41,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T01:00:00Z"}',
      "feat/t2|42":
        '{"number":42,"state":"OPEN","isDraft":false,"mergedAt":null,"createdAt":"2026-11-06T02:00:00Z"}',
      "feat/t3|43":
        '{"number":43,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T02:30:00Z"}',
      "feat/t4|44":
        '{"number":44,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-05T23:00:00Z"}',
    });
    try {
      clock = new Date("2026-11-06T03:00:00Z");
      // --pr：PR の作成時刻で success に閉じ、チケットの更新と同じ書き込みに入る
      const updated = await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      expect(updated.data.pr).toBe(41);
      expect(updated.warnings[0]).toMatch(/^t1 の実装の Run r\S+ を success で閉じた/);
      const closed = agent.store.runs.get(runs.t1)!.data;
      expect(closed).toMatchObject({
        ticket: "t1",
        step: "implement",
        result: "success",
        finished_at: "2026-11-06T01:00:00Z",
        error: null,
      });
      expect((await peekRunningRuns(agent.repo)).map((r) => r.ticket).sort()).toEqual([
        "t2",
        "t3",
        "t4",
      ]);
      await runCommand(commit, agent, {});
      expect(
        (await git(agent.repo.dataDir, ["show", "--name-only", "--format=", "HEAD"])).stdout,
      ).toContain(`runs/${runs.t1}.json`);

      // 閉じた Run への run finish は記録を変えず、警告して返す
      const head = (await git(agent.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
      const again = await runCommand(runFinish, agent, { run: runs.t1, result: "failure" });
      expect(again.data).toMatchObject({ result: "success", finished_at: "2026-11-06T01:00:00Z" });
      expect(again.warnings).toEqual([
        `Run ${runs.t1} は既に success で閉じている（finished_at 2026-11-06T01:00:00Z）。記録は変えない`,
      ]);
      expect((await git(agent.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
      expect(agent.store.runs.get(runs.t1)!.data).toEqual(closed);

      // 照合：ブランチ名で見つけた PR（t2）と記録済みの番号で引いた PR（t3）の両方で閉じる。
      // Run の開始より前に作られた PR（t4）では閉じずに警告する
      const synced = await runCommand(sync, agent, {});
      expect(synced.data.reconciled).toEqual([
        { id: "t2", from: "in_progress", to: "review", when: ["pr_open", "!pr_draft"] },
      ]);
      expect(synced.data.pr_recorded).toEqual([
        { id: "t2", pr: 42 },
        { id: "t4", pr: 44 },
      ]);
      expect(synced.data.runs_closed).toEqual([
        { id: "t2", run: runs.t2, opener: "claim", result: "success" },
        { id: "t3", run: runs.t3, opener: "claim", result: "success" },
      ]);
      expect(synced.warnings).toContainEqual(
        expect.stringMatching(
          /^t4: 実装の Run r\S+ は PR #44 の作成（2026-11-05T23:00:00Z）より後に始まったので照合では閉じない/,
        ),
      );
      expect(agent.store.runs.get(runs.t2)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T02:00:00Z",
      });
      expect(agent.store.runs.get(runs.t3)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T02:30:00Z",
      });
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([runs.t4]);
      expect((await git(agent.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
        `照合で t2: in_progress → review（pr_open, !pr_draft）。PR 番号を記録: t2: #42, t4: #44。実装の Run を記録: t2 ${runs.t2} success, t3 ${runs.t3} success`,
      );
      // 2 回目は閉じるものがない（t4 は開いたまま）
      expect((await runCommand(sync, agent, {})).data.runs_closed).toEqual([]);
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([runs.t4]);
    } finally {
      restore();
    }
  });

  it("ticket update --pr は PR の作成時刻を取れなければ今の時刻で閉じて警告し、開いた Run がなければ閉じない（RN-6）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(f.cloneA, { now: () => clock });
    await runCommand(ticketCreate, human, { title: "No gh" });
    await runCommand(ticketCreate, human, { title: "No run" });
    await runCommand(ticketCreate, human, { title: "PR before run" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const run = (
      await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t1", branch: "feat/t1" })
    ).data.run!;
    await runCommand(ticketClaim, human, { no_worktree: true, ticket: "t2", branch: "feat/t2" });
    const reopened = (
      await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t3", branch: "feat/t3" })
    ).data.run!;
    // gh は PR #9（Run の開始より前に作られた）だけを知っている
    const restore = await fakeGh(f.root, {
      "9": '{"number":9,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-05T23:00:00Z"}',
    });
    try {
      clock = new Date("2026-11-06T04:00:00Z");
      const updated = await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 7 });
      expect(updated.warnings[0]).toBe(
        "PR #7 が見つからないので、実装の Run の finished_at は今の時刻にする",
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
        `PR #9 は Run ${reopened} の開始より前に作られたので、実装の Run の finished_at は今の時刻にする`,
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
    const f = await fixture();
    const human = await initialized(f.cloneA);
    await runCommand(ticketCreate, human, { title: "Raced" });
    const stale = await agentWithRuns(f.cloneA, () => new Date("2026-11-06T00:00:00Z"));
    const run = (
      await runCommand(ticketClaim, stale, { no_worktree: true, ticket: "t1", branch: "feat/t1" })
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
      `Run ${run} は既に success で閉じている（finished_at 2026-11-06T01:00:00Z）。記録は変えない`,
    ]);
    expect(await peekRunningRuns(stale.repo)).toEqual([]);
    // 知らない Run は変わらず見つからない
    await expect(
      runCommand(runFinish, stale, { run: "r20261031-000000-0000", result: "success" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("照合が閉じようとした実装の Run が別の文脈で先に閉じていても、sync は止まらずに警告し、ほかのチケットの照合と Run の閉じ方は変わらない（RN-6）", async () => {
    const f = await fixture();
    const clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    for (const title of ["Raced", "Other"]) await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const raced = (
      await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t1", branch: "feat/t1" })
    ).data.run!;
    const other = (
      await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t2", branch: "feat/t2" })
    ).data.run!;
    for (const b of ["feat/t1", "feat/t2"]) await git(f.cloneA, ["branch", b]);
    const restore = await fakeGh(f.root, {
      "feat/t1|41":
        '{"number":41,"state":"OPEN","isDraft":false,"mergedAt":null,"createdAt":"2026-11-06T01:00:00Z"}',
      "feat/t2|42":
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
        `t1: 実装の Run ${raced} は既に閉じていた（別の操作や別のマシンが先に閉じた）ので、照合では閉じない`,
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

  it("チケットの操作が付随して閉じる Run を別の文脈が先に閉じていても、move・unclaim・update --pr は止まらずに警告する（RN-6）", async () => {
    const f = await fixture();
    const clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(f.cloneA, { now: () => clock });
    for (const title of ["Move", "Unclaim", "PR"]) await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const runs = {
      t1: (
        await runCommand(ticketClaim, agent, {
          no_worktree: true,
          ticket: "t1",
          without_branch: true,
        })
      ).data.run!,
      t2: (
        await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t2", branch: "feat/t2" })
      ).data.run!,
      t3: (
        await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t3", branch: "feat/t3" })
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
      `${ticket}: 実装の Run ${run} は既に閉じていた（別の操作や別のマシンが先に閉じた）ので、この操作では閉じない`;
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

  it("unclaim は実行中の実装の Run を failure で閉じ、branch のないチケットの move の review・done は success で閉じる。branch のあるチケットの move では閉じない（RN-6）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(f.cloneA, { now: () => clock });
    for (const title of ["Unclaim", "Review", "Done", "With branch"])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const runs = {
      t1: (
        await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t1", branch: "feat/t1" })
      ).data.run!,
      t2: (
        await runCommand(ticketClaim, agent, {
          no_worktree: true,
          ticket: "t2",
          without_branch: true,
        })
      ).data.run!,
      t3: (
        await runCommand(ticketClaim, agent, {
          no_worktree: true,
          ticket: "t3",
          without_branch: true,
        })
      ).data.run!,
      t4: (
        await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t4", branch: "feat/t4" })
      ).data.run!,
    };
    clock = new Date("2026-11-06T05:00:00Z");

    const unclaimed = await runCommand(ticketUnclaim, agent, { ticket: "t1" });
    expect(unclaimed.data.status).toBe("todo");
    expect(unclaimed.warnings[0]).toMatch(/^t1 の実装の Run r\S+ を failure で閉じた/);
    expect(agent.store.runs.get(runs.t1)!.data).toMatchObject({
      result: "failure",
      error: "ticket unclaim で todo に戻した",
      finished_at: "2026-11-06T05:00:00Z",
    });

    const reviewed = await runCommand(ticketMove, agent, { ticket: "t2", status: "review" });
    expect(reviewed.warnings[0]).toMatch(/^t2 の実装の Run r\S+ を success で閉じた/);
    expect(agent.store.runs.get(runs.t2)!.data).toMatchObject({
      result: "success",
      finished_at: "2026-11-06T05:00:00Z",
    });
    const done = await runCommand(ticketMove, agent, { ticket: "t3", status: "done" });
    expect(done.warnings[0]).toMatch(/^t3 の実装の Run r\S+ を success で閉じた/);
    expect(agent.store.runs.get(runs.t3)!.data).toMatchObject({ result: "success" });

    // branch のあるチケットは PR の記録・発見が閉じるので、move では開いたまま。閉じた Run は実行中の記録から消えている
    const moved = await runCommand(ticketMove, agent, { ticket: "t4", status: "review" });
    expect(moved.warnings).toEqual([]);
    expect(agent.store.runs.has(runs.t4)).toBe(false);
    expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([runs.t4]);
    // 閉じる Run のない unclaim は警告を出さない
    await runCommand(ticketClaim, human, {
      no_worktree: true,
      ticket: "t1",
      branch: "feat/t1-again",
    });
    expect((await runCommand(ticketUnclaim, human, { ticket: "t1" })).warnings).toEqual([]);
  });

  it("ticket move の abandoned は開いたままの実装・手直しの Run を failure で閉じ、branch のあるチケットを PR なしで done にすると実装の Run を success で閉じる（RN-6）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(f.cloneA, { now: () => clock });
    /** 閉じた Run の知らせだけを取り出す（読み取りの警告は除く） */
    const closedWarnings = (warnings: string[]) =>
      warnings.filter((w) => /を (failure|success) で閉じた/.test(w));
    for (const title of ["Abandoned", "Abandoned after fix", "Done without PR"])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const implement = (
      await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t1", branch: "feat/t1" })
    ).data.run!;
    const implement2 = (
      await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t2", branch: "feat/t2" })
    ).data.run!;
    // PR の記録を直接書いてから claim し直し、手直しの Run を開く（PR の発見の代わり）
    await agent.store.update("ticket", "t2", { pr: 42 });
    await recordBaseline(agent.repo);
    const fix = (
      await runCommand(ticketClaim, agent, {
        no_worktree: true,
        ticket: "t2",
        retry_reasons: ["指摘 A"],
      })
    ).data.run!;
    const done = (
      await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t3", branch: "feat/t3" })
    ).data.run!;
    clock = new Date("2026-11-06T05:00:00Z");

    const abandoned = await runCommand(ticketMove, agent, { ticket: "t1", status: "abandoned" });
    expect(closedWarnings(abandoned.warnings)).toEqual([
      expect.stringMatching(/^t1 の実装の Run r\S+ を failure で閉じた/),
    ]);
    expect(agent.store.runs.get(implement)!.data).toMatchObject({
      result: "failure",
      finished_at: "2026-11-06T05:00:00Z",
    });

    // 手直しの Run も、実装の Run と同じく開いたままなら failure で閉じる
    const abandonedFix = await runCommand(ticketMove, agent, { ticket: "t2", status: "abandoned" });
    expect(closedWarnings(abandonedFix.warnings)).toEqual([
      expect.stringMatching(/^t2 の実装の Run r\S+ を failure で閉じた/),
      expect.stringMatching(/^t2 の手直しの Run r\S+ を failure で閉じた/),
    ]);
    expect(agent.store.runs.get(implement2)!.data).toMatchObject({ result: "failure" });
    expect(agent.store.runs.get(fix)!.data).toMatchObject({ result: "failure" });

    // branch のあるチケットを PR なしで done にすると、実装の Run を success で閉じる
    const finished = await runCommand(ticketMove, agent, { ticket: "t3", status: "done" });
    expect(closedWarnings(finished.warnings)).toEqual([
      expect.stringMatching(/^t3 の実装の Run r\S+ を success で閉じた/),
    ]);
    expect(agent.store.runs.get(done)!.data).toMatchObject({
      result: "success",
      finished_at: "2026-11-06T05:00:00Z",
    });
    // 閉じた Run は実行中の記録から消えている
    expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([]);
  });
});
