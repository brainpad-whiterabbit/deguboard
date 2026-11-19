// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSummary } from "../test-helpers.js";
import type { TicketRunsView } from "../types.js";
import { RunPips } from "./row-end.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("カンバンの行の Run の並び（RunPips）", () => {
  it("最後の丸の経過の文字を 1 分ごとに描き直す", () => {
    vi.useFakeTimers({ now: new Date("2026-11-14T03:00:00Z") });
    const runs: TicketRunsView = {
      ticket: "t1",
      total: 1,
      running: true,
      runs: [runSummary({ running: true, started_at: "2026-11-14T02:48:00Z" })],
    };
    render(<RunPips runs={runs} stepLabel={(s) => s} />);
    const caption = () => document.querySelector(".run-pips-caption")!.textContent;
    expect(caption()).toBe("implement · 12分");
    act(() => vi.advanceTimersByTime(60_000));
    expect(caption()).toBe("implement · 13分");
    act(() => vi.advanceTimersByTime(30_000));
    expect(caption()).toBe("implement · 13分");
  });

  it("Run が 3 回以下なら「+n」を出さない", () => {
    const runs: TicketRunsView = {
      ticket: "t1",
      total: 2,
      running: false,
      runs: [runSummary({ id: "r2" }), runSummary({ id: "r1" })],
    };
    render(<RunPips runs={runs} stepLabel={(s) => s} />);
    expect(document.querySelectorAll(".run-pip")).toHaveLength(2);
    expect(document.querySelector(".run-pips-more")).toBeNull();
  });

  it("回数で締めくくる並びは「+n」を出さず、最後の丸の横に全部の回数を出す。読み上げの名前と丸の説明は変えない", () => {
    vi.useFakeTimers({ now: new Date("2026-11-14T03:00:00Z") });
    const runs: TicketRunsView = {
      ticket: "t1",
      total: 5,
      running: false,
      runs: [
        runSummary({ id: "r5", result: "success", finished_at: "2026-11-14T01:00:00Z" }),
        runSummary({ id: "r4" }),
        runSummary({ id: "r3" }),
      ],
    };
    render(<RunPips runs={runs} stepLabel={(s) => s} count />);
    expect(document.querySelectorAll(".run-pip")).toHaveLength(3);
    expect(document.querySelector(".run-pips-more")).toBeNull();
    expect(document.querySelector(".run-pips-caption")!.textContent).toBe("5 回");
    const group = document.querySelector(".run-pips")!;
    expect(group.getAttribute("aria-label")).toBe("Run 5 回。最後は implement · 2時間前");
    expect(document.querySelector(".run-pip.is-last")!.getAttribute("aria-label")).toMatch(
      /^implement · 成功、/,
    );
    cleanup();
    // 同じ並びをほかの行の出し方にすると「+2」と最後の Run の文字を出す
    render(<RunPips runs={runs} stepLabel={(s) => s} />);
    expect(document.querySelector(".run-pips-more")!.textContent).toBe("+2");
    expect(document.querySelector(".run-pips-caption")!.textContent).toBe("implement · 2時間前");
  });
});
