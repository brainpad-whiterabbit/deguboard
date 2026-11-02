import { describe, expect, it } from "vitest";
import { shortPeriod } from "./iteration-parts.js";

describe("Iteration の見出しの期間", () => {
  it("期間は月/日に縮めて – でつなぎ、片方だけなら ? を置く", () => {
    expect(shortPeriod("2026-11-15", "2026-11-28")).toBe("11/15–11/28");
    expect(shortPeriod("2026-11-05", undefined)).toBe("11/5–?");
    expect(shortPeriod(undefined, undefined)).toBeUndefined();
  });
});
