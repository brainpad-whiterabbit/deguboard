// claim に付く準備（Iteration への追加と開始・作業ブランチの worktree の作成）を、bare リモート付きの一時リポジトリで確かめる（ST-3）

import { realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../test/helpers/git-fixture.js";
import { runGit } from "../git/run.js";
import { fixture, initialized, runCleanups } from "../../test/helpers/commands-context.js";
import { iterationTargetFor } from "./claim-setup.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { localDate } from "./helpers.js";
import { iterationCreate, iterationShow, iterationStart } from "./iteration.js";
import { configSet } from "./setup.js";
import { ticketClaim, ticketCreate, ticketShow, ticketUnclaim } from "./ticket.js";

afterEach(runCleanups);

const NOW = new Date("2026-11-09T03:00:00Z");

/** require_iteration を true にした文脈（config を読み直すため開き直す） */
async function requiringIteration(cwd: string): Promise<CommandContext> {
  const ctx = await initialized(cwd, { now: () => NOW });
  await runCommand(configSet, ctx, { key: "lint.require_iteration", value: "true" });
  return openContext({ cwd, actor: { kind: "human", user: "eiki" }, now: () => NOW });
}

/** git の標準出力（前後の空白を除く） */
const out = async (dir: string, args: string[]) => (await git(dir, args)).stdout.trim();

const iterationOf = async (ctx: CommandContext, id: string) =>
  (await runCommand(ticketShow, ctx, { ticket: id })).data.iteration;

describe("claim の Iteration の準備", () => {
  it("require_iteration が true なら、Iteration の空いたチケットを active の Iteration に入れる", async () => {
    const f = await fixture();
    const ctx = await requiringIteration(f.cloneA);
    await runCommand(iterationCreate, ctx, { name: "S1", start: "2026-11-01" });
    await runCommand(iterationCreate, ctx, { name: "S2", start: "2026-10-01" });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    const claimed = await runCommand(ticketClaim, ctx, { ticket: "t1", no_worktree: true });
    // start の早い planned（s2）より active（s1）を選ぶ
    expect(claimed.data.iteration).toBe("s1");
    expect(claimed.warnings).toContain("t1 を s1 に入れた");
    // claim と同じ書き込みで push され、別の clone からも見える
    const other = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "human", user: "b" },
    });
    expect(await iterationOf(other, "t1")).toBe("s1");
  });

  it("active がなければ start の最も早い planned（start のないものは後ろ、並べば ID の小さいもの）に入れて開始する", async () => {
    const f = await fixture();
    const ctx = await requiringIteration(f.cloneA);
    await runCommand(iterationCreate, ctx, { name: "start なし" });
    await runCommand(iterationCreate, ctx, { name: "遅い", start: "2026-11-20" });
    await runCommand(iterationCreate, ctx, { name: "早い 1", start: "2026-11-10" });
    await runCommand(iterationCreate, ctx, { name: "早い 2", start: "2026-11-10" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    const claimed = await runCommand(ticketClaim, ctx, { ticket: "t1", no_worktree: true });
    expect(claimed.data.iteration).toBe("s3");
    expect(claimed.warnings).toEqual(
      expect.arrayContaining(["t1 を s3 に入れた", "s3 を開始した（active）"]),
    );
    const s3 = (await runCommand(iterationShow, ctx, { iteration: "s3" })).data;
    // 開始日は始めた日に書き換える（iteration.start と同じ。IT-1）
    expect(s3).toMatchObject({ status: "active", start: localDate(NOW) });
    // 規則だけの確かめ：start のない Iteration だけなら ID の小さいもの、閉じたものと別の Project のものは選ばない
    const doc = (id: string, data: object) =>
      ({ id, data: { project: "default", ...data } }) as never;
    expect(
      iterationTargetFor(
        [
          doc("s9", { status: "planned" }),
          doc("s10", { status: "planned" }),
          doc("s2", { status: "closed", start: "2026-01-01" }),
          doc("s1", { status: "active", project: "other" }),
        ],
        "default",
      )?.id,
    ).toBe("s9");
  });

  it("入れ先がなければ Iteration は空のまま claim し、warnings で人に頼むよう伝える。require_iteration が false なら入れない", async () => {
    const f = await fixture();
    const ctx = await requiringIteration(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    const claimed = await runCommand(ticketClaim, ctx, { ticket: "t1", no_worktree: true });
    expect(claimed.data).toMatchObject({ status: "in_progress" });
    expect(claimed.data.iteration).toBeUndefined();
    expect(claimed.warnings.join("\n")).toContain(
      "t1 を入れる Iteration（active か planned）がない",
    );

    const g = await fixture();
    const plain = await initialized(g.cloneA, { now: () => NOW });
    await runCommand(iterationCreate, plain, { name: "S1" });
    await runCommand(ticketCreate, plain, { title: "B" });
    const free = await runCommand(ticketClaim, plain, { ticket: "t1", no_worktree: true });
    expect(free.data.iteration).toBeUndefined();
    expect((await runCommand(iterationShow, plain, { iteration: "s1" })).data.status).toBe(
      "planned",
    );
  });

  it("チケットの Iteration が planned なら開始し、ほかに active があれば開始せず warnings に出して claim は成功する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA, { now: () => NOW });
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(iterationCreate, ctx, { name: "S2" });
    await runCommand(ticketCreate, ctx, { title: "A", iteration: "s1" });
    await runCommand(ticketCreate, ctx, { title: "B", iteration: "s2" });
    const first = await runCommand(ticketClaim, ctx, { ticket: "t1", no_worktree: true });
    expect(first.warnings).toContain("s1 を開始した（active）");
    expect((await runCommand(iterationShow, ctx, { iteration: "s1" })).data.status).toBe("active");
    const second = await runCommand(ticketClaim, ctx, { ticket: "t2", no_worktree: true });
    expect(second.data.status).toBe("in_progress");
    expect(second.warnings.join("\n")).toContain("s2 を開始できない（s1 が active）");
    expect((await runCommand(iterationShow, ctx, { iteration: "s2" })).data.status).toBe("planned");
  });

  it("actor.human_only の iteration.add・iteration.start は agent の claim では行わず、warnings で人に頼む", async () => {
    const f = await fixture();
    const human = await requiringIteration(f.cloneA);
    await runCommand(configSet, human, {
      key: "actor.human_only",
      value: "iteration.add, iteration.start",
    });
    await runCommand(iterationCreate, human, { name: "S1" });
    await runCommand(ticketCreate, human, { title: "A" });
    await runCommand(ticketCreate, human, { title: "B", iteration: "s1" });
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    const a = await runCommand(ticketClaim, agent, {
      ticket: "t1",
      no_worktree: true,
      no_run: true,
    });
    expect(a.data.iteration).toBeUndefined();
    expect(a.warnings.join("\n")).toContain("iteration.add は actor.human_only");
    const b = await runCommand(ticketClaim, agent, {
      ticket: "t2",
      no_worktree: true,
      no_run: true,
    });
    expect(b.warnings.join("\n")).toContain("iteration.start は actor.human_only");
    expect((await runCommand(iterationShow, agent, { iteration: "s1" })).data.status).toBe(
      "planned",
    );
  });
});

describe("claim の worktree の作成", () => {
  it("claim は作業ブランチを base から切って worktree.root/<ブランチ名> に worktree を作り、ticket show も同じ場所を返す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    const claimed = await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "feat/t1" });
    // 既定の worktree.root は ../<repo>.worktrees
    const expected = path.join(
      path.dirname(f.cloneA),
      `${path.basename(f.cloneA)}.worktrees`,
      "feat/t1",
    );
    expect(claimed.data.worktree).toBe(expected);
    expect((await runCommand(ticketShow, ctx, { ticket: "t1" })).data.worktree).toBe(
      await realpath(expected),
    );
    // リモートの base から切り、上流は付けない
    const head = await out(expected, ["rev-parse", "HEAD"]);
    expect(head).toBe(await out(f.cloneA, ["rev-parse", "origin/main"]));
    expect(await out(expected, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feat/t1");
    const upstream = await runGit(expected, ["config", "--get", "branch.feat/t1.merge"], {
      allowFailure: true,
    });
    expect(upstream).toMatchObject({ code: 1, stdout: "" });
  });

  it("--worktree-path で場所を変えられ、no_worktree・without_branch では作らない。worktree_path と同時の指定は使い方の誤り", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C", "D"]) await runCommand(ticketCreate, ctx, { title });
    const custom = path.join(f.root, "custom-wt");
    const a = await runCommand(ticketClaim, ctx, {
      ticket: "t1",
      branch: "feat/a",
      worktree_path: custom,
    });
    expect(a.data.worktree).toBe(custom);
    const b = await runCommand(ticketClaim, ctx, {
      ticket: "t2",
      branch: "feat/b",
      no_worktree: true,
    });
    expect(b.data.worktree).toBeNull();
    expect(await out(f.cloneA, ["branch", "--list", "feat/b"])).toBe("");
    const c = await runCommand(ticketClaim, ctx, { ticket: "t3", without_branch: true });
    expect(c.data.worktree).toBeNull();
    await expect(
      runCommand(ticketClaim, ctx, { ticket: "t4", no_worktree: true, worktree_path: custom }),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("unclaim の後にローカルに残ったブランチはそのまま checkout し、作れなければ warnings に出して claim は成功する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    const first = await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "feat/again" });
    const dir = first.data.worktree!;
    // 作業のコミットを残したまま worktree だけ消し、unclaim して claim し直す
    await git(dir, ["commit", "-q", "--allow-empty", "-m", "途中"]);
    const tip = await out(dir, ["rev-parse", "HEAD"]);
    await git(f.cloneA, ["worktree", "remove", dir]);
    await runCommand(ticketUnclaim, ctx, { ticket: "t1" });
    const again = await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "feat/again" });
    expect(again.data.worktree).toBe(dir);
    expect(await out(dir, ["rev-parse", "HEAD"])).toBe(tip);
    // 場所がふさがっていれば作れない。claim は済み、理由は warnings
    const blocked = await runCommand(ticketClaim, ctx, {
      ticket: "t2",
      branch: "feat/blocked",
      worktree_path: dir,
    });
    expect(blocked.data).toMatchObject({ status: "in_progress", worktree: null });
    expect(blocked.warnings.join("\n")).toContain(
      "ブランチ feat/blocked の worktree を作れなかった",
    );
  });
});
