// syncStatus の、数えた結果と追跡 ref の有無から次にすることを決める判定の組み合わせを、git なしで確かめる。
// 値を読む経路（rev-list と show-ref の呼び方、数え直し）は git.test.ts の代表の件が見る
import { describe, expect, it } from "vitest";
import { nextSyncCountStep, type SyncCountAttempt } from "./sync-judge.js";

const counted = (ahead: number, behind: number): SyncCountAttempt<string> => ({
  ok: true,
  counts: { ahead, behind },
});
const failed = (error: string): SyncCountAttempt<string> => ({ ok: false, error });

describe("同期状態の数え方の判定", () => {
  it("1 回目に数えられたら、追跡 ref を聞かずにその数で確定する", () => {
    // 数えられた後に読むものはないので、ほかの値が何であっても変わらない
    for (const refExists of [undefined, true, false]) {
      for (const second of [undefined, counted(9, 9), failed("second")]) {
        expect(nextSyncCountStep({ first: counted(2, 1), refExists, second })).toEqual({
          kind: "counted",
          counts: { ahead: 2, behind: 1 },
        });
      }
    }
  });

  it("1 回目に数えられず、追跡 ref をまだ聞いていなければ、聞く", () => {
    expect(nextSyncCountStep({ first: failed("first") })).toEqual({ kind: "ask_ref" });
  });

  it("数えられず、追跡 ref がなければ、ref がない扱いにして 1 回目の失敗を投げない", () => {
    for (const second of [undefined, counted(9, 9), failed("second")]) {
      expect(nextSyncCountStep({ first: failed("first"), refExists: false, second })).toEqual({
        kind: "no_ref",
      });
    }
  });

  it("数えた後に追跡 ref が現れていたら、1 回目の古い失敗を投げずに数え直す", () => {
    expect(nextSyncCountStep({ first: failed("first"), refExists: true })).toEqual({
      kind: "recount",
    });
  });

  it("追跡 ref が途中で現れて数え直せたら、数え直した数で確定する", () => {
    expect(
      nextSyncCountStep({ first: failed("first"), refExists: true, second: counted(1, 3) }),
    ).toEqual({ kind: "counted", counts: { ahead: 1, behind: 3 } });
  });

  it("追跡 ref があるのに数え直しても数えられなければ、数え直したときの失敗を投げ、それ以上は数え直さない", () => {
    expect(
      nextSyncCountStep({ first: failed("first"), refExists: true, second: failed("second") }),
    ).toEqual({ kind: "failed", error: "second" });
  });
});
