import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asHuman, openForInit } from "../../test/helpers/commands-context.js";
import { createFixtureFrom, git, type Layout } from "../../test/helpers/git-fixture.js";
import { resetGhCache } from "../git/facts.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { chooseCheck, matchesAnyGlob, planCheck } from "./gate-check.js";
import { gate, mergeableTiming } from "./gate.js";
import type { GateView } from "./gate-judge.js";
import { nextOf, stageFactsOf, stageOf, withBaseFact } from "./next.js";
import { runFinish, runReviewResult, runStart } from "./run.js";
import { configSet, init } from "./setup.js";
import { ticketCheck, ticketClaim, ticketCreate, ticketUpdate } from "./ticket.js";
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
        // __TIP__ は今のリモートの追跡 ref の先端に置き換える（PR の先端が push で進むのを写す。t750）
        ...Object.entries(cases()).map(
          ([key, json]) =>
            `  ${key}) echo '${json}' | sed "s|__TIP__|$(git rev-parse -q --verify refs/remotes/origin/t1)|";;`,
        ),
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

const pr = (
  over: Partial<{ state: string; isDraft: boolean; mergeable: string; headRefOid: string }> = {},
) =>
  JSON.stringify({
    number: 7,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefOid: "__TIP__",
    ...over,
  });

/** 雛形の準備（テストファイルで 1 度だけ走る）：init（software-development）・t1 を t1 で claim して 1 コミット push */
async function prepareRepo(f: Layout): Promise<void> {
  const actor = { kind: "agent" as const, user: "eiki" };
  await runCommand(init, await openForInit({ cwd: f.cloneA, actor }), {});
  const ctx: CommandContext = await openContext({ cwd: f.cloneA, actor });
  await runCommand(ticketCreate, ctx, {
    title: "A",
    body: "## 受け入れ条件\n\n- [ ] 1 つめ\n- [ ] 2 つめ\n",
    approved_by: "human",
  });
  await runCommand(ticketClaim, ctx, {
    no_worktree: true,
    ticket: "t1",
    branch: "t1",
    no_run: true,
    approved_by: "human",
  });
  await git(f.cloneA, ["checkout", "-qb", "t1"]);
  await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "作業"]);
  await git(f.cloneA, ["push", "-q", "origin", "t1"]);
}

/** prepareRepo を済ませた雛形から写し、PR #7（偽の gh）がある文脈 */
async function prepared() {
  const f = await createFixtureFrom("prepared", prepareRepo);
  cleanups.push(f.cleanup);
  const actor = { kind: "agent" as const, user: "eiki" };
  const ctx: CommandContext = await openContext({ cwd: f.cloneA, actor });
  let state = { pr: pr() };
  const rewrite = await fakeGh(f.root, () => ({ t1: state.pr, "7": state.pr }));
  const setPr = async (json: string) => {
    state = { pr: json };
    await rewrite();
  };
  return { f, ctx, setPr };
}

/** コミットのコミッタの時刻（git が記録した時刻。秒の単位） */
async function commitTime(cwd: string, rev = "HEAD"): Promise<Date> {
  const out = await git(cwd, ["log", "-1", "--format=%ct", rev]);
  return new Date(Number(out.stdout.trim()) * 1000);
}

/**
 * 見直しの Run を開いて結果を書いて閉じる。at は開始の時刻で、数なら ctx の作業ブランチの先端のコミットの時刻からその分だけ後、
 * Date ならその時刻。Date.now() と git の時計を別々に読むと秒の境目でずれうるので、比べる相手のコミットの時刻から取る（t1122）。
 * Run は開いたときのローカルの先端の SHA（head）を記録するので、review の条件は SHA で比べ、時刻では比べない（reviewedTip）。
 * 時刻は見直しどうしの順（後の見直しほど大きな分を渡す）と、heavy の回数を数える branch_at との前後にだけ使う
 */
async function review(ctx: CommandContext, at: number | Date, heavy: number) {
  const start =
    typeof at === "number"
      ? new Date((await commitTime(ctx.repo.topLevel)).getTime() + at * 60_000)
      : at;
  ctx.now = () => start;
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

describe("dg gate（品質ゲート。t532）", () => {
  it("最後の push より後の見直しが通り、受け入れ条件がすべて付き、PR が開いて衝突しなければ通る", async () => {
    const { ctx, f } = await prepared();
    await review(ctx, 1, 0);
    expect(failed(await judge(ctx, "ready"))).toEqual([]);
    // マージの前は受け入れ条件もすべて要る
    expect(failed(await judge(ctx))).toEqual(["acceptance"]);
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1, 2] });
    const view = await judge(ctx);
    // gate のないチケットは high として判定し、判定した段を gate に出す。sha は gh が返した PR の先端（t750）
    const tip = (await git(f.cloneA, ["rev-parse", "HEAD"])).stdout.trim();
    expect(view).toMatchObject({
      ticket: "t1",
      for: "merge",
      gate: "high",
      pr: 7,
      sha: tip,
      passed: true,
    });
    expect(view.conditions.map((c) => c.id)).toEqual([
      "pr",
      "acceptance",
      "review",
      "fix_rounds",
      "mergeable",
      "head",
      "base",
      "check",
    ]);
    // actions.test が空なら検査は判定せずに通し、そう detail に出す
    expect(view.conditions.find((c) => c.id === "check")).toMatchObject({
      ok: true,
      detail: expect.stringContaining("actions.test is empty, so the check is not judged"),
    });
  });

  it("見直しは開いたときのローカルの先端の SHA を記録し、見直しの前に別の clone で作ったコミットを後で push すると review を満たさない（t763）", async () => {
    const { ctx, f } = await prepared();
    // 別の clone で、見直しより前の時刻のコミットを作っておく（push は見直しの後）
    await git(f.cloneB, ["fetch", "-q", "origin", "t1"]);
    await git(f.cloneB, ["checkout", "-qb", "t1", "FETCH_HEAD"]);
    await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", "見直しの前に作った"]);
    const reviewed = (await git(f.cloneA, ["rev-parse", "HEAD"])).stdout.trim();
    // 見直しの開始は、別の clone のコミットの時刻から 1 分後に固定する（時刻で比べれば通ってしまう並びをテストが作る）
    await review(ctx, new Date((await commitTime(f.cloneB)).getTime() + 60_000), 0);
    const run = [...ctx.store.runs.values()].find((d) => d.data.step === "review")!.data;
    expect(run.head).toBe(reviewed);
    expect(failed(await judge(ctx, "ready"))).toEqual([]);
    await git(f.cloneB, ["push", "-q", "origin", "t1"]);
    // コミットの時刻は見直しの開始より前なので、時刻で比べると通ってしまう。SHA で比べるので落ちる
    const view = await judge(ctx, "ready");
    expect(failed(view)).toEqual(["review"]);
    expect(view.conditions.find((c) => c.id === "review")!.detail).toContain(
      "No review of the last push",
    );
  });

  it("見直しの後に base を取り込んだだけのマージコミットを push しても（2 回取り込んでも）、review と dg next の段階は前の見直しを数え、一時の worktree を残さない。その後にコミットを積むと数えない（RN-10）", async () => {
    const { ctx, f } = await prepared();
    await review(ctx, 1, 0);
    // 別の clone が main を進め、作業ブランチに取り込んで push する
    await git(f.cloneB, ["fetch", "-q", "origin"]);
    await git(f.cloneB, ["checkout", "-q", "--detach", "origin/main"]);
    await writeFile(path.join(f.cloneB, "main.txt"), "main\n");
    await git(f.cloneB, ["add", "--", "main.txt"]);
    await git(f.cloneB, ["commit", "-q", "-m", "main を進める"]);
    await git(f.cloneB, ["push", "-q", "origin", "HEAD:main"]);
    await git(f.cloneA, ["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    await git(f.cloneA, ["merge", "-q", "--no-edit", "origin/main"]);
    await git(f.cloneA, ["push", "-q", "origin", "t1"]);
    const worktrees = async () => (await git(f.cloneA, ["worktree", "list", "--porcelain"])).stdout;
    const before = await worktrees();
    const view = await judge(ctx, "ready");
    expect(failed(view)).toEqual([]);
    expect(view.conditions.find((c) => c.id === "review")!.detail).toContain(
      "only merged base into it",
    );
    // dg next の段階も同じ事実で前の見直しを数える（PR の番号は記録していないので、段階の事実に足して渡す）
    const ticket = { ...ctx.store.require("ticket", "t1").data, pr: 7 };
    expect(stageOf(await stageFactsOf(ctx, ticket, { fetch: true }))).toMatchObject({
      name: "reviewed",
      review_passed: true,
    });
    expect(await worktrees()).toBe(before);
    // main がまた進んで取り込み直しても（マージコミットの親がまたマージコミット）、連なりを辿って前の見直しを数える（t1162）
    await writeFile(path.join(f.cloneB, "main2.txt"), "main 2\n");
    await git(f.cloneB, ["add", "--", "main2.txt"]);
    await git(f.cloneB, ["commit", "-q", "-m", "main をまた進める"]);
    await git(f.cloneB, ["push", "-q", "origin", "HEAD:main"]);
    await git(f.cloneA, ["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    await git(f.cloneA, ["merge", "-q", "--no-edit", "origin/main"]);
    await git(f.cloneA, ["push", "-q", "origin", "t1"]);
    const beforeAgain = await worktrees();
    const again = await judge(ctx, "ready");
    expect(failed(again)).toEqual([]);
    expect(again.conditions.find((c) => c.id === "review")!.detail).toContain(
      "only merged base into it",
    );
    expect(stageOf(await stageFactsOf(ctx, ticket, { fetch: true }))).toMatchObject({
      name: "reviewed",
      review_passed: true,
    });
    expect(await worktrees()).toBe(beforeAgain);
    // 取り込みの後にコミットを積むと、先端はマージコミットでないので見直し直す
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "取り込みの後"]);
    await git(f.cloneA, ["push", "-q", "origin", "t1"]);
    expect(failed(await judge(ctx, "ready"))).toEqual(["review"]);
    expect(stageOf(await stageFactsOf(ctx, ticket, { fetch: true })).name).toBe("fixed");
  });

  it("gh が返した PR の事実（draft・衝突）を判定に渡し、gh の出力を読めなければ PR を読めないとして pr と mergeable を満たさない", async () => {
    const { ctx, setPr } = await prepared();
    await review(ctx, 1, 0);
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1, 2] });
    await setPr(pr({ isDraft: true, mergeable: "CONFLICTING" }));
    expect(failed(await judge(ctx))).toEqual(["pr", "mergeable"]);
    await setPr("");
    // 空の JSON は読めない PR として扱い、通さない。番号はチケットに記録がないので null、先端も null
    const unreadable = await judge(ctx);
    expect(failed(unreadable)).toEqual(["pr", "mergeable"]);
    expect(unreadable).toMatchObject({ pr: null, sha: null });
    expect(unreadable.conditions[0]!.detail).toContain("Cannot check the PR");
  });

  it("gh が mergeable を UNKNOWN のまま返すと、待って読み直し、上限まで待ったら待った時間を添えて満たさない", async () => {
    const { ctx, setPr } = await prepared();
    await review(ctx, 1, 0);
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1, 2] });
    const saved = mergeableTiming.delaysMs;
    mergeableTiming.delaysMs = [5, 5];
    cleanups.push(() => {
      mergeableTiming.delaysMs = saved;
    });
    await setPr(pr({ mergeable: "UNKNOWN" }));
    const view = await judge(ctx);
    expect(failed(view)).toEqual(["mergeable"]);
    expect(view.conditions.find((c) => c.id === "mergeable")!.detail).toContain(
      "still UNKNOWN after waiting 0.01 s",
    );
  });

  it("low と free は、リモートの追跡 ref がなく fetch もできなくても通る。high は push の時刻を読めず review で落ちる（t663）", async () => {
    const { f, ctx } = await prepared();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1, 2] });
    // 追跡 ref を消し、fetch が失敗するリモートに向け直す（判定は PR の事実と記録だけで足りることを見る）
    await git(f.cloneA, ["update-ref", "-d", "refs/remotes/origin/t1"]);
    await git(f.cloneA, ["remote", "set-url", "origin", path.join(f.root, "no-such-remote.git")]);
    await runCommand(ticketUpdate, asHuman(ctx), { ticket: "t1", gate: "low" });
    expect(failed(await judge(ctx, "ready"))).toEqual([]);
    expect(failed(await judge(ctx))).toEqual([]);
    await runCommand(ticketUpdate, asHuman(ctx), { ticket: "t1", gate: "free" });
    expect(failed(await judge(ctx, "ready"))).toEqual([]);
    expect(failed(await judge(ctx))).toEqual([]);
    await runCommand(ticketUpdate, asHuman(ctx), { ticket: "t1", gate: "high" });
    expect(failed(await judge(ctx, "ready"))).toEqual(["review"]);
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
    await runCommand(configSet, asHuman(base.ctx), { key: "actions.test", value: `sh, ${script}` });
    const ctx = await openContext({ cwd: base.f.cloneA, actor: base.ctx.actor });
    const runs = async () =>
      (await readFile(count, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    const setCode = (n: number) => writeFile(code, String(n));
    return { ...base, ctx, runs, setCode };
  }
  const check = (view: GateView) => view.conditions.find((c) => c.id === "check")!;

  it("最新のコミットの worktree で actions.test を回して判定し、同じコミットでは回し直さない", async () => {
    const { ctx, runs } = await withCheck();
    await review(ctx, 1, 0);
    const view = await judge(ctx, "ready");
    expect(view.passed).toBe(true);
    // 軽い検査を設定していなければ、actions.test を回したとだけ出す
    expect(check(view).detail).toMatch(
      /^The check \(actions\.test: sh .*check\.sh\) passed on the latest commit [0-9a-f]{8}$/,
    );
    expect(await runs()).toBe(1);
    // 同じコミットの判定（ready の後の merge など）は覚えた結果を使う
    await judge(ctx, "ready");
    expect(await runs()).toBe(1);
  });

  it("merge は base の今の先端を含まない先端を base で落として検査を回さず、取り込んだ先端で ready が回した検査を、base が進むまで回し直さずに使う（t1152）", async () => {
    const { ctx, f, runs } = await withCheck();
    await review(ctx, 1, 0);
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1, 2] });
    // 別の clone が main を進める（この clone は fetch していない。base の今の先端は gate が取り込んで読む）
    const advanceMain = async (file: string) => {
      await git(f.cloneB, ["fetch", "-q", "origin"]);
      await git(f.cloneB, ["checkout", "-q", "--detach", "origin/main"]);
      await writeFile(path.join(f.cloneB, file), "main\n");
      await git(f.cloneB, ["add", "--", file]);
      await git(f.cloneB, ["commit", "-q", "-m", "main を進める"]);
      await git(f.cloneB, ["push", "-q", "origin", "HEAD:main"]);
    };
    const base = (view: GateView) => view.conditions.find((c) => c.id === "base")!;
    await advanceMain("main-1.txt");
    const stale = await judge(ctx);
    expect(failed(stale)).toEqual(["base", "check"]);
    expect(base(stale).detail).toContain("Merge base into the work branch, push, and judge again");
    expect(check(stale).not_run).toBe(true);
    expect(await runs()).toBe(0);
    // dg next は同じ事実（baseContainment）を ready の番で読み、ready の前に取り込む手を返す（t1155。
    // PR の番号は記録していないので、段階の事実に足して渡す）
    const ticket = { ...ctx.store.require("ticket", "t1").data, pr: 7 };
    const step = async () =>
      nextOf(ctx, await withBaseFact(ctx, await stageFactsOf(ctx, ticket, { fetch: true })));
    const behind = await step();
    expect(behind.kind).toBe("merge_base");
    expect(behind.commands[0]).toContain("git merge --no-ff origin/main");
    // main を取り込んで push し直す。取り込んだだけのマージコミットなので、前の見直しは数えたまま。
    // ready は base を判定しない（取り込みは ready の前に済ませるが、判定はマージの前だけ）
    await git(f.cloneA, ["merge", "-q", "--no-edit", "origin/main"]);
    await git(f.cloneA, ["push", "-q", "origin", "t1"]);
    expect((await step()).kind).toBe("ready");
    const ready = await judge(ctx, "ready");
    expect(ready.passed).toBe(true);
    expect(ready.conditions.map((c) => c.id)).not.toContain("base");
    expect(await runs()).toBe(1);
    // 同じ先端の merge は、ready が回した検査の結果を使う
    const merged = await judge(ctx);
    expect(merged.passed).toBe(true);
    expect(base(merged).detail).toContain("contains the current tip of base");
    expect(check(merged).detail).toContain("reused the remembered result for this commit");
    expect(await runs()).toBe(1);
    // main がまた進めば、取り込み直すまで通らない
    await advanceMain("main-2.txt");
    expect(failed(await judge(ctx))).toEqual(["base", "check"]);
    expect(await runs()).toBe(1);
  });

  it("検査を回している間に base が進めば、検査が通っても base で落とす（検査の前に読んだ事実で通さない。t1152）", async () => {
    const { ctx, f, runs } = await withCheck();
    await review(ctx, 1, 0);
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1, 2] });
    // 検査のコマンドが、回っている間に別の clone から main を進める（並行のチケットのマージを写す）
    await git(f.cloneB, ["fetch", "-q", "origin"]);
    await git(f.cloneB, ["checkout", "-q", "--detach", "origin/main"]);
    const advance = path.join(f.root, "advance-main.sh");
    await writeFile(
      advance,
      [
        "#!/bin/sh",
        "set -e",
        // 検査は作業ブランチの worktree で回るので、git の環境変数を引き継がずに別の clone を操作する
        `cd '${f.cloneB}'`,
        "echo main > during-check.txt",
        "git add -- during-check.txt",
        "git commit -q -m 'main を進める'",
        "git push -q origin HEAD:main",
        `echo run >> '${path.join(f.root, "check-count")}'`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await runCommand(configSet, asHuman(ctx), { key: "actions.test", value: `sh, ${advance}` });
    const moving = await openContext({ cwd: f.cloneA, actor: ctx.actor });
    const view = await judge(moving);
    expect(await runs()).toBe(1);
    expect(check(view).ok).toBe(true);
    expect(failed(view)).toEqual(["base"]);
    expect(view.conditions.find((c) => c.id === "base")!.detail).toContain(
      "base moved while the check ran",
    );
    // 検査の結果はそのコミットの結果として覚えているので、判定し直しても回さず、base は検査の前に落ちる
    expect(failed(await judge(moving))).toEqual(["base", "check"]);
    expect(await runs()).toBe(1);
  });

  it("通らなければ終了コードと出力の末尾を detail に出して結果を覚えず、ほかの条件を満たさなければ回さない", async () => {
    const { f, ctx, runs, setCode } = await withCheck();
    // 見直しがない（review を満たさない）うちは回さない
    expect(check(await judge(ctx, "ready"))).toMatchObject({
      ok: false,
      detail: expect.stringContaining("was not run"),
      not_run: true,
    });
    expect(await runs()).toBe(0);
    await setCode(3);
    // 新しいコミットを push して見直す（前のコミットの結果は使わない）
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "直し"]);
    await git(f.cloneA, ["push", "-q", "origin", "t1"]);
    await review(ctx, 2, 0);
    const view = await judge(ctx, "ready");
    expect(failed(view)).toEqual(["check"]);
    expect(check(view).not_run).toBeUndefined();
    expect(check(view).detail).toContain("(exit 3)");
    expect(check(view).detail).toContain("前の行\n最後の行");
    // 通らなかった結果は覚えないので、同じコミットでも回し直す（確率で落ちる検査をコミットを足さずにやり直せる）
    await setCode(0);
    expect(check(await judge(ctx, "ready")).ok).toBe(true);
    expect(await runs()).toBe(2);
  });

  it("通った後に actions.test を変えると、同じコミットでも検査を回し直す（覚えた結果はコマンドごと）", async () => {
    const { f, ctx: first, runs } = await withCheck();
    await review(first, 1, 0);
    expect(check(await judge(first, "ready")).ok).toBe(true);
    expect(await runs()).toBe(1);
    // 検査のコマンドを別のスクリプトに変える。同じコミットでも、覚えた結果は使わずに回す
    const other = path.join(f.root, "check-other.sh");
    await writeFile(
      other,
      `#!/bin/sh\necho run >> '${path.join(f.root, "check-count")}'\necho 別の検査\nexit 0\n`,
      { mode: 0o755 },
    );
    await runCommand(configSet, asHuman(first), { key: "actions.test", value: `sh, ${other}` });
    const changed = await openContext({ cwd: f.cloneA, actor: first.actor });
    const view = await judge(changed, "ready");
    expect(check(view)).toMatchObject({
      ok: true,
      detail: expect.stringContaining("check-other.sh"),
    });
    expect(await runs()).toBe(2);
    // 変えたあとの同じコマンドの結果は覚えるので、もう一度は回さない
    await judge(changed, "ready");
    expect(await runs()).toBe(2);
  });

  it("存在しないコマンドを指すと検査を回せないで ok が false になり、結果を覚えず、見つかるようになれば回して通る", async () => {
    const { f, ctx: first } = await withCheck();
    const name = "dg-t615-no-such-check";
    await runCommand(configSet, asHuman(first), { key: "actions.test", value: name });
    const ctx = await openContext({ cwd: f.cloneA, actor: first.actor });
    await review(ctx, 1, 0);
    const view = await judge(ctx, "ready");
    expect(view.passed).toBe(false);
    expect(check(view)).toMatchObject({
      ok: false,
      detail: expect.stringContaining(`Cannot run the check (actions.test: ${name})`),
    });
    // 回せなかった結果は覚えない（記録のファイルがない）
    const stored = await readFile(path.join(ctx.repo.localDir, "checks", "t1.json"), "utf8").catch(
      () => undefined,
    );
    expect(stored).toBeUndefined();
    // コマンドが見つかるようになれば、同じコミットでも回して通る
    const bin = path.join(f.root, "check-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, name), "#!/bin/sh\necho 通った\nexit 0\n", { mode: 0o755 });
    const saved = process.env["PATH"];
    process.env["PATH"] = bin + path.delimiter + (saved ?? "");
    cleanups.push(() => {
      process.env["PATH"] = saved;
    });
    expect(check(await judge(ctx, "ready")).ok).toBe(true);
  });

  it("worktree が最新のコミットでない・未コミットの変更があるなら回さずに満たさない", async () => {
    const { f, ctx, runs } = await withCheck();
    await review(ctx, 1, 0);
    // push していないコミットがある（worktree の HEAD がリモートの先端と違う）
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "まだ push していない"]);
    expect(check(await judge(ctx, "ready")).detail).toContain("is not the latest commit");
    await git(f.cloneA, ["reset", "-q", "--hard", "HEAD~1"]);
    await writeFile(path.join(f.cloneA, "dirty.txt"), "x");
    expect(check(await judge(ctx, "ready")).detail).toContain("has uncommitted changes");
    expect(await runs()).toBe(0);
  });

  it("dg gate --only check は push の前の worktree の HEAD を検査して覚え、push した後の ready は回し直さない（t741）", async () => {
    const { f, ctx, runs } = await withCheck();
    // push していないコミット（--only check は push の前のコミットも検査する）
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "まだ push していない"]);
    const only = async () =>
      (await runCommand(gate, ctx, { ticket: "t1", only: "check" })).data as GateView;
    const view = await only();
    expect(view.conditions.map((c) => c.id)).toEqual(["check"]);
    expect(view.passed).toBe(true);
    expect(check(view).detail).toContain("passed on the latest commit");
    expect(await runs()).toBe(1);
    // 同じコミットで呼び直すと、覚えた結果を返して回さない
    expect((await only()).passed).toBe(true);
    expect(check(await only()).detail).toContain("reused the remembered result");
    expect(await runs()).toBe(1);
    // push した後の ready は、同じコミットの覚えた結果を使う
    await git(f.cloneA, ["push", "-q", "origin", "t1"]);
    await review(ctx, 1, 0);
    expect(failed(await judge(ctx, "ready"))).toEqual([]);
    expect(await runs()).toBe(1);
    // 未コミットの変更があれば回さずに拒む
    await writeFile(path.join(f.cloneA, "dirty.txt"), "x");
    expect(check(await only()).detail).toContain("has uncommitted changes");
    expect(await runs()).toBe(1);
  });

  describe("軽い検査（actions.light_test・actions.light_paths。t632）", () => {
    /** 差分のない今のコミットで全体の検査を 1 回通し（actions.test を回す）、そのコミットの短い SHA を返す（t741） */
    const passFull = async (ctx: CommandContext, cloneA: string, at: number) => {
      await review(ctx, at, 0);
      expect(check(await judge(ctx, "ready")).detail).toContain(
        "Ran actions.test because there are no files changed from base",
      );
      return (await git(cloneA, ["rev-parse", "HEAD"])).stdout.trim().slice(0, 8);
    };

    /**
     * withCheck に、軽い検査の台本と対象のパス（docs/** と最上位の *.md）を足した文脈。
     * 台本は回数のファイルに、actions.test は run、軽い検査は light を 1 行足す
     */
    async function withLight() {
      const base = await withCheck();
      const light = path.join(base.f.root, "light.sh");
      const count = path.join(base.f.root, "check-count");
      await writeFile(light, `#!/bin/sh\necho light >> '${count}'\necho 軽い検査\nexit 0\n`, {
        mode: 0o755,
      });
      await runCommand(configSet, asHuman(base.ctx), {
        key: "actions.light_test",
        value: `sh, ${light}`,
      });
      await runCommand(configSet, asHuman(base.ctx), {
        key: "actions.light_paths",
        value: "docs/**, *.md",
      });
      const ctx = await openContext({ cwd: base.f.cloneA, actor: base.ctx.actor });
      const lines = async () =>
        (await readFile(count, "utf8").catch(() => "")).split("\n").filter(Boolean);
      /** 作業ブランチにファイルを足してコミットし push する */
      const commit = async (...files: string[]) => {
        for (const file of files) {
          await mkdir(path.dirname(path.join(base.f.cloneA, file)), { recursive: true });
          await writeFile(path.join(base.f.cloneA, file), "x\n");
        }
        await git(base.f.cloneA, ["add", "--", ...files]);
        await git(base.f.cloneA, ["commit", "-q", "-m", "変更"]);
        await git(base.f.cloneA, ["push", "-q", "origin", "t1"]);
      };
      return { ...base, ctx, lines, commit };
    }

    it("差分がすべて対象のパスに入れば軽い検査を回して detail に出し、同じコミットの merge では回し直さない", async () => {
      const { ctx, lines, commit } = await withLight();
      await commit("docs/a/b.md", "NOTE.md");
      await review(ctx, 1, 0);
      const view = await judge(ctx, "ready");
      expect(view.passed).toBe(true);
      expect(check(view).detail).toMatch(
        /^The check \(light check actions\.light_test: sh .*light\.sh\) passed on the latest commit [0-9a-f]{8} \(Ran the light check because all 2 changed files are in actions\.light_paths\)$/,
      );
      expect(await lines()).toEqual(["light"]);
      // ready で通った同じコミットの merge は、覚えた結果を使う（軽い検査も actions.test も回さない）
      await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1, 2] });
      const merged = await judge(ctx, "merge");
      expect(merged.passed).toBe(true);
      expect(check(merged).detail).toContain("light check actions.light_test");
      expect(await lines()).toEqual(["light"]);
    });

    it("差分に対象のパスの外のファイルが 1 つでもあれば actions.test を回し、外のファイルを detail に出す", async () => {
      const { ctx, lines, commit } = await withLight();
      // docs/ の下と最上位の md に加えて、docs の外の md（* は / をまたがない）とコードを変える
      await commit("docs/a.md", "README.md", "src/a.ts");
      await review(ctx, 1, 0);
      const view = await judge(ctx, "ready");
      expect(view.passed).toBe(true);
      expect(check(view).detail).toContain("The check (actions.test: sh ");
      expect(check(view).detail).toContain(
        "Ran actions.test because the diff has files outside actions.light_paths (src/a.ts; 1 files)",
      );
      expect(await lines()).toEqual(["run"]);
    });

    it("差分のファイルがない（空のコミットだけ）なら actions.test を回す", async () => {
      const { ctx, lines } = await withLight();
      await review(ctx, 1, 0);
      const view = await judge(ctx, "ready");
      expect(check(view).detail).toContain(
        "Ran actions.test because there are no files changed from base",
      );
      expect(await lines()).toEqual(["run"]);
    });

    it("全体の検査が通ったコミットの後に light_paths だけを足すと、そのコミットからの差分で軽い検査を選び、全体の記録は残る（t741）", async () => {
      const { ctx, f, lines, commit } = await withLight();
      const base = await passFull(ctx, f.cloneA, 1);
      await commit("docs/a.md");
      await review(ctx, 2, 0);
      const view = await judge(ctx, "ready");
      expect(view.passed).toBe(true);
      expect(check(view).detail).toContain(
        `Ran the light check because all 1 changed files since commit ${base}, the last commit whose actions.test passed, are in actions.light_paths`,
      );
      expect(await lines()).toEqual(["run", "light"]);
      // 軽い検査が通っても、全体の記録（基準のコミット）は消えない。次の light_paths だけの差分も同じ基準から選ぶ
      await commit("NOTE.md");
      await review(ctx, 3, 0);
      expect(check(await judge(ctx, "ready")).detail).toContain(`since commit ${base}`);
      expect(await lines()).toEqual(["run", "light", "light"]);
    });

    it("全体の検査が通ったコミットの後にコードを変えたら、全体を回す（t741）", async () => {
      const { ctx, f, lines, commit } = await withLight();
      await passFull(ctx, f.cloneA, 1);
      await commit("docs/a.md");
      await review(ctx, 2, 0);
      expect(check(await judge(ctx, "ready")).detail).toContain("Ran the light check");
      await commit("src/a.ts");
      await review(ctx, 3, 0);
      const view = await judge(ctx, "ready");
      expect(view.passed).toBe(true);
      expect(check(view).detail).toContain("Ran actions.test because the changes since commit");
      expect(check(view).detail).toContain(
        "include files outside actions.light_paths (src/a.ts; 1 files)",
      );
      expect(await lines()).toEqual(["run", "light", "run"]);
    });

    it("全体の検査が通ったコミットが HEAD の祖先でなければ（rebase・force push）、差分が軽くても全体を回す（t741）", async () => {
      const { ctx, f, lines } = await withLight();
      await passFull(ctx, f.cloneA, 1);
      // 1 つ前のコミットから書き直し、force push する（前のコミットは祖先に残らない）
      await git(f.cloneA, ["reset", "-q", "--hard", "HEAD~1"]);
      await mkdir(path.join(f.cloneA, "docs"), { recursive: true });
      await writeFile(path.join(f.cloneA, "docs", "b.md"), "x\n");
      await git(f.cloneA, ["add", "--", "docs/b.md"]);
      await git(f.cloneA, ["commit", "-q", "-m", "書き直し"]);
      await git(f.cloneA, ["push", "-q", "-f", "origin", "t1"]);
      await review(ctx, 2, 0);
      const view = await judge(ctx, "ready");
      expect(check(view).detail).toContain(
        "is not an ancestor of the latest commit (rebased or force-pushed)",
      );
      expect(await lines()).toEqual(["run", "run"]);
    });

    it("全体の検査が通ったあとに main を merge で取り込んだら、差分が軽くても全体を回す（t741）", async () => {
      const { ctx, f, lines } = await withLight();
      await passFull(ctx, f.cloneA, 1);
      // main 側で docs だけを変えたコミットを作り、merge で取り込む
      await git(f.cloneA, ["checkout", "-q", "-b", "main-side", "HEAD~1"]);
      await mkdir(path.join(f.cloneA, "docs"), { recursive: true });
      await writeFile(path.join(f.cloneA, "docs", "m.md"), "x\n");
      await git(f.cloneA, ["add", "--", "docs/m.md"]);
      await git(f.cloneA, ["commit", "-q", "-m", "main の変更"]);
      await git(f.cloneA, ["checkout", "-q", "t1"]);
      await git(f.cloneA, ["merge", "-q", "--no-ff", "-m", "main を取り込む", "main-side"]);
      await git(f.cloneA, ["push", "-q", "origin", "t1"]);
      await review(ctx, 2, 0);
      const view = await judge(ctx, "ready");
      expect(check(view).detail).toContain("because a merge commit came after commit");
      expect(await lines()).toEqual(["run", "run"]);
    });

    it("全体の検査が通ったあとに actions.test を変えたら、差分が軽くても全体を回す（t741）", async () => {
      const { ctx, f, lines, commit } = await withLight();
      await passFull(ctx, f.cloneA, 1);
      await commit("docs/a.md");
      await review(ctx, 2, 0);
      expect(check(await judge(ctx, "ready")).detail).toContain("Ran the light check");
      const other = path.join(f.root, "check-other-t741.sh");
      await writeFile(
        other,
        `#!/bin/sh\necho run >> '${path.join(f.root, "check-count")}'\necho 別の検査\nexit 0\n`,
        { mode: 0o755 },
      );
      await runCommand(configSet, asHuman(ctx), { key: "actions.test", value: `sh, ${other}` });
      const changed = await openContext({ cwd: f.cloneA, actor: ctx.actor });
      await review(changed, 3, 0);
      expect(check(await judge(changed, "ready")).detail).toContain(
        "Ran actions.test because actions.test changed since commit",
      );
      expect(await lines()).toEqual(["run", "light", "run"]);
    });

    it("覚える結果は直近 5 件と全体の検査の基準のコミットの結果だけを残し、古い結果は消す（t741）", async () => {
      const { ctx, f, commit, lines } = await withLight();
      await passFull(ctx, f.cloneA, 1);
      const fullSha = (await git(f.cloneA, ["rev-parse", "HEAD"])).stdout.trim();
      const shas: string[] = [];
      // 軽い検査で 6 件の通った結果を積む（基準のコミットは動かない）
      for (let i = 0; i < 6; i++) {
        await commit(`docs/n${i}.md`);
        await review(ctx, 2 + i, 0);
        expect(check(await judge(ctx, "ready")).ok).toBe(true);
        shas.push((await git(f.cloneA, ["rev-parse", "HEAD"])).stdout.trim());
      }
      const record = JSON.parse(
        await readFile(path.join(ctx.repo.localDir, "checks", "t1.json"), "utf8"),
      ) as { results: Array<{ sha: string }>; full: { sha: string } };
      const kept = record.results.map((r) => r.sha);
      // 基準のコミット（古い）と直近 5 件（n1〜n5）は残り、最初の n0 だけが消える
      expect(kept).toHaveLength(6);
      expect(kept).toContain(fullSha);
      expect(kept).not.toContain(shas[0]);
      expect(kept).toEqual(expect.arrayContaining(shas.slice(1)));
      expect(record.full.sha).toBe(fullSha);
      // 基準のコミットに戻して呼ぶと、回さずに覚えた結果を返す
      const before = (await lines()).length;
      await git(f.cloneA, ["reset", "-q", "--hard", fullSha]);
      const only = (await runCommand(gate, ctx, { ticket: "t1", only: "check" })).data as GateView;
      expect(only.passed).toBe(true);
      expect(check(only).detail).toContain("reused the remembered result");
      expect((await lines()).length).toBe(before);
    });

    it("dg gate --only check は見直しの前の検査（actions.pre_review_test）を回し、その結果を ready の全体の検査に数えない（t1154）", async () => {
      const { ctx: first, f, lines, commit } = await withLight();
      const pre = path.join(f.root, "pre.sh");
      await writeFile(
        pre,
        `#!/bin/sh\necho pre >> '${path.join(f.root, "check-count")}'\necho 見直しの前の検査\nexit 0\n`,
        { mode: 0o755 },
      );
      await runCommand(configSet, asHuman(first), {
        key: "actions.pre_review_test",
        value: `sh, ${pre}`,
      });
      const ctx = await openContext({ cwd: f.cloneA, actor: first.actor });
      const only = async () =>
        (await runCommand(gate, ctx, { ticket: "t1", only: "check" })).data as GateView;
      // コードを変えた差分：--only check は全体の代わりに見直しの前の検査を回し、同じコミットでは回し直さない
      await commit("src/a.ts");
      const view = await only();
      expect(view.passed).toBe(true);
      expect(check(view).detail).toMatch(
        /^The check \(pre-review check actions\.pre_review_test: sh .*pre\.sh\) passed on the latest commit [0-9a-f]{8} \(Ran actions\.pre_review_test instead of actions\.test because /,
      );
      expect(check(await only()).detail).toContain("reused the remembered result");
      expect(await lines()).toEqual(["pre"]);
      // 同じコミットの ready は、見直しの前の検査の結果を使わずに全体（actions.test）を回す
      await review(ctx, 1, 0);
      const ready = await judge(ctx, "ready");
      expect(ready.passed).toBe(true);
      expect(check(ready).detail).toContain("The check (actions.test: sh ");
      expect(await lines()).toEqual(["pre", "run"]);
      // 全体が通ったコミットでの --only check は、全体の結果を使って回さない
      expect(check(await only()).detail).toContain("The check (actions.test: sh ");
      expect(await lines()).toEqual(["pre", "run"]);
      // 文書だけを足したあとは、--only check も軽い検査を回す
      await commit("docs/a.md");
      expect(check(await only()).detail).toContain("light check actions.light_test");
      expect(await lines()).toEqual(["pre", "run", "light"]);
    });

    it("旧形式（1 チケット 1 件のオブジェクト）の記録は読めないものとして、検査を回して新しい形式で書き直す（t741）", async () => {
      const { ctx, f, lines } = await withLight();
      await review(ctx, 1, 0);
      const dir = path.join(ctx.repo.localDir, "checks");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "t1.json"),
        JSON.stringify({
          sha: "0".repeat(40),
          command: ctx.config.actions.test,
          code: 0,
          tail: "",
          // 旧形式は読めないものとして捨てるので、at は比べない。時計を読まずに固定の値を置く
          at: "2026-01-01T00:00:00.000Z",
        }),
      );
      expect(check(await judge(ctx, "ready")).ok).toBe(true);
      expect(await lines()).toEqual(["run"]);
      const record = JSON.parse(await readFile(path.join(dir, "t1.json"), "utf8")) as {
        results: Array<{ sha: string }>;
      };
      expect(record.results.map((r) => r.sha)).toEqual([
        (await git(f.cloneA, ["rev-parse", "HEAD"])).stdout.trim(),
      ]);
    });
  });
});

describe("回す検査の選び方（chooseCheck。t632）", () => {
  const actions = {
    test: ["full"],
    light_test: ["light"],
    light_paths: ["docs/**", "*.md", "packages/vscode/media/**/*.png", "a?.txt"],
  };

  it("glob は * と ? が / をまたがず、** が階層をまたぐ", () => {
    expect(matchesAnyGlob("docs/x/y/z.md", ["docs/**"])).toBe(true);
    expect(matchesAnyGlob("docs", ["docs/**"])).toBe(false);
    expect(matchesAnyGlob("README.md", ["*.md"])).toBe(true);
    expect(matchesAnyGlob("docs/README.md", ["*.md"])).toBe(false);
    expect(matchesAnyGlob("packages/vscode/media/icon.png", actions.light_paths)).toBe(true);
    expect(matchesAnyGlob("packages/vscode/media/a/b.png", actions.light_paths)).toBe(true);
    expect(matchesAnyGlob("ab.txt", actions.light_paths)).toBe(true);
    expect(matchesAnyGlob("a/b.txt", actions.light_paths)).toBe(false);
    // . などの記号は文字のまま比べる
    expect(matchesAnyGlob("READMExmd", ["*.md"])).toBe(false);
  });

  it("軽い検査かその対象のパスが空なら、差分によらず actions.test", () => {
    expect(chooseCheck({ ...actions, light_test: [] }, ["docs/a.md"])).toMatchObject({
      command: ["full"],
      light: false,
      why: "",
    });
    expect(chooseCheck({ ...actions, light_paths: [] }, ["docs/a.md"]).light).toBe(false);
  });

  it("差分を読めない・空・外のファイルがあれば actions.test、すべて対象なら軽い検査", () => {
    expect(chooseCheck(actions, undefined).command).toEqual(["full"]);
    expect(chooseCheck(actions, []).command).toEqual(["full"]);
    expect(chooseCheck(actions, ["docs/a.md", "src/b.ts"]).command).toEqual(["full"]);
    expect(chooseCheck(actions, ["docs/a.md", "README.md"])).toMatchObject({
      command: ["light"],
      light: true,
    });
  });
});

describe("場面ごとの検査の決め方（planCheck。t1154）", () => {
  const actions = { test: ["full"], pre_review_test: ["pre"] };
  const whole = { command: ["full"], light: false, why: "全体の理由" };
  const light = { command: ["light"], light: true, why: "軽い理由" };

  it("軽い検査は、場面と見直しの前の検査の設定によらず軽い検査のまま", () => {
    for (const purpose of ["pre_review", "gate"] as const)
      for (const pre of [["pre"], []])
        for (const passedFull of [true, false])
          expect(
            planCheck({ ...actions, pre_review_test: pre }, purpose, light, passedFull),
          ).toEqual({ command: ["light"], kind: "light", why: "軽い理由" });
  });

  it("見直しの前（dg gate --only check）で全体になったら、設定した見直しの前の検査に替える", () => {
    const planned = planCheck(actions, "pre_review", whole, false);
    expect(planned).toMatchObject({ command: ["pre"], kind: "pre_review" });
    expect(planned.why).toContain("Ran actions.pre_review_test instead of actions.test");
  });

  it("見直しの前でも、未設定・actions.test と同じコマンド・このコミットで全体が通っているときは全体のまま", () => {
    const full = { command: ["full"], kind: "full", why: "全体の理由" };
    expect(planCheck({ ...actions, pre_review_test: [] }, "pre_review", whole, false)).toEqual(
      full,
    );
    expect(
      planCheck({ ...actions, pre_review_test: ["full"] }, "pre_review", whole, false),
    ).toEqual(full);
    expect(planCheck(actions, "pre_review", whole, true)).toEqual(full);
  });

  it("ready・merge の検査は、見直しの前の検査を設定していても全体のまま", () => {
    for (const passedFull of [true, false])
      expect(planCheck(actions, "gate", whole, passedFull)).toEqual({
        command: ["full"],
        kind: "full",
        why: "全体の理由",
      });
  });
});
