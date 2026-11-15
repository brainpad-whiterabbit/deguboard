// setup-check.ts（dg setup check の判定）を、CLI を通さずに直接確かめる（t1006）。
// 項目ごとに、満たす場合と満たさない場合、必須を満たさないときに後の項目を確かめずに待たせることを見る

import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixture,
  createLocalOnlyRepo,
  git,
  openRepo,
  type Fixture,
} from "../../test/helpers/git-fixture.js";
import { runProcess } from "../git/index.js";
import { installHooks } from "./hook-settings.js";
import { checkSetup, type SetupCheckItem, type SetupCheckResult } from "./setup-check.js";
import { writeSkillFiles } from "./skill-files.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-setup-check-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

/** 何も入れていない HOME（個人の設定と Skill の置き場所） */
const emptyEnv = async () => ({ HOME: await tempDir() });

const byId = (result: SetupCheckResult) =>
  Object.fromEntries(result.items.map((i) => [i.id, i])) as Record<
    SetupCheckItem["id"],
    SetupCheckItem
  >;

const ORDER = ["git", "repository", "board", "skills_hooks", "gitignore"];

/** PATH を差し替えて fn を動かす（git がない・古い場合を作る）。runGit は呼ぶたびに process.env を読む */
async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env["PATH"];
  process.env["PATH"] = dir;
  try {
    return await fn();
  } finally {
    process.env["PATH"] = before;
  }
}

/** ボードを作ってリモートへ送る（チームのボードがリモートにある状態） */
async function initAndPush(clone: string): Promise<void> {
  await openRepo(clone);
  await git(clone, ["push", "--quiet", "origin", "deguboard"]);
}

describe("checkSetup：git の版", () => {
  it("git が PATH になければ満たさず、後の項目は確かめずに待ちで返す", async () => {
    const f = await fixture();
    const result = await withPath(await tempDir(), async () =>
      checkSetup({ cwd: f.cloneA, env: await emptyEnv() }),
    );
    expect(result.ready).toBe(false);
    expect(result.items.map((i) => i.id)).toEqual(ORDER);
    expect(result.items[0]).toMatchObject({
      id: "git",
      level: "required",
      status: "unmet",
      message: expect.stringMatching(/not found.*2\.30/),
      fix: [],
    });
    expect(result.items.slice(1).map((i) => i.status)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(result.items.slice(1).every((i) => i.fix.length === 0 && i.state === undefined)).toBe(
      true,
    );
  });

  it("git が 2.30 より古ければ満たさず、2.30 以上なら版を状態の文に出して満たす", async () => {
    const f = await fixture();
    const bin = await tempDir();
    const fake = path.join(bin, "git");
    await writeFile(fake, "#!/bin/sh\necho 'git version 2.29.3'\n");
    await chmod(fake, 0o755);
    const old = await withPath(bin, async () =>
      checkSetup({ cwd: f.cloneA, env: await emptyEnv() }),
    );
    expect(old.items[0]).toMatchObject({
      status: "unmet",
      message: expect.stringMatching(/git 2\.29\.3 is older than 2\.30/),
    });
    expect(old.items[1]).toMatchObject({ status: "pending" });

    const real = await checkSetup({ cwd: f.cloneA, env: await emptyEnv() });
    expect(real.items[0]).toMatchObject({
      status: "ok",
      message: expect.stringMatching(/^git \d+\.\d+/),
      fix: [],
    });
  });
});

describe("checkSetup：Git リポジトリ", () => {
  it("リポジトリの外では満たさず、git init を直すコマンドに返し、後の項目は待ちで返す", async () => {
    const outside = await tempDir();
    const result = await checkSetup({ cwd: outside, env: await emptyEnv() });
    const items = byId(result);
    expect(result.ready).toBe(false);
    expect(items.git.status).toBe("ok");
    expect(items.repository).toMatchObject({
      level: "required",
      status: "unmet",
      message: expect.stringContaining("is not inside a Git repository"),
      fix: ["git init"],
    });
    expect([items.board.status, items.skills_hooks.status, items.gitignore.status]).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("直すコマンドのとおりに git init すると満たす", async () => {
    const dir = await tempDir();
    await runProcess(dir, "sh", ["-c", "git init"]);
    const items = byId(await checkSetup({ cwd: dir, env: await emptyEnv() }));
    expect(items.repository).toMatchObject({ status: "ok", fix: [] });
    // リモートのないリポジトリ：ボードは手元だけに作ることになる
    expect(items.board).toMatchObject({ status: "unmet", state: "no_remote", fix: ["dg init"] });
  });
});

describe("checkSetup：ボード", () => {
  it("init 前は、remote に届いてボードがない・届いてボードがある・届かないを見分ける", async () => {
    const f = await fixture();
    const env = await emptyEnv();
    const none = byId(await checkSetup({ cwd: f.cloneA, env }));
    expect(none.board).toMatchObject({
      level: "required",
      status: "unmet",
      state: "remote_no_board",
      message: expect.stringContaining("origin has no board"),
      fix: ["dg init"],
    });

    await initAndPush(f.cloneA);
    const team = byId(await checkSetup({ cwd: f.cloneB, env }));
    expect(team.board).toMatchObject({
      status: "unmet",
      state: "remote_board",
      message: expect.stringContaining("origin has the team's board"),
      fix: ["dg init"],
    });

    await git(f.cloneB, ["remote", "set-url", "origin", path.join(f.root, "nonexistent.git")]);
    const result = await checkSetup({ cwd: f.cloneB, env });
    const lost = byId(result);
    // 届かないときは直すコマンドを返さない（dg init --new-board は人が選ぶ道として状態の文で示す）
    expect(lost.board).toMatchObject({
      status: "unmet",
      state: "remote_unreachable",
      message: expect.stringMatching(/Cannot reach origin.*dg init --new-board/),
      fix: [],
    });
    expect(lost.board.detail).toBeTruthy();
    // ボードは必須なので、後の項目は確かめない
    expect(result.ready).toBe(false);
    expect([lost.skills_hooks.status, lost.gitignore.status]).toEqual(["pending", "pending"]);
    // 確かめるだけで、ボードを作らない
    expect((await git(f.cloneB, ["branch", "--list", "deguboard"])).stdout).toBe("");
  });

  it("init 済みなら満たし、後の推奨の項目を確かめる", async () => {
    const f = await fixture();
    await openRepo(f.cloneA);
    const result = await checkSetup({ cwd: f.cloneA, env: await emptyEnv() });
    const items = byId(result);
    expect(items.board).toMatchObject({ status: "ok", state: "ready", fix: [] });
    expect(result.ready).toBe(true);
    expect(items.skills_hooks.status).not.toBe("pending");
    expect(items.gitignore.status).not.toBe("pending");
  });

  it("手元に deguboard ブランチだけが残っているときは、リモートを見ずに dg init を案内する", async () => {
    const f = await fixture();
    await git(f.cloneA, ["branch", "deguboard"]);
    // リモートに届かなくても、init は手元のブランチを使うので届かない扱いにしない
    await git(f.cloneA, ["remote", "set-url", "origin", path.join(f.root, "nonexistent.git")]);
    const items = byId(await checkSetup({ cwd: f.cloneA, env: await emptyEnv() }));
    expect(items.board).toMatchObject({ status: "unmet", state: "local_branch", fix: ["dg init"] });
  });

  it("リモートのないリポジトリでは no_remote を返す", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const items = byId(await checkSetup({ cwd: local.dir, env: await emptyEnv() }));
    expect(items.board).toMatchObject({ status: "unmet", state: "no_remote", fix: ["dg init"] });
  });

  it("データのリモートとブランチを渡すと、その先を確かめ、直すコマンドにも同じ引数を付ける", async () => {
    const f = await fixture();
    await initAndPush(f.cloneA);
    const env = await emptyEnv();
    // origin の deguboard はあるが、渡したブランチはない
    const other = byId(await checkSetup({ cwd: f.cloneB, env, dataBranch: "deguboard-web" }));
    expect(other.board).toMatchObject({
      state: "remote_no_board",
      fix: ["dg init --data-branch deguboard-web"],
    });
    // リモートは URL（パス）でも確かめられ、リモートを足さない
    const byUrl = byId(await checkSetup({ cwd: f.cloneB, env, dataRemote: f.remoteDir }));
    expect(byUrl.board).toMatchObject({
      state: "remote_board",
      fix: [`dg init --data-remote ${f.remoteDir}`],
    });
    expect((await git(f.cloneB, ["remote"])).stdout.trim()).toBe("origin");
  });
});

describe("checkSetup：Skill と hooks", () => {
  it("どちらも入っていなければ満たさず、入れるコマンドと dg hooks check の案内を返す。推奨なので後の項目も確かめる", async () => {
    const f = await fixture();
    await openRepo(f.cloneA);
    const result = await checkSetup({ cwd: f.cloneA, env: await emptyEnv() });
    const items = byId(result);
    expect(items.skills_hooks).toMatchObject({
      level: "recommended",
      status: "unmet",
      message: expect.stringMatching(/hooks are not in.*Skills are not installed.*dg hooks check/),
      fix: ["dg hooks install", "dg skill install"],
    });
    expect(result.ready).toBe(true);
    expect(items.gitignore.status).toBe("ok");
  });

  it("hooks と Skill が入っていれば満たし、ハンドラが動かなくても満たす（動くかは dg hooks check に任せる）", async () => {
    const f = await fixture();
    await openRepo(f.cloneA);
    const env = await emptyEnv();
    // ない node を指すフック：dg hooks check は警告するが、ここは入っているかだけを見る
    const { file } = await installHooks({
      cwd: f.cloneA,
      scope: "local",
      env,
      self: () => ["/nonexistent/node", "/nonexistent/dg.js"],
    });
    const skillDir = path.join(f.cloneA, ".claude", "skills");
    await writeSkillFiles(skillDir, { force: false });
    const items = byId(await checkSetup({ cwd: f.cloneA, env }));
    expect(items.skills_hooks).toMatchObject({ status: "ok", fix: [] });
    expect(items.skills_hooks.message).toContain(file);
    expect(items.skills_hooks.message).toContain(skillDir);
    expect(items.skills_hooks.message).toContain("dg hooks check");
  });

  it("片方だけ入っているときは、足りない方のコマンドだけを返す", async () => {
    const f = await fixture();
    await openRepo(f.cloneA);
    const env = await emptyEnv();
    await installHooks({ cwd: f.cloneA, scope: "personal", env, self: () => ["node", "dg.js"] });
    const onlyHooks = byId(await checkSetup({ cwd: f.cloneA, env }));
    expect(onlyHooks.skills_hooks).toMatchObject({ status: "unmet", fix: ["dg skill install"] });

    const other = await emptyEnv();
    await writeSkillFiles(path.join(other.HOME, ".claude", "skills"), { force: false });
    const onlySkills = byId(await checkSetup({ cwd: f.cloneA, env: other }));
    expect(onlySkills.skills_hooks).toMatchObject({ status: "unmet", fix: ["dg hooks install"] });
  });

  it("古い版の dg が書いた Skill があれば満たさず、更新するコマンドを返す", async () => {
    const f = await fixture();
    await openRepo(f.cloneA);
    const env = await emptyEnv();
    await installHooks({ cwd: f.cloneA, scope: "local", env, self: () => ["node", "dg.js"] });
    const skillDir = path.join(env.HOME, ".claude", "skills");
    await writeSkillFiles(skillDir, { force: false });
    // 手を加えていない（印のハッシュが合う）、古い版の印の付いた、今と違う中身の SKILL.md
    const head = "---\nname: dgwork\n---\n\n";
    const body = "\n古い本文\n";
    const hash = createHash("sha256").update(`${head}${body}`).digest("hex");
    await writeFile(
      path.join(skillDir, "dgwork", "SKILL.md"),
      `${head}<!-- dg skill v0.0.1 sha256:${hash} -->\n${body}`,
    );
    const items = byId(await checkSetup({ cwd: f.cloneA, env }));
    expect(items.skills_hooks).toMatchObject({
      status: "unmet",
      message: expect.stringMatching(/older than this dg: dgwork.*dg hooks check/),
      fix: ["dg skill install --personal"],
    });
  });
});

describe("checkSetup：.claude/.gitignore", () => {
  it("ファイルがなければ満たす。コミットしていなければ満たさず、直すコマンドのとおりに打つと満たす", async () => {
    const f = await fixture();
    await openRepo(f.cloneA);
    const env = await emptyEnv();
    const before = byId(await checkSetup({ cwd: f.cloneA, env }));
    expect(before.gitignore).toMatchObject({
      level: "recommended",
      status: "ok",
      message: expect.stringContaining("does not exist yet"),
    });

    // dg hooks install が .claude/.gitignore に行を足す
    await installHooks({ cwd: f.cloneA, scope: "local", env, self: () => ["node", "dg.js"] });
    const added = byId(await checkSetup({ cwd: f.cloneA, env }));
    expect(added.gitignore).toMatchObject({
      status: "unmet",
      message: expect.stringContaining(".claude/.gitignore has uncommitted changes"),
    });
    expect(added.gitignore.fix).toHaveLength(2);
    for (const command of added.gitignore.fix) await runProcess(f.cloneA, "sh", ["-c", command]);
    const committed = byId(await checkSetup({ cwd: f.cloneA, env }));
    expect(committed.gitignore).toMatchObject({
      status: "ok",
      message: ".claude/.gitignore is committed",
      fix: [],
    });
    // ほかの変更は巻き込まない（無視の行の効いた設定はコミットに入らない）
    const files = await git(f.cloneA, ["show", "--name-only", "--format=", "HEAD"]);
    expect(files.stdout.trim()).toBe(".claude/.gitignore");

    // コミットの後に行が足されると、また満たさない
    await mkdir(path.join(f.cloneA, ".claude"), { recursive: true });
    await writeFile(path.join(f.cloneA, ".claude", ".gitignore"), "settings.local.json\nx\n");
    const changed = byId(await checkSetup({ cwd: f.cloneA, env }));
    expect(changed.gitignore.status).toBe("unmet");
  });
});
