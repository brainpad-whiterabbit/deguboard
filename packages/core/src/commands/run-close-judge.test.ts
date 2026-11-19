// Run を開く操作が、開いたままの前の手直しの Run を閉じるか・その結果・finished_at の決定の組み合わせ（区切り・push の時刻・
// セッション・step・二重起動）を、git なしで確かめる。事実を集めて閉じる経路（最後の push の読み取り・セッションの決め方・
// 閉じる書き込み・別の文脈が先に閉じた Run）は commands-flow-reclaim.test.ts の代表の件が見る。
// fixRunFinishedAt そのものの組み合わせは run.test.ts、照合が閉じる手直しの Run は reconcile-judge.test.ts
import { describe, expect, it } from "vitest";
import {
  closesFixRunBeforeOpening,
  decidePreviousFixRunClose,
  openedInOtherSession,
  STALE_SESSION_ERROR,
  type PreviousFixRunFacts,
} from "./run-close-judge.js";

/** 前の手直しの Run の開始と、その前後。時刻はすべてこのファイルの定数で、時計を読まない */
const BEFORE_FIX = "2026-11-06T00:30:00Z";
const FIX_AT = "2026-11-06T01:00:00Z";
const PUSHED_AT = "2026-11-06T01:30:00Z";
const NEXT_AT = "2026-11-06T02:00:00Z";
const AFTER_NEXT = "2026-11-06T02:30:00Z";

const FIX = "r20261106-010000-aaaa";

/** 既定：セッション s1 の手直しの Run が開いたままで、同じセッションが 02:00 に次の手直しを開く。push は 01:30 */
const facts = (
  over: {
    previous?: Partial<PreviousFixRunFacts["previous"]>;
    opening?: Partial<PreviousFixRunFacts["opening"]>;
    pushedAt?: string | undefined;
  } = {},
): PreviousFixRunFacts => ({
  ticket: "t1",
  previous: { id: FIX, step: "fix", started_at: FIX_AT, session: "s1", ...over.previous },
  opening: { step: "fix", session: "s1", startedAt: NEXT_AT, ...over.opening },
  pushedAt: "pushedAt" in over ? over.pushedAt : PUSHED_AT,
});

const noPushNote = (step: string) =>
  `t1: closing the earlier fix Run ${FIX} with the start of the next ${step} Run as the boundary, at the start time, since there was no push`;

describe("Run を開く操作が閉じる、前の手直しの Run（RN-6）", () => {
  it("次の Run の開始を区切りに、前の手直しの開始から区切りまでの最後の push の時刻で success に閉じる", () => {
    expect(decidePreviousFixRunClose(facts())).toEqual({
      kind: "close_run",
      run: FIX,
      opener: "reclaim",
      result: "success",
      finishedAt: PUSHED_AT,
      note: `t1: closing the earlier fix Run ${FIX} with the start of the next fix Run as the boundary, at the time of the last push`,
    });
  });

  it("finished_at は、開始から区切りまで（両端を含む）の push ならその時刻、push がない・開始より前・区切りより後なら区切りの時刻", () => {
    const at = (pushedAt: string | undefined) => {
      const action = decidePreviousFixRunClose(facts({ pushedAt }));
      return [action?.finishedAt, action?.note === noPushNote("fix")];
    };
    expect(at(FIX_AT)).toEqual([FIX_AT, false]);
    expect(at(NEXT_AT)).toEqual([NEXT_AT, false]);
    expect(at(undefined)).toEqual([NEXT_AT, true]);
    expect(at(BEFORE_FIX)).toEqual([NEXT_AT, true]);
    expect(at(AFTER_NEXT)).toEqual([NEXT_AT, true]);
  });

  it("前の手直しと同じ秒に始まる Run も区切りに数え、前の手直しより前に始まる Run（前景の起動で前にした開始）では閉じない", () => {
    expect(
      decidePreviousFixRunClose(
        facts({ opening: { step: "review", startedAt: FIX_AT }, pushedAt: undefined }),
      ),
    ).toMatchObject({ result: "success", finishedAt: FIX_AT, note: noPushNote("review") });
    expect(
      decidePreviousFixRunClose(facts({ opening: { startedAt: BEFORE_FIX } })),
    ).toBeUndefined();
  });

  it("手直しの step を開くとき、別のセッションで開いた前の手直しは、落ちたセッションの残りとして interrupted で閉じる。finished_at の決め方は同じ", () => {
    expect(decidePreviousFixRunClose(facts({ opening: { session: "s2" } }))).toEqual({
      kind: "close_run",
      run: FIX,
      opener: "reclaim",
      result: "interrupted",
      error: STALE_SESSION_ERROR,
      finishedAt: PUSHED_AT,
      note: `t1: the earlier fix Run ${FIX} was still open in another session (s1), so it is treated as left over from a crashed session and closed as interrupted`,
    });
    expect(
      decidePreviousFixRunClose(facts({ opening: { session: "s2" }, pushedAt: undefined })),
    ).toMatchObject({ result: "interrupted", finishedAt: NEXT_AT });
  });

  it("同じセッションか、どちらかのセッションが分からなければ、手直しの step を開いても success で閉じる", () => {
    for (const over of [
      {},
      { opening: { session: undefined } },
      { previous: { session: null } },
      { previous: { session: null }, opening: { session: undefined } },
    ]) {
      const action = decidePreviousFixRunClose(facts(over));
      expect(action, JSON.stringify(over)).toMatchObject({ result: "success" });
      expect(action, JSON.stringify(over)).not.toHaveProperty("error");
    }
  });

  it("手直しでない step（実装・見直し）を開くときは、別のセッションの前の手直しも success で閉じ、開く step を知らせる", () => {
    for (const step of ["implement", "review"]) {
      expect(
        decidePreviousFixRunClose(facts({ opening: { step, session: "s2" }, pushedAt: undefined })),
        step,
      ).toEqual({
        kind: "close_run",
        run: FIX,
        opener: "reclaim",
        result: "success",
        finishedAt: NEXT_AT,
        note: noPushNote(step),
      });
    }
  });

  it("別のセッションで開いた Run かは、両方のセッションが分かっていて違うときだけ", () => {
    expect(openedInOtherSession({ session: "s1" }, "s2")).toBe(true);
    expect(openedInOtherSession({ session: "s1" }, "s1")).toBe(false);
    expect(openedInOtherSession({ session: null }, "s2")).toBe(false);
    expect(openedInOtherSession({ session: "s1" }, undefined)).toBe(false);
  });

  it("同じチケットと step の Run が実行中（二重起動で拒まれる）なら前の手直しを閉じにいかない。手直しを開き直す操作が手直しの step を開くときだけ閉じる", () => {
    const closes = (step: string, duplicate: boolean, reopensFix: boolean) =>
      closesFixRunBeforeOpening({ step, duplicate, reopensFix });
    // 二重起動でなければ、どの step でも閉じにいく
    expect(closes("fix", false, false)).toBe(true);
    expect(closes("review", false, false)).toBe(true);
    expect(closes("implement", false, true)).toBe(true);
    // run start の二重起動は閉じない。もう一度の claim・印の起動のフックの手直しは閉じて開き直す
    expect(closes("fix", true, false)).toBe(false);
    expect(closes("fix", true, true)).toBe(true);
    // 手直しを開き直す操作でも、手直しでない step の二重起動では閉じない
    expect(closes("review", true, true)).toBe(false);
    expect(closes("implement", true, true)).toBe(false);
  });
});
