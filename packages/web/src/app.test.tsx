// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, INFO_NOTICE_MS } from "./app.js";
import { ClientError } from "./client/http.js";
import type { WebviewClient } from "./client/webview.js";
import type { WebviewEvent } from "@deguboard/core";
import { HostBridge, HostProvider, type Host } from "./host.js";
import type { Route } from "./router.js";
import { StoreProvider } from "./store.js";
import { iteration, mockClient, ticket } from "./test-helpers.js";
import { createUiState, memoryBackend } from "./ui-state.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
  window.localStorage.clear();
});

/** Webview に載っているときの Host。見た目の状態はテストごとのメモリ */
function webviewHost(surface: "sidebar" | "panel", open: (route: Route) => void = () => {}): Host {
  return { surface, open, state: createUiState(memoryBackend()) };
}

function mount(client = mockClient(), host?: Host) {
  const app = host ? (
    <HostProvider host={host}>
      <App />
    </HostProvider>
  ) : (
    <App />
  );
  render(<StoreProvider client={client}>{app}</StoreProvider>);
  return client;
}

describe("画面", () => {
  it("カンバンは Workflow の表示名の 4 列で、チケットを Status の列に出す。Iteration がなければ Iteration で絞らず、中止は 0 件なら出さない", async () => {
    mount();
    await screen.findByText("ログイン");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Todo1", "In Progress1", "Code Review0", "Done1"]);
    expect(screen.queryByText("Abandoned")).toBeNull();
    expect(screen.queryByLabelText("abandoned を出す")).toBeNull();
    expect(screen.queryByLabelText("Iteration")).toBeNull();
    expect(screen.getByText("Iteration はない")).toBeTruthy();
    expect(screen.getByText("3 件")).toBeTruthy();
  });

  it("中止のチケットがあるときだけ、畳んだ「中止」の列を完了の右（最後）に出す", async () => {
    const client = mockClient();
    client.data.tickets.push(ticket({ id: "t9", title: "やめた", status: "abandoned" }));
    mount(client);
    await screen.findByText("ログイン");
    const columns = [...document.querySelectorAll<HTMLDetailsElement>(".board > details.column")];
    expect(columns.map((c) => c.dataset.status)).toEqual([
      "todo",
      "in_progress",
      "review",
      "done",
      "abandoned",
    ]);
    const section = columns.at(-1)!;
    expect(section.open).toBe(false);
    expect(section.querySelector("h2")!.textContent).toBe("Abandoned1");
    expect(screen.getByText("3 件")).toBeTruthy();
  });

  it("Iteration の選択肢は planned と active と「Iteration なし」で、既定は active。選ぶとその Iteration のチケットだけになり、ハッシュに残る", async () => {
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s1", name: "最初", status: "active" }),
      iteration({ id: "s2", name: "次", status: "planned" }),
      iteration({ id: "s0", name: "昔", status: "closed" }),
    ];
    client.data.tickets[1]!.iteration = "s1";
    client.data.tickets[2]!.iteration = "s2";
    mount(client);
    await screen.findByText("API");
    const select = screen.getByLabelText<HTMLSelectElement>("Iteration");
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "s1 最初（進行中）",
      "s2 次（予定）",
      "Iteration なし",
    ]);
    expect(select.value).toBe("s1");
    expect(document.querySelector(".iteration-table")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("s1 最初");
    expect(screen.queryByText("画面")).toBeNull();
    fireEvent.change(select, { target: { value: "s2" } });
    expect(window.location.hash).toBe("#/board?iteration=s2");
    await screen.findByText("画面");
    expect(screen.queryByText("API")).toBeNull();
    fireEvent.change(screen.getByLabelText("Iteration"), { target: { value: "-" } });
    await screen.findByText("ログイン");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("Epic の選択肢は open だけ。閉じた Epic は選んでいるときだけ残す", async () => {
    const client = mockClient();
    client.data.epics = [
      ...client.data.epics,
      { ...client.data.epics[0]!, id: "e9", title: "済んだ", status: "closed" },
    ];
    mount(client);
    await screen.findByText("API");
    const options = () =>
      [...screen.getByLabelText("Epic").querySelectorAll("option")].map((o) => o.value);
    expect(options()).not.toContain("e9");
    act(() => {
      window.location.hash = "#/board?epic=e9";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(options()).toContain("e9"));
  });

  it("Epic と担当者で絞れる。旧 ID は @ の前だけを出し、担当者のないものは「なし」", async () => {
    const client = mockClient();
    client.data.tickets[1]!.assignee = "eiki@laptop";
    mount(client);
    await screen.findByText("API");
    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "e1" } });
    expect(window.location.hash).toBe("#/board?epic=e1");
    await waitFor(() => expect(screen.queryByText("ログイン")).toBeNull());
    expect(screen.getByText("API")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "" } });
    await screen.findByText("ログイン");
    const who = screen.getByLabelText("担当");
    expect([...who.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "すべて",
      "eiki",
      "なし",
    ]);
    fireEvent.change(who, { target: { value: "-" } });
    expect(window.location.hash).toBe("#/board?assignee=-");
    await waitFor(() => expect(screen.queryByText("API")).toBeNull());
    expect(screen.getByText("ログイン")).toBeTruthy();
  });

  it("同期の印は未 push と未取り込みを出し、同期ボタンが sync を呼ぶ", async () => {
    const client = mockClient();
    client.data.status = { ...client.data.status, ahead: 2, behind: 1 };
    client.handlers["sync"] = () => ({});
    mount(client);
    expect(await screen.findByText("未 push 2")).toBeTruthy();
    expect(screen.getByText("未取り込み 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "同期" }));
    await waitFor(() => expect(client.calls.some((c) => c.name === "sync")).toBe(true));
  });

  it("リモートがなくても同期ボタンは押せ、sync で照合する", async () => {
    const client = mockClient();
    client.data.status = { ...client.data.status, remote: null };
    client.handlers["sync"] = () => ({});
    mount(client);
    await screen.findByText("同期済み");
    const button = screen.getByRole("button", { name: "同期" });
    expect(button.getAttribute("title")).toContain("リモートがない");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(client.calls.some((c) => c.name === "sync")).toBe(true));
  });

  it("バックログは done を除いて出し、検索で絞れる", async () => {
    window.location.hash = "#/backlog";
    mount();
    await screen.findByText("API");
    expect(screen.queryByText("ログイン")).toBeNull();
    fireEvent.change(screen.getByLabelText("検索"), { target: { value: "web" } });
    expect(screen.queryByText("API")).toBeNull();
    expect(screen.getByText("画面")).toBeTruthy();
  });

  it("チケット詳細は本文と属性を出し、Status の変更は ticket.move を通り、拒否されたら理由を出す", async () => {
    window.location.hash = "#/tickets/t3";
    const client = mockClient();
    client.handlers["ticket.move"] = () => {
      throw new ClientError({ code: "REJECTED", message: "依存先が終わっていない" });
    };
    mount(client);
    await screen.findByRole("heading", { level: 1, name: "画面" });
    expect(screen.getByText("本文")).toBeTruthy();
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("起票者").nextElementSibling?.textContent).toBe("eiki/agent");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "in_progress" } });
    expect((await screen.findByRole("alert")).textContent).toContain("依存先が終わっていない");
    expect(client.calls.at(-1)).toMatchObject({
      name: "ticket.move",
      input: { ticket: "t3", status: "in_progress" },
    });
  });

  it("編集して保存すると ticket.update に属性と本文を渡す", async () => {
    window.location.hash = "#/tickets/t3";
    const client = mockClient();
    client.handlers["ticket.update"] = (input) => input;
    mount(client);
    await screen.findByRole("heading", { level: 1, name: "画面" });
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "新しい題" } });
    fireEvent.change(screen.getByLabelText("ラベル"), { target: { value: "web, ui" } });
    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "e1" } });
    fireEvent.change(screen.getByLabelText("担当"), { target: { value: "eiki/agent" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.calls.some((c) => c.name === "ticket.update")).toBe(true));
    expect(client.calls.find((c) => c.name === "ticket.update")!.input).toMatchObject({
      ticket: "t3",
      title: "新しい題",
      labels: ["web", "ui"],
      epic: "e1",
      iteration: null,
      assignee: "eiki/agent",
    });
  });

  it("サイドバーではチケットのリンクがハッシュ遷移せず、ホストに開いてもらう", async () => {
    window.location.hash = "#/backlog";
    const opened: Route[] = [];
    mount(
      mockClient(),
      webviewHost("sidebar", (route) => opened.push(route)),
    );
    fireEvent.click(await screen.findByText("API"));
    expect(opened).toEqual([{ page: "ticket", id: "t2" }]);
    expect(window.location.hash).toBe("#/backlog");
  });

  it("拡張ホストから reload の event が来ると読み直して表示が変わり、navigate の event でハッシュが変わる", async () => {
    const client = mockClient();
    // 拡張ホストとの接続の代わり。HostBridge が購読した相手に event を送る
    let send: ((event: WebviewEvent) => void) | undefined;
    const bridge: WebviewClient = {
      run: (name, input) => client.run(name, input),
      status: () => client.status(),
      open: async () => {},
      onEvent: (listener) => {
        send = listener;
        return () => (send = undefined);
      },
    };
    render(
      <StoreProvider client={client}>
        <HostProvider host={webviewHost("sidebar")}>
          <HostBridge client={bridge} />
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("ログイン");
    // 別の経路（ターミナルの dg など）でチケットが増えた。本物の読み直しと同じく新しい配列を返す
    client.data.tickets = [...client.data.tickets, ticket({ id: "t9", title: "外で起票した" })];
    expect(screen.queryByText("外で起票した")).toBeNull();
    act(() => send!({ kind: "event", name: "reload" }));
    expect(await screen.findByText("外で起票した")).toBeTruthy();

    act(() => send!({ kind: "event", name: "navigate", hash: "#/backlog" }));
    expect(window.location.hash).toBe("#/backlog");
  });

  it.each(["browser", "panel", "sidebar"] as const)(
    "%s でも完了の節は既定で畳み、ほかの節は開く",
    async (surface) => {
      mount(mockClient(), surface === "browser" ? undefined : webviewHost(surface));
      await screen.findByText("ログイン");
      const columns = [...document.querySelectorAll<HTMLDetailsElement>("details.column")];
      expect(columns.map((c) => [c.dataset.status, c.open])).toEqual([
        ["todo", true],
        ["in_progress", true],
        ["review", true],
        ["done", false],
      ]);
    },
  );

  it("1 行表示は担当者を短く出し、全文はツールチップに。担当者がなければ出さない", async () => {
    const client = mockClient();
    client.data.tickets.push(
      ticket({ id: "t8", title: "AI の作業", assignee: "eiki/agent" }),
      ticket({ id: "t7", title: "古い ID", assignee: "eiki@laptop" }),
    );
    mount(client, webviewHost("sidebar"));
    await screen.findByText("AI の作業");
    const rowOf = (title: string) => screen.getByText(title).closest(".row")!;
    expect(rowOf("AI の作業").querySelector(".row-assignee")).toMatchObject({
      textContent: "eiki/agent",
      title: "eiki/agent",
    });
    expect(rowOf("古い ID").querySelector(".row-assignee")).toMatchObject({
      textContent: "eiki",
      title: "eiki@laptop",
    });
    expect(rowOf("ログイン").querySelector(".row-assignee")).toBeNull();
  });

  it("節の開閉は host.state に残り、開き直しても保たれる", async () => {
    const host = webviewHost("sidebar");
    mount(mockClient(), host);
    await screen.findByText("ログイン");
    const done = document.querySelector<HTMLDetailsElement>('details[data-status="done"]')!;
    expect(done.open).toBe(false);
    done.open = true;
    fireEvent(done, new Event("toggle"));
    expect(host.state.get("board.section.done")).toBe(true);
    cleanup();
    mount(mockClient(), host);
    await screen.findByText("ログイン");
    expect(document.querySelector<HTMLDetailsElement>('details[data-status="done"]')!.open).toBe(
      true,
    );
  });

  it("サイドバーではカンバンの列が折りたためる節になり、チケットは 1 行で出る。空の節は「なし」", async () => {
    mount(mockClient(), webviewHost("sidebar"));
    await screen.findByText("ログイン");
    const app = document.querySelector(".app")!;
    expect(app.getAttribute("data-surface")).toBe("sidebar");
    const columns = [...document.querySelectorAll<HTMLDetailsElement>("details.column")];
    expect(columns).toHaveLength(4);
    expect(columns.map((c) => c.open)).toEqual([true, true, true, false]);
    expect(document.querySelectorAll(".card")).toHaveLength(0);
    expect(document.querySelectorAll(".row-drag .row")).toHaveLength(3);
    expect(screen.getAllByText("なし")).toHaveLength(1);
    expect(screen.queryByText("deguboard")).toBeNull();
  });

  it("サイドバーでは同期の印とボタンを出さない（ビューのタイトル行とバッジで代える）", async () => {
    const client = mockClient();
    client.data.status = { ...client.data.status, ahead: 2 };
    mount(client, webviewHost("sidebar"));
    await screen.findByText("ログイン");
    expect(screen.queryByRole("button", { name: "同期" })).toBeNull();
    expect(screen.queryByText("未 push 2")).toBeNull();
  });

  it("サイドバーではチケット詳細のルートでもバックログを出す（詳細はエディタのパネル）", async () => {
    window.location.hash = "#/tickets/t3";
    mount(mockClient(), webviewHost("sidebar"));
    await screen.findByText("API");
    expect(screen.queryByRole("heading", { level: 1, name: "画面" })).toBeNull();
    expect(document.querySelector("table.list")).toBeNull();
    expect(document.querySelectorAll(".backlog-main ul.rows > li")).toHaveLength(2);
  });

  it("Webview がリンクのクリックを横取りしても（document で preventDefault）、タブを押すとハッシュが変わり aria-current が移る", async () => {
    const intercept = (e: Event) => e.preventDefault();
    document.addEventListener("click", intercept);
    try {
      mount(mockClient(), webviewHost("sidebar"));
      await screen.findByText("ログイン");
      const board = screen.getByRole("link", { name: "カンバン" });
      expect(board.getAttribute("aria-current")).toBe("page");
      fireEvent.click(screen.getByRole("link", { name: "バックログ" }));
      expect(window.location.hash).toBe("#/backlog");
      await screen.findByRole("heading", { level: 1, name: "バックログ" });
      expect(screen.getByRole("link", { name: "バックログ" }).getAttribute("aria-current")).toBe(
        "page",
      );
      expect(board.getAttribute("aria-current")).toBeNull();
    } finally {
      document.removeEventListener("click", intercept);
    }
  });

  it("エディタのパネルのチケットリンクはホストに頼み（同じパネルで遷移して題が変わる）、それ以外のリンクはハッシュ遷移", async () => {
    window.location.hash = "#/backlog";
    const opened: Route[] = [];
    mount(
      mockClient(),
      webviewHost("panel", (route) => opened.push(route)),
    );
    fireEvent.click(await screen.findByText("API"));
    expect(opened).toEqual([{ page: "ticket", id: "t2" }]);
    expect(window.location.hash).toBe("#/backlog");
    fireEvent.click(screen.getByRole("link", { name: "履歴" }));
    expect(window.location.hash).toBe("#/history");
  });

  it("エディタのパネルでチケット詳細を出すときはヘッダー（タブ・Project・同期）を出さない。カンバンでは出す", async () => {
    window.location.hash = "#/tickets/t3";
    mount(mockClient(), webviewHost("panel"));
    await screen.findByRole("heading", { level: 1, name: "画面" });
    expect(screen.queryByRole("navigation", { name: "画面" })).toBeNull();
    expect(screen.queryByRole("button", { name: "同期" })).toBeNull();
    expect(screen.queryByText("deguboard")).toBeNull();
    window.location.hash = "#/board";
    await screen.findByRole("navigation", { name: "画面" });
    expect(screen.getByRole("button", { name: "同期" })).toBeTruthy();
  });

  it("履歴のタブは closed の Iteration を閉じた新しい順に出し、チケットで絞れ、行はホストに開いてもらう", async () => {
    const client = mockClient();
    client.data.iterations = [
      iteration({
        id: "s1",
        name: "最初",
        status: "closed",
        closed_at: "2026-10-10T00:00:00Z",
        completed: 3,
        carried_over: 1,
        start: "2026-09-29",
        end: "2026-10-10",
        goal: "core",
      }),
      iteration({ id: "s2", name: "次", status: "closed", closed_at: "2026-10-24T00:00:00Z" }),
      iteration({ id: "s3", name: "今", status: "active" }),
    ];
    client.data.tickets[0]!.iteration = "s1";
    client.data.tickets[1]!.iteration = "s2";
    const opened: Route[] = [];
    mount(
      client,
      webviewHost("sidebar", (route) => opened.push(route)),
    );
    const tab = await screen.findByRole("link", { name: /履歴/ });
    expect(tab.textContent).toBe("履歴");
    fireEvent.click(tab);
    await screen.findByRole("heading", { level: 1, name: "履歴" });
    const names = () =>
      [...document.querySelectorAll(".history-row .name")].map((e) => e.textContent);
    expect(names()).toEqual(["次", "最初"]);
    expect(screen.getByText("完了 3 ・ 持ち越し 1")).toBeTruthy();
    expect(screen.getByText("2026-09-29 〜 2026-10-10 ・ core")).toBeTruthy();
    // s2 には記録がないので今のチケットから求める（API は in_progress → 持ち越し 1）
    expect(screen.getByText("完了 0 ・ 持ち越し 1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "ログイン" } });
    expect(names()).toEqual(["最初"]);
    expect(screen.getByText("1 / 2 件")).toBeTruthy();
    fireEvent.click(screen.getByText("最初"));
    expect(opened).toEqual([{ page: "iterations", id: "s1" }]);
    expect(window.location.hash).toBe("#/history");
  });

  it("エディタのパネルで Iteration の詳細を出すときもヘッダーを出さない", async () => {
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "最初", status: "closed" })];
    client.handlers["iteration.show"] = () => ({ ...client.data.iterations[0], items: [] });
    window.location.hash = "#/iterations/s1";
    mount(client, webviewHost("panel"));
    await screen.findByRole("heading", { level: 1, name: /s1 最初/ });
    expect(screen.queryByRole("navigation", { name: "画面" })).toBeNull();
  });

  it("ブラウザではチケットのリンクが詳細へのハッシュ遷移のまま", async () => {
    window.location.hash = "#/backlog";
    mount();
    const link = (await screen.findByText("API")).closest("a")!;
    expect(link.getAttribute("href")).toBe("#/tickets/t2");
  });

  it("サイドバーのバックログは検索と件数だけ出し、絞り込みは畳む。効いている条件は見出しに出る", async () => {
    window.location.hash = "#/backlog";
    const host = webviewHost("sidebar");
    mount(mockClient(), host);
    await screen.findByText("API");
    expect(screen.getByLabelText("検索")).toBeTruthy();
    expect(screen.getByText("2 件")).toBeTruthy();
    const fold = document.querySelector<HTMLDetailsElement>("details.filters")!;
    expect(fold.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /最初の版/ }));
    expect(fold.querySelector("summary")!.textContent).toContain("Epic: e1");
    expect(document.querySelector(".toolbar > .muted")!.textContent).toBe("1 件");
    fold.open = true;
    fireEvent(fold, new Event("toggle"));
    expect(host.state.get("backlog.filters")).toBe(true);
  });

  it("サイドバーのバックログの Epic の欄は折りたため、作成フォームは「+」を押したときだけ開く", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.handlers["epic.create"] = (input) => input;
    const host = webviewHost("sidebar");
    mount(client, host);
    await screen.findByText("最初の版");
    const fold = document.querySelector<HTMLDetailsElement>("details.epic-panel")!;
    fold.open = false;
    fireEvent(fold, new Event("toggle"));
    expect(host.state.get("backlog.epics")).toBe(false);
    expect(screen.queryByLabelText("新しい Epic の題")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Epic を作る" }));
    expect(host.state.get("backlog.epics")).toBe(true);
    fireEvent.change(screen.getByLabelText("新しい Epic の題"), { target: { value: "次" } });
    fireEvent.click(screen.getByRole("button", { name: "作る" }));
    await waitFor(() => expect(client.calls.some((c) => c.name === "epic.create")).toBe(true));
    await waitFor(() => expect(screen.queryByLabelText("新しい Epic の題")).toBeNull());
  });

  it("サイドバーの Epic 詳細はチケットを 1 行で出し、「外す」が行の右に出る", async () => {
    window.location.hash = "#/epics/e1";
    const client = mockClient();
    client.handlers["epic.show"] = () => ({
      ...client.data.epics[0],
      body: "",
      tickets: client.data.tickets.filter((t) => t.epic === "e1"),
    });
    mount(client, webviewHost("sidebar"));
    await screen.findByRole("button", { name: "外す" });
    expect(document.querySelectorAll(".card")).toHaveLength(0);
    expect(document.querySelectorAll("ul.rows .row")).toHaveLength(1);
  });

  it("info の通知（コマンドの警告）は数秒で消える", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = mockClient();
    client.handlers["sync"] = () => ({});
    mount(client);
    await screen.findByText("ログイン");
    // 警告つきの応答。mockClient の handlers は data しか返せないので run を差し替える
    const original = client.run.bind(client);
    client.run = (async (name: string, input?: unknown) =>
      name === "sync"
        ? { data: {}, warnings: ["push できない: offline"] }
        : original(name, input)) as typeof client.run;
    fireEvent.click(screen.getByRole("button", { name: "同期" }));
    expect((await screen.findByText(/push できない/)).closest(".notice")!.className).toBe(
      "notice info",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INFO_NOTICE_MS + 100);
    });
    expect(document.querySelector(".notice")).toBeNull();
  });

  it("最初の読み込みが終わるまで「読み込み中…」を出し、空の Project では終わってから空状態になる", async () => {
    const client = mockClient();
    client.data.tickets = [];
    mount(client);
    expect(screen.getByText("読み込み中…")).toBeTruthy();
    expect(screen.queryByText("Iteration はない")).toBeNull();
    await screen.findByText("Iteration はない");
    expect(screen.queryByText("読み込み中…")).toBeNull();
  });

  it("タブはカンバン・バックログ・履歴の 3 つ。#/epics はバックログとして開き、Epic の詳細ではバックログのタブを選ぶ", async () => {
    window.location.hash = "#/epics";
    const client = mockClient();
    client.handlers["epic.show"] = () => ({ ...client.data.epics[0], body: "", tickets: [] });
    mount(client);
    await screen.findByRole("heading", { level: 1, name: "バックログ" });
    const tabs = () => screen.getByRole("navigation", { name: "画面" });
    expect([...tabs().querySelectorAll("a")].map((a) => a.textContent)).toEqual([
      "カンバン",
      "バックログ",
      "履歴",
    ]);
    window.location.hash = "#/epics/e1";
    await screen.findByRole("heading", { level: 1, name: /e1 最初の版/ });
    expect(tabs().querySelector("[aria-current=page]")!.textContent).toBe("バックログ");
  });

  it("バックログの Epic の欄は open の Epic の進捗と「Epic なし」の件数を出し、押すと絞り、もう一度押すと解除する", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.epics = [
      ...client.data.epics,
      { ...client.data.epics[0]!, id: "e9", title: "済んだ", status: "closed" },
    ];
    mount(client);
    await screen.findByText("API");
    expect(screen.queryByLabelText("Epic")).toBeNull();
    expect(screen.queryByText("済んだ")).toBeNull();
    expect(screen.getByText("0/1")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Epic なし/ }).textContent).toContain("1 件");
    const pick = screen.getByRole("button", { name: /最初の版/ });
    fireEvent.click(pick);
    expect(pick.getAttribute("aria-pressed")).toBe("true");
    const count = () => document.querySelector(".toolbar > .muted")!.textContent;
    expect(count()).toBe("1 件");
    expect(screen.queryByText("画面")).toBeNull();
    fireEvent.click(pick);
    expect(count()).toBe("2 件");
    fireEvent.click(screen.getByRole("button", { name: /Epic なし/ }));
    expect(screen.getByText("画面")).toBeTruthy();
    expect(screen.queryByText("API")).toBeNull();
  });

  it("バックログは Iteration の区画に分かれ、見出しから開始・閉じる、「Iteration なし」から作成できる。Iteration のセレクトはない", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s1", name: "今", status: "active", start: "2026-11-01", goal: "画面" }),
      iteration({ id: "s2", name: "次", status: "planned" }),
    ];
    client.data.tickets[1]!.iteration = "s1";
    for (const name of ["iteration.start", "iteration.close", "iteration.create"])
      client.handlers[name] = (input) => input;
    mount(client);
    await screen.findByText("API");
    expect(screen.queryByLabelText("Iteration")).toBeNull();
    const sections = [...document.querySelectorAll(".backlog-section")];
    expect(sections.map((e) => e.querySelector("header")!.textContent)).toEqual([
      "s1 今進行中1 件閉じる2026-11-01 〜 ? ・ 画面",
      "s2 次予定0 件開始する閉じる",
      "Iteration なし1 件+ Iteration を作る",
    ]);
    expect(sections[1]!.querySelector("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "開始する" }));
    await waitFor(() =>
      expect(client.calls.find((c) => c.name === "iteration.start")?.input).toEqual({
        iteration: "s2",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "+ Iteration を作る" }));
    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "その次" } });
    fireEvent.click(screen.getByRole("button", { name: "作る" }));
    await waitFor(() => expect(client.calls.some((c) => c.name === "iteration.create")).toBe(true));
  });

  it("サイドバーのバックログの区画は折りたたみの節で、開閉が host.state に残る", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "今", status: "active" })];
    const host = webviewHost("sidebar");
    mount(client, host);
    await screen.findByText("API");
    const fold = document.querySelector<HTMLDetailsElement>("details.backlog-section")!;
    expect(fold.open).toBe(true);
    fold.open = false;
    fireEvent(fold, new Event("toggle"));
    expect(host.state.get("backlog.section.s1")).toBe(false);
  });

  it("バックログの Epic の欄の「+」から Epic を作る", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.handlers["epic.create"] = (input) => input;
    mount(client);
    await screen.findByText("API");
    fireEvent.click(screen.getByRole("button", { name: "Epic を作る" }));
    fireEvent.change(screen.getByLabelText("新しい Epic の題"), { target: { value: "次" } });
    fireEvent.click(screen.getByRole("button", { name: "作る" }));
    await waitFor(() =>
      expect(client.calls.find((c) => c.name === "epic.create")?.input).toMatchObject({
        title: "次",
      }),
    );
  });

  it("サイドバーの Epic の欄の番号はホストに頼んで詳細を開く", async () => {
    window.location.hash = "#/backlog";
    const opened: Route[] = [];
    mount(
      mockClient(),
      webviewHost("sidebar", (route) => opened.push(route)),
    );
    await screen.findByText("最初の版");
    fireEvent.click(document.querySelector(".epic-list a")!);
    expect(opened).toEqual([{ page: "epics", id: "e1" }]);
    expect(window.location.hash).toBe("#/backlog");
  });

  it("エディタのパネルで Epic の詳細を出すときもヘッダーを出さない", async () => {
    window.location.hash = "#/epics/e1";
    const client = mockClient();
    client.handlers["epic.show"] = () => ({ ...client.data.epics[0], body: "", tickets: [] });
    mount(client, webviewHost("panel"));
    await screen.findByRole("heading", { level: 1, name: /e1 最初の版/ });
    expect(screen.queryByRole("navigation", { name: "画面" })).toBeNull();
  });
});
