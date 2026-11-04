// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { iteration, iterationDetail } from "../test-helpers.js";
import type { IterationDetail } from "../types.js";
import { IterationPlans } from "./iteration-plans.js";

afterEach(cleanup);

const brief = (
  id: string,
  status: "pending" | "approved" | "closed",
  done: number,
  total: number,
) =>
  ({
    id,
    status,
    progress: { total, done, by_status: { done, todo: total - done } },
  }) as unknown as IterationDetail["plans"][number];

describe("IterationPlans（UI-5 の Plan の節）", () => {
  it("Plan の ID・状態・done / 件数を一覧にする", () => {
    const it = {
      ...iterationDetail(iteration({ id: "s1", name: "a" })),
      plans: [brief("p1", "approved", 2, 5), brief("p2", "closed", 3, 3)],
    };
    render(<IterationPlans plans={it.plans} />);
    expect(screen.getByText("p1")).toBeTruthy();
    expect(screen.getByText("承認済み")).toBeTruthy();
    expect(screen.getByText("2/5 done")).toBeTruthy();
    expect(screen.getByText("p2")).toBeTruthy();
    expect(screen.getByText("閉じた")).toBeTruthy();
    expect(screen.getByText("3/3 done")).toBeTruthy();
  });

  it("該当する Plan がなければ節を出さない", () => {
    const { container } = render(<IterationPlans plans={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
