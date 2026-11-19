// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { HostProvider, type Host } from "../host.js";
import type { Route } from "../router.js";
import { StoreProvider } from "../store.js";
import {
  type MockClient,
  boardFixture,
  escapeMenu,
  fixture,
  iteration,
  iterationDetail,
  markedText,
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
  copy: Host["copy"] = async () => {},
) {
  const open = vi.fn<(route: Route) => void>();
  const host: Host = {
    surface,
    open,
    show: () => {},
    copy,
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
    .map((b) => markedText(b));
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

  it("選ぶと「n 件を選択 頼む」の帯が出て、「選択を外す」と Esc で外せる", async () => {
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

  it("選んだ行の吹き出し・帯の「頼む」は、選んだ全件を対象にした一覧を出し、選ぶと全件で入力欄を開く", async () => {
    window.location.hash = "#/backlog";
    const client = backlogClient();
    mount(client);
    await screen.findByText("四つ目");
    fireEvent.click(linkOf("画面"), { ctrlKey: true });
    fireEvent.click(linkOf("四つ目"), { ctrlKey: true });
    // 右クリックの文脈には選んだ全件を載せない（「詳細を開く」「ID をコピー」の行のチケットだけ）
    expect(contextOf(rowOf("四つ目"))).toEqual({
      webviewSection: "deguboardItem",
      id: "t4",
      preventDefaultContextMenuItems: true,
    });
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
    await escapeMenu();
    // 帯の右クリックの文脈には、押しても動かない「詳細を開く」「ID をコピー」の webviewSection を載せない
    expect(contextOf(bar()!)).toEqual({ preventDefaultContextMenuItems: true });
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

  it("絞り込みの件数（n / m 件）は頼む入口にしない（右クリックの文脈も Shift+F10 もない）", async () => {
    window.location.hash = "#/backlog";
    const client = backlogClient();
    mount(client);
    await screen.findByText("四つ目");
    fireEvent.change(screen.getByRole("searchbox", { name: "検索" }), {
      target: { value: "つ目" },
    });
    const count = await screen.findByText(/2 \/ 4 件/);
    expect(count.hasAttribute("data-vscode-context")).toBe(false);
    expect(count.hasAttribute("data-ask-spot")).toBe(false);
    expect(count.getAttribute("title")).toBe("全 4 件のうち 2 件");
    expect(within(count).queryByRole("button")).toBeNull();
    count.focus();
    fireEvent.keyDown(count, { key: "F10", shiftKey: true });
    expect(screen.queryByRole("menu")).toBeNull();
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
    await escapeMenu();
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
    // 選んだ行の吹き出しは、節をまたいだ全件の一覧（おすすめは点検）を出す
    fireEvent.click(
      within(rowOf("API")).getByRole("button", { name: "エージェントに頼む（選んだ 2 件）" }),
    );
    await waitFor(() => expect(items()[0]).toBe("点検するおすすめ"));
    await escapeMenu();
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
    const api = (await screen.findByText("API")).closest("li")!;
    fireEvent.click(screen.getByRole("link", { name: /API/ }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("link", { name: /画面/ }), { shiftKey: true });
    expect(open).not.toHaveBeenCalled();
    // 範囲は段の並び（t3 → t2 → t1。未完了の中は Status の順）
    expect(selected()).toEqual(["t3", "t2"]);
    // 畳んだ完了の段の行も ctrl で足し引きできる
    fireEvent.click(screen.getByRole("link", { name: /ログイン/ }), { ctrlKey: true });
    expect(selected()).toEqual(["t3", "t2", "t1"]);
    fireEvent.click(screen.getByRole("link", { name: /ログイン/ }), { ctrlKey: true });
    expect(selected()).toEqual(["t3", "t2"]);
    // 選んだ行の吹き出しの一覧は、選んだ全件を Iteration（within）つきの組で引く
    fireEvent.click(within(api).getByRole("button", { name: "エージェントに頼む（選んだ 2 件）" }));
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    expect(items()).toContain("s1 から外す");
    await escapeMenu();
    // 行の中のボタン（吹き出し）を修飾キーつきで押しても選び方は変わらない
    fireEvent.click(within(api).getByRole("button", { name: /エージェントに頼む/ }), {
      ctrlKey: true,
    });
    expect(selected()).toEqual(["t3", "t2"]);
    expect(bar()!.textContent).toContain("2 件を選択");
  });
});

describe("一覧の行の左端の帯で 1 件ずつ選ぶ（UI-15）", () => {
  it("カンバンの行の帯を押すと、その 1 件を選ぶ・外すの切り替えになり、詳細は開かない", async () => {
    const client = mockClient(boardFixture());
    const { open } = mount(client);
    await screen.findByText("画面");
    fireEvent.click(rowOf("画面"));
    fireEvent.click(rowOf("API"));
    expect(selected()).toEqual(["t3", "t2"]);
    fireEvent.click(rowOf("画面"));
    expect(selected()).toEqual(["t2"]);
    expect(open).not.toHaveBeenCalled();
    // 行の本体のクリックは今までどおり詳細を開き、選択を外す
    fireEvent.click(linkOf("画面"));
    expect(open).toHaveBeenCalledWith({ page: "ticket", id: "t3" });
    expect(selected()).toEqual([]);
  });

  it("バックログの行の帯も 1 件ずつ選ぶ・外すを切り替え、詳細は開かない", async () => {
    window.location.hash = "#/backlog";
    const { open } = mount(backlogClient());
    await screen.findByText("四つ目");
    fireEvent.click(rowOf("画面"));
    fireEvent.click(rowOf("四つ目"));
    expect(selected()).toEqual(["t3", "t4"]);
    expect(bar()!.textContent).toContain("2 件を選択");
    fireEvent.click(rowOf("画面"));
    expect(selected()).toEqual(["t4"]);
    expect(open).not.toHaveBeenCalled();
  });

  it("履歴の行の帯も 1 件ずつ選ぶ・外すを切り替え、詳細は開かない", async () => {
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
    const { open } = mount(client);
    await screen.findByText("終えた");
    fireEvent.click(rowOf("終えた"));
    expect(selected()).toEqual(["t9"]);
    fireEvent.click(rowOf("終えた"));
    expect(selected()).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it("Iteration の詳細の行の帯も 1 件ずつ選び、選んだ行は同じ帯の押し方で外せる", async () => {
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
    await screen.findByText("API");
    fireEvent.click(rowOf("API"));
    expect(selected()).toEqual(["t2"]);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(rowOf("API"));
    expect(selected()).toEqual([]);
    expect(bar()).toBeNull();
  });

  it("Epic の詳細の行の帯も 1 件ずつ選び、選んだ行は同じ帯の押し方で外せ、詳細は開かない", async () => {
    const client = mockClient();
    client.data.tickets = client.data.tickets.map((t) => ({ ...t, epic: "e1" }));
    client.handlers["epic.show"] = () => ({
      ...client.data.epics[0],
      body: "",
      tickets: client.data.tickets.filter((t) => t.epic === "e1"),
    });
    window.location.hash = "#/epics/e1";
    const { open } = mount(client, "panel");
    await screen.findByText("API");
    fireEvent.click(rowOf("API"));
    expect(selected()).toEqual(["t2"]);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(rowOf("API"));
    expect(selected()).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });
});

/** jsdom には PointerEvent がないので、同じ名前の Event に pointer の値を載せて送る（React は載った値を読む） */
function pointer(target: EventTarget, type: string, init: Record<string, unknown>) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    clientX: 0,
    clientY: 0,
    ...init,
  });
  act(() => {
    target.dispatchEvent(ev);
  });
}

/**
 * jsdom は配置をしないので、選べる行に縦の位置を与える（並びの順に 40px ずつ。高さ 30px、左端は 0。
 * 左端の帯は x = 5 で押せば、12px の中に入る）。戻り値で元に戻す
 */
function placeRows(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (!this.hasAttribute("data-select-id")) return original.call(this);
    const index = [...document.querySelectorAll("[data-select-id]")].indexOf(this);
    const top = 100 + index * 40;
    return {
      x: 0,
      y: top,
      top,
      bottom: top + 30,
      left: 0,
      right: 300,
      width: 300,
      height: 30,
      toJSON() {},
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

describe("なぞりの終わり方（UI-15）", () => {
  // 並びは backlogClient の画面（API・画面・四つ目・五つ目）。画面の行の帯から五つ目の行まで、なぞって選ぶ
  it.each([
    [
      "予備：ボタンが離れているのに離すを受けていない動き（buttons が 0）",
      () => pointer(window, "pointermove", { buttons: 0, clientX: 5, clientY: 235 }),
    ],
    [
      "離す（pointerup）",
      () => pointer(window, "pointerup", { buttons: 0, clientX: 5, clientY: 235 }),
    ],
  ])(
    "%sで終えると、通った行を残し、次の Shift+クリックの起点を押した行にし、次の 1 回のクリックだけ捨てる",
    async (_name, end) => {
      window.location.hash = "#/backlog";
      const restore = placeRows();
      try {
        const { open } = mount(backlogClient());
        await screen.findByText("四つ目");
        pointer(rowOf("画面"), "pointerdown", { clientX: 5, clientY: 155 });
        pointer(window, "pointermove", { buttons: 1, clientX: 5, clientY: 175 });
        pointer(window, "pointermove", { buttons: 1, clientX: 5, clientY: 235 });
        expect(selected(), "なぞりの途中は通った行を選ぶ").toEqual(["t3", "t4", "t5"]);
        end();
        // 終えたあとも選んだ行は残り、なぞりを始めた行（画面）が起点になる
        expect(selected()).toEqual(["t3", "t4", "t5"]);
        // なぞりは終わっているので、ボタンを押したままの動きが来ても選びは動かない（動きの受け口を外していることの確かめ）
        pointer(window, "pointermove", { buttons: 1, clientX: 5, clientY: 115 });
        expect(selected()).toEqual(["t3", "t4", "t5"]);
        expect(bar()!.textContent).toContain("3 件を選択");
        // 終えた直後の 1 回のクリックは捨てる（詳細は開かず、選びも変えない）
        fireEvent.click(linkOf("API"));
        expect(open).not.toHaveBeenCalled();
        expect(selected()).toEqual(["t3", "t4", "t5"]);
        // 起点は画面なので、Shift+クリックの範囲は API から画面まで
        fireEvent.click(linkOf("API"), { shiftKey: true });
        expect(selected()).toEqual(["t2", "t3"]);
      } finally {
        restore();
      }
    },
  );
});

describe("選んだ行の ID をコピーする（UI-15）", () => {
  /** バックログで行を Ctrl+クリックで選んでおく。コピーは copy に届く */
  async function selectRows(titles: readonly string[], copy: Host["copy"]) {
    window.location.hash = "#/backlog";
    mount(backlogClient(), "sidebar", {}, copy);
    await screen.findByText("四つ目");
    for (const title of titles) fireEvent.click(linkOf(title), { ctrlKey: true });
  }

  it("帯の「頼む」の右の「ID をコピー」で、選んだ ID を見えている順に空白で区切ってコピーし、選択は外さず、何件の何をコピーしたかを少しの間出す", async () => {
    const copy = vi.fn<Host["copy"]>(async () => {});
    // 選んだ順（五つ目 → 画面）ではなく、見えている順（画面 → 五つ目）でコピーする
    await selectRows(["五つ目", "画面"], copy);
    const buttons = within(bar()!)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(buttons).toEqual(["頼む", "ID をコピー", "コピーの形を選ぶ", "選択を外す"]);
    const copyIds = within(bar()!).getByRole("button", { name: "ID をコピー" });
    expect(copyIds.title).toBe("選んだ 2 件の ID をコピー（Ctrl/⌘+C）");
    fireEvent.click(copyIds);
    expect(copy).toHaveBeenCalledWith("t3 t5");
    const status = within(bar()!).getByRole("status");
    await waitFor(() => expect(status.textContent).toBe("2 件の ID をコピーしました"));
    expect(bar()!.textContent).toContain("2 件を選択");
    expect(selected()).toEqual(["t3", "t5"]);
    // 少しの間で消える
    await waitFor(() => expect(status.textContent).toBe(""), { timeout: 3000 });
  });

  it("コピーに失敗したら、帯にそのことを出す", async () => {
    const copy = vi.fn<Host["copy"]>(async () => {
      throw new Error("clipboard");
    });
    await selectRows(["画面"], copy);
    fireEvent.click(within(bar()!).getByRole("button", { name: "ID をコピー" }));
    expect(await within(bar()!).findByText("コピーできませんでした")).toBeTruthy();
    expect(selected()).toEqual(["t3"]);
  });

  it("▾ のメニューで ID・ID とタイトル・Markdown のリストを選べ、項目には先頭の 1 件の見本を出す", async () => {
    const copy = vi.fn<Host["copy"]>(async () => {});
    await selectRows(["四つ目", "画面"], copy);
    const formats = within(bar()!).getByRole("button", { name: "コピーの形を選ぶ" });
    fireEvent.click(formats);
    expect(formats.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("menu", { name: "コピーの形" });
    expect(
      within(list)
        .getAllByRole("menuitem")
        .map((b) => b.textContent),
    ).toEqual(["IDt3 …", "ID とタイトルt3 画面 …", "Markdown のリスト- t3 画面 …"]);
    // 先頭の項目にフォーカスを置き（escapeMenu が移るのを待って確かめる）、Esc でメニューだけを閉じ、▾ に戻る。選択は残る
    await escapeMenu();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(formats);
    expect(selected()).toEqual(["t3", "t4"]);
    expect(copy).not.toHaveBeenCalled();
    fireEvent.click(formats);
    fireEvent.click(
      within(screen.getByRole("menu", { name: "コピーの形" })).getByRole("menuitem", {
        name: /^ID とタイトル/,
      }),
    );
    expect(copy).toHaveBeenLastCalledWith("t3 画面\nt4 四つ目");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(await within(bar()!).findByText("2 件の ID とタイトルをコピーしました")).toBeTruthy();

    fireEvent.click(formats);
    fireEvent.click(screen.getByRole("menuitem", { name: /^Markdown のリスト/ }));
    expect(copy).toHaveBeenLastCalledWith("- t3 画面\n- t4 四つ目");
    expect(
      await within(bar()!).findByText("2 件を Markdown のリストでコピーしました"),
    ).toBeTruthy();

    fireEvent.click(formats);
    fireEvent.click(screen.getAllByRole("menuitem")[0]!);
    expect(copy).toHaveBeenLastCalledWith("t3 t4");
    // コピーしても選択は外さない
    expect(selected()).toEqual(["t3", "t4"]);
  });

  it("選んだ後に並び順を変えても、コピーは今見えている順で出す", async () => {
    const copy = vi.fn<Host["copy"]>(async () => {});
    await selectRows(["画面", "四つ目"], copy);
    fireEvent.click(screen.getByRole("button", { name: "表示" }));
    const group = screen.getByRole("group", { name: "並び順" });
    fireEvent.click(within(group).getByRole("menuitemradio", { name: "番号" }));
    // 選んでいる基準をもう一度押すと向きが入れ替わる（番号 ↓：五つ目 → 四つ目 → 画面 → API）
    fireEvent.click(within(group).getByRole("menuitemradio", { name: "番号 ↑" }));
    expect(selected()).toEqual(["t4", "t3"]);
    fireEvent.click(within(bar()!).getByRole("button", { name: "ID をコピー" }));
    expect(copy).toHaveBeenLastCalledWith("t4 t3");
  });

  it("文字を選んでいないときの Ctrl/⌘+C は選んだ ID を空白区切りでコピーし、文字を選んでいるとき・入力欄では横取りしない", async () => {
    const copy = vi.fn<Host["copy"]>(async () => {});
    await selectRows(["画面", "五つ目"], copy);
    const ctrlC = fireEvent.keyDown(linkOf("画面"), { key: "c", ctrlKey: true });
    expect(ctrlC, "既定のコピーを止める").toBe(false);
    expect(copy).toHaveBeenLastCalledWith("t3 t5");
    fireEvent.keyDown(document.body, { key: "C", metaKey: true });
    expect(copy).toHaveBeenCalledTimes(2);

    // 文字を選んでいるときはブラウザのコピーに任せる
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("四つ目"));
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(fireEvent.keyDown(document.body, { key: "c", ctrlKey: true })).toBe(true);
    window.getSelection()!.removeAllRanges();
    // 入力欄（検索）の Ctrl+C も横取りしない
    const search = screen.getByRole("searchbox", { name: "検索" });
    expect(fireEvent.keyDown(search, { key: "c", ctrlKey: true })).toBe(true);
    // Shift・Alt つきと、修飾キーなしの c は受けない
    fireEvent.keyDown(document.body, { key: "c", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: "c", ctrlKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: "c" });
    expect(copy).toHaveBeenCalledTimes(2);
    // 選んでいないときは受けない
    fireEvent.click(within(bar()!).getByRole("button", { name: "選択を外す" }));
    expect(fireEvent.keyDown(document.body, { key: "c", ctrlKey: true })).toBe(true);
    expect(copy).toHaveBeenCalledTimes(2);
  });

  it("「選択を外す」は × のアイコンで、名前はツールチップと aria-label に出す", async () => {
    await selectRows(["画面"], async () => {});
    const clear = within(bar()!).getByRole("button", { name: "選択を外す" });
    expect(clear.title).toBe("選択を外す（Esc）");
    expect(clear.textContent).toBe("");
    expect(clear.querySelector("svg")).toBeTruthy();
  });
});
