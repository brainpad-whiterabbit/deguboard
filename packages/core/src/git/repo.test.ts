import { describe, expect, it } from "vitest";
import { osUserName, webUrlOf } from "./repo.js";

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
