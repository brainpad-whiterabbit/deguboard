import { describe, expect, it } from "vitest";
import { plan, runSummary, ticket } from "../test-helpers.js";
import {
  isWaitingReadiness,
  kanbanPlanMarks,
  kanbanReadiness,
  needsPlanSlot,
  runPipCaption,
  runPipDetails,
  runPipKey,
  runTone,
  shortSpan,
  showRunPips,
  stepLabelOf,
  waitLabel,
} from "./row-end.js";
import { formatTime } from "./timeline.js";

describe("左パネルのカンバンの行の Plan の番号と待ち", () => {
  it("開いた Plan に入っているチケットだけに、Plan の番号・承認待ちか・core の waiting の待ちの相手を持たせる", () => {
    const marks = kanbanPlanMarks([
      plan({
        id: "p1",
        tickets: ["t1", "t2", "t3", "t4", "t9"],
        after: { t3: ["t1"], t4: ["t2", "t3"] },
        // 消えた t9 は core の waiting にない
        waiting: { t1: [], t2: [], t3: [], t4: ["t2", "t3", "t8"] },
      }),
      plan({ id: "p2", tickets: ["t5"], status: "closed", waiting: { t5: [] } }),
      plan({ id: "p3", tickets: ["t6"], status: "pending", waiting: { t6: [] } }),
    ]);
    expect(Object.fromEntries(marks)).toEqual({
      t1: { plan: "p1", pending: false, waitingOn: [] },
      t2: { plan: "p1", pending: false, waitingOn: [] },
      t3: { plan: "p1", pending: false, waitingOn: [] },
      t4: { plan: "p1", pending: false, waitingOn: ["t2", "t3", "t8"] },
      // 承認待ちの Plan のチケットは pending
      t6: { plan: "p3", pending: true, waitingOn: [] },
    });
  });

  it("待ちの相手は 1 件なら番号、2 件以上なら先頭と残りの件数で書く", () => {
    expect(waitLabel(["t137"])).toBe("t137 待ち");
    expect(waitLabel(["t2", "t3", "t9"])).toBe("t2+2 待ち");
    expect(waitLabel([])).toBe("");
  });
});

describe("左パネルのカンバンの待ち・承認待ちの行を薄くする", () => {
  const dimmedIds = (
    plans: Parameters<typeof kanbanPlanMarks>[0],
    tickets: ReturnType<typeof ticket>[],
  ) => {
    const marks = kanbanPlanMarks(plans);
    return tickets
      .filter((t) => isWaitingReadiness(kanbanReadiness(t, marks.get(t.id))))
      .map((t) => t.id);
  };

  it("待ちの相手が残る todo と承認待ちの Plan の todo だけを薄くし、着手可・Plan の外・todo でない行は薄くしない", () => {
    const tickets = [
      ticket({ id: "t1", status: "in_progress" }),
      ticket({ id: "t2" }),
      ticket({ id: "t3" }),
      ticket({ id: "t4" }),
      // Plan に入っていない todo
      ticket({ id: "t5" }),
      // 承認待ちの Plan の、待ちの相手のない todo と in_progress
      ticket({ id: "t6" }),
      ticket({ id: "t7", status: "in_progress" }),
    ];
    const plans = [
      plan({
        id: "p1",
        tickets: ["t1", "t2", "t3", "t4"],
        after: { t3: ["t1"] },
        // in_progress の t1 に待ちの相手が残っても、todo でなければ薄くしない
        waiting: { t1: ["t9"], t2: [], t3: ["t1"], t4: [] },
      }),
      plan({ id: "p2", tickets: ["t6", "t7"], status: "pending", waiting: { t6: [], t7: [] } }),
    ];
    expect(dimmedIds(plans, tickets)).toEqual(["t3", "t6"]);
    const marks = kanbanPlanMarks(plans);
    expect(kanbanReadiness(tickets[1]!, marks.get("t2"))).toBe("ready");
    expect(kanbanReadiness(tickets[2]!, marks.get("t3"))).toBe("waiting");
    expect(kanbanReadiness(tickets[4]!, marks.get("t5"))).toBeNull();
    expect(kanbanReadiness(tickets[5]!, marks.get("t6"))).toBe("pending");
    expect(kanbanReadiness(tickets[6]!, marks.get("t7"))).toBeNull();
  });

  it("Plan が承認されると、承認待ちだった行は薄くしない", () => {
    const tickets = [ticket({ id: "t1" })];
    const waiting = { t1: [] };
    expect(
      dimmedIds([plan({ id: "p1", tickets: ["t1"], status: "pending", waiting })], tickets),
    ).toEqual(["t1"]);
    expect(
      dimmedIds([plan({ id: "p1", tickets: ["t1"], status: "approved", waiting })], tickets),
    ).toEqual([]);
  });
});

describe("開いた Plan に入っていない行の空き枠の判定", () => {
  const mark = { plan: "p1", pending: false, waitingOn: [] };
  it("開いた Plan に入っていない todo・in_progress・review だけ出す", () => {
    expect(needsPlanSlot({ status: "todo" }, undefined)).toBe(true);
    expect(needsPlanSlot({ status: "in_progress" }, undefined)).toBe(true);
    expect(needsPlanSlot({ status: "review" }, undefined)).toBe(true);
    expect(needsPlanSlot({ status: "done" }, undefined)).toBe(false);
    expect(needsPlanSlot({ status: "abandoned" }, undefined)).toBe(false);
  });
  it("開いた Plan に入っている行には出さない", () => {
    expect(needsPlanSlot({ status: "todo" }, mark)).toBe(false);
    expect(needsPlanSlot({ status: "in_progress" }, mark)).toBe(false);
  });
});

describe("カンバンの行の Run の並び", () => {
  const now = Date.parse("2026-11-14T03:00:00Z");
  const label = (step: string) =>
    stepLabelOf(
      { steps: [{ id: "implement", label: "Implement", actions: [], approval: false }] },
      step,
    );
  const closed = runSummary({
    step: "review",
    result: "success",
    finished_at: "2026-11-14T01:00:00Z",
  });
  const running = runSummary({
    step: "implement",
    running: true,
    started_at: "2026-11-14T02:48:00Z",
  });
  const views = (...runs: ReturnType<typeof runSummary>[]) => ({
    ticket: "t1" as const,
    total: runs.length,
    runs,
  });

  it("手の名前は Workflow の steps の label で、なければ id のまま", () => {
    expect(label("implement")).toBe("Implement");
    expect(label("review")).toBe("review");
    expect(stepLabelOf(undefined, "fix")).toBe("fix");
  });

  it("並びは In Progress と Review の行で Run があるときに出し、ほかの状態は実行中の Run があるときだけ出す", () => {
    expect(showRunPips({ status: "in_progress" }, views(closed))).toBe(true);
    expect(showRunPips({ status: "review" }, views(closed))).toBe(true);
    expect(showRunPips({ status: "in_progress" }, views())).toBe(false);
    expect(showRunPips({ status: "in_progress" }, undefined)).toBe(false);
    expect(showRunPips({ status: "todo" }, views(closed))).toBe(false);
    expect(showRunPips({ status: "todo" }, views(running))).toBe(true);
    expect(showRunPips({ status: "done" }, views(closed))).toBe(false);
  });

  it("丸の種類は結果に、重い指摘のあった見直しと返事待ちの実行中の Run を足す。書き終わりを待つ Run は実行中のまま", () => {
    expect(runPipKey(closed)).toBe("success");
    expect(
      runPipKey(runSummary({ result: "success", review: { heavy: 1, light: 0, passed: false } })),
    ).toBe("heavy");
    expect(
      runPipKey(runSummary({ result: "success", review: { heavy: 0, light: 2, passed: true } })),
    ).toBe("success");
    expect(runPipKey(runSummary({ result: "failure" }))).toBe("failure");
    expect(runPipKey(runSummary({ result: "interrupted" }))).toBe("interrupted");
    expect(runPipKey(runSummary({ result: null }))).toBe("unfinished");
    expect(runPipKey(running)).toBe("running");
    expect(runPipKey({ ...running, waiting_since: "2026-11-14T02:55:00Z" })).toBe("waiting");
    expect(runPipKey({ ...running, settling_since: "2026-11-14T02:55:00Z" })).toBe("running");
  });

  it("行の地の色を変えるのは、最後の Run が返事待ちか失敗・中断のときだけ", () => {
    expect(runTone(views({ ...running, waiting_since: "2026-11-14T02:55:00Z" }, closed))).toBe(
      "waiting",
    );
    expect(runTone(views(runSummary({ result: "failure" }), closed))).toBe("failed");
    expect(runTone(views(runSummary({ result: "interrupted" })))).toBe("failed");
    expect(runTone(views(running, runSummary({ result: "failure" })))).toBeNull();
    expect(runTone(views(closed))).toBeNull();
  });

  it("経過は 1 時間未満は分、1 日未満は時間、それより長ければ日で書く", () => {
    expect(shortSpan(59_000)).toBe("0分");
    expect(shortSpan(12 * 60_000)).toBe("12分");
    expect(shortSpan(3 * 3600_000 + 59 * 60_000)).toBe("3時間");
    expect(shortSpan(50 * 3600_000)).toBe("2日");
    expect(shortSpan(-1000)).toBe("0分");
  });

  it("最後の丸の横の文字は「手 · 経過」「返事待ち · n分」「中断 · n時間前」の形", () => {
    expect(runPipCaption(running, label, now)).toBe("Implement · 12分");
    expect(runPipCaption({ ...running, waiting_since: "2026-11-14T02:55:00Z" }, label, now)).toBe(
      "返事待ち · 5分",
    );
    expect(
      runPipCaption(
        runSummary({ result: "interrupted", finished_at: "2026-11-14T01:00:00Z" }),
        label,
        now,
      ),
    ).toBe("中断 · 2時間前");
    expect(runPipCaption(closed, label, now)).toBe("review · 2時間前");
  });

  it("丸の説明は手・結果・開始の時刻とかかった時間に、直した指摘の数・見直しの指摘の数・失敗の理由を足す", () => {
    const fix = runSummary({
      step: "fix",
      result: "success",
      started_at: "2026-11-14T01:00:00Z",
      finished_at: "2026-11-14T01:03:20Z",
      retries: 2,
    });
    expect(runPipDetails(fix, label, now)).toEqual([
      "fix · 成功",
      `${formatTime("2026-11-14T01:00:00Z")} · 3分 20秒`,
      "直した指摘 2",
    ]);
    const review = runSummary({
      step: "review",
      result: "success",
      review: { heavy: 1, light: 3, passed: false },
    });
    expect(runPipDetails(review, label, now)).toContain("指摘 重い 1 / 軽い 3");
    expect(runPipDetails(review, label, now)[0]).toBe("review · 重い指摘");
    const failed = runSummary({ result: "failure", error: "テストが落ちた" });
    expect(runPipDetails(failed, label, now).at(-1)).toBe("テストが落ちた");
    // 実行中は今までの時間
    expect(runPipDetails(running, label, now)[1]).toBe(
      `${formatTime(running.started_at)} · 12分 0秒`,
    );
  });
});
