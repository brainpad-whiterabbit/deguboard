import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git, openRepo, type Fixture } from "../../test/helpers/git-fixture.js";
import { reconcileStatus } from "../workflow/reconcile.js";
import { resolveWorkflow } from "../workflow/resolve.js";
import { findWorkflowTemplate } from "../workflow/templates/index.js";
import { validateWorkflow } from "../workflow/validate.js";
import { collectBranchFacts } from "./facts.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
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

describe("branch_merged の判定", () => {
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

  it("review のブランチは push していなくても、先端が base の真の祖先なら merged（ローカルで ff マージした形）", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await git(f.cloneA, ["checkout", "-qb", "feat/t1-x"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "作業"]);
    await git(f.cloneA, ["checkout", "-q", "main"]);
    await git(f.cloneA, ["merge", "-q", "--ff-only", "feat/t1-x"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "次の作業"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);
    expect(
      (await collectBranchFacts(a.repo, "feat/t1-x", { needPr: false, status: "review" })).facts,
    ).toMatchObject({ branch_pushed: false, branch_merged: true });
    // Status を渡さないとき（遷移の検査など）も祖先判定だけで決める
    expect((await collectBranchFacts(a.repo, "feat/t1-x", { needPr: false })).facts).toMatchObject({
      branch_merged: true,
    });
  });
});

describe("software-development の照合", () => {
  const wf = resolveWorkflow(
    validateWorkflow(findWorkflowTemplate("software-development")!, "software-development.yaml")
      .definition!,
  );

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
    expect(reconcileStatus(wf, "in_progress", facts)).toMatchObject({
      kind: "advance",
      to: "review",
      rule: { when: ["pr_open", "!pr_draft"] },
    });
    // main が進んでも同じ
    await advanceMain(f, a.repo.dataDir, "別の PR が main に入る");
    const { facts: after } = await collectBranchFacts(a.repo, "feat/watch-data-dir", {
      needPr: false,
      status: "in_progress",
    });
    expect(after).toMatchObject({ branch_merged: false });
    expect(
      reconcileStatus(wf, "in_progress", {
        ...after,
        pr_open: true,
        pr_draft: false,
        pr_merged: false,
      }),
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
