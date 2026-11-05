// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../store.js";
import { mockClient, ticket } from "../test-helpers.js";
import { HistoryTicketList, HistoryTicketRow } from "./history-rows.js";

afterEach(cleanup);

function mount(children: ReactNode) {
  return render(<StoreProvider client={mockClient()}>{children}</StoreProvider>);
}

const metaOf = (id: string) =>
  [...document.querySelectorAll(".history-ticket")]
    .find((r) => r.querySelector("code")?.textContent === id)!
    .querySelector(".history-ticket-meta")!.textContent;

describe("履歴用の行", () => {
  it("検索語を渡すと、タイトルの当たった部分・番号の当たった部分・当たったラベルに印を付ける", async () => {
    mount(
      <>
        <HistoryTicketRow
          ticket={ticket({ id: "t1", title: "検索の Search と search", status: "done" })}
          query="SEARCH"
        />
        <HistoryTicketRow
          ticket={ticket({
            id: "t2",
            title: "別の題",
            status: "done",
            labels: ["ui", "search-ui"],
          })}
          query="search"
        />
        <HistoryTicketRow ticket={ticket({ id: "t3", title: "番号", status: "done" })} query="T3" />
      </>,
    );
    await screen.findByText("t2");
    const marks = (id: string) =>
      [...document.querySelectorAll(".history-ticket")]
        .find((r) => r.querySelector("code")?.textContent === id)!
        .querySelectorAll("mark");
    expect([...marks("t1")].map((m) => m.textContent)).toEqual(["Search", "search"]);
    expect([...marks("t2")].map((m) => m.textContent)).toEqual(["search"]);
    expect(metaOf("t2")).toBe("PR なし ・ ラベル search-ui");
    expect([...marks("t3")].map((m) => m.closest("code") !== null)).toEqual([true]);
  });

  it("2 段目に Epic と PR 番号を出し、Epic のないものは何も書かず、PR のないものは「PR なし」と書く。優先度のバッジは出さない", async () => {
    mount(
      <>
        <HistoryTicketRow
          ticket={ticket({ id: "t1", status: "done", epic: "e1", pr: 12, priority: "high" })}
        />
        <HistoryTicketRow ticket={ticket({ id: "t2", status: "done" })} />
      </>,
    );
    await screen.findByText("t1");
    expect(metaOf("t1")).toBe("e1 ・ #12");
    expect(metaOf("t2")).toBe("PR なし");
    expect(document.querySelector(".priority-high")).toBeNull();
    expect(document.querySelector(".row-assignee")).toBeNull();
  });

  it("中止の行は状態の点を輪（status-abandoned）にし、2 段目の頭に中止と書く。Iteration と付記は渡したときだけ出し、Epic は省ける", async () => {
    mount(
      <HistoryTicketRow
        ticket={ticket({ id: "t3", status: "abandoned", iteration: "s2", epic: "e1" })}
        showIteration
        showEpic={false}
        note="今は s3"
      />,
    );
    await screen.findByText("t3");
    const row = document.querySelector(".history-ticket")!;
    expect(row.classList.contains("abandoned")).toBe(true);
    expect(metaOf("t3")).toBe("Abandoned ・ s2 ・ PR なし ・ 今は s3");
    expect(row.querySelector(".history-abandoned")).toBeTruthy();
    // 輪とタイトルの薄さの見た目は CSS なので、test/layout/sidebar.layout.ts の computed style で確かめる
    expect(row.querySelector(".status-dot.status-abandoned")).toBeTruthy();
  });
});

describe("履歴用の一覧", () => {
  const tickets = Array.from({ length: 11 }, (_, n) => ticket({ id: `t${n + 1}`, status: "done" }));
  const shown = () =>
    [...document.querySelectorAll(".history-list code")].map((c) => c.textContent);

  it("多いときは先頭の数件だけ出し、「ほか N 件」を押すと残りを出す", async () => {
    mount(<HistoryTicketList tickets={tickets} head={8} />);
    await screen.findByText("t1");
    expect(shown()).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
    fireEvent.click(screen.getByRole("button", { name: "ほか 3 件" }));
    expect(shown()).toHaveLength(11);
    expect(screen.queryByRole("button", { name: /^ほか/ })).toBeNull();
  });

  it("件数が先頭の数以下なら「ほか N 件」を出さない", async () => {
    mount(<HistoryTicketList tickets={tickets.slice(0, 8)} head={8} />);
    await screen.findByText("t1");
    expect(shown()).toHaveLength(8);
    expect(screen.queryByRole("button", { name: /^ほか/ })).toBeNull();
  });
});
