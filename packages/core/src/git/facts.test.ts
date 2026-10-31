import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git, openRepo, type Fixture } from "../../test/helpers/git-fixture.js";
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

describe("branch_merged の判定", () => {
  it("切ったばかりでコミットのないブランチ（先端が base と同じ）は merged にしない。コミットを積めば false のまま、base に取り込まれて base が進めば true", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await git(f.cloneA, ["branch", "feat/t1-x"]);
    expect(await collectBranchFacts(a.repo, "feat/t1-x", { needPr: false })).toMatchObject({
      branch_exists: true,
      branch_merged: false,
    });
    await git(f.cloneA, ["checkout", "-q", "feat/t1-x"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "作業"]);
    expect(await collectBranchFacts(a.repo, "feat/t1-x", { needPr: false })).toMatchObject({
      branch_merged: false,
    });
    // ff マージの直後は先端が base と同じなので、まだ merged とは言わない
    await git(f.cloneA, ["checkout", "-q", "main"]);
    await git(f.cloneA, ["merge", "-q", "--ff-only", "feat/t1-x"]);
    expect(await collectBranchFacts(a.repo, "feat/t1-x", { needPr: false })).toMatchObject({
      branch_merged: false,
    });
    // base が進めば真の祖先になる（base はリモートの main を見る）
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "次の作業"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);
    expect(await collectBranchFacts(a.repo, "feat/t1-x", { needPr: false })).toMatchObject({
      branch_merged: true,
    });
  });
});
