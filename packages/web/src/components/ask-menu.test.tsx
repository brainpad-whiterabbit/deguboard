// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import type { WebviewEvent } from "@deguboard/core";
import type { WebviewClient } from "../client/webview.js";
import { HostBridge, HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import {
  type MockClient,
  boardFixture,
  fixture,
  iteration,
  iterationDetail,
  mockClient,
  plan,
  ticket,
} from "../test-helpers.js";
import { createUiState, memoryBackend, type UiState } from "../ui-state.js";
import { ASK_HINT, ASK_HINT_KEY } from "./ask-menu.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function mount(
  client: MockClient,
  {
    surface = "sidebar",
    state = createUiState(memoryBackend({ [ASK_HINT_KEY]: true })),
    copied = [],
  }: { surface?: Host["surface"]; state?: UiState; copied?: string[] } = {},
) {
  const host: Host = {
    surface,
    open: () => {},
    show: () => {},
    copy: async (text) => void copied.push(text),
    state,
  };
  return render(
    <StoreProvider client={client}>
      <HostProvider host={host}>
        <App />
      </HostProvider>
    </StoreProvider>,
  );
}

const contextOf = (el: Element) =>
  JSON.parse(el.getAttribute("data-vscode-context")!) as Record<string, unknown>;
/** 吹き出しのボタン（名前は「エージェントに頼む（場所）」） */
const bubble = (place: string) =>
  screen.getByRole("button", { name: `エージェントに頼む（${place}）` });
const menu = () => screen.getByRole("menu");
const items = () =>
  within(menu())
    .getAllByRole("menuitem")
    .map((b) => b.textContent);
const composer = () => screen.getByRole("region", { name: "エージェントに頼む" });
const pressed = () =>
  within(within(composer()).getByRole("group", { name: "頼むこと" }))
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-pressed") === "true")?.textContent;

function boardClient(): MockClient {
  const client = mockClient(boardFixture());
  client.data.plans.push(plan({ id: "p7", tickets: ["t3"], pending_approval: true }));
  return client;
}

describe("左パネルのカンバンから頼む（UI-15）", () => {
  it("行・状態の節の見出し・Iteration の見出し・Plan の帯に吹き出しを置き、右クリックの文脈には頼む対象・候補・おすすめを載せない", async () => {
    mount(boardClient());
    await screen.findByText("画面");
    const recommended = async (place: string) => {
      fireEvent.click(bubble(place));
      await waitFor(() => expect(items()[0]).toMatch(/おすすめ$/));
      const first = items()[0];
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      return first;
    };
    // 行（todo で着手できる t3）。既定の右クリックのメニューだけを止める
    const row = screen.getByText("画面").closest("[data-ask-spot]")!;
    expect(contextOf(row)).toEqual({ preventDefaultContextMenuItems: true });
    expect(await recommended("行 t3")).toBe("進めるおすすめ");
    // 状態の節の見出し（in_progress の節は中のチケットをまとめて）
    const section = document.querySelector('.column[data-status="in_progress"] > summary')!;
    expect(contextOf(section)).toEqual({ preventDefaultContextMenuItems: true });
    expect(await recommended("状態の節 In Progress")).toBe("再開するおすすめ");
    // 空の節（review）は頼む対象がないので出さない
    expect(
      document
        .querySelector('.column[data-status="review"] > summary')!
        .hasAttribute("data-vscode-context"),
    ).toBe(false);
    // Iteration の見出しと Plan の帯
    const head = document.querySelector(".sidebar-head .head-line.sub")!;
    expect(contextOf(head)).toEqual({ preventDefaultContextMenuItems: true });
    expect(await recommended("Iteration の見出し s0")).toBe("計画を立てるおすすめ");
    expect(await recommended("Plan の帯 p7")).toBe("承認するおすすめ");
  });

  it("出ている場所の候補は 1 回の ask-menu でまとめて引き、一覧が読み直されたら引き直す", async () => {
    const client = boardClient();
    mount(client);
    await screen.findByText("画面");
    const askMenus = () => client.calls.filter((c) => c.name === "ask-menu");
    await waitFor(() => expect(askMenus().length).toBeGreaterThan(0));
    const sets = askMenus().flatMap((c) => (c.input as { sets: string[] }).sets);
    expect(new Set(sets)).toEqual(new Set(["t1", "t2", "t3", "s0", "p7"]));
    // 同じ組を重ねて引かない
    expect(sets.length).toBe(new Set(sets).size);
  });

  it("吹き出しを押すと頼むことの一覧が直接出て、場所の名前の下に、おすすめを先頭に並べる。選ぶと入力欄をその頼むことで開く", async () => {
    mount(boardClient());
    await screen.findByText("画面");
    fireEvent.click(bubble("行 t3"));
    await waitFor(() => expect(items()[0]).toBe("進めるおすすめ"));
    expect(within(menu()).getByText("行 t3")).toBeTruthy();
    expect(items()).toEqual([
      "進めるおすすめ",
      "計画を立てる",
      "直す",
      "分ける",
      "点検する",
      "やめる",
      "自由に",
    ]);
    // 先頭の項目にフォーカスを置く
    expect(document.activeElement?.textContent).toBe("進めるおすすめ");
    // 一覧を開いている間は吹き出しを出し続ける
    expect(screen.getByText("画面").closest("[data-ask-spot]")!.getAttribute("data-ask-spot")).toBe(
      "active",
    );
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "分ける" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(pressed()).toBe("分ける"));
    expect(within(composer()).getByRole("button", { name: "t3 を外す" })).toBeTruthy();
    // 入力欄の対象になった行は選んだ印のまま
    expect(screen.getByText("画面").closest("[data-ask-spot]")!.getAttribute("data-ask-spot")).toBe(
      "active",
    );
  });

  it("吹き出しと Shift+F10 の一覧で頼むことを選ぶと、開くと同時にその依頼文をコピーして「コピーしました」を出す（t340）", async () => {
    const copied: string[] = [];
    mount(boardClient(), { copied });
    await screen.findByText("画面");
    // 吹き出し
    fireEvent.click(bubble("行 t3"));
    await waitFor(() => expect(items()[0]).toBe("進めるおすすめ"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "分ける" }));
    await waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toBe("/dgimport t3\nt3 を分けて");
    await waitFor(() =>
      expect(within(composer()).getByRole("status").textContent).toContain("コピーしました"),
    );
    fireEvent.click(within(composer()).getByRole("button", { name: "閉じる" }));
    // Shift+F10
    const link = screen.getByText("画面").closest("a")!;
    link.focus();
    fireEvent.keyDown(link, { key: "F10", shiftKey: true });
    await waitFor(() => expect(items()[0]).toBe("進めるおすすめ"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "点検する" }));
    await waitFor(() => expect(copied).toHaveLength(2));
    expect(copied[1]).toBe("/dgcheck t3");
    await waitFor(() =>
      expect(within(composer()).getByRole("status").textContent).toContain("コピーしました"),
    );
  });

  it("行にフォーカスがあるとき Shift+F10 で同じ一覧を出し、↑↓ で動き、Esc で閉じて戻る", async () => {
    mount(boardClient());
    await screen.findByText("画面");
    const link = screen.getByText("画面").closest("a")!;
    link.focus();
    fireEvent.keyDown(link, { key: "F10", shiftKey: true });
    await waitFor(() => expect(items()[0]).toBe("進めるおすすめ"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("計画を立てる");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe("自由に");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    // 呼んだ行のリンクに戻る（そのまま ↑↓ で行を移れる）
    expect(document.activeElement).toBe(link);
  });

  it("見出しの吹き出しを押しても節は開閉しない。外を押すと一覧を閉じる", async () => {
    mount(boardClient());
    await screen.findByText("画面");
    const details = document.querySelector<HTMLDetailsElement>(
      '.column[data-status="in_progress"]',
    )!;
    const before = details.open;
    fireEvent.click(bubble("状態の節 In Progress"));
    await waitFor(() => expect(items()[0]).toBe("再開するおすすめ"));
    expect(details.open).toBe(before);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("左パネルのバックログと履歴から頼む（UI-15）", () => {
  function backlogClient(): MockClient {
    const client = mockClient(
      fixture({
        iterations: [iteration({ id: "s1", name: "来週", status: "planned" })],
      }),
    );
    client.data.tickets.push(ticket({ id: "t4", title: "入った", iteration: "s1" }));
    return client;
  }

  it("行・区画の見出し（Iteration と Iteration なし）から頼め、Epic の札からは頼めない", async () => {
    window.location.hash = "#/backlog";
    mount(backlogClient());
    await screen.findByText("入った");
    // 行：planned の Iteration の todo は計画を立てるがおすすめ。バックログの行は「詳細を開く」「ID をコピー」の文脈だけ載せる
    const row = screen.getByText("入った").closest("li")!;
    expect(contextOf(row)).toEqual({
      webviewSection: "backlogTicket",
      ticket: "t4",
      preventDefaultContextMenuItems: true,
    });
    fireEvent.click(bubble("行 t4"));
    await waitFor(() => expect(items()[0]).toBe("計画を立てるおすすめ"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    // 区画の見出し（「Iteration なし」は中のチケットをまとめて。in_progress と todo が混ざるので点検する）
    fireEvent.click(bubble("区画の見出し s1"));
    await waitFor(() => expect(items()[0]).toBe("計画を立てるおすすめ"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(bubble("区画の見出し Iteration なし"));
    await waitFor(() => expect(items()[0]).toBe("点検するおすすめ"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    // Epic の札は頼む入口にしない（吹き出しも、右クリックの文脈も、Shift+F10 もない）
    const chip = screen.getByRole("button", { name: /^e1/ });
    expect(chip.hasAttribute("data-vscode-context")).toBe(false);
    expect(chip.hasAttribute("data-ask-spot")).toBe(false);
    expect(screen.queryByRole("button", { name: "エージェントに頼む（Epic の札 e1）" })).toBeNull();
    chip.focus();
    fireEvent.keyDown(chip, { key: "F10", shiftKey: true });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("履歴のチケットの行と Iteration の行から頼める", async () => {
    const client = mockClient(
      fixture({
        iterations: [
          iteration({ id: "s1", name: "終わった週", goal: "終わった週", status: "closed" }),
        ],
        tickets: [ticket({ id: "t1", title: "終えた", status: "done", iteration: "s1" })],
      }),
    );
    window.location.hash = "#/history";
    mount(client);
    await screen.findByText("終わった週");
    fireEvent.click(bubble("Iteration s1"));
    await waitFor(() => expect(items()[0]).toBe("振り返るおすすめ"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    window.location.hash = "#/history?view=ticket";
    await screen.findByText("終えた");
    fireEvent.click(bubble("行 t1"));
    await waitFor(() => expect(items()[0]).toBe("不具合・続きを起票するおすすめ"));
  });
});

describe("初めての案内（UI-15）", () => {
  it("左パネルを初めて開いたときに出し、× で消すと見た目の状態に残してもう出さない。ブラウザでは出さない", async () => {
    const state = createUiState(memoryBackend());
    const view = mount(mockClient(boardFixture()), { state });
    await screen.findByText("画面");
    expect(screen.getByText(ASK_HINT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "案内を閉じる" }));
    expect(screen.queryByText(ASK_HINT)).toBeNull();
    expect(state.get(ASK_HINT_KEY)).toBe(true);
    view.unmount();
    mount(mockClient(boardFixture()), { state });
    await screen.findByText("画面");
    expect(screen.queryByText(ASK_HINT)).toBeNull();
    cleanup();

    mount(mockClient(boardFixture()), {
      surface: "browser",
      state: createUiState(memoryBackend()),
    });
    await screen.findByText("画面");
    expect(screen.queryByText(ASK_HINT)).toBeNull();
  });
});

describe("入力欄を頼むことを選んで開く", () => {
  it("選んだ頼むことが開いた後に候補から外れたら（Status が変わったなど）、おすすめに戻す", async () => {
    const client = mockClient(boardFixture());
    let send: ((event: WebviewEvent) => void) | undefined;
    const bridge: WebviewClient = {
      run: (name, input) => client.run(name, input),
      status: () => client.status(),
      open: async () => {},
      show: async () => {},
      copy: async () => {},
      terminals: async () => [],
      sendToTerminal: async () => null,
      openWorktree: async () => {},
      openDiff: async () => {},
      onEvent: (listener) => {
        send = listener;
        return () => (send = undefined);
      },
    };
    const host: Host = {
      surface: "sidebar",
      open: () => {},
      show: () => {},
      copy: async () => {},
      state: createUiState(memoryBackend({ [ASK_HINT_KEY]: true })),
    };
    render(
      <StoreProvider client={client}>
        <HostProvider host={host}>
          <HostBridge client={bridge} />
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("画面");
    // 行の吹き出しの一覧から「分ける」を選んで開く
    fireEvent.click(bubble("行 t3"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: /分ける/ }));
    await waitFor(() => expect(pressed()).toBe("分ける"));
    // review に変わると「分ける」は候補にないので、おすすめ（確かめて片付ける）に戻る
    client.data.tickets = client.data.tickets.map((t) =>
      t.id === "t3" ? { ...t, status: "review" } : t,
    );
    act(() => send!({ kind: "event", name: "reload" }));
    await waitFor(() => expect(pressed()).toBe("★確かめて片付ける"));
  });
});

describe("案内と失敗の扱い（見直しの指摘）", () => {
  it("初めての案内は頼める場所のない設定画面には出さず、カンバンに移ると出す", async () => {
    window.location.hash = "#/config";
    mount(mockClient(boardFixture()), { state: createUiState(memoryBackend()) });
    await screen.findByRole("link", { name: "カンバン" });
    await waitFor(() => expect(document.querySelector(".page")!.textContent).not.toBe(""));
    expect(screen.queryByText(ASK_HINT)).toBeNull();
    act(() => {
      window.location.hash = "#/board";
    });
    await screen.findByText("画面");
    expect(screen.getByText(ASK_HINT)).toBeTruthy();
  });

  it("ask-menu の呼び出しが丸ごと失敗したら、一覧に「読み込み中…」を残さず理由を出す", async () => {
    const client = mockClient(boardFixture());
    client.handlers["ask-menu"] = () => {
      throw new Error("拡張ホストに届かない");
    };
    mount(client);
    await screen.findByText("画面");
    await waitFor(() => expect(client.calls.some((c) => c.name === "ask-menu")).toBe(true));
    fireEvent.click(bubble("行 t3"));
    await waitFor(() => expect(within(menu()).getByText(/拡張ホストに届かない/)).toBeTruthy());
    expect(within(menu()).queryByText("読み込み中…")).toBeNull();
    expect(within(menu()).queryAllByRole("menuitem")).toHaveLength(0);
  });
});

describe("パネルの詳細から頼む（UI-15）", () => {
  /** s1（active）に t3（todo）と t1（done）を入れた fixture。Iteration の詳細は iteration.show で中のチケットを返す */
  function detailClient(): MockClient {
    const data = fixture({
      iterations: [iteration({ id: "s1", name: "最初", status: "active" })],
    });
    data.tickets = data.tickets.map((t) =>
      t.id === "t3" || t.id === "t1" ? { ...t, iteration: "s1" } : t,
    );
    const client = mockClient(data);
    client.handlers["iteration.show"] = () =>
      iterationDetail(
        client.data.iterations[0]!,
        client.data.tickets.filter((t) => t.iteration === "s1"),
      );
    client.handlers["epic.show"] = () => ({
      ...client.data.epics[0],
      body: "",
      tickets: client.data.tickets.filter((t) => t.epic === "e1"),
    });
    return client;
  }
  const askInputs = (client: MockClient) =>
    client.calls.filter((c) => c.name === "ask").map((c) => c.input as Record<string, unknown>);

  it("Iteration の詳細のタイトルの横に吹き出しが常にあり、押すと一覧が出て、選ぶとパネルの下に入力欄が出る", async () => {
    window.location.hash = "#/iterations/s1";
    const client = detailClient();
    mount(client, { surface: "panel" });
    await screen.findByRole("heading", { level: 1 });
    // 吹き出しはマウスを載せなくても出ている（右端に重ねず、タイトルの横に置く）
    expect(bubble("タイトル s1").className).toBe("ask-bubble pinned");
    fireEvent.click(bubble("タイトル s1"));
    await waitFor(() => expect(items()[0]).toBe("計画を立てるおすすめ"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "最後まで進める" }));
    await waitFor(() => expect(pressed()).toBe("最後まで進める"));
    // 対象はその詳細
    expect(within(composer()).getByText("s1")).toBeTruthy();
    await waitFor(() =>
      expect(askInputs(client).at(-1)).toMatchObject({ targets: ["s1"], action: "all" }),
    );
  });

  it("Iteration の詳細の中の行は吹き出しで頼め、候補に「s1 から外す」を含む。終わったチケットには出さない", async () => {
    window.location.hash = "#/iterations/s1";
    const client = detailClient();
    mount(client, { surface: "panel" });
    const row = (await screen.findByText("画面")).closest("li")!;
    expect(contextOf(row)).toEqual({ preventDefaultContextMenuItems: true });
    // 候補は場所（@s1）つきの組でまとめて引く
    const askedSets = () =>
      client.calls
        .filter((c) => c.name === "ask-menu")
        .flatMap((c) => (c.input as { sets: string[] }).sets);
    await waitFor(() => expect(askedSets()).toContain("t3 @s1"));
    fireEvent.click(bubble("行 t3"));
    await waitFor(() => expect(items()).toContain("s1 から外す"));
    expect(items()[0]).toBe("進めるおすすめ");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    // 終わったチケットには出さない
    fireEvent.click(bubble("行 t1"));
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    expect(items()).not.toContain("s1 から外す");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(bubble("行 t3"));
    await waitFor(() => expect(items()).toContain("s1 から外す"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "s1 から外す" }));
    await waitFor(() => expect(pressed()).toBe("s1 から外す"));
    await waitFor(() =>
      expect(askInputs(client).at(-1)).toMatchObject({
        targets: ["t3"],
        within: "s1",
        action: "remove",
      }),
    );
  });

  it("Epic の詳細のタイトルと中の行から頼め、行の候補に「e1 から外す」を含む", async () => {
    window.location.hash = "#/epics/e1";
    const client = detailClient();
    mount(client, { surface: "panel" });
    await screen.findByRole("heading", { level: 1 });
    expect(bubble("タイトル e1").className).toBe("ask-bubble pinned");
    fireEvent.click(bubble("タイトル e1"));
    await waitFor(() => expect(items()[0]).toBe("起票して e1 に足すおすすめ"));
    fireEvent.keyDown(menu(), { key: "Escape" });
    const row = screen.getByText("API").closest("li")!;
    expect(contextOf(row)).toEqual({ preventDefaultContextMenuItems: true });
    fireEvent.click(bubble("行 t2"));
    await waitFor(() => expect(items()).toContain("e1 から外す"));
  });

  it("チケットの詳細のタイトルの横に吹き出しがある", async () => {
    window.location.hash = "#/tickets/t3";
    const client = detailClient();
    mount(client, { surface: "panel" });
    await screen.findByRole("heading", { level: 1, name: "画面" });
    const title = document.querySelector("header[data-ask-spot]")!;
    expect(contextOf(title)).toEqual({ preventDefaultContextMenuItems: true });
    fireEvent.click(bubble("タイトル t3"));
    await waitFor(() => expect(items()[0]).toBe("進めるおすすめ"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "分ける" }));
    await waitFor(() => expect(pressed()).toBe("分ける"));
    await waitFor(() =>
      expect(askInputs(client).at(-1)).toMatchObject({ targets: ["t3"], action: "split" }),
    );
  });
});
