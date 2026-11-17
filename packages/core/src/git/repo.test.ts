import { afterEach, describe, expect, it } from "vitest";
import { createLocalOnlyRepo, git } from "../../test/helpers/git-fixture.js";
import {
  defaultUser,
  forgetIdentityConfig,
  osUserName,
  requireIdentity,
  webUrlOf,
} from "./repo.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

// 主体のユーザ名と作者は、同じ 1 回の git config（--get-regexp）で読み、1 回の操作の中で覚える（t1075）。
// 1 つずつ --get で読んでいたときと同じ値になること（最後の値・空の値・前後の空白）と、捨てるまで読み直さないことを確かめる
describe("主体と作者の git config", () => {
  async function repoOf() {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    await git(local.dir, ["config", "user.name", "  名前 A  "]);
    await git(local.dir, ["config", "user.email", "a@example.com"]);
    return { dataDir: local.dir };
  }

  it("同じキーが複数あれば最後の値を使い、空の値はないものとして次の出どころへ進む", async () => {
    const repo = await repoOf();
    await git(repo.dataDir, ["config", "--add", "user.name", "名前 B"]);
    await git(repo.dataDir, ["config", "deguboard.user", ""]);
    expect(await defaultUser(repo)).toEqual({ user: "名前 B", source: "user.name" });
    expect(await requireIdentity(repo)).toEqual({ name: "名前 B", email: "a@example.com" });
  });

  it("覚えた値は捨てるまで使い、捨てた後は読み直す", async () => {
    const repo = await repoOf();
    expect(await defaultUser(repo)).toEqual({ user: "名前 A", source: "user.name" });
    await git(repo.dataDir, ["config", "deguboard.user", "deg"]);
    await git(repo.dataDir, ["config", "--unset", "user.email"]);
    // 同じ操作の中（捨てる前）は、文脈を開くときに読んだ値を使う
    expect(await defaultUser(repo)).toEqual({ user: "名前 A", source: "user.name" });
    expect(await requireIdentity(repo)).toEqual({ name: "名前 A", email: "a@example.com" });
    // 別の GitRepo（別の操作の文脈）は覚えた値を共有しない
    await expect(requireIdentity({ ...repo })).rejects.toMatchObject({ code: "IDENTITY_MISSING" });
    forgetIdentityConfig(repo);
    expect(await defaultUser(repo)).toEqual({ user: "deg", source: "git-config" });
    await expect(requireIdentity(repo)).rejects.toMatchObject({ code: "IDENTITY_MISSING" });
  });
});

describe("リモートの Web の URL", () => {
  it("https・ssh・scp 形式の URL を https の URL に直し、認証情報・ポート・.git を落とす", () => {
    const want = "https://github.com/owner/repo";
    expect(webUrlOf("https://github.com/owner/repo.git")).toBe(want);
    expect(webUrlOf("https://user:token@github.com/owner/repo/\n")).toBe(want);
    expect(webUrlOf("git@github.com:owner/repo.git")).toBe(want);
    expect(webUrlOf("ssh://git@github.com:22/owner/repo.git")).toBe(want);
  });

  it("ローカルのパスや owner/repo の形でない URL は null", () => {
    expect(webUrlOf("/tmp/remote.git")).toBeNull();
    expect(webUrlOf("file:///tmp/remote.git")).toBeNull();
    expect(webUrlOf("C:\\repos\\remote.git")).toBeNull();
    expect(webUrlOf("https://github.com/repo.git")).toBeNull();
  });
});

describe("OS のユーザ名", () => {
  const fail = () => {
    throw new Error("ENOENT: no such file or directory, uv_os_get_passwd");
  };

  it("os.userInfo() が名前を返せばそれを使う", () => {
    expect(osUserName(() => ({ username: "eiki" }), { USER: "env-u" })).toBe("eiki");
  });

  it("os.userInfo() が例外を投げれば USER、USERNAME、unknown の順に代わりの値を使う", () => {
    expect(osUserName(fail, { USER: "env-u", USERNAME: "win-u" })).toBe("env-u");
    expect(osUserName(fail, { USERNAME: "win-u" })).toBe("win-u");
    expect(osUserName(fail, {})).toBe("unknown");
    expect(osUserName(() => ({ username: "" }), {})).toBe("unknown");
  });

  it("既定の引数では例外を投げずに空でない名前を返す", () => {
    expect(osUserName()).not.toBe("");
  });
});
