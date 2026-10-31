import { describe, expect, it } from "vitest";
import { dgAdvice, majorOf, resolveDg } from "./dg.js";

const enoent = () => {
  const e = new Error("spawn dg ENOENT") as NodeJS.ErrnoException;
  e.code = "ENOENT";
  return Promise.reject(e);
};

describe("PATH の dg", () => {
  it("dg --version の出力を版にし、ENOENT は missing、それ以外の失敗は error", async () => {
    expect(await resolveDg(async () => "1.2.3\n")).toEqual({ kind: "found", version: "1.2.3" });
    expect(await resolveDg(enoent)).toEqual({ kind: "missing" });
    expect(await resolveDg(() => Promise.reject(new Error("壊れている")))).toEqual({
      kind: "error",
      detail: "壊れている",
    });
  });

  it("ないときはインストールを案内し、メジャーが違えば知らせ、同じなら何も言わない（UI-11）", () => {
    expect(dgAdvice({ kind: "missing" }, "1.0.0")).toMatchObject({ level: "info" });
    expect(dgAdvice({ kind: "missing" }, "1.0.0")?.text).toContain("npm i -g deguboard");
    expect(dgAdvice({ kind: "found", version: "2.0.1" }, "1.4.0")).toMatchObject({
      level: "warning",
    });
    expect(dgAdvice({ kind: "found", version: "2.0.1" }, "1.4.0")?.text).toContain(
      "メジャーが違う",
    );
    expect(dgAdvice({ kind: "found", version: "1.9.0" }, "1.4.0")).toBeUndefined();
    expect(dgAdvice({ kind: "found", version: "0.0.0" }, "0.0.0")).toBeUndefined();
    expect(dgAdvice({ kind: "error", detail: "x" }, "1.0.0")?.text).toContain("失敗");
    expect(majorOf("v3.1.0")).toBe(3);
    expect(majorOf("dev")).toBeUndefined();
  });
});
