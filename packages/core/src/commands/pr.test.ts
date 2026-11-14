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
import { gate, type GateView } from "./gate.js";
import { prMerge, prReady, type PrAdvanceView } from "./pr.js";
import { runFinish, runHandoff, runReviewResult, runStart } from "./run.js";
import { configSet, init } from "./setup.js";
import { ticketCheck, ticketClaim, ticketCreate, ticketUpdate } from "./ticket.js";

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
  // このファイルがあると、gh pr merge はマージを済ませた状態（mergedView の JSON）にしてから失敗する（t686。ブランチの削除の失敗を写す）
  const mergedThenFail = path.join(root, "gh-merged-then-fail");
  const mergedView = path.join(root, "gh-merged-view.json");
  // このファイルがあると、gh pr merge は比べる前に feat/t1 へ push する（判定の後に PR の先端が進むのを写す。t750）
  const pushBeforeMerge = path.join(root, "gh-push-before-merge");
  // このファイルがあると、gh pr merge はリモートとローカルの feat/t1 を消す（本物の gh の --delete-branch を写す。t849）
  const deleteOnMerge = path.join(root, "gh-delete-on-merge");
  // このファイルがあると、承認者のコメントの書き込み（gh api の POST）だけ失敗する（t883）
  const failComment = path.join(root, "gh-fail-comment");
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
        `    if [ -f '${failBody}' ]; then echo "gh の失敗" >&2; exit 1; fi; sed "s|__TIP__|$(git ls-remote origin refs/heads/feat/t1 | cut -f1)|" '${viewFile}'; exit 0`,
        "  fi",
        // 承認者のコメント（REST の issues の comments。-f body=<文>）を記録に書き足す（t883）
        '  if [ "$2" = --method ] && [ "$3" = POST ] && [ "$4" = "repos/{owner}/{repo}/issues/7/comments" ] && [ "$5" = -f ]; then',
        `    if [ -f '${failComment}' ]; then echo "gh の失敗" >&2; exit 1; fi`,
        `    echo "api POST issues/7/comments $6" >> '${log}'; exit 0`,
        "  fi",
        "  exit 1",
        "fi",
        'case "$2" in',
        // __TIP__ は今のリモートの先端（ls-remote。追跡 ref は fetch するまで古い）に置き換える（PR の先端が push で進むのを写す。t750）
        `  view) if [ "$5" = body ]; then ${projectCards}; fi; sed "s|__TIP__|$(git ls-remote origin refs/heads/feat/t1 | cut -f1)|" '${viewFile}';;`,
        // gh pr merge は --match-head-commit の値がリモートの先端と違えば拒む（GitHub と同じく、判定していないコミットをマージしない。t750）
        `  merge) if [ -f '${pushBeforeMerge}' ]; then rm -f '${pushBeforeMerge}'; git commit -q --allow-empty -m "gh の間の作業"; git push -q origin feat/t1; fi; want=""; prev=""; for a in "$@"; do if [ "$prev" = --match-head-commit ]; then want="$a"; fi; prev="$a"; done; if [ -n "$want" ] && [ "$want" != "$(git ls-remote origin refs/heads/feat/t1 | cut -f1)" ]; then echo "Head branch was modified. Review and try the merge again." >&2; exit 1; fi; if [ -f '${mergedThenFail}' ]; then cp '${mergedView}' '${viewFile}'; echo "gh の失敗" >&2; exit 1; fi; if [ -f '${failMerge}' ]; then echo "gh の失敗" >&2; exit 1; fi; echo "$@" >> '${log}'; if [ -f '${deleteOnMerge}' ]; then git push -q origin --delete feat/t1; git branch -q -D feat/t1; fi;;`,
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
  // gh pr merge が、PR を merged（JSON）にしてから失敗する状態にする
  const mergedThenFailCall = async (merged: string) => {
    await writeFile(mergedView, merged);
    await writeFile(mergedThenFail, "1");
  };
  return {
    write,
    calls,
    editedBody,
    failBodyView,
    failBodyWrite,
    failMergeCall,
    allowMergeCall,
    mergedThenFailCall,
    pushBeforeMerge: () => writeFile(pushBeforeMerge, "1"),
    deleteOnMerge: () => writeFile(deleteOnMerge, "1"),
    failCommentCall: () => writeFile(failComment, "1"),
  };
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
  const state = { draft: true, noHead: false, conflict: false };
  // 今の push した先端（PR の headRefOid。偽の gh が __TIP__ をリモートの先端に置き換える）
  const tip = (await git(f.cloneA, ["rev-parse", "HEAD"])).stdout.trim();
  const prJson = (merged: boolean) =>
    JSON.stringify({
      number: 7,
      state: merged ? "MERGED" : "OPEN",
      isDraft: state.draft,
      mergeable: state.conflict ? "CONFLICTING" : "MERGEABLE",
      // headRefOid を返さない gh（JSON から外す）
      headRefOid: state.noHead ? undefined : "__TIP__",
      body: "## 概要\n\n元の本文\n",
    });
  const gh = await fakeGh(f.root, () => prJson(false));
  const undraft = async () => {
    state.draft = false;
    await gh.write();
  };
  const withoutHead = async () => {
    state.noHead = true;
    await gh.write();
  };
  // PR が base と衝突している（true）か、していない（false）かを切り替える
  const conflicting = async (on: boolean) => {
    state.conflict = on;
    await gh.write();
    resetGhCache();
  };
  // gh pr merge がマージを済ませた後に失敗する状態（PR の state が MERGED になって gh が非 0 で終わる）
  const mergedThenFail = () => gh.mergedThenFailCall(prJson(true));
  return {
    ctx,
    tip,
    f,
    calls: gh.calls,
    editedBody: gh.editedBody,
    failBodyView: gh.failBodyView,
    failBodyWrite: gh.failBodyWrite,
    failMergeCall: gh.failMergeCall,
    allowMergeCall: gh.allowMergeCall,
    undraft,
    withoutHead,
    conflicting,
    mergedThenFail,
    pushBeforeMerge: gh.pushBeforeMerge,
    deleteOnMerge: gh.deleteOnMerge,
    failCommentCall: gh.failCommentCall,
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
    // 段が変更に合わないときの付け替え（版上げの例は出さない。t661）
    expect(ready!.detail).toContain("dg ticket update t1 --gate <level>");
    expect(ready!.detail).toContain("then run dg pr ready again");
    expect(ready!.detail).not.toContain("version-bump");
    const merge = await rejection(runCommand(prMerge, ctx, { ticket: "t1" }));
    expect(merge!.code).toBe("GATE_FAILED");
    expect(merge!.detail).toContain("acceptance:");
    expect(await calls()).toEqual([]);
  });

  it("満たせば gh pr ready・gh pr merge を PR の番号で呼び、判定した品質ゲートを返す", async () => {
    const { ctx, tip, calls, undraft } = await prepared();
    await passedReview(ctx);
    const ready = (await runCommand(prReady, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(ready).toMatchObject({ ticket: "t1", pr: 7, action: "ready", gate: { passed: true } });
    // マージの前は draft でなく、受け入れ条件がすべて付いていること
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    const merged = (await runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true }))
      .data as PrAdvanceView;
    expect(merged).toMatchObject({ pr: 7, action: "merge", method: "squash" });
    expect(await calls()).toEqual([
      "pr ready 7",
      `pr merge 7 --squash --match-head-commit ${tip} --delete-branch`,
    ]);
  });

  it("--approved-by を渡すと、マージの後に誰が承認してマージしたかを PR のコメントに残す。渡さなければ（--auto で聞かずにマージ）残さない（t883）", async () => {
    const { ctx, tip, calls, undraft } = await prepared();
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    // 聞かずにマージしたときは承認者を残さない（コメントを書かない）
    const auto = (await runCommand(prMerge, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(auto.approved_by).toBeNull();
    expect(await calls()).toEqual([`pr merge 7 --squash --match-head-commit ${tip}`]);
    // human は自分のユーザ本人。マージの後に、打った主体と承認者をコメントに書く
    const approved = await runCommand(prMerge, ctx, { ticket: "t1", approved_by: "human" });
    expect((approved.data as PrAdvanceView).approved_by).toBe("eiki");
    expect(approved.warnings).toEqual([]);
    expect((await calls()).slice(1)).toEqual([
      `pr merge 7 --squash --match-head-commit ${tip}`,
      "api POST issues/7/comments body=Merged with `dg pr merge` by eiki/agent, after eiki approved the merge.",
    ]);
  });

  it("--approved-by に agent の ID を渡すと VALIDATION_FAILED で止まり、gh を呼ばない。マージに失敗したら承認者を残さず、コメントを書けなければマージは成功のまま警告する（t883）", async () => {
    const { ctx, calls, undraft, failMergeCall, allowMergeCall, failCommentCall } =
      await prepared();
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    for (const ref of ["agent", "eiki/agent"]) {
      const rejected = await rejection(
        runCommand(prMerge, ctx, { ticket: "t1", approved_by: ref }),
      );
      expect(rejected!.code).toBe("VALIDATION_FAILED");
      expect(rejected!.message).toContain("eiki/agent is an agent");
    }
    await failMergeCall();
    expect(
      await rejection(runCommand(prMerge, ctx, { ticket: "t1", approved_by: "human" })),
    ).toBeDefined();
    expect(await calls()).toEqual([]);
    await allowMergeCall();
    await failCommentCall();
    const merged = await runCommand(prMerge, ctx, { ticket: "t1", approved_by: "mika" });
    expect(merged.data).toMatchObject({ action: "merge", approved_by: "mika" });
    expect(merged.warnings.join("\n")).toContain(
      "the approver (mika) could not be recorded as a comment on the PR",
    );
    expect((await calls()).filter((c) => c.startsWith("api POST"))).toEqual([]);
  });

  it("品質ゲートを満たさない PR は、承認者を渡さなければ GATE_FAILED のままで人に聞く道を案内し、--approved-by を渡すと越えた条件を結果と PR のコメントに残してマージする（t884）", async () => {
    const { ctx, tip, calls, undraft } = await prepared();
    // 見直しがなく、受け入れ条件に印がない（どちらも既定の merge.approval_overrides にある）
    await undraft();
    const unapproved = await rejection(runCommand(prMerge, ctx, { ticket: "t1" }));
    expect(unapproved!.code).toBe("GATE_FAILED");
    expect(unapproved!.detail).toContain("acceptance:");
    expect(unapproved!.detail).toContain("review:");
    // 人に gh を打ってもらう案内は出さず、人に聞いて承認者を渡す道を案内する
    expect(unapproved!.detail).toContain("ask whether to merge anyway");
    expect(unapproved!.detail).toContain("dg pr merge t1 --approved-by human");
    expect(unapproved!.detail).toContain("check, review, fix_rounds, acceptance");
    expect(unapproved!.detail).not.toContain("ask a human to run gh pr merge");
    expect(await calls()).toEqual([]);
    const merged = await runCommand(prMerge, ctx, { ticket: "t1", approved_by: "human" });
    expect(merged.data).toMatchObject({
      action: "merge",
      approved_by: "eiki",
      overridden: ["acceptance", "review"],
      gate: { passed: false },
    });
    expect(await calls()).toEqual([
      `pr merge 7 --squash --match-head-commit ${tip}`,
      "api POST issues/7/comments body=Merged with `dg pr merge` by eiki/agent, after eiki approved the merge. The approval overrode these unmet quality gate conditions: acceptance, review.",
    ]);
  });

  it("config の merge.approval_overrides にない条件を満たさない PR は、--approved-by を渡しても GATE_FAILED のままで、その条件を満たすとマージする。一覧に入れられるのは越えられる条件だけ（t884）", async () => {
    const { ctx: first, calls, undraft } = await prepared();
    // 衝突・先端・PR は一覧に入れられない
    for (const value of ["mergeable", "head", "pr"])
      expect(
        await rejection(runCommand(configSet, first, { key: "merge.approval_overrides", value })),
        value,
      ).toBeDefined();
    await runCommand(configSet, first, { key: "merge.approval_overrides", value: "review" });
    const ctx = await openContext({ cwd: first.repo.topLevel, actor: first.actor });
    await undraft();
    const err = await rejection(runCommand(prMerge, ctx, { ticket: "t1", approved_by: "human" }));
    expect(err!.code).toBe("GATE_FAILED");
    expect(err!.detail).toContain("A person's approval does not override acceptance");
    expect(err!.detail).toContain("merge.approval_overrides lists: review;");
    expect(err!.detail).not.toContain("ask whether to merge anyway");
    expect(await calls()).toEqual([]);
    // 承認者を渡さないときも、承認では越えられない条件があることを案内する
    const unapproved = await rejection(runCommand(prMerge, ctx, { ticket: "t1" }));
    expect(unapproved!.detail).toContain("A person's approval does not override acceptance");
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    const merged = await runCommand(prMerge, ctx, { ticket: "t1", approved_by: "human" });
    expect(merged.data).toMatchObject({ approved_by: "eiki", overridden: ["review"] });
    expect((await calls()).length).toBe(2);
  });

  it("衝突（mergeable）・PR の先端（head）・draft は、既定の一覧でも --approved-by を渡しても越えられず、gh を呼ばない（t884）", async () => {
    const { ctx, calls, undraft, withoutHead, conflicting } = await prepared();
    // draft のまま
    const draft = await rejection(runCommand(prMerge, ctx, { ticket: "t1", approved_by: "human" }));
    expect(draft!.code).toBe("GATE_FAILED");
    expect(draft!.detail).toContain("A person's approval does not override pr");
    await undraft();
    await conflicting(true);
    const conflict = await rejection(
      runCommand(prMerge, ctx, { ticket: "t1", approved_by: "human" }),
    );
    expect(conflict!.code).toBe("GATE_FAILED");
    expect(conflict!.detail).toContain("mergeable: mergeable is CONFLICTING");
    expect(conflict!.detail).toContain("A person's approval does not override mergeable");
    await conflicting(false);
    // PR の先端を読めない（判定したコミットに固定できない）
    await withoutHead();
    resetGhCache();
    const head = await rejection(runCommand(prMerge, ctx, { ticket: "t1", approved_by: "human" }));
    expect(head!.code).toBe("GATE_FAILED");
    expect(head!.detail).toContain("A person's approval does not override head");
    expect(await calls()).toEqual([]);
  });

  it("検査が一覧になければ、ほかの満たさない条件を承認で越えるときも検査を回し、通らなければ --approved-by を渡しても GATE_FAILED で止まる（t884）", async () => {
    const { ctx: first, calls, undraft } = await prepared();
    const script = path.join(path.dirname(first.repo.topLevel), "failing-override-check.sh");
    await writeFile(script, "#!/bin/sh\necho 落ちたテスト\nexit 1\n", { mode: 0o755 });
    await runCommand(configSet, first, { key: "actions.test", value: `sh, ${script}` });
    await runCommand(configSet, first, {
      key: "merge.approval_overrides",
      value: "review, fix_rounds, acceptance",
    });
    const ctx = await openContext({ cwd: first.repo.topLevel, actor: first.actor });
    await undraft();
    // 承認がなければ、ほかの条件を満たさないので検査は回さない
    const unapproved = await rejection(runCommand(prMerge, ctx, { ticket: "t1" }));
    expect(unapproved!.detail).toContain("the check (actions.test) was not run");
    const err = await rejection(runCommand(prMerge, ctx, { ticket: "t1", approved_by: "human" }));
    expect(err!.code).toBe("GATE_FAILED");
    expect(err!.detail).toContain("落ちたテスト");
    expect(err!.detail).toContain("A person's approval does not override check");
    expect(await calls()).toEqual([]);
  });

  it("書く保留がないときに rebase の途中を見つけたら、外の変更と報告せず rebase の警告を出して ready にする（t753）", async () => {
    const { ctx, calls } = await prepared();
    await passedReview(ctx);
    // 人が始めた rebase の途中を写す（印のない rebase-merge）
    const dir = (
      await git(ctx.repo.dataDir, ["rev-parse", "--git-path", "rebase-merge"])
    ).stdout.trim();
    await mkdir(path.resolve(ctx.repo.dataDir, dir), { recursive: true });
    const ready = await runCommand(prReady, ctx, { ticket: "t1" });
    expect(ready.warnings.join("\n")).toContain("A rebase started outside dg is in progress");
    expect(ready.warnings.join("\n")).not.toContain("changes made outside dg");
    expect(await calls()).toEqual(["pr ready 7"]);
  });

  it("--method・--delete-branch を省けば config の merge.method・merge.delete_branch に従い、渡せばそちらを使う（t601）", async () => {
    const { ctx: first, tip, calls, undraft } = await prepared();
    await runCommand(configSet, first, { key: "merge.method", value: "rebase" });
    await runCommand(configSet, first, { key: "merge.delete_branch", value: "true" });
    const ctx = await openContext({ cwd: first.repo.topLevel, actor: first.actor });
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    const merged = (await runCommand(prMerge, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(merged.method).toBe("rebase");
    await runCommand(prMerge, ctx, { ticket: "t1", method: "merge", delete_branch: false });
    expect(await calls()).toEqual([
      `pr merge 7 --rebase --match-head-commit ${tip} --delete-branch`,
      `pr merge 7 --merge --match-head-commit ${tip}`,
    ]);
  });

  it("--delete-branch のときは品質ゲートを通した後、gh を呼ぶ前に作業ブランチの worktree を消し、その worktree から呼べば消さずに警告する（t601）", async () => {
    const { ctx, tip, calls, undraft } = await prepared();
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
    const call = `pr merge 7 --squash --match-head-commit ${tip} --delete-branch`;
    expect(await calls()).toEqual([call, call]);
  });

  it("--delete-branch でマージすると、消した worktree とブランチを結果の removed に出す。ブランチを消さないマージには removed を付けない（t849）", async () => {
    const { ctx, undraft, deleteOnMerge } = await prepared();
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    const main = ctx.repo.topLevel;
    await git(main, ["checkout", "-q", "main"]);
    const wt = path.join(path.dirname(main), "wt-t1");
    await git(main, ["worktree", "add", "-q", wt, "feat/t1"]);
    const kept = await runCommand(prMerge, ctx, { ticket: "t1", delete_branch: false });
    expect((kept.data as PrAdvanceView).removed).toBeUndefined();
    expect(existsSync(wt)).toBe(true);
    // gh がリモートとローカルのブランチを消す
    await deleteOnMerge();
    const merged = await runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true });
    expect(merged.warnings).toEqual([]);
    expect((merged.data as PrAdvanceView).removed).toEqual({
      worktree: wt,
      local_branch: "feat/t1",
      remote_branch: "origin/feat/t1",
    });
    expect(existsSync(wt)).toBe(false);
    expect((await git(main, ["branch", "--list", "feat/t1"])).stdout.trim()).toBe("");
  });

  it("--delete-branch で gh pr merge が失敗したら、消した作業ブランチの worktree を同じパスに戻し、エラーの detail にその扱いを出す。原因を直した後の再実行はマージできる（t643）", async () => {
    const { ctx, tip, calls, undraft, failMergeCall, allowMergeCall } = await prepared();
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
    expect(await calls()).toEqual([
      `pr merge 7 --squash --match-head-commit ${tip} --delete-branch`,
    ]);
  });

  /**
   * worktree.setup を書き、作業ブランチの worktree を main の外に用意して、gh pr merge が失敗する状態にした文脈を返す。
   * --delete-branch で呼ぶと worktree は消され、失敗で同じパスに戻る
   */
  async function setupWorktreeMergeFails(setup: string[]) {
    const { ctx: first, calls, undraft, failMergeCall, mergedThenFail } = await prepared();
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
    return { ctx, main, wt, calls, mergedThenFail };
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

  it("gh pr merge が失敗しても PR がマージ済み（MERGED）なら成功を返し、ブランチの削除の失敗を warnings に出す。worktree は戻さず、準備のコマンドも回さない（t686）", async () => {
    const marker = ["node", "-e", "require('node:fs').writeFileSync('setup-ran.txt', 'ok')"];
    const { ctx, main, wt, calls, mergedThenFail } = await setupWorktreeMergeFails(marker);
    // gh はマージを済ませたあと、ローカルのブランチの削除に失敗した状態
    await mergedThenFail();
    const merged = await runCommand(prMerge, ctx, { ticket: "t1", delete_branch: true });
    expect(merged.data).toMatchObject({ pr: 7, action: "merge", method: "squash" });
    expect(merged.warnings.join("\n")).toContain(
      "is merged, but gh could not delete the work branch",
    );
    expect(merged.warnings.join("\n")).toContain("gh の失敗");
    // worktree は消したまま戻さず、準備のコマンドも回していない（戻す先の worktree が無い）
    expect(existsSync(wt)).toBe(false);
    expect((await git(main, ["worktree", "list"])).stdout).not.toContain("wt-t1");
    expect(existsSync(path.join(main, "setup-ran.txt"))).toBe(false);
    expect(merged.warnings.join("\n")).not.toContain("was restored");
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

  it("free のチケットは見直しがなくても dg pr ready・dg pr merge が gh を呼び、受け入れ条件に印がなくても通る（t663）", async () => {
    const { ctx, tip, calls, undraft } = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t1", gate: "free" });
    const ready = (await runCommand(prReady, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(ready).toMatchObject({ pr: 7, action: "ready" });
    expect(ready.gate).toMatchObject({ gate: "free", passed: true });
    await undraft();
    const merged = (await runCommand(prMerge, ctx, { ticket: "t1", delete_branch: false }))
      .data as PrAdvanceView;
    expect(merged).toMatchObject({ pr: 7, action: "merge", gate: { gate: "free", passed: true } });
    expect(await calls()).toEqual(["pr ready 7", `pr merge 7 --squash --match-head-commit ${tip}`]);
  });

  it("low のチケットは見直しがなくても dg pr ready が gh を呼ぶが、受け入れ条件に印がなければ dg pr merge は GATE_FAILED で止まり、印を付けると通る（t663）", async () => {
    const { ctx, tip, calls, undraft } = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t1", gate: "low" });
    const ready = (await runCommand(prReady, ctx, { ticket: "t1" })).data as PrAdvanceView;
    expect(ready.gate).toMatchObject({ gate: "low", passed: true });
    await undraft();
    const err = await rejection(runCommand(prMerge, ctx, { ticket: "t1", delete_branch: false }));
    expect(err).toBeInstanceOf(OperationError);
    expect(err!.code).toBe("GATE_FAILED");
    expect(err!.detail).toContain("acceptance: Acceptance criteria 1 are not marked");
    expect(await calls()).toEqual(["pr ready 7"]);
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    const merged = (await runCommand(prMerge, ctx, { ticket: "t1", delete_branch: false }))
      .data as PrAdvanceView;
    expect(merged).toMatchObject({ pr: 7, action: "merge", gate: { gate: "low", passed: true } });
    expect(await calls()).toEqual(["pr ready 7", `pr merge 7 --squash --match-head-commit ${tip}`]);
  });

  it("ゲートが判定した後に別のコミットを push したら、マージしない（判定したコミットに固定し、新しいコミットは見直しと検査を通っていない。t750）", async () => {
    const { ctx, f, tip, calls, undraft } = await prepared();
    // 見直しは今始めて通す。あとの push は 1 秒以上あとにする（コミットの時刻は秒までなので、見直しより後の時刻にならないように）
    const run = (
      await runCommand(runStart, ctx, { ticket: "t1", step: "review", agent: "claude-code" })
    ).data as Run;
    await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 0, light: 0, passed: true });
    await runCommand(runFinish, ctx, { run: run.id, result: "success" });
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    // ゲートは今の先端（tip）を判定して通す
    const judged = (await runCommand(gate, ctx, { ticket: "t1", for: "merge" })).data as GateView;
    expect(judged).toMatchObject({ passed: true, sha: tip });
    // 判定の後にコミットを push する（PR の先端が進む）
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "判定の後の作業"]);
    await git(f.cloneA, ["push", "-q", "origin", "feat/t1"]);
    const err = await rejection(runCommand(prMerge, ctx, { ticket: "t1", delete_branch: false }));
    expect(err).toBeInstanceOf(OperationError);
    expect(err!.code).toBe("GATE_FAILED");
    expect(err!.detail).toContain("review:");
    expect(await calls()).toEqual([]);
  });

  it("ゲートが判定した後、gh pr merge の直前に別のコミットが push されても、判定したコミットに固定した --match-head-commit を gh が拒み、マージしない（t750）", async () => {
    const { ctx, f, tip, calls, undraft, pushBeforeMerge } = await prepared();
    await passedReview(ctx);
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    // gh が比べる前に、リモートの先端が判定したコミットから進む（ゲートは判定の後に走らないので、これは gh の段で止まる）
    await pushBeforeMerge();
    const err = await rejection(runCommand(prMerge, ctx, { ticket: "t1", delete_branch: false }));
    expect(err!.message).toContain("Head branch was modified");
    expect(await calls()).toEqual([]);
    const remoteTip = (await git(f.cloneA, ["ls-remote", "origin", "refs/heads/feat/t1"])).stdout
      .trim()
      .split(/\s+/)[0];
    expect(remoteTip).not.toBe(tip);
  });

  it("low のチケットで、別の clone から fetch されずに push されて PR の先端が作業ブランチの最新と違えば、dg pr merge は head を理由に GATE_FAILED で止まる（t750）", async () => {
    const { ctx, f, calls, undraft } = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t1", gate: "low" });
    await undraft();
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    // 別の clone から push する。この clone は fetch しないので、追跡 ref（作業ブランチの最新）は古いまま
    await git(f.cloneB, ["fetch", "-q", "origin", "feat/t1"]);
    await git(f.cloneB, ["checkout", "-q", "-B", "feat/t1", "FETCH_HEAD"]);
    await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", "別の clone の作業"]);
    await git(f.cloneB, ["push", "-q", "origin", "feat/t1"]);
    const err = await rejection(runCommand(prMerge, ctx, { ticket: "t1", delete_branch: false }));
    expect(err).toBeInstanceOf(OperationError);
    expect(err!.code).toBe("GATE_FAILED");
    expect(err!.detail).toContain("head: PR #7's head");
    expect(err!.detail).toContain("is not the latest commit of the work branch");
    expect(await calls()).toEqual([]);
  });

  it("free のチケットで gh が PR の先端を返さなければ、dg pr merge は理由を head: で示して GATE_FAILED で止まる（判定できる条件がなくても理由が空にならない。t750）", async () => {
    const { ctx, calls, undraft, withoutHead } = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t1", gate: "free" });
    await undraft();
    await withoutHead();
    const err = await rejection(runCommand(prMerge, ctx, { ticket: "t1", delete_branch: false }));
    expect(err).toBeInstanceOf(OperationError);
    expect(err!.code).toBe("GATE_FAILED");
    expect(err!.detail).toContain("head: cannot read the PR head commit from gh");
    expect(await calls()).toEqual([]);
  });
});
