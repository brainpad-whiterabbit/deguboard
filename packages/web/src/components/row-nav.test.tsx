// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { HostProvider, type Host } from "../host.js";
import type { Route } from "../router.js";
import { StoreProvider } from "../store.js";
import { type MockClient, boardFixture, fixture, mockClient, ticket } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { ASK_HINT_KEY } from "./ask-menu.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function mount(client: MockClient) {
  const opened: Route[] = [];
  const host: Host = {
    surface: "sidebar",
    open: (route) => opened.push(route),
    show: () => {},
    copy: async () => {},
    state: createUiState(memoryBackend({ [ASK_HINT_KEY]: true })),
  };
  render(
    <StoreProvider client={client}>
      <HostProvider host={host}>
        <App />
      </HostProvider>
    </StoreProvider>,
  );
  return { opened };
}

/** Iteration のないバックログ。並びは t2（high）→ t3 → t4 */
function backlogClient(): MockClient {
  const client = mockClient(fixture());
  client.data.tickets.push(ticket({ id: "t4", title: "四つ目" }));
  return client;
}

const linkOf = (title: string) => screen.getByText(title).closest("a")!;
const rowLinks = () => [...document.querySelectorAll<HTMLElement>("a.ticket-row")];

describe("サイドバーの行のキー操作", () => {
  it("Tab で入れる行は 1 行だけ（先頭）で、↑↓ で今の行が移り、端では止まる", async () => {
    window.location.hash = "#/backlog";
    mount(backlogClient());
    await screen.findByText("API");
    await waitFor(() => expect(rowLinks().map((a) => a.tabIndex)).toEqual([0, -1, -1]));

    linkOf("API").focus();
    fireEvent.keyDown(linkOf("API"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowLinks()[1]);
    expect(rowLinks().map((a) => a.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowLinks()[2]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rowLinks()[1]);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(rowLinks()[0]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(rowLinks()[2]);
  });

  it("Enter で今の行の詳細を、エディタのパネルに開く（ハッシュは変えない）", async () => {
    window.location.hash = "#/backlog";
    const { opened } = mount(backlogClient());
    await screen.findByText("API");
    const link = linkOf("API");
    link.focus();
    fireEvent.keyDown(link, { key: "Enter" });
    expect(opened).toEqual([{ page: "ticket", id: "t2" }]);
    expect(window.location.hash).toBe("#/backlog");
  });

  it("Space で行を選び・外し、続けて別の行を足せる。a で選んだ行の「エージェントに頼む」が開き、Esc で行に戻る", async () => {
    window.location.hash = "#/backlog";
    const client = backlogClient();
    mount(client);
    await screen.findByText("API");
    const first = linkOf("API");
    first.focus();
    fireEvent.keyDown(first, { key: " " });
    expect(document.querySelectorAll("[data-selected]")).toHaveLength(1);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: " " });
    expect(
      [...document.querySelectorAll("[data-selected]")].map((el) =>
        el.getAttribute("data-select-id"),
      ),
    ).toEqual(["t2", "t3"]);

    fireEvent.keyDown(document.activeElement!, { key: "a" });
    const menu = await screen.findByRole("menu");
    expect(menu.getAttribute("aria-label")).toBe("エージェントに頼む（選んだ 2 件）");
    await waitFor(() => expect(within(menu).getAllByRole("menuitem").length).toBeGreaterThan(0));
    fireEvent.keyDown(within(menu).getAllByRole("menuitem")[0]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(rowLinks()[1]);

    // 外す
    fireEvent.keyDown(document.activeElement!, { key: " " });
    expect(document.querySelectorAll("[data-selected]")).toHaveLength(1);
  });

  it("a は選んでいない行にも効き、その行だけを対象に開く。修飾キーつきは受けない", async () => {
    window.location.hash = "#/backlog";
    mount(backlogClient());
    await screen.findByText("API");
    const link = linkOf("API");
    link.focus();
    fireEvent.keyDown(link, { key: "a", ctrlKey: true });
    fireEvent.keyDown(link, { key: " ", ctrlKey: true });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.querySelectorAll("[data-selected]")).toHaveLength(0);
    fireEvent.keyDown(link, { key: "a" });
    expect((await screen.findByRole("menu")).getAttribute("aria-label")).toBe(
      "エージェントに頼む（行 t2）",
    );
  });

  it("履歴の行も同じキーで移り、開き、選べる", async () => {
    window.location.hash = "#/history?view=ticket";
    const client = mockClient();
    client.data.tickets = [ticket({ id: "t9", title: "終えた", status: "done" })];
    client.handlers["history"] = () => ({
      events: [
        {
          kind: "ticket",
          id: "t9",
          commit: "t9",
          author: "a",
          subject: "s",
          type: "changed",
          at: "2026-10-20T12:00:00Z",
          changes: [{ field: "status", from: "review", to: "done" }],
        },
      ],
      truncated: false,
    });
    const { opened } = mount(client);
    await screen.findByText("終えた");
    const link = linkOf("終えた");
    link.focus();
    fireEvent.keyDown(link, { key: " " });
    expect(link.closest("[data-select-id]")!.hasAttribute("data-selected")).toBe(true);
    fireEvent.keyDown(link, { key: "Enter" });
    expect(opened.at(-1)).toEqual({ page: "ticket", id: "t9" });
  });

  it("吹き出しのボタンは Tab で止まらず、移れる行は今の 1 行だけ", async () => {
    window.location.hash = "#/backlog";
    mount(backlogClient());
    await screen.findByText("API");
    await waitFor(() =>
      expect(
        [...document.querySelectorAll<HTMLElement>(".ask-bubble")].map((b) => b.tabIndex),
      ).toEqual([-1, -1, -1]),
    );
    const tabbable = [
      ...document.querySelectorAll<HTMLElement>("a.ticket-row, .ask-bubble"),
    ].filter((el) => el.tabIndex >= 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(rowLinks()[0]);
  });

  it("節を畳むと、見えている先頭の行が tabIndex=0 になる", async () => {
    window.location.hash = "#/board";
    mount(mockClient(boardFixture()));
    await screen.findByText("ログイン");
    // 畳んだ節の中の行は見えないので数えない
    const visibleRows = () => rowLinks().filter((a) => !a.closest("details:not([open])"));
    const first = () => visibleRows()[0]!;
    await waitFor(() => expect(visibleRows().filter((a) => a.tabIndex === 0)).toHaveLength(1));
    const zeroRow = visibleRows().find((a) => a.tabIndex === 0)!;
    // 今 0 の行がある節を畳む
    const details = zeroRow.closest("details")!;
    details.open = false;
    expect(visibleRows()).not.toContain(zeroRow);
    await waitFor(() => expect(visibleRows().filter((a) => a.tabIndex === 0)).toEqual([first()]));
  });

  it("履歴の行の Iteration・Epic のリンクも Tab で止まらず、移れる行は今の 1 行だけ", async () => {
    window.location.hash = "#/history?view=ticket";
    const client = mockClient();
    client.data.tickets = [
      ticket({ id: "t8", title: "一つ目", status: "done", iteration: "s1", epic: "e1" }),
      ticket({ id: "t9", title: "二つ目", status: "done", iteration: "s1", epic: "e1" }),
    ];
    const ev = (id: string) => ({
      kind: "ticket",
      id,
      commit: id,
      author: "a",
      subject: "s",
      type: "changed",
      at: "2026-10-20T12:00:00Z",
      changes: [{ field: "status", from: "review", to: "done" }],
    });
    client.handlers["history"] = () => ({ events: [ev("t8"), ev("t9")], truncated: false });
    mount(client);
    await screen.findByText("一つ目");
    expect(document.querySelectorAll(".history-ticket-meta a").length).toBeGreaterThan(0);
    await waitFor(() => {
      const tabbable = [
        ...document.querySelectorAll<HTMLElement>("[data-select-id] a, [data-select-id] button"),
      ].filter((el) => el.tabIndex >= 0);
      expect(tabbable).toHaveLength(1);
      expect(tabbable[0]!.matches("a.ticket-row")).toBe(true);
    });
  });
});
