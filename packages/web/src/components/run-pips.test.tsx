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
      runs: [runSummary({ id: "r2" }), runSummary({ id: "r1" })],
    };
    render(<RunPips runs={runs} stepLabel={(s) => s} />);
    expect(document.querySelectorAll(".run-pip")).toHaveLength(2);
    expect(document.querySelector(".run-pips-more")).toBeNull();
  });
});
