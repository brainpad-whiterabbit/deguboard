// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import { boardFixture, iteration, mockClient, type MockClient } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { ALL_ITERATIONS } from "../router.js";
import { ASK_HINT_KEY } from "./ask-menu.js";
import { STICKY_BAND_PX } from "./sticky-band.js";

/** jsdom には IntersectionObserver がないので、見張った要素と呼び返しを覚える代わりを置く */
class FakeObserver {
  static all: FakeObserver[] = [];
  readonly targets: Element[] = [];
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit,
  ) {
    FakeObserver.all.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  disconnect() {
    FakeObserver.all = FakeObserver.all.filter((o) => o !== this);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

/** 目印の行が見えているか、上へ抜けたか（下に外れたか）を呼び返しで伝える。rootBounds の上の端は帯の高さの所 */
function scrollTo(state: "visible" | "above" | "below") {
  const observer = FakeObserver.all.at(-1)!;
  const top = STICKY_BAND_PX;
  const bottom = state === "visible" ? top + 10 : state === "above" ? top - 1 : 900;
  act(() =>
    observer.callback(
      [
        {
          isIntersecting: state === "visible",
          boundingClientRect: { top: bottom - 6, bottom } as DOMRectReadOnly,
          rootBounds: { top, bottom: 800 } as DOMRectReadOnly,
        } as IntersectionObserverEntry,
      ],
      observer as unknown as IntersectionObserver,
    ),
  );
}

beforeEach(() => {
  FakeObserver.all = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

function hostOf(surface: Host["surface"]): Host {
  return {
    surface,
    open: () => {},
    show: () => {},
    copy: async () => {},
    state: createUiState(memoryBackend({ [ASK_HINT_KEY]: true })),
  };
}

function mount(client: MockClient) {
  render(
    <StoreProvider client={client}>
      <HostProvider host={hostOf("sidebar")}>
        <App />
      </HostProvider>
    </StoreProvider>,
  );
}

const band = () => document.querySelector<HTMLElement>(".sticky-band-bar");

describe("左パネルのカンバンで見出しが上に抜けたら残す 1 行の帯（UI-2）", () => {
  it("見出しの進みの帯の行を一覧（.page）の中で帯の高さを除いて見張り、上へ抜けたら番号・名前・小さな進みの帯・n/m の帯を出し、見えたら消す。下に外れている間は出さない", async () => {
    mount(mockClient(boardFixture()));
    await screen.findByText("ログイン");
    const observer = FakeObserver.all.at(-1)!;
    expect(observer.targets[0]!.querySelector(".status-band")).toBeTruthy();
    expect(observer.options.root).toBe(document.querySelector(".page"));
    expect(observer.options.rootMargin).toBe(`-${STICKY_BAND_PX}px 0px 0px 0px`);
    // 帯の箱は高さ 0 で一覧の先頭に置き、中身だけを出し入れする（一覧は動かない）
    const box = document.querySelector<HTMLElement>("section > .sticky-band")!;
    expect(box).toBeTruthy();
    expect(band()).toBeNull();

    scrollTo("above");
    expect(band()!.textContent).toBe("s0既定1/3");
    expect(band()!.querySelector(".status-band.short .bar")).toBeTruthy();
    expect(box.contains(band())).toBe(true);

    scrollTo("visible");
    expect(band()).toBeNull();
    scrollTo("below");
    expect(band()).toBeNull();
  });

  it("「すべて」を選んでいるときは、番号の代わりに「すべて」を出して名前は出さず、進みは planned と active の合計", async () => {
    window.location.hash = `#/board?iteration=${ALL_ITERATIONS}`;
    const client = mockClient(
      boardFixture({ iterations: [iteration({ id: "s0", name: "既定", status: "active" })] }),
    );
    client.data.iterations.push(iteration({ id: "s1", name: "次", status: "planned" }));
    client.data.tickets[2] = { ...client.data.tickets[2]!, iteration: "s1" };
    mount(client);
    await screen.findByText("ログイン");
    scrollTo("above");
    expect(band()!.textContent).toBe("すべて1/3");
    expect(band()!.textContent).not.toContain("既定");
    // 「すべて」は頼む対象がないので、頼む場所にしない
    expect(band()!.hasAttribute("data-ask-spot")).toBe(false);
  });

  it("帯の名前を押すと一覧を一番上へ戻す", async () => {
    mount(mockClient(boardFixture()));
    await screen.findByText("ログイン");
    const page = document.querySelector<HTMLElement>(".page")!;
    page.scrollTop = 400;
    scrollTo("above");
    fireEvent.click(within(band()!).getByRole("button", { name: "s0既定" }));
    expect(page.scrollTop).toBe(0);
  });

  it("帯は選んでいる Iteration を頼む場所になり、吹き出しと Shift+F10 で頼む一覧を開く。右クリックは Iteration の詳細・ID のコピー", async () => {
    mount(mockClient(boardFixture()));
    await screen.findByText("ログイン");
    scrollTo("above");
    const bar = band()!;
    expect(JSON.parse(bar.getAttribute("data-vscode-context")!)).toMatchObject({ id: "s0" });
    expect(
      within(bar).getByRole("button", { name: "エージェントに頼む（Iteration の見出し s0）" }),
    );
    fireEvent.keyDown(within(bar).getByRole("button", { name: "s0既定" }), {
      key: "F10",
      shiftKey: true,
    });
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("状態の節の見出しは、貼り付いても頼む場所のままで、押せば節を開閉する", async () => {
    mount(mockClient(boardFixture()));
    await screen.findByText("ログイン");
    scrollTo("above");
    const todo = document.querySelector<HTMLDetailsElement>('details[data-status="todo"]')!;
    const summary = todo.querySelector("summary")!;
    expect(summary.hasAttribute("data-ask-spot")).toBe(true);
    expect(todo.open).toBe(true);
    todo.open = false;
    fireEvent(todo, new Event("toggle"));
    expect(todo.open).toBe(false);
  });
});
