// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ticket } from "../test-helpers.js";
import type { Ticket } from "../types.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import {
  FLASH_DURATION_MS,
  changedTickets,
  nextFlash,
  summarizeTickets,
  useChangeFlash,
} from "./change-flash.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("変化したチケットを見つける", () => {
  const before = summarizeTickets([
    ticket({ id: "t1", status: "todo" }),
    ticket({ id: "t2", status: "in_progress", iteration: "s1" }),
    ticket({ id: "t3", status: "todo" }),
  ]);

  it("Status か Iteration が変わったものと、新しく現れたものを返し、消えたものは返さない", () => {
    const now = summarizeTickets([
      ticket({ id: "t1", status: "in_progress" }),
      ticket({ id: "t2", status: "in_progress", iteration: "s2" }),
      ticket({ id: "t4", status: "todo" }),
    ]);
    expect(changedTickets(before, now)).toEqual(["t1", "t2", "t4"]);
  });

  it("比べる相手がない（初めての描画）ときは何も返さない", () => {
    expect(changedTickets(undefined, before)).toEqual([]);
  });

  it("点滅は時間内の描き直しでは始めた時刻のまま続け、終わったら外す", () => {
    const first = nextFlash({}, ["t1"], 1000);
    expect(nextFlash(first, [], 1000 + FLASH_DURATION_MS - 1)).toEqual({ t1: 1000 });
    expect(nextFlash(first, [], 1000 + FLASH_DURATION_MS)).toEqual({});
    expect(nextFlash(first, ["t2"], 1500)).toEqual({ t1: 1000, t2: 1500 });
  });
});

describe("点滅の hook", () => {
  const setVisibility = (state: DocumentVisibilityState) =>
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);

  function setup(enabled = true) {
    const state = createUiState(memoryBackend());
    let tickets: Ticket[] = [ticket({ id: "t1", status: "todo" })];
    const hook = renderHook(({ list }) => useChangeFlash(list, state, enabled), {
      initialProps: { list: tickets },
    });
    const update = (next: Ticket[]) => {
      tickets = next;
      hook.rerender({ list: tickets });
    };
    return { hook, update };
  }

  it("初めての描画は点滅させず、次の描画で変わった行を点滅させ、時間が過ぎたら外す", () => {
    vi.useFakeTimers();
    const { hook, update } = setup();
    expect(hook.result.current.flashing.size).toBe(0);
    update([ticket({ id: "t1", status: "in_progress" })]);
    expect([...hook.result.current.flashing]).toEqual(["t1"]);
    act(() => void vi.advanceTimersByTime(FLASH_DURATION_MS + 10));
    expect(hook.result.current.flashing.size).toBe(0);
  });

  it("ignore したチケットの次の 1 回の変化は点滅させない（自分のドラッグ）", () => {
    const { hook, update } = setup();
    act(() => hook.result.current.ignore("t1"));
    update([ticket({ id: "t1", status: "in_progress" })]);
    expect(hook.result.current.flashing.size).toBe(0);
    update([ticket({ id: "t1", status: "review" })]);
    expect([...hook.result.current.flashing]).toEqual(["t1"]);
  });

  it("隠れている間に見つけた変化は、見えたときに点滅させる", () => {
    const { hook, update } = setup();
    const visibility = setVisibility("hidden");
    update([ticket({ id: "t1", status: "in_progress" })]);
    expect(hook.result.current.flashing.size).toBe(0);
    visibility.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect([...hook.result.current.flashing]).toEqual(["t1"]);
  });

  it("enabled が false（サイドバー以外）なら点滅させない", () => {
    const { hook, update } = setup(false);
    update([ticket({ id: "t1", status: "in_progress" })]);
    expect(hook.result.current.flashing.size).toBe(0);
  });
});
