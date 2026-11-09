import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { resetGhCache } from "../git/facts.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { gate, type GateView } from "./gate.js";
import { runFinish, runReviewResult, runStart } from "./run.js";
import { configSet, init } from "./setup.js";
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
  await runCommand(ticketClaim, ctx, {
    no_worktree: true,
    ticket: "t1",
    branch: "feat/t1",
    no_run: true,
  });
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
      "check",
    ]);
    // actions.test が空なら検査は判定せずに通し、そう detail に出す
    expect(view.conditions.find((c) => c.id === "check")).toMatchObject({
      ok: true,
      detail: expect.stringContaining("actions.test が空なので、検査は判定しない"),
    });
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

describe("dg gate の検査（actions.test。t601）", () => {
  /**
   * actions.test に、リポジトリの外の検査の台本を置いた文脈。台本は回るたびに回数のファイルに 1 行足し、
   * exit-code のファイルの値で終わる（出力の末尾が detail に出ることを見るため、最後に「最後の行」を出す）
   */
  async function withCheck() {
    const base = await prepared();
    const script = path.join(base.f.root, "check.sh");
    const count = path.join(base.f.root, "check-count");
    const code = path.join(base.f.root, "exit-code");
    await writeFile(code, "0");
    await writeFile(
      script,
      `#!/bin/sh\necho run >> '${count}'\necho 前の行\necho 最後の行\nexit $(cat '${code}')\n`,
      { mode: 0o755 },
    );
    await runCommand(configSet, base.ctx, { key: "actions.test", value: `sh, ${script}` });
    const ctx = await openContext({ cwd: base.f.cloneA, actor: base.ctx.actor });
    const runs = async () =>
      (await readFile(count, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    const setCode = (n: number) => writeFile(code, String(n));
    return { ...base, ctx, runs, setCode };
  }
  const check = (view: GateView) => view.conditions.find((c) => c.id === "check")!;

  it("最新のコミットの worktree で actions.test を回して判定し、同じコミットでは回し直さない", async () => {
    const { ctx, runs } = await withCheck();
    await review(ctx, later(1), 0);
    const view = await judge(ctx, "ready");
    expect(view.passed).toBe(true);
    expect(check(view).detail).toMatch(
      /^検査（sh .*check\.sh）が最新のコミット [0-9a-f]{8} で通った$/,
    );
    expect(await runs()).toBe(1);
    // 同じコミットの判定（ready の後の merge など）は覚えた結果を使う
    await judge(ctx, "ready");
    expect(await runs()).toBe(1);
  });

  it("通らなければ終了コードと出力の末尾を detail に出して結果を覚えず、ほかの条件を満たさなければ回さない", async () => {
    const { f, ctx, runs, setCode } = await withCheck();
    // 見直しがない（review を満たさない）うちは回さない
    expect(check(await judge(ctx, "ready"))).toMatchObject({
      ok: false,
      detail: expect.stringContaining("回していない"),
    });
    expect(await runs()).toBe(0);
    await setCode(3);
    // 新しいコミットを push して見直す（前のコミットの結果は使わない）
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "直し"]);
    await git(f.cloneA, ["push", "-q", "origin", "feat/t1"]);
    await review(ctx, later(2), 0);
    const view = await judge(ctx, "ready");
    expect(failed(view)).toEqual(["check"]);
    expect(check(view).detail).toContain("通らない（exit 3）");
    expect(check(view).detail).toContain("前の行\n最後の行");
    // 通らなかった結果は覚えないので、同じコミットでも回し直す（確率で落ちる検査をコミットを足さずにやり直せる）
    await setCode(0);
    expect(check(await judge(ctx, "ready")).ok).toBe(true);
    expect(await runs()).toBe(2);
  });

  it("worktree が最新のコミットでない・未コミットの変更があるなら回さずに満たさない", async () => {
    const { f, ctx, runs } = await withCheck();
    await review(ctx, later(1), 0);
    // push していないコミットがある（worktree の HEAD がリモートの先端と違う）
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "まだ push していない"]);
    expect(check(await judge(ctx, "ready")).detail).toContain("最新のコミット");
    await git(f.cloneA, ["reset", "-q", "--hard", "HEAD~1"]);
    await writeFile(path.join(f.cloneA, "dirty.txt"), "x");
    expect(check(await judge(ctx, "ready")).detail).toContain("未コミットの変更がある");
    expect(await runs()).toBe(0);
  });
});
