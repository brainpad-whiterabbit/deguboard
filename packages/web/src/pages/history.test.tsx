// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import { iteration, mockClient, ticket } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { carriedOverFrom, epicCountsOf, groupByEpic } from "./history.js";

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
});

function sidebarHost(): Host {
  return {
    surface: "sidebar",
    open: () => {},
    show: () => {},
    state: createUiState(memoryBackend()),
  };
}

describe("Iteration の行", () => {
  it("内訳は Epic なしを含み、合計が Iteration に入っている終わったチケットの件数と合う", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    client.data.iterations = [
      iteration({
        id: "s4",
        name: "sprint4",
        goal: "左パネルを主画面にする",
        status: "closed",
        closed_at: "2026-11-01T00:00:00Z",
        completed: 3,
        carried_over: 2,
      }),
    ];
    client.data.tickets = [
      ticket({ id: "t1", status: "done", iteration: "s4", epic: "e1" }),
      ticket({ id: "t2", status: "done", iteration: "s4" }),
      ticket({ id: "t3", status: "done", iteration: "s4" }),
      ticket({ id: "t4", status: "abandoned", iteration: "s4", epic: "e1" }),
      // 終わっていないチケットと、ほかの Iteration のチケットは数えない
      ticket({ id: "t5", status: "todo", iteration: "s4", epic: "e1" }),
      ticket({ id: "t6", status: "done", iteration: "s5" }),
    ];
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    const row = (await screen.findByText("左パネルを主画面にする")).closest(".history-row")!;
    expect(row.querySelector("small")!.textContent).toBe("sprint4 ・ 内訳: e1 2, Epic なし 2");
    expect([...row.querySelectorAll(".counts .badge")].map((b) => b.textContent)).toEqual([
      "完了 3",
      "中止 1",
      "持ち越し 2",
    ]);
    const finished = client.data.tickets.filter(
      (t) => t.iteration === "s4" && (t.status === "done" || t.status === "abandoned"),
    );
    const counts = epicCountsOf(finished);
    expect(counts.reduce((n, c) => n + c.count, 0)).toBe(finished.length);
  });
});

describe("サイドバーの履歴", () => {
  it("開いた Iteration のチケットは Epic で分けず番号の順の 1 本の一覧で出し、持ち越しがなければ持ち越しの節を出さない", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s4", name: "sprint4", status: "closed" })];
    client.data.tickets = [
      ticket({ id: "t10", status: "done", iteration: "s4", epic: "e1", pr: 30 }),
      ticket({ id: "t2", status: "done", iteration: "s4", epic: "e2" }),
      ticket({ id: "t3", status: "abandoned", iteration: "s4" }),
    ];
    client.handlers["history"] = () => ({ events: [], shallow: false, incomplete: [] });
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("sprint4");
    const item = document.querySelector<HTMLDetailsElement>("details.history-item")!;
    item.open = true;
    fireEvent(item, new Event("toggle"));
    await waitFor(() => expect(item.querySelectorAll(".history-list")).toHaveLength(1));
    expect([...item.querySelectorAll(".history-list code")].map((c) => c.textContent)).toEqual([
      "t2",
      "t3",
      "t10",
    ]);
    expect(item.querySelector(".history-group")).toBeNull();
    expect(item.querySelector(".history-ticket.abandoned code")!.textContent).toBe("t3");
    expect(item.querySelector(".history-ticket:last-child .history-ticket-meta")!.textContent).toBe(
      "e1 ・ #30",
    );
  });

  it("終わったチケットのない Epic は薄く出して開けず、チップは完了 0 だけ、2 段目にチケットなし・閉じた日・Iteration を出す", async () => {
    window.location.hash = "#/history?view=epic";
    const client = mockClient();
    client.data.epics[0] = {
      ...client.data.epics[0]!,
      status: "closed",
      closed_at: "2026-10-31T00:00:00Z",
    };
    // e1 のチケットは t2（in_progress）だけで、終わったものはない
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
    expect(row.closest("details")).toBeNull();
    expect(row.closest(".history-item")!.classList.contains("history-empty")).toBe(true);
    expect([...row.querySelectorAll(".counts .badge")].map((b) => b.textContent)).toEqual([
      "完了 0",
    ]);
    expect(row.querySelector("small")!.textContent).toBe(
      "終わったチケットなし ・ 2026-10-31 に閉じた ・ s1",
    );
    expect(screen.getByRole("searchbox").getAttribute("placeholder")).toBe(
      "番号・タイトル・ラベルで検索",
    );
  });

  it("開いた Epic の終わったチケットは番号の順の 1 本の一覧で、2 段目に Iteration（なければ Iteration なし）と PR を出し、Epic は出さない", async () => {
    window.location.hash = "#/history?view=epic";
    const client = mockClient();
    client.data.epics[0] = {
      ...client.data.epics[0]!,
      status: "closed",
      closed_at: "2026-10-31T00:00:00Z",
    };
    client.data.tickets = [
      ticket({ id: "t10", status: "done", iteration: "s1", epic: "e1", pr: 30 }),
      ticket({ id: "t2", status: "done", epic: "e1" }),
      ticket({ id: "t3", status: "abandoned", iteration: "s1", epic: "e1" }),
      // 終わっていないチケットとほかの Epic のチケットは出さない
      ticket({ id: "t4", status: "todo", epic: "e1" }),
      ticket({ id: "t5", status: "done", epic: "e2" }),
    ];
    const opened: unknown[] = [];
    render(
      <StoreProvider client={client}>
        <HostProvider host={{ ...sidebarHost(), open: (r) => opened.push(r) }}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    const row = (await screen.findByText("最初の版")).closest(".history-epic")!;
    expect([...row.querySelectorAll(".counts .badge")].map((b) => b.textContent)).toEqual([
      "完了 2",
      "中止 1",
    ]);
    expect(row.querySelector("small")!.textContent).toBe("2026-10-31 に閉じた ・ s1");
    const item = row.closest<HTMLDetailsElement>("details.history-item")!;
    item.open = true;
    fireEvent(item, new Event("toggle"));
    await waitFor(() => expect(item.querySelectorAll(".history-list")).toHaveLength(1));
    expect([...item.querySelectorAll(".history-list code")].map((c) => c.textContent)).toEqual([
      "t2",
      "t3",
      "t10",
    ]);
    expect([...item.querySelectorAll(".history-ticket-meta")].map((m) => m.textContent)).toEqual([
      "Iteration なし ・ PR なし",
      "Abandoned ・ s1 ・ PR なし",
      "s1 ・ #30",
    ]);
    // 番号を押すと詳細を開く
    fireEvent.click(item.querySelector(".history-list .history-ticket-main")!);
    expect(opened).toEqual([{ page: "ticket", id: "t2" }]);
  });

  it("チケットの見方は日付の見出しなしの終えた新しい順の 1 本の一覧で、2 段目に Iteration・PR・終えた日を出し、中止の行は薄く出す", async () => {
    window.location.hash = "#/history?view=ticket";
    const client = mockClient();
    client.data.tickets = [
      ticket({ id: "t1", title: "古い", status: "done", iteration: "s1", epic: "e1", pr: 12 }),
      ticket({ id: "t2", title: "新しい", status: "done" }),
      ticket({
        id: "t4",
        title: "やめた",
        status: "abandoned",
        updated_at: "2026-01-01T00:00:00Z",
      }),
      ticket({ id: "t5", title: "途中", status: "todo" }),
    ];
    const finished = (id: string, at: string) => ({
      kind: "ticket",
      id,
      commit: id,
      author: "a",
      subject: "s",
      type: "changed",
      at,
      changes: [{ field: "status", from: "review", to: "done" }],
    });
    client.handlers["history"] = () => ({
      events: [finished("t1", "2026-10-01T12:00:00Z"), finished("t2", "2026-10-20T12:00:00Z")],
      shallow: false,
      incomplete: [],
    });
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll(".history-ticket")).toHaveLength(3));
    // 日付の見出しはなく、1 本の一覧
    expect(document.querySelector(".history-group")).toBeNull();
    expect(document.querySelectorAll(".history-list")).toHaveLength(1);
    expect([...document.querySelectorAll(".history-list code")].map((c) => c.textContent)).toEqual([
      "t2",
      "t1",
      "t4",
    ]);
    // 2 段目は Iteration・PR・終えた日。Epic は出さず、終えた日が分からないものは更新日に ~ を付ける
    expect(
      [...document.querySelectorAll(".history-ticket-meta")].map((m) =>
        m.textContent!.replace(/\d\d$/, "dd"),
      ),
    ).toEqual([
      "Iteration なし ・ PR なし ・ 2026-10-dd",
      "s1 ・ #12 ・ 2026-10-dd",
      "Abandoned ・ Iteration なし ・ PR なし ・ ~2026-01-dd",
    ]);
    const abandoned = document.querySelectorAll(".history-ticket")[2]!;
    expect(abandoned.classList.contains("abandoned")).toBe(true);
    expect(document.querySelector(".history-finished")).toBeNull();
    // 絞り込みは検索と結果だけ
    expect(screen.getByLabelText("結果")).toBeTruthy();
    expect(screen.queryByLabelText("Epic")).toBeNull();
  });

  it("チケットの見方の「ほか N 件」は、検索や結果の絞り込みを変えると閉じた状態に戻る", async () => {
    window.location.hash = "#/history?view=ticket";
    const client = mockClient();
    client.data.tickets = Array.from({ length: 12 }, (_, n) =>
      ticket({ id: `t${n + 1}`, title: `チケット ${n + 1}`, status: "done" }),
    );
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    const more = await screen.findByRole("button", { name: "ほか 4 件" });
    fireEvent.click(more);
    expect(document.querySelectorAll(".history-ticket")).toHaveLength(12);
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "チケット" } });
    expect(document.querySelectorAll(".history-ticket")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "ほか 4 件" })).toBeTruthy();
  });
});
