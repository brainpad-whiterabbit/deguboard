// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import { type MockClient, boardFixture, fixture, mockClient, ticket } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { ASK_HINT_KEY } from "./ask-menu.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function mount(client: MockClient) {
  const host: Host = {
    surface: "sidebar",
    open: () => {},
    show: () => {},
    copy: async () => {},
    state: createUiState(memoryBackend({ [ASK_HINT_KEY]: true })),
  };
  return render(
    <StoreProvider client={client}>
      <HostProvider host={host}>
        <App />
      </HostProvider>
    </StoreProvider>,
  );
}

const head = () => document.querySelector<HTMLElement>(".epic-head");
const contextOf = (el: Element) =>
  JSON.parse(el.getAttribute("data-vscode-context")!) as Record<string, unknown>;
const bubble = (place: string) =>
  screen.getByRole("button", { name: `エージェントに頼む（${place}）` });
const menu = () => screen.getByRole("menu");
const items = () =>
  within(menu())
    .getAllByRole("menuitem")
    .map((b) => b.textContent);
const composer = () => screen.getByRole("region", { name: "エージェントに頼む" });
/** ask-menu で引いた組（鍵）。対象と場所が同じなら同じ鍵になり、core は同じ候補を返す */
const askedSets = (client: MockClient) =>
  client.calls
    .filter((c) => c.name === "ask-menu")
    .flatMap((c) => (c.input as { sets: string[] }).sets);
const epicChip = () => screen.getByRole("button", { name: "e1 最初の版" });
const noneChip = () => document.querySelector<HTMLElement>(".epic-chip.loose")!;

describe("カンバンの選んでいる Epic の見出し（UI-10・UI-15）", () => {
  it("Epic で絞っている間だけ Iteration の見出しの下に「Epic 番号 題 done/全体 ×」を出し、× で絞り込みを外す。値の札には Epic を出さない", async () => {
    mount(mockClient(boardFixture()));
    await screen.findByText("画面");
    expect(head()).toBeNull();

    fireEvent.click(epicChip());
    await waitFor(() => expect(head()).toBeTruthy());
    expect(head()!.textContent).toBe("Epice1 最初の版0/1×");
    // Iteration の見出しのすぐ下で、進みの帯の上
    expect(head()!.previousElementSibling).toBe(
      document.querySelector(".sidebar-head .head-line.sub"),
    );
    // 題は Epic の詳細へのリンク
    expect(within(head()!).getByRole("link").getAttribute("href")).toBe("#/epics/e1");
    // 札が見えていても見出しを出し、Epic の値の札は出さない（見出しが × を兼ねる）
    expect(epicChip().getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".filter-chips")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Epic e1 の絞り込みを外す" }));
    await waitFor(() => expect(head()).toBeNull());
    expect(window.location.hash).not.toContain("epic");
    expect(screen.getByText("画面")).toBeTruthy();
  });

  it("見出しの吹き出しと Shift+F10 でその Epic を頼める。対象の組は Epic の詳細のタイトルと同じ（Epic の ID だけ）で、右クリックの文脈は Epic の ID", async () => {
    const client = mockClient(boardFixture());
    mount(client);
    await screen.findByText("画面");
    fireEvent.click(epicChip());
    await waitFor(() => expect(head()).toBeTruthy());
    expect(contextOf(head()!)).toEqual({
      webviewSection: "deguboardItem",
      id: "e1",
      preventDefaultContextMenuItems: true,
    });
    fireEvent.click(bubble("Epic の見出し e1"));
    // Epic の詳細のタイトル（ask-menu.test.tsx）と同じおすすめ
    await waitFor(() => expect(items()[0]).toBe("起票して e1 に足すおすすめ"));
    expect(within(menu()).getByText("Epic の見出し e1")).toBeTruthy();
    // 場所（@・#）を付けずに Epic の ID だけで引く（詳細のタイトルと同じ鍵）
    expect(askedSets(client)).toContain("e1");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    head()!.focus();
    fireEvent.keyDown(head()!, { key: "F10", shiftKey: true });
    await waitFor(() => expect(items()[0]).toBe("起票して e1 に足すおすすめ"));
    fireEvent.click(within(menu()).getAllByRole("menuitem")[0]!);
    await waitFor(() =>
      expect(within(composer()).getByRole("button", { name: "e1 を外す" })).toBeTruthy(),
    );
  });

  it("「なし」で絞ると「Epic なし N 件」を出し、見えている Epic のないチケットの全件を対象にする（行を複数選ぶときと同じく、ID を並べただけの組）", async () => {
    const client = mockClient(boardFixture());
    mount(client);
    await screen.findByText("画面");
    fireEvent.click(noneChip());
    await waitFor(() => expect(head()).toBeTruthy());
    // done の t1 と todo の t3（どちらも Epic なし）
    expect(head()!.textContent).toBe("Epicなし2 件×");
    // Epic の ID がないので、右クリックの文脈は既定のメニューを止めるだけ
    expect(contextOf(head()!)).toEqual({ preventDefaultContextMenuItems: true });
    fireEvent.click(bubble("Epic の見出し なし"));
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    expect(askedSets(client)).toContain("t1 t3");
    fireEvent.click(within(menu()).getAllByRole("menuitem")[0]!);
    await waitFor(() =>
      expect(within(composer()).getByRole("button", { name: "t1 を外す" })).toBeTruthy(),
    );
    expect(within(composer()).getByRole("button", { name: "t3 を外す" })).toBeTruthy();
  });

  it("閉じた Epic で絞ったとき（札の列に出ない）も見出しを出し、頼めて、× で外せる", async () => {
    const client = mockClient(boardFixture());
    client.data.epics = client.data.epics.map((e) => ({ ...e, status: "closed" as const }));
    window.location.hash = "#/board?epic=e1";
    mount(client);
    await screen.findByText("API");
    expect(document.querySelector(".epic-chips")).toBeNull();
    expect(head()!.textContent).toBe("Epice1 最初の版0/1終了×");
    fireEvent.click(bubble("Epic の見出し e1"));
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Epic e1 の絞り込みを外す" }));
    await waitFor(() => expect(head()).toBeNull());
  });

  it("一覧にない Epic で絞ったときは、ID と × だけの見出しにして頼む入口を置かない", async () => {
    window.location.hash = "#/board?epic=e9";
    mount(mockClient(boardFixture()));
    await waitFor(() => expect(head()).toBeTruthy());
    expect(head()!.textContent).toBe("Epice9×");
    expect(head()!.hasAttribute("data-ask-spot")).toBe(false);
    expect(within(head()!).getAllByRole("button")).toHaveLength(1);
  });
});

describe("バックログの選んでいる Epic の見出し（UI-10・UI-15）", () => {
  function backlogClient(): MockClient {
    const client = mockClient(fixture());
    client.data.tickets.push(ticket({ id: "t4", title: "四つ目" }));
    return client;
  }

  it("Epic で絞っている間だけ Epic の札の下に見出しを出し、吹き出しでその Epic を頼め、× で外せる。条件の札には Epic を出さない", async () => {
    window.location.hash = "#/backlog";
    const client = backlogClient();
    mount(client);
    await screen.findByText("画面");
    expect(head()).toBeNull();

    fireEvent.click(epicChip());
    expect(head()!.textContent).toBe("Epice1 最初の版0/1×");
    expect(head()!.previousElementSibling).toBe(
      document.querySelector(".backlog-epics .epic-chips"),
    );
    expect(document.querySelector(".quick-filters .filter-chip")).toBeNull();
    expect(contextOf(head()!)).toMatchObject({ id: "e1" });
    fireEvent.click(bubble("Epic の見出し e1"));
    await waitFor(() => expect(items()[0]).toBe("起票して e1 に足すおすすめ"));
    expect(askedSets(client)).toContain("e1");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Epic e1 の絞り込みを外す" }));
    expect(head()).toBeNull();
    expect(epicChip().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("画面")).toBeTruthy();
  });

  it("「なし」で絞ると、ほかの絞り込みの後に見えている Epic のない行の全件を対象にする", async () => {
    window.location.hash = "#/backlog";
    const client = backlogClient();
    mount(client);
    await screen.findByText("画面");
    fireEvent.click(noneChip());
    // 終わっていない Epic なしは t3 と t4
    expect(head()!.textContent).toBe("Epicなし2 件×");
    fireEvent.click(bubble("Epic の見出し なし"));
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    expect(askedSets(client)).toContain("t3 t4");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    // 検索で 1 件に減らすと、見出しの件数と対象も 1 件になる
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "四つ目" } });
    expect(head()!.textContent).toBe("Epicなし1 件×");
    fireEvent.click(bubble("Epic の見出し なし"));
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    expect(askedSets(client)).toContain("t4");
  });
});
