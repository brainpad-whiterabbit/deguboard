// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../store.js";
import { mockClient } from "../test-helpers.js";
import { ProgressBar, StatusDot, TicketTable } from "./parts.js";

afterEach(cleanup);

function mount(node: React.ReactNode) {
  render(<StoreProvider client={mockClient()}>{node}</StoreProvider>);
}

describe("進捗バー", () => {
  it("Status ごとに件数の割合で積み上げ、0 件の Status は出さない", async () => {
    mount(
      <ProgressBar
        progress={{
          total: 4,
          done: 1,
          by_status: { todo: 2, in_progress: 1, review: 0, done: 1, abandoned: 3 },
        }}
      />,
    );
    const bar = (await screen.findByText("1/4")).previousElementSibling!;
    const segments = [...bar.children].map((el) => ({
      cls: el.className,
      width: (el as HTMLElement).style.width,
    }));
    expect(segments).toEqual([
      { cls: "status-done", width: "25%" },
      { cls: "status-in_progress", width: "25%" },
      { cls: "status-todo", width: "50%" },
    ]);
  });

  it("チケットがなければ空のバーと 0/0", async () => {
    mount(
      <ProgressBar
        progress={{
          total: 0,
          done: 0,
          by_status: { todo: 0, in_progress: 0, review: 0, done: 0, abandoned: 0 },
        }}
      />,
    );
    const bar = (await screen.findByText("0/0")).previousElementSibling!;
    expect(bar.children).toHaveLength(0);
  });
});

describe("状態の印と空の一覧", () => {
  it("丸印は Workflow の表示名を読み上げ用の名前にする", async () => {
    mount(<StatusDot status="review" />);
    expect(await screen.findByRole("img", { name: "Code Review" })).toBeTruthy();
  });

  it("空の一覧は破線の枠（.empty）で出す", async () => {
    mount(<TicketTable tickets={[]} />);
    expect((await screen.findByText("該当するチケットはない")).className).toBe("empty");
  });
});
