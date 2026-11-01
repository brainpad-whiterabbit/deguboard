// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import { mockClient, ticket } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { carriedOverFrom, groupByDay, groupByEpic } from "./history.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("履歴のまとめ方", () => {
  it("Epic ごとにチケットの多い順でまとめ、Epic なしは最後", () => {
    const groups = groupByEpic([
      ticket({ id: "t3", epic: "e2" }),
      ticket({ id: "t1" }),
      ticket({ id: "t2", epic: "e1" }),
      ticket({ id: "t4", epic: "e2" }),
    ]);
    expect(groups.map((g) => [g.epic, g.tickets.map((t) => t.id)])).toEqual([
      ["e2", ["t3", "t4"]],
      ["e1", ["t2"]],
      [null, ["t1"]],
    ]);
  });

  it("持ち越しは、その Iteration から外れる出来事のあったチケット。今も入っているものは除く", () => {
    const events = [
      {
        kind: "ticket",
        id: "t2",
        at: "x",
        changes: [{ field: "iteration", from: "s1", to: "s2" }],
      },
      {
        kind: "ticket",
        id: "t3",
        at: "x",
        changes: [{ field: "iteration", from: "s1", to: null }],
      },
      {
        kind: "ticket",
        id: "t4",
        at: "x",
        changes: [{ field: "iteration", from: null, to: "s1" }],
      },
      {
        kind: "ticket",
        id: "t5",
        at: "x",
        changes: [{ field: "iteration", from: "s1", to: "s2" }],
      },
    ] as unknown as Parameters<typeof carriedOverFrom>[1];
    const tickets = [ticket({ id: "t5", iteration: "s1" })];
    expect(carriedOverFrom("s1", events, tickets)).toEqual(["t2", "t3"]);
  });

  it("終えた日ごとにまとめ、更新日で代えた日には ~ を付ける", () => {
    const rows = [
      { ticket: ticket({ id: "t1" }), at: "2026-11-01T03:00:00Z", approximate: false },
      { ticket: ticket({ id: "t2" }), at: "2026-11-01T04:00:00Z", approximate: false },
      { ticket: ticket({ id: "t3" }), at: "2026-10-01T04:00:00Z", approximate: true },
    ];
    expect(groupByDay(rows).map((g) => [g.day.replace(/\d\d$/, "dd"), g.rows.length])).toEqual([
      ["2026-11-dd", 2],
      ["~2026-10-dd", 1],
    ]);
  });
});

function sidebarHost(): Host {
  return {
    surface: "sidebar",
    open: () => {},
    show: () => {},
    state: createUiState(memoryBackend()),
  };
}

describe("サイドバーの履歴", () => {
  it("Epic の見方は進捗バーを出さず、2 段目に件数・閉じた日・Iteration を出す", async () => {
    window.location.hash = "#/history?view=epic";
    const client = mockClient();
    client.data.epics[0] = {
      ...client.data.epics[0]!,
      status: "closed",
      closed_at: "2026-10-31T00:00:00Z",
    };
    client.data.tickets[1]!.iteration = "s1";
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    const row = (await screen.findByText("最初の版")).closest(".history-epic")!;
    expect(row.querySelector(".progress")).toBeNull();
    expect(row.querySelector("small")!.textContent).toBe("1 件 ・ 2026-10-31 に閉じた ・ s1");
    expect(screen.getByRole("searchbox").getAttribute("placeholder")).toBe(
      "番号・タイトル・ラベルで検索",
    );
  });

  it("チケットの見方は終えた日を小見出しにし、行には値のある Iteration・Epic・PR だけを書き、中止の行は薄く出す", async () => {
    window.location.hash = "#/history?view=ticket";
    const client = mockClient();
    client.data.tickets.push(
      ticket({
        id: "t4",
        title: "やめた",
        status: "abandoned",
        updated_at: "2026-01-01T00:00:00Z",
      }),
    );
    client.data.tickets[0]!.pr = 12;
    client.data.tickets[0]!.epic = "e1";
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll(".history-ticket")).toHaveLength(2));
    expect(document.querySelector(".history-group h3")!.textContent).toMatch(/^~2026-01-0\d 2 件$/);
    const rowOf = (id: string) =>
      [...document.querySelectorAll(".history-ticket")].find(
        (r) => r.querySelector("code")?.textContent === id,
      )!;
    const done = rowOf("t1");
    const abandoned = rowOf("t4");
    expect(done.querySelector(".history-ticket-meta")!.textContent).toBe("e1 ・ #12");
    expect(abandoned.classList.contains("abandoned")).toBe(true);
    expect(abandoned.querySelector(".history-ticket-meta")).toBeNull();
    expect(document.querySelector(".history-finished")).toBeNull();
  });
});
