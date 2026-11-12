import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  createFixture,
  disposeFixtureTemplate,
  fixtureTemplateDir,
  git,
} from "../../test/helpers/git-fixture.js";

// 雛形から写したリポジトリが、一から作ったものと同じに振る舞うことを確かめる

afterAll(async () => {
  // テストファイルの終わりに雛形が消えていることを確かめる（消すのは fixture の afterAll と同じ関数）
  const dir = await fixtureTemplateDir();
  await disposeFixtureTemplate();
  if (dir) expect(existsSync(dir)).toBe(false);
});

describe("createFixture（雛形から写す）", () => {
  it("写した clone の remote.origin.url は写した先の remote.git を指し、雛形を指さない", async () => {
    const f = await createFixture();
    const template = await fixtureTemplateDir();
    expect(template).toBeDefined();
    for (const clone of [f.cloneA, f.cloneB]) {
      const url = (await git(clone, ["config", "--get", "remote.origin.url"])).stdout.trim();
      expect(url).toBe(f.remoteDir);
      expect(url.startsWith(template ?? "")).toBe(false);
    }
    await f.cleanup();
  });

  it("一から作ったものと同じく、remote に main が 1 つだけあり、deguboard のブランチはない", async () => {
    const f = await createFixture();
    const heads = (await git(f.cloneB, ["ls-remote", "--heads", "origin"])).stdout;
    expect(heads).toContain("refs/heads/main");
    expect(heads).not.toContain("refs/heads/deguboard");
    const log = (await git(f.cloneB, ["log", "--format=%s", "origin/main"])).stdout.trim();
    expect(log).toBe("最初のコミット");
    await f.cleanup();
  });

  it("clone の identity は一から作ったものと同じく設定されている", async () => {
    const f = await createFixture();
    expect((await git(f.cloneA, ["config", "user.name"])).stdout.trim()).toBe("テスト");
    expect((await git(f.cloneB, ["config", "user.email"])).stdout.trim()).toBe("test@example.com");
    await f.cleanup();
  });

  it("写した先どうしと雛形は互いに影響しない（push は写した先の remote だけに届く）", async () => {
    const f1 = await createFixture();
    const f2 = await createFixture();
    await git(f1.cloneA, ["commit", "--quiet", "--allow-empty", "-m", "f1 の変更"]);
    await git(f1.cloneA, ["push", "--quiet", "origin", "main"]);
    const seenInF1 = (await git(f1.cloneB, ["fetch", "--quiet", "origin"])).stdout;
    expect(seenInF1).toBe("");
    const logF1 = (await git(f1.cloneB, ["log", "--format=%s", "origin/main"])).stdout;
    expect(logF1).toContain("f1 の変更");
    const logF2 = (await git(f2.cloneB, ["log", "--format=%s", "origin/main"])).stdout;
    expect(logF2).not.toContain("f1 の変更");
    const template = await fixtureTemplateDir();
    const logTemplate = (
      await git(template ?? "", ["--git-dir", "remote.git", "log", "--format=%s", "main"])
    ).stdout;
    expect(logTemplate).not.toContain("f1 の変更");
    await f1.cleanup();
    await f2.cleanup();
  });

  it("cleanup は写した先を消す", async () => {
    const f = await createFixture();
    expect(existsSync(f.root)).toBe(true);
    await f.cleanup();
    expect(existsSync(f.root)).toBe(false);
  });
});
