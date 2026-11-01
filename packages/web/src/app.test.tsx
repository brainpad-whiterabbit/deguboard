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
import type { RunView } from "./types.js";
import { createUiState, memoryBackend } from "./ui-state.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
  window.localStorage.clear();
});

/** Webview に載っているときの Host。見た目の状態はテストごとのメモリ */
function webviewHost(
  surface: "sidebar" | "panel",
  open: (route: Route) => void = () => {},
  show: (route: Route) => void = () => {},
): Host {
  return { surface, open, show, state: createUiState(memoryBackend()) };
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

  it("チケット詳細に Run の節を出し、属性の欄に「予定（e3）」を出さない", async () => {
    window.location.hash = "#/tickets/t3";
    const client = mockClient();
    mount(client);
    await screen.findByRole("heading", { level: 1, name: "画面" });
    expect(await screen.findByRole("heading", { level: 2, name: "Run" })).toBeTruthy();
    expect(await screen.findByText("Run はない")).toBeTruthy();
    expect(screen.queryByText("予定（e3）")).toBeNull();
    expect(client.calls.some((c) => c.name === "run.list")).toBe(true);
  });

  it("エディタのパネルのチケット詳細は、編集のボタンをタイトルの行に置き、作成・更新を手元時刻で出し、値のない属性を「なし」の 1 行にまとめる", async () => {
    window.location.hash = "#/tickets/t3";
    mount(mockClient(), webviewHost("panel"));
    const h1 = await screen.findByRole("heading", { level: 1, name: "画面" });
    const edit = screen.getByRole("button", { name: "本文と属性を編集" });
    expect(edit.closest("header")).toBe(h1.closest("header"));
    const created = screen.getByText("作成").nextElementSibling!.querySelector("time")!;
    expect(created.getAttribute("title")).toBe("2026-01-01T00:00:00Z");
    expect(created.textContent).toMatch(/^2026-01-01 \d\d:\d\d$/);
    expect(screen.queryByText("依存先")).toBeNull();
    expect(screen.queryByText("ブランチ")).toBeNull();
    const empty = screen.getByText("なし", { selector: "dt" }).nextElementSibling!;
    expect(empty.textContent).toBe("Epic・Iteration・依存先・依存元・担当・ブランチ・PR");
    // 編集中はすべての属性を出す
    fireEvent.click(edit);
    expect(screen.getByLabelText("Epic")).toBeTruthy();
    expect(screen.queryByText("なし", { selector: "dt" })).toBeNull();
  });

  it("ブラウザのチケット詳細は今のまま（編集は本文の下、作成は ISO、値のない属性も 1 行ずつ）", async () => {
    window.location.hash = "#/tickets/t3";
    mount(mockClient());
    const h1 = await screen.findByRole("heading", { level: 1, name: "画面" });
    expect(screen.getByRole("button", { name: "編集" }).closest("header")).not.toBe(
      h1.closest("header"),
    );
    expect(screen.getByText("作成").nextElementSibling!.textContent).toBe("2026-01-01T00:00:00Z");
    expect(screen.getByText("依存先")).toBeTruthy();
    expect(screen.queryByText("なし", { selector: "dt" })).toBeNull();
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
      show: async () => {},
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

  it.each(["#/tickets/t3", "#/runs"])(
    "拡張ホストから reload の event が来ると、%s の Run を取り直す（ターミナルの dg run start はチケットを変えない）",
    async (hash) => {
      window.location.hash = hash;
      const client = mockClient();
      // 本物の読み直しと同じく、チケットが変わらなくても新しい配列を返す
      client.handlers["ticket.list"] = () => [...client.data.tickets];
      let runs: RunView[] = [];
      client.handlers["run.list"] = () => runs;
      client.handlers["metrics.show"] = () => null;
      let send: ((event: WebviewEvent) => void) | undefined;
      const bridge: WebviewClient = {
        run: (name, input) => client.run(name, input),
        status: () => client.status(),
        open: async () => {},
        show: async () => {},
        onEvent: (listener) => {
          send = listener;
          return () => (send = undefined);
        },
      };
      render(
        <StoreProvider client={client}>
          <HostProvider host={webviewHost("panel")}>
            <HostBridge client={bridge} />
            <App />
          </HostProvider>
        </StoreProvider>,
      );
      await waitFor(() => expect(client.calls.some((c) => c.name === "run.list")).toBe(true));
      const before = client.calls.filter((c) => c.name === "run.list").length;
      runs = [
        {
          id: "r20261101-010000-aaaa",
          ticket: "t3",
          step: "外で始めた step",
          agent: "claude-code",
          model: null,
          started_at: "2026-11-01T01:00:00Z",
          finished_at: null,
          result: null,
          error: null,
          retries: 0,
          usage: { input: null, output: null, cache_read: null, cache_write: null },
          running: true,
          duration_seconds: null,
        } as RunView,
      ];
      expect(screen.queryByText("外で始めた step")).toBeNull();
      act(() => send!({ kind: "event", name: "reload" }));
      expect((await screen.findAllByText("外で始めた step")).length).toBeGreaterThan(0);
      expect(client.calls.filter((c) => c.name === "run.list").length).toBeGreaterThan(before);
    },
  );

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

  it("サイドバーのカンバンで見えている行の担当が 1 人だけなら、行に担当を出さない", async () => {
    const client = mockClient();
    for (const t of client.data.tickets) t.assignee = "eiki/agent";
    mount(client, webviewHost("sidebar"));
    await screen.findByText("ログイン");
    expect(document.querySelectorAll(".row-drag .row")).toHaveLength(3);
    expect(document.querySelector(".row-assignee")).toBeNull();
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

  it("エディタのパネルのチケットリンクはホストに開いてもらい（同じパネルで遷移して題が変わる）、一覧の画面へのリンクはサイドバーに出してもらう", async () => {
    window.location.hash = "#/epics/e1";
    const client = mockClient();
    client.handlers["epic.show"] = () => ({
      ...client.data.epics[0],
      body: "",
      tickets: client.data.tickets.filter((t) => t.epic === "e1"),
    });
    const opened: Route[] = [];
    const shown: Route[] = [];
    mount(
      client,
      webviewHost(
        "panel",
        (route) => opened.push(route),
        (route) => shown.push(route),
      ),
    );
    fireEvent.click(await screen.findByText("API"));
    expect(opened).toEqual([{ page: "ticket", id: "t2" }]);
    fireEvent.click(screen.getByRole("link", { name: "この Epic でカンバンを見る" }));
    expect(shown).toEqual([{ page: "board", epic: "e1" }]);
    expect(window.location.hash).toBe("#/epics/e1");
  });

  it("エディタのパネルはチケット詳細にヘッダー（タブ・Project・同期）を出さない", async () => {
    window.location.hash = "#/tickets/t3";
    mount(mockClient(), webviewHost("panel"));
    await screen.findByRole("heading", { level: 1, name: "画面" });
    expect(screen.queryByRole("navigation", { name: "画面" })).toBeNull();
    expect(screen.queryByRole("button", { name: "同期" })).toBeNull();
    expect(screen.queryByText("deguboard")).toBeNull();
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
    // s2 には閉じたときの記録がないので、web で数え直さず「—」と出す
    expect(screen.getByText("完了 — ・ 持ち越し —")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "ログイン" } });
    expect(names()).toEqual(["最初"]);
    expect(screen.getByText("1 / 2 件")).toBeTruthy();
    fireEvent.click(screen.getByText("s1"));
    expect(opened).toEqual([{ page: "iterations", id: "s1" }]);
    expect(window.location.hash).toBe("#/history");
  });

  it("履歴の Iteration の行に Epic ごとの件数が出て、開くと中の終わったチケットが出る", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "最初", status: "closed" })];
    client.data.tickets[0]!.iteration = "s1";
    client.data.tickets[0]!.epic = "e1";
    client.data.tickets.push(
      ticket({ id: "t4", title: "やめた", status: "abandoned", iteration: "s1", epic: "e1" }),
      ticket({ id: "t5", title: "持ち越し", status: "todo", iteration: "s1" }),
    );
    const opened: Route[] = [];
    mount(
      client,
      webviewHost("sidebar", (route) => opened.push(route)),
    );
    await screen.findByRole("heading", { level: 1, name: "履歴" });
    const row = document.querySelector(".history-row")!;
    expect(row.querySelector("small")!.textContent).toBe("Epic: e1 2");
    const item = document.querySelector<HTMLDetailsElement>("details.history-item")!;
    expect(item.open).toBe(false);
    item.open = true;
    const tickets = [...item.querySelectorAll(".history-tickets li")].map((li) => li.textContent);
    expect(tickets).toEqual(["t1ログインe1", "t4やめたe1"]);
    fireEvent.click(item.querySelector(".history-tickets a")!);
    fireEvent.click(row.querySelector("small a")!);
    expect(opened).toEqual([
      { page: "ticket", id: "t1" },
      { page: "epics", id: "e1" },
    ]);
  });

  it("履歴を Epic の見方に切り替えると、閉じた Epic を閉じた新しい順に出し、見方がハッシュに残る。検索も効く", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    const base = client.data.epics[0]!;
    client.data.epics = [
      base,
      { ...base, id: "e2", title: "古い", status: "closed", closed_at: "2026-10-01T00:00:00Z" },
      { ...base, id: "e3", title: "新しい", status: "closed", closed_at: "2026-10-20T00:00:00Z" },
    ];
    client.data.iterations = [iteration({ id: "s1", name: "最初", status: "closed" })];
    client.data.tickets[0]!.epic = "e3";
    client.data.tickets[0]!.iteration = "s1";
    mount(client);
    await screen.findByRole("heading", { level: 1, name: "履歴" });
    fireEvent.click(screen.getByRole("button", { name: "Epic" }));
    await waitFor(() => expect(window.location.hash).toBe("#/history?view=epic"));
    const names = () =>
      [...document.querySelectorAll(".history-row .name")].map((e) => e.textContent);
    await waitFor(() => expect(names()).toEqual(["新しい", "古い"]));
    expect(screen.getByRole("button", { name: "Epic" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".history-row small")!.textContent).toBe(
      "2026-10-20 に閉じた ・ s1",
    );
    expect(screen.getByRole("link", { name: "s1" }).getAttribute("href")).toBe("#/iterations/s1");
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "t1" } });
    expect(names()).toEqual(["新しい"]);
    expect(screen.getByText("1 / 2 件")).toBeTruthy();
  });

  it("チケット詳細に経過の節があり、変化を時刻の順に出す。エディタのパネルでも出る", async () => {
    window.location.hash = "#/tickets/t2";
    const client = mockClient();
    const base = { kind: "ticket", id: "t2", commit: "c", author: "eiki", subject: "s" };
    client.handlers["history"] = (input) => {
      expect(input).toEqual({ ticket: "t2" });
      return {
        events: [
          {
            ...base,
            commit: "c1",
            type: "created",
            at: "2026-11-01T00:00:00Z",
            changes: [{ field: "status", from: null, to: "todo" }],
          },
          {
            ...base,
            commit: "c2",
            type: "changed",
            at: "2026-11-01T01:00:00Z",
            changes: [
              { field: "status", from: "todo", to: "in_progress" },
              { field: "assignee", from: null, to: "eiki/agent" },
            ],
          },
          {
            ...base,
            commit: "c3",
            type: "changed",
            at: "2026-11-01T02:00:00Z",
            changes: [
              { field: "iteration", from: "s1", to: null },
              { field: "pr", from: null, to: "5" },
            ],
          },
        ],
        shallow: true,
        incomplete: ["t2"],
      };
    };
    mount(client, webviewHost("panel"));
    await screen.findByRole("heading", { level: 2, name: "経過" });
    const items = async () =>
      waitFor(() => {
        const list = [...document.querySelectorAll(".timeline-list li > span:last-child")];
        expect(list).toHaveLength(3);
        return list.map((e) => e.textContent);
      });
    expect(await items()).toEqual([
      "起票 ・ Todo",
      "Todo → In Progress ・ 担当: eiki/agent",
      "Iteration s1 から外した ・ PR #5",
    ]);
    expect(screen.getByText(/これより前の経過は欠けている/)).toBeTruthy();
  });

  it("履歴のチケットの見方は終わったチケットを終えた新しい順に出し、分からないものは更新日で並べてそう出す。結果・Epic・検索で絞れる", async () => {
    window.location.hash = "#/history?view=ticket";
    const client = mockClient();
    client.data.tickets = [
      ticket({ id: "t1", title: "古い", status: "done", epic: "e1", pr: 3, iteration: "s1" }),
      ticket({ id: "t2", title: "新しい", status: "done", labels: ["web"] }),
      ticket({
        id: "t3",
        title: "やめた",
        status: "abandoned",
        updated_at: "2026-10-15T00:00:00Z",
      }),
      ticket({ id: "t4", title: "途中", status: "todo" }),
    ];
    const finished = (id: string, at: string, to = "done") => ({
      kind: "ticket",
      id,
      commit: id,
      author: "a",
      subject: "s",
      type: "changed",
      at,
      changes: [{ field: "status", from: "review", to }],
    });
    client.handlers["history"] = () => ({
      events: [finished("t1", "2026-10-01T00:00:00Z"), finished("t2", "2026-10-20T00:00:00Z")],
      shallow: false,
      incomplete: [],
    });
    mount(client);
    await screen.findByRole("heading", { level: 1, name: "履歴" });
    expect(screen.getByRole("button", { name: "チケット" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    const ids = () =>
      [...document.querySelectorAll(".history-finished li code")].map((e) => e.textContent);
    await waitFor(() => expect(ids()).toEqual(["t2", "t3", "t1"]));
    expect(screen.getByText(/更新日（updated_at）で並べている/)).toBeTruthy();
    const t1 = document.querySelectorAll(".history-finished li")[2]!;
    expect(t1.textContent).toContain("#3");
    expect(t1.querySelector("a[href='#/iterations/s1']")).toBeTruthy();
    expect(t1.querySelector("a[href='#/epics/e1']")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("結果"), { target: { value: "abandoned" } });
    expect(ids()).toEqual(["t3"]);
    fireEvent.change(screen.getByLabelText("結果"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "e1" } });
    expect(ids()).toEqual(["t1"]);
    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "web" } });
    expect(ids()).toEqual(["t2"]);
    expect(screen.getByText("1 / 3 件")).toBeTruthy();
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

  it("エディタのパネルの Epic 詳細はチケットを未完了・完了・中止の段の 1 本の一覧で出し、完了と中止は畳み、0 件の段と戻るリンクは出さない", async () => {
    window.location.hash = "#/epics/e1";
    const client = mockClient();
    client.handlers["epic.show"] = () => ({
      ...client.data.epics[0],
      body: "",
      tickets: [
        ticket({ id: "t2", title: "API", status: "in_progress", epic: "e1" }),
        ticket({ id: "t4", title: "設計", status: "todo", priority: "high", epic: "e1" }),
        ticket({ id: "t5", title: "調査", status: "done", epic: "e1" }),
      ],
    });
    mount(client, webviewHost("panel"));
    await screen.findAllByRole("button", { name: "外す" });
    expect(document.querySelectorAll(".card")).toHaveLength(0);
    expect(document.querySelectorAll(".column")).toHaveLength(0);
    const sections = [...document.querySelectorAll<HTMLDetailsElement>(".epic-tickets > details")];
    expect(sections.map((d) => d.querySelector("summary")!.textContent)).toEqual([
      "未完了 2",
      "完了 1",
    ]);
    expect(sections.map((d) => d.open)).toEqual([true, false]);
    // 段の中は Workflow の Status の順（todo が先）
    expect([...sections[0]!.querySelectorAll(".row code")].map((c) => c.textContent)).toEqual([
      "t4",
      "t2",
    ]);
    expect(screen.queryByRole("link", { name: "← バックログ" })).toBeNull();
  });

  it("ブラウザの Epic 詳細は今のまま Status ごとの列で出し、戻るリンクも出す", async () => {
    window.location.hash = "#/epics/e1";
    const client = mockClient();
    client.handlers["epic.show"] = () => ({
      ...client.data.epics[0],
      body: "",
      tickets: client.data.tickets.filter((t) => t.epic === "e1"),
    });
    mount(client);
    await screen.findByRole("button", { name: "外す" });
    expect(document.querySelectorAll(".column").length).toBeGreaterThan(1);
    expect(document.querySelectorAll(".card")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "← バックログ" })).toBeTruthy();
  });

  it("エディタのパネルの Iteration 詳細は「← カンバン」を出さない", async () => {
    window.location.hash = "#/iterations/s1";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "最初", status: "active" })];
    client.handlers["iteration.show"] = () => ({ ...client.data.iterations[0], items: [] });
    mount(client, webviewHost("panel"));
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("link", { name: "← カンバン" })).toBeNull();
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

  it("タブはカンバン・バックログ・履歴・Run の 4 つ。#/epics はバックログとして開き、Epic の詳細ではバックログのタブを選ぶ", async () => {
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
      "Run",
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

  it("サイドバーの Iteration の見出しは開始・閉じるを「…」に入れ、閉じるは未完了の件数を示す確認を経てから閉じる", async () => {
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "今", status: "active" })];
    client.data.tickets[1]!.iteration = "s1";
    client.data.tickets[2]!.iteration = "s1";
    client.handlers["iteration.close"] = (input) => input;
    mount(client, webviewHost("sidebar"));
    await screen.findByText("API");
    expect(screen.queryByRole("button", { name: "閉じる" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "s1 の操作" }));
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    const confirm = screen.getByRole("group", { name: "s1 今 を閉じる確認" });
    expect(confirm.textContent).toContain("未完了が 2 件ある");
    expect(client.calls.some((c) => c.name === "iteration.close")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));
    expect(screen.queryByRole("group", { name: "s1 今 を閉じる確認" })).toBeNull();
    expect(client.calls.some((c) => c.name === "iteration.close")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "2 件を残して閉じる" }));
    await waitFor(() =>
      expect(client.calls.find((c) => c.name === "iteration.close")?.input).toEqual({
        iteration: "s1",
      }),
    );
  });

  it("エディタのパネルの Epic 詳細の閉じるも確認を経てから閉じる", async () => {
    window.location.hash = "#/epics/e1";
    const client = mockClient();
    client.handlers["epic.show"] = () => ({
      ...client.data.epics[0],
      body: "",
      tickets: client.data.tickets.filter((t) => t.epic === "e1"),
    });
    client.handlers["epic.close"] = (input) => input;
    mount(client, webviewHost("panel"));
    fireEvent.click(await screen.findByRole("button", { name: "閉じる" }));
    expect(screen.getByRole("group", { name: /を閉じる確認/ }).textContent).toContain(
      "未完了が 1 件ある",
    );
    expect(client.calls.some((c) => c.name === "epic.close")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "1 件を残して閉じる" }));
    await waitFor(() => expect(client.calls.some((c) => c.name === "epic.close")).toBe(true));
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
