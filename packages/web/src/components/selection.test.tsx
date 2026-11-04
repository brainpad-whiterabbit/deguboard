// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { HostProvider, type Host } from "../host.js";
import type { Route } from "../router.js";
import { StoreProvider } from "../store.js";
import {
  type MockClient,
  boardFixture,
  fixture,
  iteration,
  iterationDetail,
  mockClient,
  ticket,
} from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { ASK_HINT_KEY } from "./ask-menu.js";
import { selectKind } from "./selection.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function mount(
  client: MockClient,
  surface: Host["surface"] = "sidebar",
  state: Record<string, unknown> = {},
) {
  const open = vi.fn<(route: Route) => void>();
  const host: Host = {
    surface,
    open,
    show: () => {},
    copy: async () => {},
    state: createUiState(memoryBackend({ [ASK_HINT_KEY]: true, ...state })),
  };
  render(
    <StoreProvider client={client}>
      <HostProvider host={host}>
        <App />
      </HostProvider>
    </StoreProvider>,
  );
  return { open };
}

const contextOf = (el: Element) =>
  JSON.parse(el.getAttribute("data-vscode-context")!) as Record<string, unknown>;
/** タイトルの文字から、選べる行（data-select-id の要素） */
const rowOf = (title: string) => screen.getByText(title).closest<HTMLElement>("[data-select-id]")!;
/** 行のリンク（押すと詳細を開くところ） */
const linkOf = (title: string) => screen.getByText(title).closest("a")!;
const selected = () =>
  [...document.querySelectorAll("[data-selected]")].map((el) => el.getAttribute("data-select-id"));
const bar = () => screen.queryByRole("region", { name: "選んだ行" });
const menu = () => screen.getByRole("menu");
const items = () =>
  within(menu())
    .getAllByRole("menuitem")
    .map((b) => b.textContent);
const askInputs = (client: MockClient) =>
  client.calls.filter((c) => c.name === "ask").map((c) => c.input as Record<string, unknown>);

/** Iteration のないバックログ（1 つの一覧）。並びは優先度と番号で t2（high）→ t3 → t4 → t5 */
function backlogClient(): MockClient {
  const client = mockClient(fixture());
  client.data.tickets.push(
    ticket({ id: "t4", title: "四つ目" }),
    ticket({ id: "t5", title: "五つ目" }),
  );
  return client;
}

describe("選び方の判定", () => {
  it("Ctrl と ⌘ は 1 行ずつ、Shift は範囲、Alt つきと修飾キーなしは選ばない", () => {
    const k = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
    expect(selectKind({ ...k, ctrlKey: true })).toBe("toggle");
    expect(selectKind({ ...k, metaKey: true })).toBe("toggle");
    expect(selectKind({ ...k, shiftKey: true })).toBe("range");
    expect(selectKind({ ...k, ctrlKey: true, altKey: true })).toBeNull();
    expect(selectKind(k)).toBeNull();
  });
});

describe("左パネルのバックログの行を複数選ぶ（UI-15）", () => {
  it("Ctrl/⌘+クリックで 1 行ずつ足し外しし、そのときは詳細を開かない。ふつうのクリックは詳細を開き、選択を外す", async () => {
    window.location.hash = "#/backlog";
    const { open } = mount(backlogClient());
    await screen.findByText("四つ目");
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    fireEvent.click(linkOf("四つ目"), { metaKey: true });
    expect(selected()).toEqual(["t3", "t4"]);
    expect(open).not.toHaveBeenCalled();
    // もう一度押すと外す
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    expect(selected()).toEqual(["t4"]);
    // ふつうのクリックは今までどおり詳細を開く
    fireEvent.click(linkOf("五つ目"));
    expect(open).toHaveBeenCalledWith({ page: "ticket", id: "t5" });
    expect(selected()).toEqual([]);
    expect(bar()).toBeNull();
  });

  it("Shift+クリックで前に押した行からの範囲を選び、続けて押すと同じ起点から選び直す", async () => {
    window.location.hash = "#/backlog";
    const { open } = mount(backlogClient());
    await screen.findByText("四つ目");
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    fireEvent.click(linkOf("五つ目"), { shiftKey: true });
    expect(selected()).toEqual(["t3", "t4", "t5"]);
    fireEvent.click(linkOf("API"), { shiftKey: true });
    expect(selected()).toEqual(["t2", "t3"]);
    expect(open).not.toHaveBeenCalled();
    // 起点がなければ押した行だけ
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(selected()).toEqual([]);
  });

  it("選ぶと「n 件を選択 ・ 頼む」の帯が出て、「選択を外す」と Esc で外せる", async () => {
    window.location.hash = "#/backlog";
    mount(backlogClient());
    await screen.findByText("四つ目");
    expect(bar()).toBeNull();
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    fireEvent.click(linkOf("四つ目"), { ctrlKey: true });
    expect(bar()!.textContent).toContain("2 件を選択");
    expect(within(bar()!).getByRole("button", { name: "頼む" })).toBeTruthy();
    fireEvent.click(within(bar()!).getByRole("button", { name: "選択を外す" }));
    expect(bar()).toBeNull();
    expect(selected()).toEqual([]);
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    expect(bar()!.textContent).toContain("1 件を選択");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(bar()).toBeNull();
  });

  it("選んだ行の吹き出し・右クリックの文脈・帯の「頼む」は、選んだ全件を対象にした一覧を出し、選ぶと全件で入力欄を開く", async () => {
    window.location.hash = "#/backlog";
    const client = backlogClient();
    mount(client);
    await screen.findByText("四つ目");
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    fireEvent.click(linkOf("四つ目"), { ctrlKey: true });
    // 右クリックの文脈：選んだ行はどちらも全件
    for (const title of ["画面", "四つ目"]) {
      await waitFor(() => expect(contextOf(rowOf(title))["askActions"]).toBeDefined());
      expect(contextOf(rowOf(title))).toMatchObject({
        webviewSection: "backlogTicket",
        askTargets: "t3 t4",
        askRecommended: "assign",
      });
    }
    // 選んでいない行は自分だけ
    expect(contextOf(rowOf("五つ目"))["askTargets"]).toBe("t5");
    // 吹き出し
    // 選んだ行はどちらも吹き出しを出したまま（場所の名前は「選んだ 2 件」）
    expect(
      screen.getAllByRole("button", { name: "エージェントに頼む（選んだ 2 件）" }),
    ).toHaveLength(2);
    fireEvent.click(
      within(rowOf("四つ目")).getByRole("button", { name: "エージェントに頼む（選んだ 2 件）" }),
    );
    await waitFor(() => expect(items()[0]).toBe("割り当てるおすすめ"));
    expect(within(menu()).getByText("選んだ 2 件")).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    // 帯の「頼む」
    fireEvent.click(within(bar()!).getByRole("button", { name: "頼む" }));
    await waitFor(() => expect(items()[0]).toBe("割り当てるおすすめ"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "点検する" }));
    await waitFor(() =>
      expect(askInputs(client).at(-1)).toMatchObject({ targets: ["t3", "t4"], action: "check" }),
    );
    // 入力欄を開いている間は帯を出さない。選択は残る
    expect(bar()).toBeNull();
    expect(selected()).toEqual(["t3", "t4"]);
  });

  it("絞り込みの件数（n / m 件）の右クリックの文脈と Shift+F10 で、絞った結果を対象にした一覧が出る", async () => {
    window.location.hash = "#/backlog";
    const client = backlogClient();
    mount(client);
    await screen.findByText("四つ目");
    fireEvent.change(screen.getByRole("searchbox", { name: "検索" }), {
      target: { value: "つ目" },
    });
    const count = await screen.findByText(/2 \/ 4 件/);
    await waitFor(() => expect(contextOf(count)["askActions"]).toBeDefined());
    expect(contextOf(count)).toMatchObject({
      webviewSection: "backlogHeading",
      askTargets: "t4 t5",
      askRecommended: "assign",
    });
    // 吹き出しは置かない
    expect(within(count).queryByRole("button")).toBeNull();
    count.focus();
    fireEvent.keyDown(count, { key: "F10", shiftKey: true });
    await waitFor(() => expect(items()[0]).toBe("割り当てるおすすめ"));
    expect(within(menu()).getByText("絞り込みの結果 2 件")).toBeTruthy();
    // 0 件なら頼めない
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.change(screen.getByRole("searchbox", { name: "検索" }), {
      target: { value: "ないもの" },
    });
    const none = await screen.findByText(/0 \/ 4 件/);
    expect(none.hasAttribute("data-vscode-context")).toBe(false);
  });
});

describe("見直しの指摘（UI-15）", () => {
  it("Shift+クリックの範囲が畳んだ節をまたいでも、見えない行は選ばない", async () => {
    const client = mockClient(boardFixture());
    client.data.tickets.push(
      ticket({ id: "t4", title: "見てもらう", status: "review", iteration: "s0" }),
    );
    // in_progress の節（t2）を畳んでおく。並びは todo（t3）→ in_progress（t2）→ review（t4）
    mount(client, "sidebar", { "board.section.in_progress": false, "board.section.review": true });
    await screen.findByText("見てもらう");
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    fireEvent.click(linkOf("見てもらう"), { shiftKey: true });
    expect(selected()).toEqual(["t3", "t4"]);
    expect(bar()!.textContent).toContain("2 件を選択");
  });

  it("頼むことの一覧を Esc で閉じても選択は残り、もう一度の Esc で外す", async () => {
    window.location.hash = "#/backlog";
    mount(backlogClient());
    await screen.findByText("四つ目");
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    fireEvent.click(linkOf("四つ目"), { ctrlKey: true });
    fireEvent.click(within(bar()!).getByRole("button", { name: "頼む" }));
    await waitFor(() => expect(items()[0]).toBe("割り当てるおすすめ"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(selected()).toEqual(["t3", "t4"]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(selected()).toEqual([]);
  });

  it("バックログの検索・絞り込みを変えたら選択を外す（隠れた行を対象に残さない）", async () => {
    window.location.hash = "#/backlog";
    mount(backlogClient());
    await screen.findByText("四つ目");
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    expect(selected()).toEqual(["t3"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "検索" }), {
      target: { value: "つ目" },
    });
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("バックログの Iteration の区画の行は、ふつうのクリックで詳細を開き、Ctrl+クリックで選ぶ", async () => {
    const client = mockClient(
      fixture({ iterations: [iteration({ id: "s1", name: "来週", status: "planned" })] }),
    );
    window.location.hash = "#/backlog";
    const { open } = mount(client);
    await screen.findByText("画面");
    fireEvent.click(linkOf("画面"));
    expect(open).toHaveBeenCalledWith({ page: "ticket", id: "t3" });
    expect(selected()).toEqual([]);
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    expect(selected()).toEqual(["t3"]);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("カンバンとパネルの詳細の行を複数選ぶ（UI-15）", () => {
  it("左パネルのカンバンの行も Ctrl+クリックで選べ、節をまたいで選んだ全件を対象にする", async () => {
    const client = mockClient(boardFixture());
    const { open } = mount(client);
    await screen.findByText("画面");
    fireEvent.click(linkOf("API"), { ctrlKey: true });
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    expect(open).not.toHaveBeenCalled();
    // 画面の並び（todo の節が in_progress の節より上）で持つ
    expect(selected()).toEqual(["t3", "t2"]);
    await waitFor(() => expect(contextOf(rowOf("API"))["askActions"]).toBeDefined());
    expect(contextOf(rowOf("API"))).toMatchObject({
      webviewSection: "boardTicket",
      askTargets: "t3 t2",
      askRecommended: "check",
    });
    expect(bar()!.textContent).toContain("2 件を選択");
    // Iteration を替えると（画面が替わると）外す
    window.location.hash = "#/board?iteration=all";
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("パネルの Iteration の詳細の行は、選ぶと Iteration を within にして全件を対象にする", async () => {
    const data = fixture({ iterations: [iteration({ id: "s1", name: "最初", status: "active" })] });
    data.tickets = data.tickets.map((t) => ({ ...t, iteration: "s1" }));
    const client = mockClient(data);
    client.handlers["iteration.show"] = () =>
      iterationDetail(
        client.data.iterations[0]!,
        client.data.tickets.filter((t) => t.iteration === "s1"),
      );
    window.location.hash = "#/iterations/s1";
    const { open } = mount(client, "panel");
    const api = (await screen.findByRole("link", { name: "API" })).closest("tr")!;
    fireEvent.click(screen.getByRole("link", { name: "API" }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("link", { name: "画面" }), { shiftKey: true });
    expect(open).not.toHaveBeenCalled();
    // 範囲は表の並び（t2 → t1 → t3）
    expect(selected()).toEqual(["t2", "t1", "t3"]);
    fireEvent.click(screen.getByRole("link", { name: "ログイン" }), { ctrlKey: true });
    expect(selected()).toEqual(["t2", "t3"]);
    await waitFor(() => expect(contextOf(api)["askActions"]).toBeDefined());
    expect(contextOf(api)).toMatchObject({
      webviewSection: "detailTicket",
      askTargets: "t2 t3",
      askWithin: "s1",
    });
    expect(contextOf(api)["askActions"]).toContain("remove");
    // 行の中のボタン（吹き出し）を修飾キーつきで押しても選び方は変わらない
    fireEvent.click(within(api).getByRole("button", { name: /エージェントに頼む/ }), {
      ctrlKey: true,
    });
    expect(selected()).toEqual(["t2", "t3"]);
    expect(bar()!.textContent).toContain("2 件を選択");
  });
});
