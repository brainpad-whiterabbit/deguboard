import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { OperationError } from "../errors.js";
import { resetGhCache } from "../git/facts.js";
import type { Run } from "../model/run.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { brief } from "./brief.js";
import { prMerge, prReady, type PrAdvanceView } from "./pr.js";
import { runFinish, runHandoff, runReviewResult, runStart } from "./run.js";
import { configSet, init } from "./setup.js";
import { ticketCheck, ticketClaim, ticketCreate } from "./ticket.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * 偽の gh。pr view は PR #7 の JSON（pr() の値。ファイルから返す）を返し、pr ready・pr merge は引数を記録に書き足す。
 * 本文の読み書きは gh api の pulls（REST）で受け、PATCH の --input の中身を edited に残して呼んだことを記録に書く（t600）。
 * Projects (classic) の廃止を写し、pr view --json body と pr edit は GraphQL の projectCards のエラーで落ちる（t637）
 */
async function fakeGh(root: string, pr: () => string) {
  const bin = path.join(root, "fake-bin");
  const log = path.join(root, "gh-calls.log");
  const viewFile = path.join(root, "gh-view.json");
  const edited = path.join(root, "gh-edited-body.json");
  // このファイルがあると、本文の読み取り（gh api の GET）だけ失敗する（検査の view は通す）
  const failBody = path.join(root, "gh-fail-body");
  // このファイルがあると、本文の書き込み（gh api の PATCH）だけ失敗する
  const failWrite = path.join(root, "gh-fail-write");
  // このファイルがあると、gh pr merge だけ失敗する（t643。マージの失敗で消した worktree を戻すかを見る）
  const failMerge = path.join(root, "gh-fail-merge");
  const projectCards =
    'echo "GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience (repository.pullRequest.projectCards)" >&2; exit 1';
  await mkdir(bin, { recursive: true });
  const write = async () => {
    await writeFile(viewFile, pr());
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        'if [ "$1" = api ]; then',
        '  if [ "$2" = --method ] && [ "$3" = PATCH ] && [ "$4" = "repos/{owner}/{repo}/pulls/7" ] && [ "$5" = --input ]; then',
        `    if [ -f '${failWrite}' ]; then echo "gh の失敗" >&2; exit 1; fi`,
        `    echo "api PATCH pulls/7" >> '${log}'; cp "$6" '${edited}'; exit 0`,
        "  fi",
        '  if [ "$2" = "repos/{owner}/{repo}/pulls/7" ]; then',
        `    if [ -f '${failBody}' ]; then echo "gh の失敗" >&2; exit 1; fi; cat '${viewFile}'; exit 0`,
        "  fi",
        "  exit 1",
        "fi",
        'case "$2" in',
        `  view) if [ "$5" = body ]; then ${projectCards}; fi; cat '${viewFile}';;`,
        `  merge) if [ -f '${failMerge}' ]; then echo "gh の失敗" >&2; exit 1; fi; echo "$@" >> '${log}';;`,
        `  ready) echo "$@" >> '${log}';;`,
        `  edit) ${projectCards};;`,
        "  *) exit 1;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  };
  await write();
  const saved = process.env["PATH"];
  process.env["PATH"] = bin + path.delimiter + (saved ?? "");
  resetGhCache();
  cleanups.push(() => {
    process.env["PATH"] = saved;
    resetGhCache();
  });
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter((l) => l !== "");
  const editedBody = async () =>
    (JSON.parse(await readFile(edited, "utf8")) as { body: string }).body;
  const failBodyView = () => writeFile(failBody, "1");
  const failBodyWrite = () => writeFile(failWrite, "1");
  const failMergeCall = () => writeFile(failMerge, "1");
  const allowMergeCall = () => rm(failMerge, { force: true });
  return { write, calls, editedBody, failBodyView, failBodyWrite, failMergeCall, allowMergeCall };
}

/** t1 を feat/t1 で claim して 1 コミット push し、PR #7（偽の gh。draft）がある文脈 */
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
    body: "## 受け入れ条件\n\n- [ ] 1 つめ\n",
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
  const state = { draft: true };
  const gh = await fakeGh(f.root, () =>
    JSON.stringify({
      number: 7,
      state: "OPEN",
      isDraft: state.draft,
      mergeable: "MERGEABLE",
      body: "## 概要\n\n元の本文\n",
    }),
  );
  const undraft = async () => {
    state.draft = false;
    await gh.write();
  };
  return {
    ctx,
    calls: gh.calls,
    editedBody: gh.editedBody,
    failBodyView: gh.failBodyView,
    failBodyWrite: gh.failBodyWrite,
    failMergeCall: gh.failMergeCall,
    allowMergeCall: gh.allowMergeCall,
    undraft,
  };
}

/** 見直しの 1 回を記録する（offset 秒後の時刻。回の順と作業ブランチの後を分けるため） */
async function reviewRound(
  ctx: CommandContext,
  offset: number,
  findings: Array<{
    severity: "heavy" | "light";
    category: string;
    file?: string;
    line?: number;
    reason: string;
    fix?: string;
  }>,
) {
  ctx.now = () => new Date(Date.now() + offset * 1000);
  const run = (
    await runCommand(runStart, ctx, { ticket: "t1", step: "review", agent: "claude-code" })
  ).data as Run;
  await runCommand(runReviewResult, ctx, { ticket: "t1", findings });
  await runCommand(runFinish, ctx, { run: run.id, result: "success" });
}

/** 最後の push より後に通った見直しを記録する */
async function passedReview(ctx: CommandContext) {
  ctx.now = () => new Date(Date.now() + 60_000);
  const run = (
    await runCommand(runStart, ctx, { ticket: "t1", step: "review", agent: "claude-code" })
  ).data as Run;
  await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 0, light: 0, passed: true });
  await runCommand(runFinish, ctx, { run: run.id, result: "success" });
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as OperationError,
  );

describe("dg pr ready・dg pr merge（t545）", () => {
  it("品質ゲートを満たさなければ GATE_FAILED で満たさない条件と理由を返し、gh を呼ばない", async () => {
    const { ctx, calls } = await prepared();
    const ready = await rejection(runCommand(prReady, ctx, { ticket: "t1" }));
    expect(ready).toBeInstanceOf(OperationError);
    expect(ready!.code).toBe("GATE_FAILED");
    expect(ready!.message).toContain("dg gate t1 --for ready");
    expect(ready!.detail).toContain("review:");
    expect(ready!.detail).toContain("ask a human to run gh pr ready");
    const merge = await rejection(runCommand(prMerge, ctx, { ticket: "t1" }));
    expect(merge!.code).toBe("GATE_FAILED");
    expect(merge!.detail).toContain("acceptance:");
    expect(await calls()).toEqual([]);
  });

  it("満たせば gh pr ready・gh pr merge を PR の番号で呼び、判定した品質ゲートを返す", async () => {
    const { ctx, calls, undraft } = await prepared();
    await passedReview(ctx);
    const ready = (await runCommand(prReady, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(ready).toMatchObject({ ticket: "t1", pr: 7, action: "ready", gate: { passed: true } });
    // マージの前は draft でなく、受け入れ条件がすべて付いていること
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    const merged = (await runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true }))
      .data as PrAdvanceView;
    expect(merged).toMatchObject({ pr: 7, action: "merge", method: "squash" });
    expect(await calls()).toEqual(["pr ready 7", "pr merge 7 --squash --delete-branch"]);
  });

  it("--method・--delete-branch を省けば config の merge.method・merge.delete_branch に従い、渡せばそちらを使う（t601）", async () => {
    const { ctx: first, calls, undraft } = await prepared();
    await runCommand(configSet, first, { key: "merge.method", value: "rebase" });
    await runCommand(configSet, first, { key: "merge.delete_branch", value: "true" });
    const ctx = await openContext({ cwd: first.repo.topLevel, actor: first.actor });
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    const merged = (await runCommand(prMerge, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(merged.method).toBe("rebase");
    await runCommand(prMerge, ctx, { ticket: "t1", method: "merge", delete_branch: false });
    expect(await calls()).toEqual(["pr merge 7 --rebase --delete-branch", "pr merge 7 --merge"]);
  });

  it("--delete-branch のときは品質ゲートを通した後、gh を呼ぶ前に作業ブランチの worktree を消し、その worktree から呼べば消さずに警告する（t601）", async () => {
    const { ctx, calls, undraft } = await prepared();
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    // feat/t1 を cloneA から外し、別の worktree に checkout する
    const main = ctx.repo.topLevel;
    await git(main, ["checkout", "-q", "main"]);
    const wt = path.join(path.dirname(main), "wt-t1");
    await git(main, ["worktree", "add", "-q", wt, "feat/t1"]);
    // その worktree から呼ぶと、自分の作業ツリーは消さない
    const inner = await openContext({ cwd: wt, actor: ctx.actor });
    const fromInside = await runCommand(prMerge, inner, { ticket: "t1", delete_branch: true });
    expect(fromInside.warnings.join("\n")).toContain("so the worktree is not deleted");
    expect(await git(main, ["worktree", "list"])).toMatchObject({
      stdout: expect.stringContaining("wt-t1"),
    });
    // main の worktree から呼ぶと消してから gh を呼ぶ
    const merged = await runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true });
    expect(merged.warnings).toEqual([]);
    expect((await git(main, ["worktree", "list"])).stdout).not.toContain("wt-t1");
    expect(await calls()).toEqual([
      "pr merge 7 --squash --delete-branch",
      "pr merge 7 --squash --delete-branch",
    ]);
  });

  it("--delete-branch で gh pr merge が失敗したら、消した作業ブランチの worktree を同じパスに戻し、エラーの detail にその扱いを出す。原因を直した後の再実行はマージできる（t643）", async () => {
    const { ctx, calls, undraft, failMergeCall, allowMergeCall } = await prepared();
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    const main = ctx.repo.topLevel;
    await git(main, ["checkout", "-q", "main"]);
    const wt = path.join(path.dirname(main), "wt-t1");
    await git(main, ["worktree", "add", "-q", wt, "feat/t1"]);
    await failMergeCall();
    const err = await rejection(runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true }));
    expect(err).toBeInstanceOf(OperationError);
    expect(err!.code).toBe("GIT_ERROR");
    expect(err!.detail).toContain("the deleted worktree");
    expect(err!.detail).toContain("was restored (you can continue working)");
    // 同じパスに、作業ブランチを checkout した worktree が戻っている
    expect(existsSync(wt)).toBe(true);
    expect((await git(wt, ["branch", "--show-current"])).stdout.trim()).toBe("feat/t1");
    expect((await git(main, ["worktree", "list"])).stdout).toContain("wt-t1");
    expect(await calls()).toEqual([]);
    // 原因を直した後は、同じ呼び方でマージでき、今度は worktree を消してから gh を呼ぶ
    await allowMergeCall();
    const merged = await runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true });
    expect(merged.data).toMatchObject({ pr: 7, action: "merge" });
    expect(merged.warnings).toEqual([]);
    expect((await git(main, ["worktree", "list"])).stdout).not.toContain("wt-t1");
    expect(await calls()).toEqual(["pr merge 7 --squash --delete-branch"]);
  });

  /**
   * worktree.setup を書き、作業ブランチの worktree を main の外に用意して、gh pr merge が失敗する状態にした文脈を返す。
   * --delete-branch で呼ぶと worktree は消され、失敗で同じパスに戻る
   */
  async function setupWorktreeMergeFails(setup: string[]) {
    const { ctx: first, calls, undraft, failMergeCall } = await prepared();
    await runCommand(configSet, first, { key: "worktree.setup", value: setup });
    const ctx = await openContext({ cwd: first.repo.topLevel, actor: first.actor });
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    const main = ctx.repo.topLevel;
    await git(main, ["checkout", "-q", "main"]);
    const wt = path.join(path.dirname(main), "wt-t1");
    await git(main, ["worktree", "add", "-q", wt, "feat/t1"]);
    await failMergeCall();
    return { ctx, main, wt, calls };
  }

  it("--delete-branch で gh pr merge が失敗して worktree を戻したら、戻した worktree で config の worktree.setup を回し直す（t643）", async () => {
    // node で印のファイルを書くだけの準備のコマンド（シェルを通さない）
    const marker = ["node", "-e", "require('node:fs').writeFileSync('setup-ran.txt', 'ok')"];
    const { ctx, main, wt, calls } = await setupWorktreeMergeFails(marker);
    const err = await rejection(runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true }));
    expect(err!.code).toBe("GIT_ERROR");
    expect(err!.detail).toContain("was restored (you can continue working)");
    expect(err!.detail).toContain("The setup command (node -e");
    expect(err!.detail).toContain("was also run again");
    // 印のファイルは戻した worktree の中にあり、元のクローンには無い
    expect(existsSync(path.join(wt, "setup-ran.txt"))).toBe(true);
    expect(existsSync(path.join(main, "setup-ran.txt"))).toBe(false);
    expect(await calls()).toEqual([]);
  });

  it("戻した worktree で準備のコマンドが止まったら、エラーの detail に終了コードと手で回す案内を出す（t643）", async () => {
    const { ctx, wt, calls } = await setupWorktreeMergeFails([
      "node",
      "-e",
      "console.error('準備の失敗'); process.exit(3)",
    ]);
    const err = await rejection(runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true }));
    expect(err!.code).toBe("GIT_ERROR");
    expect(err!.detail).toContain("was restored (you can continue working)");
    expect(err!.detail).toContain("exit code 3");
    expect(err!.detail).toContain("end of stderr: 準備の失敗");
    expect(err!.detail).toContain("by hand in");
    // 戻した worktree は残っている（作業を続けられる）
    expect(existsSync(wt)).toBe(true);
    expect(await calls()).toEqual([]);
  });

  it("検査（actions.test）が通らなければ GATE_FAILED に終了コードと出力の末尾を入れ、gh を呼ばない（t601）", async () => {
    const { ctx: first, calls } = await prepared();
    const script = path.join(path.dirname(first.repo.topLevel), "failing-check.sh");
    await writeFile(script, "#!/bin/sh\necho 落ちたテスト\nexit 1\n", { mode: 0o755 });
    await runCommand(configSet, first, { key: "actions.test", value: `sh, ${script}` });
    const ctx = await openContext({ cwd: first.repo.topLevel, actor: first.actor });
    await passedReview(ctx);
    const ready = await rejection(runCommand(prReady, ctx, { ticket: "t1" }));
    expect(ready!.code).toBe("GATE_FAILED");
    expect(ready!.detail).toContain("check: The check");
    expect(ready!.detail).toContain("exit 1");
    expect(ready!.detail).toContain("落ちたテスト");
    expect(await calls()).toEqual([]);
  });

  it("検査（actions.test）が通らなければ dg pr merge は GATE_FAILED で止まり、gh を呼ばず、検査に使った作業ブランチの worktree を残す（t615）", async () => {
    const { ctx: first, calls, undraft } = await prepared();
    const script = path.join(path.dirname(first.repo.topLevel), "failing-merge-check.sh");
    await writeFile(script, "#!/bin/sh\necho 落ちたテスト\nexit 1\n", { mode: 0o755 });
    await runCommand(configSet, first, { key: "actions.test", value: `sh, ${script}` });
    const ctx = await openContext({ cwd: first.repo.topLevel, actor: first.actor });
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    // feat/t1 を main の worktree から外し、別の worktree に checkout する（検査はその worktree で回る）
    const main = ctx.repo.topLevel;
    await git(main, ["checkout", "-q", "main"]);
    const wt = path.join(path.dirname(main), "wt-t1");
    await git(main, ["worktree", "add", "-q", wt, "feat/t1"]);
    // --delete-branch でも、品質ゲートを通らなければ worktree は消さない（消すのは通った後だけ）
    const err = await rejection(runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true }));
    expect(err).toBeInstanceOf(OperationError);
    expect(err!.code).toBe("GATE_FAILED");
    expect(err!.detail).toContain("check: The check");
    expect(err!.detail).toContain("exit 1");
    expect(err!.detail).toContain("落ちたテスト");
    expect(await calls()).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect((await git(main, ["worktree", "list"])).stdout).toContain("wt-t1");
  });

  it("dg pr ready は直さなかった軽い指摘を PR の本文に書き足し、もとの本文は残す。受け入れ条件の軽い指摘は手直しに回るので書かない（t600）。gh pr view --json body・gh pr edit が Projects (classic) のエラーで落ちても、REST で読み書きして ready にする（t637）", async () => {
    const { ctx, calls, editedBody } = await prepared();
    ctx.now = () => new Date(Date.now() + 60_000);
    const run = (
      await runCommand(runStart, ctx, { ticket: "t1", step: "review", agent: "claude-code" })
    ).data as Run;
    await runCommand(runReviewResult, ctx, {
      ticket: "t1",
      findings: [
        { severity: "light", category: "受け入れ条件の漏れ", reason: "1 つめが足りない" },
        {
          severity: "light",
          category: "参考節との食い違い",
          file: "src/b.ts",
          reason: "広がり",
          fix: "節に足す",
        },
      ],
    });
    await runCommand(runFinish, ctx, { run: run.id, result: "success" });
    const ready = (await runCommand(prReady, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(ready.noted).toBe(1);
    const body = await editedBody();
    expect(body).toContain("## 概要\n\n元の本文");
    expect(body).toContain("## Unfixed light findings");
    expect(body).toContain("- [light] src/b.ts (参考節との食い違い): 広がり Fix: 節に足す");
    expect(body).not.toContain("1 つめが足りない");
    expect(await calls()).toEqual(["api PATCH pulls/7", "pr ready 7"]);
  });

  it("見直しを 2 回したとき、1 回目に手直しに渡さなかった軽い指摘も本文に載り、同じ文は 1 つだけ書く（t600）", async () => {
    const { ctx, calls, editedBody } = await prepared();
    await reviewRound(ctx, 60, [
      { severity: "heavy", category: "不具合", file: "src/a.ts", line: 3, reason: "型が違う" },
      { severity: "light", category: "受け入れ条件の漏れ", reason: "1 つめが足りない" },
      { severity: "light", category: "参考節との食い違い", file: "src/b.ts", reason: "広がり1" },
    ]);
    await reviewRound(ctx, 120, [
      { severity: "light", category: "参考節との食い違い", file: "src/b.ts", reason: "広がり1" },
      { severity: "light", category: "言い回し", file: "src/c.ts", reason: "2 回目の軽い" },
    ]);
    const ready = (await runCommand(prReady, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(ready.noted).toBe(2);
    const body = await editedBody();
    expect(body.split("[light] src/b.ts (参考節との食い違い): 広がり1").length - 1).toBe(1);
    expect(body).toContain("- [light] src/c.ts (言い回し): 2 回目の軽い");
    expect(body).not.toContain("1 つめが足りない");
    expect(body).not.toContain("型が違う");
    expect(body).toContain("## 概要\n\n元の本文");
    expect(await calls()).toEqual(["api PATCH pulls/7", "pr ready 7"]);
  });

  it("作業ブランチより前の見直しの軽い指摘は本文に載せない（t600）", async () => {
    const { ctx, editedBody } = await prepared();
    // 作業ブランチ（claim）より前の見直しの回。本文には載らない
    await reviewRound(ctx, -3600, [
      { severity: "light", category: "言い回し", reason: "前の作業" },
    ]);
    await reviewRound(ctx, 60, [{ severity: "light", category: "言い回し", reason: "今回の軽い" }]);
    const ready = (await runCommand(prReady, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(ready.noted).toBe(1);
    const body = await editedBody();
    expect(body).toContain("今回の軽い");
    expect(body).not.toContain("前の作業");
  });

  it("親が手直しに渡した軽い指摘は、直したかによらず PR の本文に書かない。渡さなかった軽い指摘は載る（t639）", async () => {
    const { ctx, editedBody } = await prepared();
    await reviewRound(ctx, 60, [
      {
        severity: "light",
        category: "参考節との食い違い",
        file: "src/b.ts",
        reason: "渡した広がり",
      },
      { severity: "light", category: "言い回し", file: "src/c.ts", reason: "渡さなかった言い回し" },
    ]);
    await runCommand(runHandoff, ctx, {
      ticket: "t1",
      findings: [
        {
          severity: "light",
          category: "参考節との食い違い",
          file: "src/b.ts",
          reason: "渡した広がり",
        },
      ],
    });
    const ready = (await runCommand(prReady, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(ready.noted).toBe(1);
    const body = await editedBody();
    expect(body).toContain("- [light] src/c.ts (言い回し): 渡さなかった言い回し");
    expect(body).not.toContain("渡した広がり");
  });

  it("手直しに渡す指摘は最新の見直しの一覧にあるものだけ。ないものは VALIDATION_FAILED で、一覧がなければ同じく止まる（t639）", async () => {
    const { ctx } = await prepared();
    const none = await rejection(
      runCommand(runHandoff, ctx, {
        ticket: "t1",
        findings: [
          { severity: "light", category: "言い回し", file: "src/x.ts", reason: "一覧なし" },
        ],
      }),
    );
    expect(none!.code).toBe("VALIDATION_FAILED");
    await reviewRound(ctx, 60, [{ severity: "light", category: "言い回し", reason: "一覧の軽い" }]);
    const err = await rejection(
      runCommand(runHandoff, ctx, {
        ticket: "t1",
        findings: [{ severity: "light", category: "言い回し", reason: "一覧にない" }],
      }),
    );
    expect(err!.code).toBe("VALIDATION_FAILED");
    expect(err!.detail).toContain("一覧にない");
  });

  it("手直しに渡した軽い指摘は、手直しの文（brief --role fix）の直す指摘に入る（t639）", async () => {
    const { ctx } = await prepared();
    await reviewRound(ctx, 60, [
      { severity: "light", category: "言い回し", file: "src/c.ts", reason: "渡した言い回し" },
      { severity: "light", category: "言い回し", file: "src/d.ts", reason: "渡さない言い回し" },
    ]);
    await runCommand(runHandoff, ctx, {
      ticket: "t1",
      findings: [
        { severity: "light", category: "言い回し", file: "src/c.ts", reason: "渡した言い回し" },
      ],
    });
    const fix = (await runCommand(brief, ctx, { ticket: "t1", role: "fix" })).data as {
      text: string;
    };
    expect(fix.text).toContain("渡した言い回し");
    expect(fix.text).not.toContain("渡さない言い回し");
  });

  it("本文の読み取りの失敗は本文を書き足せなかったと OperationError で返し、ready を呼ばない（t600）", async () => {
    const { ctx, calls, failBodyView } = await prepared();
    await reviewRound(ctx, 60, [{ severity: "light", category: "言い回し", reason: "軽い" }]);
    await failBodyView();
    const err = await rejection(runCommand(prReady, ctx, { ticket: "t1" }));
    expect(err).toBeInstanceOf(OperationError);
    expect(err!.code).toBe("GIT_ERROR");
    expect(err!.message).toContain("Could not append to the body");
    expect(err!.message).toContain("so it was not made ready");
    expect(await calls()).toEqual([]);
  });

  it("本文の書き込みの失敗は GIT_ERROR で返し、ready を呼ばない（t637）", async () => {
    const { ctx, calls, failBodyWrite } = await prepared();
    await reviewRound(ctx, 60, [{ severity: "light", category: "言い回し", reason: "軽い" }]);
    await failBodyWrite();
    const err = await rejection(runCommand(prReady, ctx, { ticket: "t1" }));
    expect(err).toBeInstanceOf(OperationError);
    expect(err!.code).toBe("GIT_ERROR");
    expect(err!.message).toContain("writing the body failed");
    expect(await calls()).toEqual([]);
  });
});
