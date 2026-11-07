import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { resetGhCache } from "../git/facts.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { gate, type GateView } from "./gate.js";
import { runFinish, runReviewResult, runStart } from "./run.js";
import { init } from "./setup.js";
import { ticketCheck, ticketClaim, ticketCreate } from "./ticket.js";
import type { Run } from "../model/run.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 偽の gh。pr view の selector（$3）ごとに返す JSON を変えられる */
async function fakeGh(root: string, cases: () => Record<string, string>) {
  const bin = path.join(root, "fake-bin");
  await mkdir(bin, { recursive: true });
  const write = () =>
    writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        'case "$3" in',
        ...Object.entries(cases()).map(([key, json]) => `  ${key}) echo '${json}';;`),
        '  *) echo "no pull requests found for branch $3" >&2; exit 1;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  await write();
  const saved = process.env["PATH"];
  process.env["PATH"] = bin + path.delimiter + (saved ?? "");
  resetGhCache();
  cleanups.push(() => {
    process.env["PATH"] = saved;
    resetGhCache();
  });
  return write;
}

const pr = (over: Partial<{ state: string; isDraft: boolean; mergeable: string }> = {}) =>
  JSON.stringify({ number: 7, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", ...over });

/** t1 を feat/t1 で claim して 1 コミット push し、PR #7（偽の gh）がある文脈 */
async function prepared() {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  const actor = { kind: "agent" as const, user: "eiki" };
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {
    template: "software-development",
  });
  const ctx: CommandContext = await openContext({ cwd: f.cloneA, actor });
  await runCommand(ticketCreate, ctx, {
    title: "A",
    body: "## 受け入れ条件\n\n- [ ] 1 つめ\n- [ ] 2 つめ\n",
  });
  await runCommand(ticketClaim, ctx, { ticket: "t1", branch: "feat/t1", no_run: true });
  await git(f.cloneA, ["checkout", "-qb", "feat/t1"]);
  await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "作業"]);
  await git(f.cloneA, ["push", "-q", "origin", "feat/t1"]);
  let state = { pr: pr() };
  const rewrite = await fakeGh(f.root, () => ({ "feat/t1": state.pr, "7": state.pr }));
  const setPr = async (json: string) => {
    state = { pr: json };
    await rewrite();
  };
  return { f, ctx, setPr };
}

/** 見直しの Run を開いて結果を書いて閉じる。at は開始の時刻（push との前後を決める） */
async function review(ctx: CommandContext, at: Date, heavy: number) {
  ctx.now = () => at;
  const run = (
    await runCommand(runStart, ctx, { ticket: "t1", step: "review", agent: "claude-code" })
  ).data as Run;
  await runCommand(runReviewResult, ctx, {
    ticket: "t1",
    heavy,
    light: 0,
    ...(heavy === 0 ? { passed: true } : {}),
  });
  await runCommand(runFinish, ctx, { run: run.id, result: "success" });
}

const judge = async (ctx: CommandContext, stage: "ready" | "merge" = "merge") =>
  (await runCommand(gate, ctx, { ticket: "t1", for: stage })).data as GateView;

const failed = (view: GateView) => view.conditions.filter((c) => !c.ok).map((c) => c.id);

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe("dg gate（品質ゲート。t532）", () => {
  it("最後の push より後の見直しが通り、受け入れ条件がすべて付き、PR が開いて衝突しなければ通る", async () => {
    const { ctx } = await prepared();
    await review(ctx, later(1), 0);
    expect(failed(await judge(ctx, "ready"))).toEqual([]);
    // マージの前は受け入れ条件もすべて要る
    expect(failed(await judge(ctx))).toEqual(["acceptance"]);
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1, 2] });
    const view = await judge(ctx);
    expect(view).toMatchObject({ ticket: "t1", for: "merge", pr: 7, passed: true });
    expect(view.conditions.map((c) => c.id)).toEqual([
      "pr",
      "acceptance",
      "review",
      "fix_rounds",
      "mergeable",
    ]);
  });

  it("見直しが最後の push より前・通っていない・結果がないなら review を満たさない", async () => {
    const { ctx } = await prepared();
    expect(failed(await judge(ctx, "ready"))).toEqual(["review"]);
    await review(ctx, later(-60), 0);
    const before = await judge(ctx, "ready");
    expect(before.conditions.find((c) => c.id === "review")!.detail).toContain(
      "より後の見直しがない",
    );
    await review(ctx, later(1), 2);
    const heavy = await judge(ctx, "ready");
    expect(heavy.conditions.find((c) => c.id === "review")).toMatchObject({ ok: false });
    expect(heavy.conditions.find((c) => c.id === "review")!.detail).toContain("重い指摘 2 件");
  });

  it("重い指摘が出た見直しが上限（2 回）を超えたら fix_rounds を満たさない", async () => {
    const { ctx } = await prepared();
    await review(ctx, later(1), 1);
    await review(ctx, later(2), 1);
    expect(failed(await judge(ctx, "ready"))).toEqual(["review"]);
    await review(ctx, later(3), 1);
    expect(failed(await judge(ctx, "ready"))).toEqual(["review", "fix_rounds"]);
  });

  it("PR が draft ならマージの前を、衝突していればマージの前を、PR がなければどちらも満たさない", async () => {
    const { ctx, setPr } = await prepared();
    await review(ctx, later(1), 0);
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1, 2] });
    await setPr(pr({ isDraft: true }));
    expect(failed(await judge(ctx, "ready"))).toEqual([]);
    expect(failed(await judge(ctx))).toEqual(["pr"]);
    await setPr(pr({ mergeable: "CONFLICTING" }));
    expect(failed(await judge(ctx))).toEqual(["mergeable"]);
    await setPr("");
    // 空の JSON は読めない PR として扱い、通さない
    expect(failed(await judge(ctx))).toEqual(["pr", "mergeable"]);
  });
});
