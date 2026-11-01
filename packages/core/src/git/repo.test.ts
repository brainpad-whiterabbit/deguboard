import { describe, expect, it } from "vitest";
import { webUrlOf } from "./repo.js";

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
