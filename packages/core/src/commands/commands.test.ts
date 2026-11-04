import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixture,
  createLocalOnlyRepo,
  git,
  type Fixture,
} from "../../test/helpers/git-fixture.js";
import { UsageError } from "../errors.js";
import { pickUser } from "../model/actor.js";
import { defaultConfig } from "../model/config.js";
import { resetGhCache } from "../git/facts.js";
import { osUserName } from "../git/repo.js";
import { openContext, type ContextOptions } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { epicAdd, epicClose, epicCreate, epicReopen, epicShow, epicUpdate } from "./epic.js";
import { findCommand } from "./index.js";
import {
  iterationAdd,
  iterationClose,
  iterationCreate,
  iterationReopen,
  iterationUpdate,
  iterationShow,
  iterationStart,
} from "./iteration.js";
import {
  planApprove,
  planClose,
  planCreate,
  planList,
  planReadiness,
  planShow,
  type ReadinessTicket,
} from "./plan.js";
import { projectCreate } from "./project.js";
import {
  configSet,
  configShow,
  init,
  lint,
  sync,
  validate,
  whoami,
  type ConfigShowView,
} from "./setup.js";
import {
  ticketCheck,
  ticketClaim,
  ticketCreate,
  ticketDelete,
  ticketImport,
  ticketList,
  ticketMove,
  ticketShow,
  ticketUnclaim,
  ticketUpdate,
} from "./ticket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

/** 制約を書いた Workflow（strict）をデータディレクトリに置いて索引を作り直す */
async function writeStrictWorkflow(ctx: CommandContext): Promise<void> {
  await writeFile(
    path.join(ctx.repo.dataDir, "workflows/strict.yaml"),
    [
      "id: strict",
      "name: Strict",
      "transitions:",
      "  - { from: todo, to: in_progress, requires: [deps_done] }",
      "  - { from: todo, to: done, by: [] }",
      "  - { from: todo, to: abandoned, by: [human] }",
      "  - { from: in_progress, to: abandoned, by: [human] }",
      "  - { from: review, to: abandoned, by: [human] }",
      "  - { from: done, to: todo, by: [human] }",
      "",
    ].join("\n"),
  );
  await ctx.store.rescan();
}

/** init まで済ませた文脈を開く */
async function initialized(
  cwd: string,
  opts: Partial<ContextOptions> = {},
  initInput: { template?: "general" | "software-development" | "consulting" } = {},
): Promise<CommandContext> {
  const first = await openContext({
    cwd,
    initialize: {},
    actor: { kind: "human", user: "eiki" },
    ...opts,
  });
  await runCommand(init, first, initInput);
  return openContext({ cwd, actor: { kind: "human", user: "eiki" }, ...opts });
}

describe("init", () => {
  it("worktree・config・テンプレート・default プロジェクトを置いて push し、2 回目は何も作らない", async () => {
    const f = await fixture();
    const ctx = await openContext({ cwd: f.cloneA, initialize: {} });
    const r = await runCommand(init, ctx, { template: "software-development" });
    expect(r.data.worktree).toBe("orphan");
    expect(r.data.created).toEqual([
      "config.yaml",
      ".gitignore",
      ".gitattributes",
      "workflows/software-development.yaml",
      "workflows/consulting.yaml",
      "workflows/general.yaml",
      "projects/default.yaml",
    ]);
    expect(r.write).toMatchObject({ committed: true, pushed: true });
    expect(ctx.store.projects.get("default")?.data.workflow).toBe("software-development");
    const again = await openContext({ cwd: f.cloneA, initialize: {} });
    const r2 = await runCommand(init, again, {});
    expect(r2.data.worktree).toBe("existing");
    expect(r2.data.created).toEqual([]);
    expect(r2.write).toBeUndefined();
    // 別の clone は リモートから取り込み、何も書かないので書き込みの結果を返さない
    const b = await openContext({ cwd: f.cloneB, initialize: {} });
    expect(b.worktree).toBe("from_remote");
    expect(b.store.workflows.size).toBe(3);
    const rb = await runCommand(init, b, {});
    expect(rb.data).toMatchObject({ worktree: "from_remote", created: [] });
    expect(rb.write).toBeUndefined();
  });

  it("リモートがなくても init と起票ができる", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const ctx = await initialized(local.dir);
    expect(ctx.repo.remote).toBeNull();
    const r = await runCommand(ticketCreate, ctx, { title: "オフラインの起票" });
    expect(r.data.id).toBe("t1");
    expect(r.write).toMatchObject({ committed: true, pushed: false, provisional: false });
  });

  it("初期化していないリポジトリでは NOT_INITIALIZED になる", async () => {
    const f = await fixture();
    await expect(openContext({ cwd: f.cloneA })).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
  });
});

describe("チケットの流れ", () => {
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

    const claimed = await runCommand(ticketClaim, ctx, { ticket: "1" });
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
    await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "feature/t1-with-pr" });
    await runCommand(ticketClaim, ctx, { ticket: "t2", branch: "feature/t2-without-pr" });
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
    const claimed = await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "chore/reused" });
    expect(claimed.data.branch_at).toBe("2026-11-02T05:00:00Z");
    await runCommand(ticketClaim, ctx, { ticket: "t2", branch: "chore/fresh" });
    await runCommand(ticketClaim, ctx, { ticket: "t3", branch: "chore/legacy" });
    // branch_at のない古いチケットの形（created_at と比べる）
    await ctx.store.update("ticket", "t3", { branch_at: undefined });
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
      expect(t1Warnings[0]).toContain("--pr 105");
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
      await runCommand(ticketClaim, ctx, { ticket: "t1", without_branch: true });
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
      runCommand(ticketClaim, ctx, { ticket: "t1", branch: "chore/reused" }),
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
      runCommand(ticketClaim, ctx, { ticket: "t1", branch: "chore/local" }),
    ).rejects.toEqual(leftover);

    // ref がない・切ったばかり・base にない作業があるときは通る
    await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "chore/new" });
    await git(f.cloneA, ["branch", "chore/cut", "origin/main"]);
    await runCommand(ticketClaim, ctx, { ticket: "t2", branch: "chore/cut" });
    await runCommand(ticketClaim, ctx, { ticket: "t3", branch: "chore/wip" });
    expect(ctx.store.tickets.get("t3")?.data).toMatchObject({
      status: "in_progress",
      branch: "chore/wip",
    });

    // 終わっていない別のチケットが記録している名前は、使っているチケットと別の名前の案内を返す
    await expect(
      runCommand(ticketClaim, ctx, { ticket: "t4", branch: "chore/new" }),
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
    await runCommand(ticketClaim, ctx, { ticket: "t4", branch: "chore/reused" });
    expect(ctx.store.tickets.get("t4")?.data.branch).toBe("chore/reused");

    // 終わったチケットが記録している名前は使える
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "done" });
    await runCommand(ticketCreate, ctx, { title: "E" });
    await runCommand(ticketClaim, ctx, { ticket: "t5", branch: "chore/cut" });
    expect(ctx.store.tickets.get("t5")?.data.branch).toBe("chore/cut");
  });

  it("PR の要らない作業は claim の without_branch で branch を持たず、照合で動かず警告も出ない。update の branch で付け外しできる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA, {}, { template: "software-development" });
    await runCommand(ticketCreate, ctx, { title: "Data cleanup" });
    await expect(
      runCommand(ticketClaim, ctx, { ticket: "t1", without_branch: true, branch: "feature/x" }),
    ).rejects.toBeInstanceOf(UsageError);
    const claimed = await runCommand(ticketClaim, ctx, { ticket: "t1", without_branch: true });
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
    await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "feature/t1-no-pr" });
    await runCommand(ticketClaim, ctx, { ticket: "t2", branch: "feature/t2-closed" });
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

  it("既定ではどの遷移も通り、制約を書いた Workflow では by: []・by: [human]・requires: [deps_done] で拒否される", async () => {
    const f = await fixture();
    const human = await initialized(f.cloneA);
    // 既定（general）：todo → done も、依存が終わっていない claim も、agent の abandoned も通る
    await runCommand(ticketCreate, human, { title: "A" });
    await runCommand(ticketCreate, human, { title: "B", depends_on: ["t1"] });
    const agent = await openContext({
      cwd: f.cloneA,
      actor: { kind: "agent", user: "claude" },
    });
    expect(
      (await runCommand(ticketMove, human, { ticket: "t1", status: "done" })).data.status,
    ).toBe("done");
    expect((await runCommand(ticketClaim, agent, { ticket: "t2" })).data.status).toBe(
      "in_progress",
    );
    const dropped = (await runCommand(ticketMove, agent, { ticket: "t2", status: "abandoned" }))
      .data;
    expect(dropped.status).toBe("abandoned");
    expect(dropped.assignee).toBeUndefined();

    // strict：制約に当たる遷移だけが拒否される
    await writeStrictWorkflow(human);
    await runCommand(ticketCreate, human, { title: "C", workflow: "strict" });
    await runCommand(ticketCreate, human, { title: "D", depends_on: ["t3"], workflow: "strict" });
    await agent.store.rescan();
    await expect(
      runCommand(ticketMove, human, { ticket: "t3", status: "done" }),
    ).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "todo から done への遷移は Workflow がこの主体に許していない",
    });
    await expect(runCommand(ticketClaim, human, { ticket: "t4" })).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "todo から in_progress への遷移の条件を満たしていない: deps_done",
    });
    await expect(
      runCommand(ticketMove, agent, { ticket: "t3", status: "abandoned" }),
    ).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    const abandoned = await runCommand(ticketMove, human, { ticket: "t3", status: "abandoned" });
    expect(abandoned.data.status).toBe("abandoned");
    const list = await runCommand(ticketList, human, {});
    expect(list.data.map((t) => t.id)).toEqual(["t1", "t4"]);
    const all = await runCommand(ticketList, human, { include_abandoned: true });
    expect(all.data.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
    // 依存先が abandoned なら deps_done は満たされ、着手できる（WF-2）
    const ready = await runCommand(ticketList, human, { ready: true });
    expect(ready.data.map((t) => t.id)).toEqual(["t4"]);
    const claimed = await runCommand(ticketClaim, human, { ticket: "t4" });
    expect(claimed.data.status).toBe("in_progress");
  });

  it("list は各行に deps_done を載せ、show と同じく別の Project の依存先も見る", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(projectCreate, ctx, { id: "other" });
    await runCommand(ticketCreate, ctx, { title: "別の Project", project: "other" });
    await runCommand(ticketCreate, ctx, { title: "B", depends_on: ["t1"] });
    await runCommand(ticketCreate, ctx, { title: "C", depends_on: ["t2"] });
    const depsDone = async () =>
      (await runCommand(ticketList, ctx, { project: "default" })).data.map((t) => [
        t.id,
        t.deps_done,
      ]);
    expect(await depsDone()).toEqual([
      ["t2", false],
      ["t3", false],
    ]);
    // 依存先は default の一覧に出ないが、done になれば deps_done は真になる
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    expect(await depsDone()).toEqual([
      ["t2", true],
      ["t3", false],
    ]);
    const shown = await runCommand(ticketShow, ctx, { ticket: "t2" });
    expect(shown.data.deps_done).toBe(true);
    expect(shown.data.pending_deps).toEqual([]);
  });

  it("show は終わっていない依存先を ID と Status で出し、別の Project の終わった依存先は出さず、見つからない依存先は Status を null で出す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(projectCreate, ctx, { id: "other" });
    await runCommand(ticketCreate, ctx, { title: "別の Project・済み", project: "other" });
    await runCommand(ticketCreate, ctx, { title: "別の Project・途中", project: "other" });
    await runCommand(ticketCreate, ctx, { title: "やめた" });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "in_progress" });
    await runCommand(ticketMove, ctx, { ticket: "t3", status: "abandoned" });
    await runCommand(ticketCreate, ctx, { title: "待ち", depends_on: ["t1", "t2", "t3"] });
    const shown = await runCommand(ticketShow, ctx, { ticket: "t4" });
    expect(shown.data.pending_deps).toEqual([{ id: "t2", status: "in_progress" }]);
    expect(shown.data.deps_done).toBe(false);
    // 依存先を消すと Status の分からない待ちとして残る（deps_done と同じく待つ）
    await runCommand(ticketDelete, ctx, { ticket: "t1" });
    expect((await runCommand(ticketShow, ctx, { ticket: "t4" })).data.pending_deps).toEqual([
      { id: "t1", status: null },
      { id: "t2", status: "in_progress" },
    ]);
  });

  it("unclaim は自分（同じユーザの人と AI）の claim だけ外し、他人のものは force が要る", async () => {
    const f = await fixture();
    const eiki = await initialized(f.cloneA);
    await runCommand(ticketCreate, eiki, { title: "A" });
    await runCommand(ticketClaim, eiki, { ticket: "t1", branch: "feature/a" });
    const other = await openContext({ cwd: f.cloneA, actor: { kind: "human", user: "other" } });
    await expect(runCommand(ticketUnclaim, other, { ticket: "t1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    const r = await runCommand(ticketUnclaim, other, { ticket: "t1", force: true });
    expect(r.data).toMatchObject({ status: "todo" });
    expect(r.data.assignee).toBeUndefined();
    expect(r.data.branch).toBeUndefined();

    // eiki の AI が claim したものは eiki 本人が force なしで外せる
    const eikiAgent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    const byAgent = await runCommand(ticketClaim, eikiAgent, { ticket: "t1" });
    expect(byAgent.data.assignee).toBe("eiki/agent");
    await eiki.store.rescan();
    const released = await runCommand(ticketUnclaim, eiki, { ticket: "t1" });
    expect(released.data.status).toBe("todo");
  });

  it("whoami は操作している主体の ID・ユーザ名・種別と、本人とみなす ID（人とその AI）を返す", async () => {
    const f = await fixture();
    const human = await initialized(f.cloneA);
    expect((await runCommand(whoami, human, {})).data).toEqual({
      id: "eiki",
      user: "eiki",
      user_source: "flag",
      kind: "human",
      own_ids: ["eiki", "eiki/agent"],
    });
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    expect((await runCommand(whoami, agent, {})).data).toEqual({
      id: "eiki/agent",
      user: "eiki",
      user_source: "flag",
      kind: "agent",
      own_ids: ["eiki", "eiki/agent"],
    });
  });

  it("主体のユーザ名は --user > DEGUBOARD_USER > git config の deguboard.user > git の user.name > OS のユーザ名の順で決まり、whoami が出どころを返す（t217）", async () => {
    const f = await fixture();
    await initialized(f.cloneA);
    const who = async (actor: Parameters<typeof openContext>[0]["actor"]) => {
      const ctx = await openContext({ cwd: f.cloneA, ...(actor ? { actor } : {}) });
      const { user, user_source } = (await runCommand(whoami, ctx, {})).data;
      return { user, user_source };
    };
    // 入口が渡すもの：--user と DEGUBOARD_USER（pickUser）
    expect(await who(pickUser("flag-u", "env-u"))).toEqual({ user: "flag-u", user_source: "flag" });
    expect(await who(pickUser(undefined, "env-u"))).toEqual({ user: "env-u", user_source: "env" });
    // 入口が何も渡さなければ git から決める
    expect(await who(pickUser(undefined, undefined))).toEqual({
      user: "テスト",
      user_source: "user.name",
    });
    await git(f.cloneA, ["config", "deguboard.user", "deg"]);
    expect(await who(undefined)).toEqual({ user: "deg", user_source: "git-config" });
    expect(await who(pickUser(undefined, "env-u"))).toEqual({ user: "env-u", user_source: "env" });
    // どちらも空なら OS のユーザ名（passwd に項目がない環境では USER などの代わりの値。osUserName のテストで確かめる）
    await git(f.cloneA, ["config", "deguboard.user", ""]);
    await git(f.cloneA, ["config", "user.name", ""]);
    expect(await who(undefined)).toEqual({ user: osUserName(), user_source: "os" });
  });

  it("起票者は既定で操作した主体、created_by: human でユーザ本人になり、担当者は create / update / claim で付く", async () => {
    const f = await fixture();
    const human = await initialized(f.cloneA);
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    const byAgent = await runCommand(ticketCreate, agent, { title: "A" });
    expect(byAgent.data.created_by).toBe("eiki/agent");
    const directed = await runCommand(ticketCreate, agent, {
      title: "B",
      created_by: "human",
      assignee: "agent",
    });
    expect(directed.data).toMatchObject({ created_by: "eiki", assignee: "eiki/agent" });

    await human.store.rescan();
    const assigned = await runCommand(ticketUpdate, human, { ticket: "t1", assignee: "other" });
    expect(assigned.data.assignee).toBe("other");
    // 事前の担当者と別のユーザが claim すると上書きし、warnings で知らせる
    const claimed = await runCommand(ticketClaim, human, { ticket: "t1" });
    expect(claimed.data.assignee).toBe("eiki");
    expect(claimed.warnings).toContain("担当者を other から eiki に変えた");
    // todo に戻すと担当者は消える。起票者は残る
    const back = await runCommand(ticketMove, human, { ticket: "t1", status: "todo" });
    expect(back.data.assignee).toBeUndefined();
    expect(back.data.created_by).toBe("eiki/agent");
    const cleared = await runCommand(ticketUpdate, human, { ticket: "t2", assignee: null });
    expect(cleared.data.assignee).toBeUndefined();

    // 絞り込み（human / agent は自分に解く）
    await runCommand(ticketUpdate, human, { ticket: "t2", assignee: "agent" });
    const mine = await runCommand(ticketList, human, { assignee: "agent" });
    expect(mine.data.map((t) => t.id)).toEqual(["t2"]);
    const filed = await runCommand(ticketList, human, { created_by: "human" });
    expect(filed.data.map((t) => t.id)).toEqual(["t2"]);
    // 事前に担当者が付いていても ready には出る
    const ready = await runCommand(ticketList, human, { ready: true });
    expect(ready.data.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("旧名の claimed_by は assignee として読め、担当者を書く操作で消える", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    const file = path.join(ctx.repo.dataDir, "tickets/t1.md");
    const text = await readFile(file, "utf8");
    await writeFile(
      file,
      text.replace("status: todo", "status: in_progress\nclaimed_by: eiki@laptop"),
    );
    await ctx.store.rescan();
    const shown = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(shown.data.assignee).toBe("eiki@laptop");
    expect("claimed_by" in shown.data).toBe(false);
    // 旧 ID はホスト名を含むので別のユーザに見える。force で外すとファイルから claimed_by も消える
    const released = await runCommand(ticketUnclaim, ctx, { ticket: "t1", force: true });
    expect(released.data.assignee).toBeUndefined();
    expect(await readFile(file, "utf8")).not.toContain("claimed_by");
  });

  it("同じチケットを 2 つの clone が claim すると、負けた側は CLAIM_LOST で assignee を書き換えない", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    await runCommand(ticketCreate, a, { title: "A" });
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "agent", user: "b" },
    });
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await runCommand(ticketClaim, b, { ticket: "t1" });
      },
    };
    const racer = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "a" }, hooks });
    await expect(runCommand(ticketClaim, racer, { ticket: "t1" })).rejects.toMatchObject({
      code: "CLAIM_LOST",
    });
    expect(racer.store.tickets.get("t1")?.data.assignee).toBe("b/agent");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("ticket list の query は前後の空白を除き大文字小文字を区別せず、番号・タイトル・ラベルの部分一致で当たり、空白だけならすべてに当たる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketImport, ctx, {
      drafts: Array.from({ length: 12 }, (_, i) => ({
        title: `チケット ${i + 1}`,
        labels: i === 4 ? ["Frontend"] : [],
      })),
    });
    const ids = async (query: string) =>
      (await runCommand(ticketList, ctx, { query })).data.map((t) => t.id);
    expect(await ids(" T1 ")).toEqual(["t1", "t10", "t11", "t12"]);
    expect(await ids("frontEND")).toEqual(["t5"]);
    expect(await ids("チケット 12")).toEqual(["t12"]);
    const all = (await runCommand(ticketList, ctx, {})).data.map((t) => t.id);
    expect(all).toHaveLength(12);
    expect(await ids("   ")).toEqual(all);
  });

  it("import は仮キーを depends_on から参照でき、1 コミットで採番する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const r = await runCommand(ticketImport, ctx, {
      drafts: [
        { key: "schema", title: "スキーマ", acceptance: ["表が決まる"] },
        { key: "api", title: "API", depends_on: ["schema"] },
        { title: "画面", depends_on: ["api", "schema"] },
      ],
    });
    expect(r.data.map((t) => [t.id, t.depends_on])).toEqual([
      ["t1", []],
      ["t2", ["t1"]],
      ["t3", ["t2", "t1"]],
    ]);
    const shown = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(shown.data.body).toContain("- [ ] 表が決まる\n");
    const log = (await git(ctx.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log[0]).toBe("3 件のチケットを取り込み: t1, t2, t3");
    await expect(
      runCommand(ticketImport, ctx, {
        drafts: [
          { key: "x", title: "x", depends_on: ["y"] },
          { key: "y", title: "y", depends_on: ["x"] },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const ready = await runCommand(ticketList, ctx, { ready: true });
    expect(ready.data.map((t) => t.id)).toEqual(["t1"]);
  });

  it("update は属性と本文を直し、循環する依存と未定義のフィールドを拒否する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", workflow: "software-development" });
    await runCommand(ticketCreate, ctx, { title: "B", depends_on: ["t1"] });
    const r = await runCommand(ticketUpdate, ctx, {
      ticket: "t1",
      priority: "high",
      fields: { estimate: 3 },
      body: "## 概要\n\n直した\n",
    });
    expect(r.data).toMatchObject({ priority: "high", estimate: 3, body: "## 概要\n\n直した\n" });
    // acceptance は受け入れ条件の節だけを置き換え、節がなければ足す。body とは同時に指定できない
    const a1 = await runCommand(ticketUpdate, ctx, { ticket: "t1", acceptance: ["a", "b"] });
    expect(a1.data.body).toBe("## 概要\n\n直した\n\n## 受け入れ条件\n\n- [ ] a\n- [ ] b\n");
    await runCommand(ticketUpdate, ctx, {
      ticket: "t1",
      body: "## 概要\n\n直した\n\n## 受け入れ条件\n\n- [x] a\n- [ ] b\n",
    });
    const a2 = await runCommand(ticketUpdate, ctx, { ticket: "t1", acceptance: ["b", "a", "c"] });
    expect(a2.data.body).toBe(
      "## 概要\n\n直した\n\n## 受け入れ条件\n\n- [ ] b\n- [x] a\n- [ ] c\n",
    );
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t1", body: "x", acceptance: ["a"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t1", depends_on: ["t2"] }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t1", fields: { nope: 1 } }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const shown = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(shown.data.dependents).toEqual(["t2"]);
    const text = await readFile(path.join(ctx.repo.dataDir, "tickets/t1.md"), "utf8");
    expect(text).toContain("estimate: 3");
  });

  it("check は番号で受け入れ条件に印を付け外しし、show が acceptance を出す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", summary: "s", acceptance: ["a", "b", "c"] });
    const shown = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(shown.data.acceptance).toEqual([
      { index: 1, text: "a", checked: false },
      { index: 2, text: "b", checked: false },
      { index: 3, text: "c", checked: false },
    ]);
    const checked = await runCommand(ticketCheck, ctx, { ticket: "t1", items: [3, 1, 1] });
    expect(checked.data.body).toBe(
      "## 概要\n\ns\n\n## 受け入れ条件\n\n- [x] a\n- [ ] b\n- [x] c\n",
    );
    expect(checked.data.acceptance.map((i) => i.checked)).toEqual([true, false, true]);
    expect(checked.write).toMatchObject({ committed: false });
    const undone = await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1], undo: true });
    expect(undone.data.acceptance.map((i) => i.checked)).toEqual([false, false, true]);
    const none = await runCommand(ticketCheck, ctx, { ticket: "t1", all: true, undo: true });
    expect(none.data.acceptance.some((i) => i.checked)).toBe(false);
    const all = await runCommand(ticketCheck, ctx, { ticket: "t1", all: true });
    expect(all.data.acceptance.every((i) => i.checked)).toBe(true);
    // batch なので作業ツリーに残り、sync がまとめてコミットする
    await runCommand(sync, ctx, {});
    const log = (await git(ctx.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log[0]).toBe("変更をまとめてコミット");
  });

  it("check は all と番号の同時指定・無指定を INVALID_INPUT、節や項目がない・範囲外を NOT_FOUND で拒否する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", acceptance: ["a", "b", "c"] });
    await runCommand(ticketCreate, ctx, { title: "B", body: "本文だけ\n" });
    await runCommand(ticketCreate, ctx, { title: "C", summary: "雛形のまま" });
    await expect(
      runCommand(ticketCheck, ctx, { ticket: "t1", all: true, items: [1] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(runCommand(ticketCheck, ctx, { ticket: "t1", items: [] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(runCommand(ticketCheck, ctx, { ticket: "t2", items: [1] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(runCommand(ticketCheck, ctx, { ticket: "t3", all: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      runCommand(ticketCheck, ctx, { ticket: "t1", items: [2, 4] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("4") });
  });
});

describe("Epic と Iteration", () => {
  it("Epic は進捗を都度求め、終わっていないチケットが残ると force なしでは閉じられない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const epic = await runCommand(epicCreate, ctx, { title: "ログインの刷新", summary: "目的" });
    expect(epic.data).toMatchObject({ id: "e1", status: "open" });
    await runCommand(ticketCreate, ctx, { title: "A", epic: "e1" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(epicAdd, ctx, { epic: "1", tickets: ["t2"] });
    const shown = await runCommand(epicShow, ctx, { epic: "e1" });
    expect(shown.data.progress).toEqual({
      total: 2,
      done: 0,
      by_status: { todo: 2, in_progress: 0, review: 0, done: 0, abandoned: 0 },
    });
    await expect(runCommand(epicClose, ctx, { epic: "e1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    // 既定では agent も閉じられる（actor.human_only が空）
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    const closed = await runCommand(epicClose, agent, { epic: "e1", force: true });
    expect(closed.data.status).toBe("closed");
    expect(closed.data.closed_at).toBeDefined();
    expect(closed.warnings).toHaveLength(1);
    await expect(runCommand(ticketCreate, agent, { title: "C", epic: "e1" })).rejects.toMatchObject(
      { code: "REJECTED" },
    );
    const reopened = await runCommand(epicReopen, agent, { epic: "e1" });
    expect(reopened.data.closed_at).toBeUndefined();
  });

  it("actor.human_only に入れたコマンドだけが agent から拒否され、人は通る", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(epicCreate, ctx, { title: "E", summary: "目的" });
    await runCommand(iterationCreate, ctx, { name: "Sprint 1" });
    // カンマ区切りで配列に入り、エイリアスは正式名に直る
    const set = await runCommand(configSet, ctx, {
      key: "actor.human_only",
      value: "epic.close, sprint.close",
    });
    expect(set.data.actor.human_only).toEqual(["epic.close", "iteration.close"]);
    await expect(
      runCommand(configSet, ctx, { key: "actor.human_only", value: "epic.nope" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    await expect(runCommand(epicClose, agent, { epic: "e1" })).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    await expect(runCommand(iterationClose, agent, { iteration: "s1" })).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    // 一覧にない操作はそのまま行える
    await runCommand(epicUpdate, agent, { epic: "e1", title: "E2" });
    const human = await openContext({ cwd: f.cloneA });
    expect((await runCommand(epicClose, human, { epic: "e1" })).data.status).toBe("closed");
    // 空文字で空に戻ると、agent も閉じる・再開できる（文脈ごとに store を持つので開き直す）
    const cleared = await runCommand(configSet, human, { key: "actor.human_only", value: "" });
    expect(cleared.data.actor.human_only).toEqual([]);
    const agent2 = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    expect((await runCommand(epicReopen, agent2, { epic: "e1" })).data.status).toBe("open");
    expect((await runCommand(iterationClose, agent2, { iteration: "s1" })).data.status).toBe(
      "closed",
    );
  });

  it("Iteration は開始・終了でき、閉じるときに完了と持ち越しを数える", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const it1 = await runCommand(iterationCreate, ctx, {
      name: "Sprint 1",
      start: "2026-11-01",
      end: "2026-11-14",
    });
    expect(it1.data).toMatchObject({ id: "s1", status: "planned" });
    expect(it1.data).not.toHaveProperty("tickets");
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B", priority: "high" });
    const added = await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t2", "t1"] });
    expect(added.data).toEqual({ iteration: "s1", tickets: ["t2", "t1"] });
    await runCommand(iterationStart, ctx, { iteration: "1" });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "in_progress" });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    // 所属はチケットの iteration だけで表し、並びは優先度と番号（IT-2）
    const shown = await runCommand(iterationShow, ctx, { iteration: "s1" });
    expect(shown.data.items.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(shown.data).not.toHaveProperty("tickets");
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    const closed = await runCommand(iterationClose, agent, { iteration: "s1" });
    expect(closed.data).toMatchObject({ status: "closed", completed: 1, carried_over: 1 });
    expect(agent.store.tickets.get("t2")?.data.iteration).toBeUndefined();
    expect(agent.store.tickets.get("t1")?.data.iteration).toBe("s1");
  });

  it("update は指定した属性だけを直し、閉じた Iteration も直せる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(iterationCreate, ctx, {
      name: "Sprint 1",
      start: "2026-12-13",
      end: "2026-12-26",
    });
    const updated = await runCommand(iterationUpdate, ctx, { iteration: "1", goal: "履歴を読む" });
    expect(updated.data).toMatchObject({
      name: "Sprint 1",
      goal: "履歴を読む",
      start: "2026-12-13",
      end: "2026-12-26",
      status: "planned",
    });
    // start と end の形の誤りは入力の誤り（UsageError）で、どちらも記録を変えない
    for (const dates of [{ end: "12/27" }, { start: "2026-12-1" }, { start: "2026/12/13" }]) {
      await expect(
        runCommand(iterationUpdate, ctx, { iteration: "s1", ...dates }),
      ).rejects.toBeInstanceOf(UsageError);
    }
    expect(ctx.store.iterations.get("s1")?.data).toMatchObject({
      start: "2026-12-13",
      end: "2026-12-26",
    });
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    const renamed = await runCommand(iterationUpdate, ctx, {
      iteration: "s1",
      name: "Sprint 1b",
      goal: "",
      end: "2026-12-27",
    });
    expect(renamed.data).toMatchObject({
      name: "Sprint 1b",
      goal: "",
      end: "2026-12-27",
      status: "closed",
    });
  });

  it("閉じた Iteration は reopen で active に戻り、件数が消えてチケットを入れ直せる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(iterationCreate, ctx, { name: "Sprint 1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    // 閉じていなければ拒否
    await expect(runCommand(iterationReopen, ctx, { iteration: "s1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    const closed = await runCommand(iterationClose, ctx, { iteration: "s1" });
    expect(closed.data).toMatchObject({ status: "closed", completed: 0, carried_over: 1 });
    await expect(
      runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    // 既定では agent も再開できる。持ち越しがあれば入れ直しを促す
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    const reopened = await runCommand(iterationReopen, agent, { iteration: "1" });
    expect(reopened.data.status).toBe("active");
    expect(reopened.data.closed_at).toBeUndefined();
    expect(reopened.data.completed).toBeUndefined();
    expect(reopened.data.carried_over).toBeUndefined();
    // 再開は即座に push するので、まとめ待ちの変更を先にコミットした警告も並ぶ
    expect(reopened.warnings).toEqual([
      "まとめ待ちの変更を先にコミットした",
      "閉じたときに外した 1 件は戻らない。iteration add で入れ直す",
    ]);
    // 持ち越したチケットは戻らないので入れ直す
    expect(agent.store.tickets.get("t1")?.data.iteration).toBeUndefined();
    await runCommand(iterationAdd, agent, { iteration: "s1", tickets: ["t1"] });
    expect(agent.store.tickets.get("t1")?.data.iteration).toBe("s1");
    // 持ち越しがなければ警告は出ない
    await runCommand(ticketMove, agent, { ticket: "t1", status: "in_progress" });
    await runCommand(ticketMove, agent, { ticket: "t1", status: "done" });
    await runCommand(iterationClose, agent, { iteration: "s1" });
    const again = await runCommand(iterationReopen, agent, { iteration: "s1" });
    expect(again.warnings).toEqual(["まとめ待ちの変更を先にコミットした"]);
  });

  it("active の Iteration は Project に 1 つで、ほかに active があれば start と reopen を拒否する（IT-1）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(projectCreate, ctx, { id: "other" });
    for (const name of ["Sprint 1", "Sprint 2", "Sprint 3"])
      await runCommand(iterationCreate, ctx, { name });
    await runCommand(iterationCreate, ctx, { name: "別の Project", project: "other" });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    // 拒否のメッセージに今 active の Iteration を出し、記録は変えない
    await expect(runCommand(iterationStart, ctx, { iteration: "s2" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s1 が active"),
    });
    expect(ctx.store.iterations.get("s2")?.data.status).toBe("planned");
    // 別の Project の Iteration は数えない
    expect((await runCommand(iterationStart, ctx, { iteration: "s4" })).data.status).toBe("active");
    // 閉じれば次を始められ、閉じた方を再開するのは今の active を閉じてから
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    await runCommand(iterationStart, ctx, { iteration: "s2" });
    await expect(runCommand(iterationReopen, ctx, { iteration: "s1" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s2 が active"),
    });
    expect(ctx.store.iterations.get("s1")?.data.status).toBe("closed");
    await runCommand(iterationClose, ctx, { iteration: "s2" });
    expect((await runCommand(iterationReopen, ctx, { iteration: "s1" })).data.status).toBe(
      "active",
    );
  });

  it("2 つの clone が同時に別の Iteration を start すると、push で負けた側は検査からやり直して拒否される", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    for (const name of ["Sprint 1", "Sprint 2"]) await runCommand(iterationCreate, a, { name });
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "agent", user: "b" },
    });
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await runCommand(iterationStart, b, { iteration: "s2" });
      },
    };
    const racer = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "a" }, hooks });
    await expect(runCommand(iterationStart, racer, { iteration: "s1" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s2 が active"),
    });
    expect(racer.store.iterations.get("s1")?.data.status).toBe("planned");
    expect(racer.store.iterations.get("s2")?.data.status).toBe("active");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("reopen で push に負けても、相手が別の変更なら検査からやり直して成功し、警告を重ねない", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    await runCommand(iterationCreate, a, { name: "Sprint 1" });
    await runCommand(ticketCreate, a, { title: "A" });
    await runCommand(iterationAdd, a, { iteration: "s1", tickets: ["t1"] });
    await runCommand(iterationClose, a, { iteration: "s1" });
    await runCommand(sync, a, {});
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "agent", user: "b" },
    });
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await runCommand(iterationCreate, b, { name: "Sprint 2" });
      },
    };
    const racer = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "a" }, hooks });
    const reopened = await runCommand(iterationReopen, racer, { iteration: "s1" });
    expect(reopened.data.status).toBe("active");
    expect(reopened.warnings).toEqual([
      "閉じたときに外した 1 件は戻らない。iteration add で入れ直す",
    ]);
    // 相手の変更も取り込んでいる
    expect(racer.store.iterations.get("s2")?.data.name).toBe("Sprint 2");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("reopen で push に負け、相手が別の Iteration を start していれば、検査からやり直して拒否される", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    for (const name of ["Sprint 1", "Sprint 2"]) await runCommand(iterationCreate, a, { name });
    await runCommand(iterationClose, a, { iteration: "s1" });
    await runCommand(sync, a, {});
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "agent", user: "b" },
    });
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await runCommand(iterationStart, b, { iteration: "s2" });
      },
    };
    const racer = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "a" }, hooks });
    await expect(runCommand(iterationReopen, racer, { iteration: "s1" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s2 が active"),
    });
    expect(racer.store.iterations.get("s1")?.data.status).toBe("closed");
    expect(racer.store.iterations.get("s2")?.data.status).toBe("active");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("lint は同じ Project に 2 つ以上ある active の Iteration を指摘し、別の Project の active は数えない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(projectCreate, ctx, { id: "other" });
    for (const name of ["Sprint 1", "Sprint 2", "Sprint 3"])
      await runCommand(iterationCreate, ctx, { name });
    await runCommand(iterationCreate, ctx, { name: "別の Project", project: "other" });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    await runCommand(iterationStart, ctx, { iteration: "s4" });
    const multiple = async () =>
      (await runCommand(lint, ctx, {})).data.issues
        .filter((i) => i.code === "lint_iteration_multiple_active")
        .map((i) => [i.id, i.message]);
    expect(await multiple()).toEqual([]);
    // 手の編集やマージで 2 つ目の active ができた場合（start の検査を通らない）
    await ctx.store.update("iteration", "s3", { status: "active" });
    const message = "同じ Project に active の Iteration が 2 つある（s1, s3）";
    expect(await multiple()).toEqual([
      ["s1", message],
      ["s3", message],
    ]);
    expect(
      (await runCommand(lint, ctx, { project: "other" })).data.issues.filter(
        (i) => i.code === "lint_iteration_multiple_active",
      ),
    ).toEqual([]);
  });
});

describe("Plan", () => {
  it("create は承認待ちで作って即 push し、存在しない・終わった・別の開いた Plan のチケットを拒否する（PL-3）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C", "D", "E"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(ticketMove, ctx, { ticket: "t4", status: "done" });
    await runCommand(ticketMove, ctx, { ticket: "t5", status: "abandoned" });
    const created = await runCommand(planCreate, ctx, {
      tickets: ["t1", "2"],
      after: { t2: "t1" },
      scope: { t1: "API だけ" },
      approach: { t1: "既存の型を使う", t2: "画面は作らない" },
    });
    expect(created.data).toMatchObject({
      id: "p1",
      project: "default",
      tickets: ["t1", "t2"],
      after: { t2: ["t1"] },
      pending_approval: true,
      details: {
        t1: { scope: "API だけ", approach: "既存の型を使う" },
        t2: { approach: "画面は作らない" },
      },
    });
    expect(created.write).toMatchObject({ committed: true, pushed: true });
    const yaml = await readFile(path.join(ctx.repo.dataDir, "plans/p1.yaml"), "utf8");
    expect(yaml).toContain("pending_approval: true");
    // 同じチケットを 2 つの開いた Plan に入れられない
    await expect(runCommand(planCreate, ctx, { tickets: ["t3", "t1"] })).rejects.toMatchObject({
      code: "REJECTED",
    });
    // done と abandoned のチケットは入れられない
    await expect(runCommand(planCreate, ctx, { tickets: ["t4"] })).rejects.toMatchObject({
      code: "REJECTED",
    });
    await expect(runCommand(planCreate, ctx, { tickets: ["t5"] })).rejects.toMatchObject({
      code: "REJECTED",
    });
    // 存在しないチケットは NOT_FOUND
    await expect(runCommand(planCreate, ctx, { tickets: ["t99"] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // after は Plan の中のチケットだけで、循環できない
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t3"], after: { t3: "t4" } }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t3"], after: { t3: "t3" } }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(ctx.store.plans.size).toBe(1);
    // 閉じた Plan のチケットは別の Plan に入れられる
    await runCommand(planClose, ctx, { plan: "p1" });
    const next = await runCommand(planCreate, ctx, { tickets: ["t1", "t3"] });
    expect(next.data).toMatchObject({ id: "p2", tickets: ["t1", "t3"] });
  });

  it("create は after の循環と、Plan の外のチケットへの scope を拒否する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, ctx, { title });
    await expect(
      runCommand(planCreate, ctx, {
        tickets: ["t1", "t2", "t3"],
        after: { t1: ["t3"], t2: "t1", t3: "t2" },
      }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t1"], scope: { t2: "外" } }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(ctx.store.plans.size).toBe(0);
  });

  it("create は段階（tier）を details に記録し、不正な値と Plan の外のチケットを拒否する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B"]) await runCommand(ticketCreate, ctx, { title });
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t1"], tier: { t1: "huge" as "light" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t1"], tier: { t2: "light" } }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(ctx.store.plans.size).toBe(0);
    await runCommand(planCreate, ctx, {
      tickets: ["t1", "t2"],
      scope: { t1: "範囲" },
      tier: { t1: "light", t2: "heavy" },
    });
    const shown = await runCommand(planShow, ctx, { plan: "p1" });
    expect(shown.data.details).toEqual({
      t1: { scope: "範囲", tier: "light" },
      t2: { tier: "heavy" },
    });
  });

  it("show は進捗を Plan に書かず、チケットの状態から求めて待ちを出す（PL-2）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2", "t3"], after: { t2: ["t1"] } });
    const yaml = path.join(ctx.repo.dataDir, "plans/p1.yaml");
    const before = await readFile(yaml, "utf8");
    const first = await runCommand(planShow, ctx, { plan: "1" });
    expect(first.data.progress).toMatchObject({ total: 3, done: 0 });
    expect(first.data.items.map((t) => [t.id, t.waiting])).toEqual([
      ["t1", []],
      ["t2", ["t1"]],
      ["t3", []],
    ]);
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    await runCommand(ticketMove, ctx, { ticket: "t3", status: "abandoned" });
    const second = await runCommand(planShow, ctx, { plan: "p1" });
    expect(second.data.progress).toEqual({
      total: 2,
      done: 1,
      by_status: { todo: 1, in_progress: 0, review: 0, done: 1, abandoned: 1 },
    });
    expect(second.data.items.find((t) => t.id === "t2")?.waiting).toEqual([]);
    // Plan のファイルは書き換わらない
    expect(await readFile(yaml, "utf8")).toBe(before);
    expect(await readFile(yaml, "utf8")).not.toContain("progress");
  });

  it("show と list は、待ちの相手を after が先・depends_on が後で出し、着手できるものと次を Plan の順で決める（PL-6）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C", "D"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(ticketCreate, ctx, { title: "E", depends_on: ["t3", "t4"] });
    // items が [t1(after t2), t2, t3, t5(after t3、depends_on t3・t4)]
    await runCommand(planCreate, ctx, {
      tickets: ["t1", "t2", "t3", "t5"],
      after: { t1: "t2", t5: "t3" },
    });
    const first = await runCommand(planShow, ctx, { plan: "p1" });
    expect(first.data.items.map((t) => [t.id, t.waiting, t.ready])).toEqual([
      ["t1", ["t2"], false],
      ["t2", [], true],
      ["t3", [], true],
      ["t5", ["t3", "t4"], false],
    ]);
    expect(first.data.ready).toEqual(["t2", "t3"]);
    expect(first.data.next).toEqual({ id: "t2", waiting: [] });
    // t2 が終われば、段の浅い t3 より Plan の順で先の t1 が次になる
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "done" });
    const second = await runCommand(planShow, ctx, { plan: "p1" });
    expect(second.data.next).toEqual({ id: "t1", waiting: [] });
    // list の行も同じ値を持つ
    const [row] = (await runCommand(planList, ctx, {})).data;
    expect(row).toMatchObject({
      waiting: { t1: [], t2: [], t3: [], t5: ["t3", "t4"] },
      ready: ["t1", "t3"],
      next: { id: "t1", waiting: [] },
    });
    // 着手できる todo がなければ、Plan の順で先頭の todo とその待ちの相手を次に出す
    for (const id of ["t1", "t3"])
      await runCommand(ticketMove, ctx, { ticket: id, status: "in_progress" });
    const third = await runCommand(planShow, ctx, { plan: "p1" });
    expect(third.data.ready).toEqual([]);
    expect(third.data.next).toEqual({ id: "t5", waiting: ["t3", "t4"] });
  });

  it("消したチケットを after が指しても待たない。depends_on は deps_done と同じく待つ（PL-6）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2"], after: { t2: "t1" } });
    await runCommand(ticketDelete, ctx, { ticket: "t1" });
    const shown = await runCommand(planShow, ctx, { plan: "p1" });
    expect(shown.warnings).toEqual(["t1 が見つからない（削除された）"]);
    expect(shown.data.items.map((t) => [t.id, t.waiting, t.ready])).toEqual([["t2", [], true]]);
    expect(shown.data.next).toEqual({ id: "t2", waiting: [] });
    const [row] = (await runCommand(planList, ctx, {})).data;
    expect(row?.waiting).toEqual({ t2: [] });
  });

  it("depends_on は abandoned の依存先と別の Project の終わった依存先を待たず、消した依存先は deps_done と同じく待つ（PL-6）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(projectCreate, ctx, { id: "other" });
    // t1 は別の Project、t2 は abandoned にし、t3 は消す
    await runCommand(ticketCreate, ctx, { title: "別の Project", project: "other" });
    for (const title of ["やめる", "消す"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(ticketCreate, ctx, { title: "D", depends_on: ["t1"] });
    await runCommand(ticketCreate, ctx, { title: "E", depends_on: ["t2"] });
    await runCommand(ticketCreate, ctx, { title: "F", depends_on: ["t3"] });
    await runCommand(planCreate, ctx, { tickets: ["t4", "t5", "t6"] });
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "abandoned" });
    await runCommand(ticketDelete, ctx, { ticket: "t3" });
    const waits = async () =>
      (await runCommand(planShow, ctx, { plan: "p1" })).data.items.map((t) => [t.id, t.waiting]);
    expect(await waits()).toEqual([
      ["t4", ["t1"]],
      ["t5", []],
      ["t6", ["t3"]],
    ]);
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    expect(await waits()).toEqual([
      ["t4", []],
      ["t5", []],
      ["t6", ["t3"]],
    ]);
  });

  it("after が Plan の外を指しても待たず、閉じた Plan は着手できるものも次も出さない（PL-6）", () => {
    const rows: ReadinessTicket[] = [
      { id: "t1", status: "todo", depends_on: [] },
      { id: "t2", status: "todo", depends_on: [] },
      { id: "t3", status: "in_progress", depends_on: [] },
    ];
    const tickets = new Map<string, ReadinessTicket>(rows.map((t) => [t.id, t]));
    const ticketOf = (id: string) => tickets.get(id);
    // t3 は Plan に入っていない（壊れたデータ）。画面の依存グラフも辺を出さない
    const open = planReadiness(
      { tickets: ["t1", "t2"], after: { t1: ["t3"], t2: ["t1"] } },
      ticketOf,
    );
    expect(open).toEqual({
      waiting: { t1: [], t2: ["t1"] },
      ready: ["t1"],
      next: { id: "t1", waiting: [] },
    });
    const closed = planReadiness(
      { tickets: ["t1", "t2"], after: { t2: ["t1"] }, closed_at: "2026-11-02T00:00:00Z" },
      ticketOf,
    );
    expect(closed).toEqual({ waiting: { t1: [], t2: ["t1"] }, ready: [], next: null });
  });

  it("approve は approved_by と approved_at を書いて pending_approval を外し、close は closed_at を書く", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(planCreate, ctx, { tickets: ["t1"] });
    const approved = await runCommand(planApprove, ctx, { plan: "p1" });
    expect(approved.data).toMatchObject({ pending_approval: false, approved_by: "eiki" });
    expect(approved.data.approved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 二度目の承認は拒否する
    await expect(runCommand(planApprove, ctx, { plan: "p1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    const closed = await runCommand(planClose, ctx, { plan: "p1" });
    expect(closed.data.closed_at).toBeDefined();
    expect(closed.warnings).toEqual(["t1 を残したまま閉じた"]);
    await expect(runCommand(planClose, ctx, { plan: "p1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    await expect(runCommand(planApprove, ctx, { plan: "p1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    await expect(runCommand(planShow, ctx, { plan: "p9" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("list は状態と進捗を出して open・pending・approved・closed と Project で絞り、ticket show は開いた Plan を出す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(planCreate, ctx, { tickets: ["t1"] });
    await runCommand(planClose, ctx, { plan: "p1" });
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2"] });
    await runCommand(planApprove, ctx, { plan: "p2" });
    await runCommand(planCreate, ctx, { tickets: ["t3"] });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    const all = await runCommand(planList, ctx, {});
    expect(all.data.map((p) => [p.id, p.status])).toEqual([
      ["p1", "closed"],
      ["p2", "approved"],
      ["p3", "pending"],
    ]);
    expect(all.data[1]?.progress).toMatchObject({ total: 2, done: 1 });
    const ids = async (input: {
      status?: "open" | "pending" | "approved" | "closed";
      project?: string;
    }) => (await runCommand(planList, ctx, input)).data.map((p) => p.id);
    expect(await ids({ status: "open" })).toEqual(["p2", "p3"]);
    expect(await ids({ status: "pending" })).toEqual(["p3"]);
    expect(await ids({ status: "approved" })).toEqual(["p2"]);
    expect(await ids({ status: "closed" })).toEqual(["p1"]);
    expect(await ids({ project: "default" })).toEqual(["p1", "p2", "p3"]);
    expect(await ids({ project: "other" })).toEqual([]);
    // 閉じた Plan は出さず、開いた Plan だけを出す
    const shown = async (ticket: string) =>
      (await runCommand(ticketShow, ctx, { ticket })).data.plan;
    expect(await shown("t1")).toBe("p2");
    expect(await shown("t3")).toBe("p3");
    await runCommand(planClose, ctx, { plan: "p3" });
    expect(await shown("t3")).toBeNull();
  });

  it("agent の承認は agent の ID を記録し、actor.human_only に plan.approve を入れると拒否される", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(planCreate, ctx, { tickets: ["t1"] });
    await runCommand(planCreate, ctx, { tickets: ["t2"] });
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    const approved = await runCommand(planApprove, agent, { plan: "p1" });
    expect(approved.data.approved_by).toBe("eiki/agent");
    await runCommand(configSet, ctx, { key: "actor.human_only", value: "plan.approve" });
    const agent2 = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    await expect(runCommand(planApprove, agent2, { plan: "p2" })).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    });
  });
});

describe("用意", () => {
  it("validate と lint が指摘を出し、config.set が 1 項目を変える", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", body: "本文だけ\n" });
    // 雛形のまま（項目が空）
    await runCommand(ticketCreate, ctx, { title: "B", summary: "s" });
    // 概要にだけチェックリストがあっても、受け入れ条件は空
    await runCommand(ticketCreate, ctx, {
      title: "C",
      body: "## 概要\n\n- [ ] x\n\n## 受け入れ条件\n\n- [ ] \n",
    });
    // 項目があれば指摘しない。済みの項目と占位の … も項目として数える
    await runCommand(ticketCreate, ctx, { title: "D", acceptance: ["a"] });
    await runCommand(ticketCreate, ctx, {
      title: "E",
      body: "## 概要\n\ns\n\n## 受け入れ条件\n\n- [x] 済み\n- [ ] …\n",
    });
    await expect(
      runCommand(ticketCreate, ctx, { title: "F", acceptance: ["a\nb"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // done のチケットは未チェックが残っていても（F）、全部付いていても（G）指摘しない。未チェックは照合で done に進めたときだけ sync が警告する
    await runCommand(ticketCreate, ctx, { title: "F", acceptance: ["a", "b", "c"] });
    await runCommand(ticketCheck, ctx, { ticket: "t6", items: [2] });
    await runCommand(ticketMove, ctx, { ticket: "t6", status: "done" });
    await runCommand(ticketCreate, ctx, { title: "G", acceptance: ["a"] });
    await runCommand(ticketCheck, ctx, { ticket: "t7", all: true });
    await runCommand(ticketMove, ctx, { ticket: "t7", status: "done" });
    const v = await runCommand(validate, ctx, {});
    expect(v.data.ok).toBe(true);
    const l = await runCommand(lint, ctx, {});
    expect(l.data.issues.map((i) => [i.id, i.code, i.message])).toEqual([
      ["t1", "lint_summary_missing", "本文に ## 概要 がない"],
      ["t1", "lint_acceptance_missing", "本文に ## 受け入れ条件 がない"],
      ["t2", "lint_acceptance_empty", "受け入れ条件に項目がない"],
      ["t3", "lint_acceptance_empty", "受け入れ条件に項目がない"],
    ]);
    const c = await runCommand(configSet, ctx, { key: "commit.mode", value: "each" });
    expect(c.data.commit.mode).toBe("each");
    expect(c.data.git.remote).toBe("origin");
    // 画面は配列をそのまま渡す。config.show の fields は値と一緒に既定値と説明を返す
    const list = await runCommand(configSet, ctx, {
      key: "actions.test",
      value: ["mise", "run", "check"],
    });
    expect(list.data.actions.test).toEqual(["mise", "run", "check"]);
    const shown = (await runCommand(configShow, ctx, { fields: true })).data as ConfigShowView;
    expect(shown.config.commit.mode).toBe("each");
    expect(shown.fields.find((x) => x.key === "commit.mode")?.default).toBe("batch");
    expect((await runCommand(configShow, ctx, {})).data).toMatchObject({
      commit: { mode: "each" },
    });
    await expect(
      runCommand(configSet, ctx, { key: "commit.mode", value: "nope" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("config.set は文字列の項目に数字だけ・true だけの値を文字列のまま保存し、真偽値・数値・リストの項目は変換して保存する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    // 文字列の項目：数字だけ・true・false だけでも文字列のまま
    const year = await runCommand(configSet, ctx, { key: "git.base_branch", value: "2026" });
    expect(year.data.git.base_branch).toBe("2026");
    const t = await runCommand(configSet, ctx, { key: "git.remote", value: "true" });
    expect(t.data.git.remote).toBe("true");
    const fl = await runCommand(configSet, ctx, { key: "worktree.root", value: "false" });
    expect(fl.data.worktree.root).toBe("false");
    // 真偽値の項目："true"・"false" は真偽値に直し、ほかの文字列は拒む
    const on = await runCommand(configSet, ctx, { key: "auto.merge", value: "true" });
    expect(on.data.auto.merge).toBe(true);
    const off = await runCommand(configSet, ctx, { key: "auto.merge", value: "false" });
    expect(off.data.auto.merge).toBe(false);
    await expect(
      runCommand(configSet, ctx, { key: "auto.merge", value: "yes" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // 数値：スキーマに数値の項目はないので、スキーマにない項目（looseObject が通す）で今のとおり数値に直すことを確かめる
    const n = await runCommand(configSet, ctx, { key: "git.depth", value: "3" });
    expect((n.data.git as Record<string, unknown>).depth).toBe(3);
    // リストの項目：カンマ区切りで配列に。数字だけ・true だけの要素も文字列のまま、空文字は空の配列
    const list = await runCommand(configSet, ctx, {
      key: "actions.test",
      value: "mise, run,2026",
    });
    expect(list.data.actions.test).toEqual(["mise", "run", "2026"]);
    const one = await runCommand(configSet, ctx, { key: "actions.test", value: "true" });
    expect(one.data.actions.test).toEqual(["true"]);
    const empty = await runCommand(configSet, ctx, { key: "actions.test", value: "" });
    expect(empty.data.actions.test).toEqual([]);
    // 読み直しても保存した値のまま
    const shown = (await runCommand(configShow, ctx, {})).data as ConfigShowView["config"];
    expect(shown.git).toMatchObject({ base_branch: "2026", remote: "true", depth: 3 });
    expect(shown.auto.merge).toBe(false);
  });

  it("config.set は enum の項目（commit.mode）を空にしても既定に戻さず弾き、値は変わらない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(configSet, ctx, { key: "commit.mode", value: "each" });
    for (const value of ["", null]) {
      await expect(runCommand(configSet, ctx, { key: "commit.mode", value })).rejects.toMatchObject(
        { code: "VALIDATION_FAILED" },
      );
    }
    const shown = (await runCommand(configShow, ctx, {})).data as ConfigShowView["config"];
    expect(shown.commit.mode).toBe("each");
  });

  it("config.set は既定が空でない文字列の項目を空にすると既定に戻し、既定が空の項目は空のまま、配列の項目は空の配列にする", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const defaults = defaultConfig();
    // priority.* を書き換えてから空にすると、Core の既定の文に戻る
    await runCommand(configSet, ctx, { key: "priority.high", value: "独自の基準" });
    const cleared = await runCommand(configSet, ctx, { key: "priority.high", value: "" });
    expect(cleared.data.priority.high).toBe(defaults.priority.high);
    // 読み直しても既定のまま。キーを消すので config.yaml には書かれない
    const shown = (await runCommand(configShow, ctx, {})).data as ConfigShowView["config"];
    expect(shown.priority.high).toBe(defaults.priority.high);
    // 最上位の文字列の項目（既定 "default"）も空で既定に戻る
    await runCommand(configSet, ctx, { key: "default_project", value: "other" });
    const proj = await runCommand(configSet, ctx, { key: "default_project", value: "" });
    expect(proj.data.default_project).toBe("default");
    // 既定が空の項目（models.*）は空のまま
    await runCommand(configSet, ctx, { key: "models.light", value: "sonnet" });
    const light = await runCommand(configSet, ctx, { key: "models.light", value: "" });
    expect(light.data.models.light).toBe("");
    // 配列の項目は空にすると空の配列（既定の空に一致）
    await runCommand(configSet, ctx, { key: "actor.human_only", value: "epic.close" });
    const human = await runCommand(configSet, ctx, { key: "actor.human_only", value: "" });
    expect(human.data.actor.human_only).toEqual([]);
  });

  it("validate は読めない Run のファイルを指摘し、ほかの読み込みは止めない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", summary: "s", acceptance: ["a"] });
    const run = {
      id: "r20261031-041500-3fa2",
      ticket: "t1",
      step: "implement",
      agent: "claude-code",
      model: null,
      started_at: "2026-10-31T04:15:00Z",
      finished_at: "2026-10-31T05:00:00Z",
      result: "success",
      error: null,
      retries: 0,
      usage: { input: 10, output: null, cache_read: null, cache_write: null, estimated: true },
    };
    await mkdir(path.join(ctx.repo.dataDir, "runs"), { recursive: true });
    await writeFile(
      path.join(ctx.repo.dataDir, "runs/r20261031-041500-3fa2.json"),
      JSON.stringify(run),
    );
    await writeFile(path.join(ctx.repo.dataDir, "runs/r20261031-041600-0000.json"), "{");
    const v = await runCommand(validate, ctx, {});
    expect(v.data.ok).toBe(false);
    expect(v.data.issues.map((i) => [i.path, i.code])).toEqual([
      ["runs/r20261031-041600-0000.json", "json_error"],
    ]);
    expect(ctx.store.runs.get("r20261031-041500-3fa2")?.data.usage.estimated).toBe(true);
    expect(ctx.store.tickets.has("t1")).toBe(true);
  });

  it("lint は閉じた Epic に残る終わっていないチケットと、すべて終わったのに開いている Epic・Plan を指摘する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const acceptance = ["a"];
    await runCommand(epicCreate, ctx, { title: "閉じた", summary: "s" });
    await runCommand(epicCreate, ctx, { title: "終わった", summary: "s" });
    await runCommand(epicCreate, ctx, { title: "途中", summary: "s" });
    await runCommand(ticketCreate, ctx, { title: "A", summary: "s", acceptance, epic: "e1" });
    await runCommand(ticketCreate, ctx, { title: "B", summary: "s", acceptance, epic: "e2" });
    await runCommand(ticketCreate, ctx, { title: "C", summary: "s", acceptance, epic: "e3" });
    await runCommand(ticketCreate, ctx, { title: "D", summary: "s", acceptance, epic: "e3" });
    await runCommand(epicClose, ctx, { epic: "e1", force: true });
    await runCommand(planCreate, ctx, { tickets: ["t2"] });
    await runCommand(planCreate, ctx, { tickets: ["t3"] });
    for (const ticket of ["t2", "t3"])
      await runCommand(ticketMove, ctx, { ticket, status: "done" });
    await runCommand(planClose, ctx, { plan: "p2" });
    const l = await runCommand(lint, ctx, {});
    expect(l.data.issues.map((i) => [i.id, i.code, i.message])).toEqual([
      ["e1", "lint_epic_closed_unfinished", "閉じた Epic に終わっていないチケット t1 が残る"],
      ["e2", "lint_epic_finished_open", "チケットがすべて終わったが Epic が開いている"],
      ["p1", "lint_plan_finished_open", "チケットがすべて終わったが Plan が開いている"],
    ]);
  });

  it("lint.require_iteration が true のときだけ、Iteration に入らずに todo・abandoned 以外に進んだチケットを指摘し、閉じた Epic の done は除く", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const acceptance = ["a"];
    await runCommand(epicCreate, ctx, { title: "閉じた", summary: "s" });
    await runCommand(epicCreate, ctx, { title: "開いた", summary: "s" });
    await runCommand(iterationCreate, ctx, { name: "Sprint 1" });
    // t1: todo / t2: abandoned / t3: in_progress / t4: Iteration に入った in_progress
    // t5: 閉じた Epic の done / t6: 開いた Epic の done / t7: Epic のない done / t8: 閉じた Epic の in_progress
    for (const title of ["A", "B", "C", "D"])
      await runCommand(ticketCreate, ctx, { title, summary: "s", acceptance });
    await runCommand(ticketCreate, ctx, { title: "E", summary: "s", acceptance, epic: "e1" });
    await runCommand(ticketCreate, ctx, { title: "F", summary: "s", acceptance, epic: "e2" });
    await runCommand(ticketCreate, ctx, { title: "G", summary: "s", acceptance });
    await runCommand(ticketCreate, ctx, { title: "H", summary: "s", acceptance, epic: "e1" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t4"] });
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "abandoned" });
    for (const ticket of ["t3", "t4", "t8"])
      await runCommand(ticketMove, ctx, { ticket, status: "in_progress" });
    for (const ticket of ["t5", "t6", "t7"])
      await runCommand(ticketMove, ctx, { ticket, status: "done" });
    await runCommand(epicClose, ctx, { epic: "e1", force: true });
    const missing = async () =>
      (await runCommand(lint, ctx, {})).data.issues
        .filter((i) => i.code === "lint_iteration_missing")
        .map((i) => [i.id, i.message]);
    // 既定（false）では指摘しない
    expect(ctx.store.config.lint.require_iteration).toBe(false);
    expect(await missing()).toEqual([]);
    const c = await runCommand(configSet, ctx, { key: "lint.require_iteration", value: "true" });
    expect(c.data.lint.require_iteration).toBe(true);
    expect(await missing()).toEqual([
      ["t3", "Iteration に入らずに in_progress に進んでいる"],
      ["t6", "Iteration に入らずに done に進んでいる"],
      ["t7", "Iteration に入らずに done に進んでいる"],
      ["t8", "Iteration に入らずに in_progress に進んでいる"],
    ]);
    await runCommand(configSet, ctx, { key: "lint.require_iteration", value: "false" });
    expect(await missing()).toEqual([]);
  });

  it("入力の形が違えば UsageError、sprint は iteration のエイリアス", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await expect(runCommand(ticketCreate, ctx, { title: "" })).rejects.toBeInstanceOf(UsageError);
    expect(findCommand("sprint.create")?.name).toBe("iteration.create");
    expect(findCommand("ticket.nope")).toBeUndefined();
  });
});

describe("仮番号の振り直し（DT-5）", () => {
  it("オフラインで起票した仮番号がリモートの番号と衝突したら、sync が番号・ファイル名・参照・コミットの題を振り直して push する", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    const b = await initialized(f.cloneB);

    // A はオフラインで t1・t2（t1 に依存）を起票する。push できないので仮番号
    await git(f.cloneA, ["remote", "set-url", "origin", path.join(f.root, "nonexistent.git")]);
    const a1 = await runCommand(ticketCreate, a, { title: "A の 1" });
    expect(a1.data.id).toBe("t1");
    expect(a1.write).toMatchObject({ pushed: false, provisional: true });
    const a2 = await runCommand(ticketCreate, a, { title: "A の 2", depends_on: ["t1"] });
    expect(a2.data).toMatchObject({ id: "t2", depends_on: ["t1"] });
    expect(a.store.tickets.get("t2")?.data.provisional).toBe(true);

    // その間に B がオンラインで t1 を起票して push する
    const b1 = await runCommand(ticketCreate, b, { title: "B の 1" });
    expect(b1.data.id).toBe("t1");
    expect(b1.write).toMatchObject({ pushed: true });

    // A がオンラインに戻って sync する。A の t1 は衝突するので次の空き番号 t3 になり、t2 の依存も追従する
    await git(f.cloneA, ["remote", "set-url", "origin", f.remoteDir]);
    const synced = await runCommand(sync, a, {});
    expect(synced.data.renumbered).toEqual([{ from: "t1", to: "t3" }]);
    expect(synced.data.conflicts).toEqual([]);
    expect(synced.data.pushed).toBe(true);
    expect(synced.data.confirmed.sort()).toEqual(["t2", "t3"]);
    expect(a.store.tickets.get("t1")?.data.title).toBe("B の 1");
    expect(a.store.tickets.get("t3")?.data.title).toBe("A の 1");
    expect(a.store.tickets.get("t3")?.data.provisional).toBeUndefined();
    expect(a.store.tickets.get("t2")?.data.depends_on).toEqual(["t3"]);
    await expect(
      readFile(path.join(a.repo.dataDir, "tickets", "t3.md"), "utf8"),
    ).resolves.toContain("id: t3");
    const log = (await git(a.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log).toContain("t3 を起票: A の 1");
    expect(log).toContain("t1 を起票: B の 1");
    expect(log.some((m) => m === "t1 を起票: A の 1")).toBe(false);

    // B が取り込むと同じ 3 件が見える
    await runCommand(sync, b, {});
    expect([...b.store.tickets.values()].map((t) => `${t.id}:${t.data.title}`).sort()).toEqual([
      "t1:B の 1",
      "t2:A の 2",
      "t3:A の 1",
    ]);
    expect(b.store.tickets.get("t2")?.data.depends_on).toEqual(["t3"]);
  });

  it("仮番号でない競合はこれまでどおり報告し、何も書き換えない", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    const b = await initialized(f.cloneB);
    await runCommand(ticketCreate, a, { title: "共通" });
    await runCommand(sync, b, {});
    // 同じチケットの同じ項目を両方で変えて、まとめてコミットしてから push を競わせる
    await runCommand(ticketUpdate, a, { ticket: "t1", title: "A が変えた" });
    await runCommand(ticketUpdate, b, { ticket: "t1", title: "B が変えた" });
    expect((await runCommand(sync, b, {})).data.pushed).toBe(true);
    const synced = await runCommand(sync, a, {});
    expect(synced.data.conflicts).toEqual(["tickets/t1.md"]);
    expect(synced.data.renumbered).toEqual([]);
    expect(a.store.tickets.get("t1")?.data.title).toBe("A が変えた");
  });
});
