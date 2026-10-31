import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixture,
  createLocalOnlyRepo,
  git,
  type Fixture,
} from "../../test/helpers/git-fixture.js";
import { UsageError } from "../errors.js";
import { openContext, type ContextOptions } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { epicAdd, epicClose, epicCreate, epicReopen, epicShow } from "./epic.js";
import { findCommand } from "./index.js";
import {
  iterationAdd,
  iterationClose,
  iterationCreate,
  iterationShow,
  iterationStart,
} from "./iteration.js";
import { configSet, init, lint, sync, validate } from "./setup.js";
import {
  ticketClaim,
  ticketCreate,
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

/** init まで済ませた文脈を開く */
async function initialized(
  cwd: string,
  opts: Partial<ContextOptions> = {},
): Promise<CommandContext> {
  const first = await openContext({
    cwd,
    initialize: {},
    actor: { kind: "human", id: "eiki@laptop" },
    ...opts,
  });
  await runCommand(init, first, {});
  return openContext({ cwd, actor: { kind: "human", id: "eiki@laptop" }, ...opts });
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
    // 別の clone は リモートから取り込む
    const b = await openContext({ cwd: f.cloneB, initialize: {} });
    expect(b.worktree).toBe("from_remote");
    expect(b.store.workflows.size).toBe(3);
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
      labels: ["frontend"],
    });
    expect(created.data).toMatchObject({
      id: "t1",
      status: "todo",
      priority: "medium",
      labels: ["frontend"],
    });
    expect(created.data.body).toContain("## 概要\n\n入力の検査");
    expect(created.write).toMatchObject({ pushed: true });

    const claimed = await runCommand(ticketClaim, ctx, { ticket: "1" });
    expect(claimed.data).toMatchObject({
      status: "in_progress",
      claimed_by: "eiki@laptop",
      branch: "feature/t1-login-validation",
    });

    const review = await runCommand(ticketMove, ctx, { ticket: "t1", status: "review" });
    expect(review.data).toMatchObject({ status: "review", from: "in_progress" });
    // commit.mode は既定の batch なので作業ツリーに残る
    expect(review.write).toMatchObject({ committed: false });

    // 作業ブランチを作って main にマージする
    await git(f.cloneA, ["checkout", "-qb", "feature/t1-login-validation"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "実装"]);
    await git(f.cloneA, ["checkout", "-q", "main"]);
    await git(f.cloneA, ["merge", "-q", "--ff-only", "feature/t1-login-validation"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);

    const synced = await runCommand(sync, ctx, {});
    expect(synced.data.reconciled).toEqual([{ id: "t1", from: "review", to: "done" }]);
    expect(synced.data.pushed).toBe(true);
    expect(synced.data.status).toMatchObject({ ahead: 0, behind: 0, dirty: false });
    expect(ctx.store.tickets.get("t1")?.data.status).toBe("done");
    const log = (await git(ctx.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log[0]).toContain("照合で t1: review → done");
    expect(log[1]).toBe("変更をまとめてコミット");
  });

  it("表にない遷移・人だけの遷移・依存が終わっていない claim は拒否される", async () => {
    const f = await fixture();
    const human = await initialized(f.cloneA);
    await runCommand(ticketCreate, human, { title: "A" });
    await runCommand(ticketCreate, human, { title: "B", depends_on: ["t1"] });
    await expect(
      runCommand(ticketMove, human, { ticket: "t1", status: "done" }),
    ).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    await expect(runCommand(ticketClaim, human, { ticket: "t2" })).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    const agent = await openContext({
      cwd: f.cloneA,
      actor: { kind: "agent", id: "claude@laptop" },
    });
    await expect(
      runCommand(ticketMove, agent, { ticket: "t1", status: "abandoned" }),
    ).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    const abandoned = await runCommand(ticketMove, human, { ticket: "t1", status: "abandoned" });
    expect(abandoned.data.status).toBe("abandoned");
    const list = await runCommand(ticketList, human, {});
    expect(list.data.map((t) => t.id)).toEqual(["t2"]);
    const all = await runCommand(ticketList, human, { include_abandoned: true });
    expect(all.data.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("unclaim は自分の claim だけ外し、他人のものは force が要る", async () => {
    const f = await fixture();
    const eiki = await initialized(f.cloneA);
    await runCommand(ticketCreate, eiki, { title: "A" });
    await runCommand(ticketClaim, eiki, { ticket: "t1", branch: "feature/a" });
    const other = await openContext({ cwd: f.cloneA, actor: { kind: "human", id: "other@pc" } });
    await expect(runCommand(ticketUnclaim, other, { ticket: "t1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    const r = await runCommand(ticketUnclaim, other, { ticket: "t1", force: true });
    expect(r.data).toMatchObject({ status: "todo" });
    expect(r.data.claimed_by).toBeUndefined();
    expect(r.data.branch).toBeUndefined();
  });

  it("同じチケットを 2 つの clone が claim すると、負けた側は CLAIM_LOST で claimed_by を書き換えない", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    await runCommand(ticketCreate, a, { title: "A" });
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "agent", id: "b@pc" },
    });
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await runCommand(ticketClaim, b, { ticket: "t1" });
      },
    };
    const racer = await openContext({ cwd: f.cloneA, actor: { kind: "agent", id: "a@pc" }, hooks });
    await expect(runCommand(ticketClaim, racer, { ticket: "t1" })).rejects.toMatchObject({
      code: "CLAIM_LOST",
    });
    expect(racer.store.tickets.get("t1")?.data.claimed_by).toBe("b@pc");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("import は仮キーを depends_on から参照でき、1 コミットで採番する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const r = await runCommand(ticketImport, ctx, {
      drafts: [
        { key: "schema", title: "スキーマ" },
        { key: "api", title: "API", depends_on: ["schema"] },
        { title: "画面", depends_on: ["api", "schema"] },
      ],
    });
    expect(r.data.map((t) => [t.id, t.depends_on])).toEqual([
      ["t1", []],
      ["t2", ["t1"]],
      ["t3", ["t2", "t1"]],
    ]);
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
    const closed = await runCommand(epicClose, ctx, { epic: "e1", force: true });
    expect(closed.data.status).toBe("closed");
    expect(closed.data.closed_at).toBeDefined();
    expect(closed.warnings).toHaveLength(1);
    await expect(runCommand(ticketCreate, ctx, { title: "C", epic: "e1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    const reopened = await runCommand(epicReopen, ctx, { epic: "e1" });
    expect(reopened.data.closed_at).toBeUndefined();
  });

  it("Iteration は開始・終了でき、閉じるときに完了と持ち越しを数える", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const it1 = await runCommand(iterationCreate, ctx, {
      name: "Sprint 1",
      start: "2026-11-01",
      end: "2026-11-14",
    });
    expect(it1.data).toMatchObject({ id: "s1", status: "planned", tickets: [] });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t2", "t1"] });
    await runCommand(iterationStart, ctx, { iteration: "1" });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "in_progress" });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    const shown = await runCommand(iterationShow, ctx, { iteration: "s1" });
    expect(shown.data.items.map((t) => t.id)).toEqual(["t2", "t1"]);
    const closed = await runCommand(iterationClose, ctx, { iteration: "s1" });
    expect(closed.data).toMatchObject({ status: "closed", completed: 1, carried_over: 1 });
    expect(ctx.store.tickets.get("t2")?.data.iteration).toBeUndefined();
    expect(ctx.store.tickets.get("t1")?.data.iteration).toBe("s1");
  });
});

describe("用意", () => {
  it("validate と lint が指摘を出し、config.set が 1 項目を変える", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", body: "本文だけ\n" });
    const v = await runCommand(validate, ctx, {});
    expect(v.data.ok).toBe(true);
    const l = await runCommand(lint, ctx, {});
    expect(l.data.issues.map((i) => i.code)).toEqual([
      "lint_summary_missing",
      "lint_acceptance_missing",
    ]);
    const c = await runCommand(configSet, ctx, { key: "commit.mode", value: "each" });
    expect(c.data.commit.mode).toBe("each");
    expect(c.data.git.remote).toBe("origin");
    await expect(
      runCommand(configSet, ctx, { key: "commit.mode", value: "nope" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("入力の形が違えば UsageError、sprint は iteration のエイリアス", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await expect(runCommand(ticketCreate, ctx, { title: "" })).rejects.toBeInstanceOf(UsageError);
    expect(findCommand("sprint.create")?.name).toBe("iteration.create");
    expect(findCommand("ticket.nope")).toBeUndefined();
  });
});
