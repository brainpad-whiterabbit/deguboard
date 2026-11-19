import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git, openRepo, type Fixture } from "../../test/helpers/git-fixture.js";
import { reconcileStatus } from "../workflow/reconcile.js";
import { DEFAULT_WORKFLOW } from "../workflow/resolve.js";
import { collectBranchFacts, fetchPrGateFacts, resetGhCache } from "./facts.js";
import type { GitRepo } from "./repo.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** 偽の gh が pr view の selector ごとに返すもの */
interface GhReply {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/**
 * PATH を偽の gh だけの置き場所にする（本物の gh を拾わない）。gh を置かなければ gh がない形。
 * pr view の selector（$3）ごとに replies の出力と終了コードを返す。fetchPrGateFacts は topLevel だけを使う
 */
async function fakeGh(
  replies: Record<string, GhReply> | undefined,
): Promise<{ repo: GitRepo; gh: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dg-fake-gh-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const gh = path.join(bin, "gh");
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  if (replies) {
    await writeFile(
      gh,
      [
        "#!/bin/sh",
        'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
        'case "$3" in',
        ...Object.entries(replies).map(
          ([selector, r]) =>
            `  ${selector}) printf '%s' ${quote(r.stdout ?? "")}; printf '%s' ${quote(r.stderr ?? "")} >&2; exit ${r.code ?? 0};;`,
        ),
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  const saved = process.env["PATH"];
  process.env["PATH"] = bin;
  resetGhCache();
  cleanups.push(async () => {
    process.env["PATH"] = saved;
    resetGhCache();
    await rm(root, { recursive: true, force: true });
  });
  return { repo: { topLevel: root } as GitRepo, gh };
}

// 品質ゲート（gate.ts）が PR の事実を読む分岐。gate.test.ts は正常と出力が読めない場合を経路として見る
describe("品質ゲートの PR の事実の読み取り", () => {
  const view = (over: Record<string, unknown>) =>
    JSON.stringify({
      number: 7,
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      headRefOid: "abc123",
      ...over,
    });

  it.each<[string, GhReply, unknown]>([
    [
      "読めた PR の事実をそのまま返す",
      { stdout: view({ isDraft: true, mergeable: "CONFLICTING" }) },
      {
        pr: { number: 7, state: "OPEN", isDraft: true, mergeable: "CONFLICTING", head: "abc123" },
      },
    ],
    [
      "番号のほかが欠ければ、state は空・draft でない・mergeable は UNKNOWN・head なし",
      { stdout: JSON.stringify({ number: 7 }) },
      { pr: { number: 7, state: "", isDraft: false, mergeable: "UNKNOWN", head: undefined } },
    ],
    [
      "headRefOid が空なら head なし",
      { stdout: view({ headRefOid: "" }) },
      { pr: { number: 7, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", head: undefined } },
    ],
    [
      "headRefOid が文字列でなければ head なし",
      { stdout: view({ headRefOid: null }) },
      { pr: { number: 7, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", head: undefined } },
    ],
    [
      "PR がない（no pull requests found）なら missing",
      { stderr: 'no pull requests found for branch "t1"\n', code: 1 },
      { missing: true },
    ],
    [
      "PR が見つからない（could not find）なら missing",
      { stderr: "GraphQL: Could not find pull request 99\n", code: 1 },
      { missing: true },
    ],
    [
      "ほかの失敗は、stderr の 1 行目を理由にする",
      { stderr: "HTTP 502: Bad Gateway\nmore detail\n", code: 1 },
      { reason: "Cannot read the PR with gh (HTTP 502: Bad Gateway)" },
    ],
    [
      "出力が JSON でなければ読めない",
      { stdout: "not json" },
      { reason: "Cannot read the output of gh" },
    ],
    [
      "番号が文字列なら番号を読めない",
      { stdout: view({ number: "7" }) },
      { reason: "Cannot read the PR number from gh" },
    ],
    [
      "番号が整数でなければ番号を読めない",
      { stdout: view({ number: 7.5 }) },
      { reason: "Cannot read the PR number from gh" },
    ],
  ])("%s", async (_name, reply, expected) => {
    const { repo } = await fakeGh({ t1: reply });
    expect(await fetchPrGateFacts(repo, "t1")).toEqual(expected);
  });

  it("gh がなければ、gh がないことを理由にする", async () => {
    const { repo } = await fakeGh(undefined);
    expect(await fetchPrGateFacts(repo, "t1")).toEqual({ reason: "gh is not installed" });
  });

  it("gh があると確かめた後に呼べなくなれば、呼べないことを理由にする", async () => {
    const { repo, gh } = await fakeGh({ t1: { stdout: view({}) } });
    // 1 回目で gh があると覚える
    expect(await fetchPrGateFacts(repo, "t1")).toMatchObject({ pr: { number: 7 } });
    await rm(gh);
    expect(await fetchPrGateFacts(repo, "t1")).toEqual({
      reason: "Cannot call gh (gh not found)",
    });
  });
});

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

/** 別の作業が main に入って push された形にする（data worktree にも取り込む） */
async function advanceMain(f: Fixture, dataDir: string, message: string): Promise<void> {
  await git(f.cloneB, ["pull", "-q", "--ff-only", "origin", "main"]);
  await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", message]);
  await git(f.cloneB, ["push", "-q", "origin", "main"]);
  await git(dataDir, ["fetch", "-q", "--prune", "origin"]);
}

// branch_merged の判定の組み合わせ（起点・Status・push の有無）は facts-judge.test.ts が git なしで見る。
// ここは ref と SHA を読み、要るときだけ祖先を聞いて判定に渡す経路を、ブランチの一生の順に見る
describe("branch_merged の事実の読み取り", () => {
  it("切ったばかりでコミットのないブランチは、main が進んでも merged にしない。push して ff マージされ、main が進めば true", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    const opts = { needPr: false, status: "in_progress" as const };
    await git(f.cloneA, ["branch", "feat/t1-x"]);
    // 先端が base と同じ
    expect((await collectBranchFacts(a.repo, "feat/t1-x", opts)).facts).toMatchObject({
      branch_exists: true,
      branch_pushed: false,
      branch_merged: false,
    });
    // main が進んで先端が base の真の祖先になっても、push していない in_progress のブランチは作業がないとみなす（t38）
    await advanceMain(f, a.repo.dataDir, "別の PR が main に入る");
    expect((await collectBranchFacts(a.repo, "feat/t1-x", opts)).facts).toMatchObject({
      branch_merged: false,
    });
    await advanceMain(f, a.repo.dataDir, "さらに別の PR が main に入る");
    expect((await collectBranchFacts(a.repo, "feat/t1-x", opts)).facts).toMatchObject({
      branch_merged: false,
    });
    // 作業を積めば祖先ではなくなるので false のまま
    await git(f.cloneA, ["checkout", "-q", "feat/t1-x"]);
    await git(f.cloneA, ["pull", "-q", "--rebase", "origin", "main"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "作業"]);
    await git(f.cloneA, ["push", "-q", "-u", "origin", "feat/t1-x"]);
    expect((await collectBranchFacts(a.repo, "feat/t1-x", opts)).facts).toMatchObject({
      branch_pushed: true,
      branch_merged: false,
    });
    // ff マージの直後は先端が base と同じなので、まだ merged とは言わない
    await git(f.cloneA, ["checkout", "-q", "main"]);
    await git(f.cloneA, ["pull", "-q", "--ff-only", "origin", "main"]);
    await git(f.cloneA, ["merge", "-q", "--ff-only", "feat/t1-x"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);
    await git(a.repo.dataDir, ["fetch", "-q", "--prune", "origin"]);
    expect((await collectBranchFacts(a.repo, "feat/t1-x", opts)).facts).toMatchObject({
      branch_merged: false,
    });
    // base が進めば真の祖先になる（push 済みなので作業の入ったブランチとみなす）
    await advanceMain(f, a.repo.dataDir, "次の作業");
    expect((await collectBranchFacts(a.repo, "feat/t1-x", opts)).facts).toMatchObject({
      branch_merged: true,
    });
  });
});

describe("既定の Workflow の照合", () => {
  const wf = DEFAULT_WORKFLOW;

  it("push 済みで PR が open、main より 1 コミット先のブランチは review に進み、done には進まない（t42）", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await git(f.cloneA, ["checkout", "-qb", "feat/watch-data-dir"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "作業"]);
    await git(f.cloneA, ["push", "-q", "-u", "origin", "feat/watch-data-dir"]);
    await git(a.repo.dataDir, ["fetch", "-q", "--prune", "origin"]);
    const { facts: gitFacts } = await collectBranchFacts(a.repo, "feat/watch-data-dir", {
      needPr: false,
      status: "in_progress",
    });
    expect(gitFacts).toMatchObject({ branch_pushed: true, branch_merged: false });
    // PR の事実は gh が出す形をそのまま足す（テストでは gh を呼ばない）
    const facts = { ...gitFacts, pr_open: true, pr_draft: false, pr_merged: false };
    expect(reconcileStatus(wf, "in_progress", facts, { pr: 7 })).toMatchObject({
      kind: "advance",
      to: "review",
      trigger: { when: ["pr_open", "!pr_draft"] },
    });
    // main が進んでも同じ
    await advanceMain(f, a.repo.dataDir, "別の PR が main に入る");
    const { facts: after } = await collectBranchFacts(a.repo, "feat/watch-data-dir", {
      needPr: false,
      status: "in_progress",
    });
    expect(after).toMatchObject({ branch_merged: false });
    expect(
      reconcileStatus(
        wf,
        "in_progress",
        { ...after, pr_open: true, pr_draft: false, pr_merged: false },
        { pr: 7 },
      ),
    ).toMatchObject({ kind: "advance", to: "review" });
  });

  it("claim 直後の commit のないブランチは、PR がなく main が進んでも in_progress のまま（t30・t36・t37 の事故の形）", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await git(f.cloneA, ["branch", "feat/watch-data-dir"]);
    await advanceMain(f, a.repo.dataDir, "別の PR が main に入る");
    const facts = {
      ...(
        await collectBranchFacts(a.repo, "feat/watch-data-dir", {
          needPr: false,
          status: "in_progress",
        })
      ).facts,
      // gh が「PR がない」と答えた形
      pr_open: false,
      pr_draft: false,
      pr_merged: false,
    };
    expect(facts).toMatchObject({
      branch_exists: true,
      branch_pushed: false,
      branch_merged: false,
    });
    expect(reconcileStatus(wf, "in_progress", facts)).toEqual({ kind: "none" });
  });
});
