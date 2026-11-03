import { describe, expect, it } from "vitest";
// 開始・再開を阻む判定の写しを照らすためだけに core の実行時のコードを取り込む（画面のコードは型だけを取る。ADR-007）
import { otherActiveMessage, otherActiveOf } from "@deguboard/core";
import { iteration } from "../test-helpers.js";
import type { Iteration } from "../types.js";
import { blockedByActiveReason, otherActiveIteration, shortPeriod } from "./iteration-parts.js";

describe("Iteration の見出しの期間", () => {
  it("期間は月/日に縮めて – でつなぎ、片方だけなら ? を置く", () => {
    expect(shortPeriod("2026-11-15", "2026-11-28")).toBe("11/15–11/28");
    expect(shortPeriod("2026-11-05", undefined)).toBe("11/5–?");
    expect(shortPeriod(undefined, undefined)).toBeUndefined();
  });
});

describe("Iteration の開始・再開を阻む active（IT-1）", () => {
  const s1 = iteration({ id: "s1", name: "今", status: "active" });
  const s2 = iteration({ id: "s2", name: "次", status: "planned" });
  const s3 = iteration({ id: "s3", name: "前", status: "closed" });
  const other = iteration({ id: "s4", name: "別", status: "active", project: "other" });

  it("別の Project の active は数えない", () => {
    expect(otherActiveIteration([s2, other], s2)).toBeUndefined();
    expect(otherActiveIteration([s1, s2, other], s2)?.id).toBe("s1");
    expect(otherActiveIteration([s1, other], { id: "s5", project: "other" })?.id).toBe("s4");
  });

  it("自分自身は数えない", () => {
    expect(otherActiveIteration([s1, s2], s1)).toBeUndefined();
    expect(otherActiveIteration([other], other)).toBeUndefined();
  });

  it("判定は core の rejectIfOtherActive（otherActiveOf）の写しで、同じ結果になる", () => {
    // 壊れたデータで active がいくつもあるときも、core と同じく番号の小さいものを返す
    const s10 = iteration({ id: "s10", name: "十", status: "active" });
    const s9 = iteration({ id: "s9", name: "九", status: "active" });
    const all: Iteration[] = [s1, s2, s3, other, s10, s9];
    const lists: Iteration[][] = [
      [],
      [s2],
      [s1, s2, s3],
      [s2, other],
      [s3, other],
      all,
      [s10, s9, s2],
    ];
    for (const list of lists)
      for (const it of [...all, iteration({ id: "s11", name: "外", project: "other" })])
        expect(otherActiveIteration(list, it)?.id).toBe(otherActiveOf(list, it)?.id);
  });

  it("理由の文は core の文と同じ形で、active を「進行中」と書いて名前を添え、人が決めるの但し書きを省く", () => {
    for (const verb of ["開始", "再開"] as const) {
      const web = blockedByActiveReason(s1, s2, verb);
      expect(web).toBe(
        `s1 今 が進行中なので s2 を${verb}できない（進行中の Iteration は Project に 1 つ）。先に s1 を閉じる`,
      );
      // そろえない部分を core の言い方に戻すと core の文と一致する
      const asCore = `${web
        .replace("s1 今 が進行中", "s1 が active ")
        .replace("（進行中の", "（active の")}（閉じるかは人が決める）`;
      expect(asCore).toBe(otherActiveMessage("s1", "s2", verb));
    }
  });
});
