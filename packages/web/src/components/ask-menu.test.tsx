// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import type { WebviewEvent } from "@deguboard/core";
import type { WebviewClient } from "../client/webview.js";
import { HostBridge, HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import {
  boardFixture,
  fixture,
  iteration,
  mockClient,
  plan,
  ticket,
  type MockClient,
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
  }: { surface?: Host["surface"]; state?: UiState } = {},
) {
  const host: Host = { surface, open: () => {}, show: () => {}, copy: async () => {}, state };
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
  it("行・状態の節の見出し・Iteration の見出し・Plan の帯に吹き出しを置き、右クリックの文脈に対象・候補・おすすめを載せる", async () => {
    mount(boardClient());
    await screen.findByText("画面");
    // 行（todo で着手できる t3）
    const row = screen.getByText("画面").closest("[data-ask-spot]")!;
    await waitFor(() => expect(contextOf(row)["askActions"]).toBeDefined());
    expect(contextOf(row)).toEqual({
      webviewSection: "boardTicket",
      askTargets: "t3",
      askActions: "work plan fix split check abandon free",
      askRecommended: "work",
      preventDefaultContextMenuItems: true,
    });
    expect(within(row as HTMLElement).getByRole("button", { name: /行 t3/ })).toBeTruthy();
    // 状態の節の見出し（in_progress の節は中のチケットをまとめて）
    const section = document.querySelector('.column[data-status="in_progress"] > summary')!;
    await waitFor(() => expect(contextOf(section)["askRecommended"]).toBe("resume"));
    expect(contextOf(section)).toMatchObject({ webviewSection: "boardHeading", askTargets: "t2" });
    // 空の節（review）は頼む対象がないので出さない
    expect(
      document
        .querySelector('.column[data-status="review"] > summary')!
        .hasAttribute("data-vscode-context"),
    ).toBe(false);
    // Iteration の見出しと Plan の帯
    const head = document.querySelector(".sidebar-head .head-line.sub")!;
    await waitFor(() => expect(contextOf(head)["askRecommended"]).toBe("plan"));
    expect(contextOf(head)).toMatchObject({ webviewSection: "boardHeading", askTargets: "s0" });
    expect(bubble("Iteration の見出し s0")).toBeTruthy();
    const band = document.querySelector(".plan-row")!;
    await waitFor(() => expect(contextOf(band)["askRecommended"]).toBe("approve"));
    expect(bubble("Plan の帯 p7")).toBeTruthy();
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
    // 呼んだ行の吹き出しに戻る（次の Tab で行の続きへ進める）
    expect(document.activeElement).toBe(bubble("行 t3"));
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

  it("行・区画の見出し（Iteration と Iteration なし）・Epic の札から頼め、札には吹き出しを置かない", async () => {
    window.location.hash = "#/backlog";
    mount(backlogClient());
    await screen.findByText("入った");
    // 行：planned の Iteration の todo は計画を立てるがおすすめ
    fireEvent.click(bubble("行 t4"));
    await waitFor(() => expect(items()[0]).toBe("計画を立てるおすすめ"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    // 区画の見出し（「Iteration なし」は中のチケットをまとめて。in_progress と todo が混ざるので点検する）
    const sections = [...document.querySelectorAll(".sidebar-section > summary")];
    await waitFor(() =>
      expect(sections.map((s) => contextOf(s)["askRecommended"])).toEqual(["plan", "check"]),
    );
    expect(sections.map((s) => contextOf(s)["askTargets"])).toEqual(["s1", "t2 t3"]);
    expect(contextOf(sections[0]!)["webviewSection"]).toBe("backlogHeading");
    // Epic の札は右クリックと Shift+F10 だけ
    const chip = screen.getByRole("button", { name: /^e1/ });
    expect(contextOf(chip)).toMatchObject({ webviewSection: "epicChip", askTargets: "e1" });
    expect(screen.queryByRole("button", { name: "エージェントに頼む（Epic の札 e1）" })).toBeNull();
    chip.focus();
    fireEvent.keyDown(chip, { key: "F10", shiftKey: true });
    await waitFor(() => expect(items()[0]).toBe("起票して e1 に足すおすすめ"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "チケットを足す・外す" }));
    // 一覧を選んでも札の絞り込みは押されない
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("履歴のチケットの行と Iteration の行から頼める", async () => {
    const client = mockClient(
      fixture({
        iterations: [iteration({ id: "s1", name: "終わった週", status: "closed" })],
        tickets: [ticket({ id: "t1", title: "終えた", status: "done", iteration: "s1" })],
      }),
    );
    window.location.hash = "#/history";
    mount(client);
    await screen.findByText("終わった週");
    fireEvent.click(bubble("Iteration s1"));
    await waitFor(() => expect(items()[0]).toBe("振り返るおすすめ"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    const spot = screen.getByText("終わった週").closest("[data-ask-spot]")!;
    expect(contextOf(spot)["webviewSection"]).toBe("historyRow");

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
    // 右クリックのサブメニューから選んだのと同じ：action つきの ask の event
    act(() => send!({ kind: "event", name: "ask", targets: ["t3"], action: "split" }));
    await waitFor(() => expect(pressed()).toBe("分ける"));
    // review に変わると「分ける」は候補にないので、おすすめ（確かめて片付ける）に戻る
    client.data.tickets = client.data.tickets.map((t) =>
      t.id === "t3" ? { ...t, status: "review" } : t,
    );
    act(() => send!({ kind: "event", name: "reload" }));
    await waitFor(() => expect(pressed()).toBe("★確かめて片付ける"));
  });
});
