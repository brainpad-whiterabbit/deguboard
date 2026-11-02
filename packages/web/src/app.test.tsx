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
import { fixture, iteration, mockClient, plan, ticket } from "./test-helpers.js";
import type { RunView } from "./types.js";
import { createUiState, memoryBackend } from "./ui-state.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
  window.localStorage.clear();
});

/** surface を指定した Host。見た目の状態はテストごとのメモリ */
function hostOf(
  surface: Host["surface"],
  open: (route: Route) => void = () => {},
  show: (route: Route) => void = () => {},
): Host {
  return { surface, open, show, state: createUiState(memoryBackend()) };
}

/** 実行中の Run（run.list の 1 件） */
function runningRun(ticketId: string): RunView {
  return {
    id: "r20261101-010000-aaaa",
    ticket: ticketId,
    step: "implement",
    agent: "claude-code",
    model: null,
    started_at: "2026-11-01T01:00:00Z",
    finished_at: null,
    result: null,
    error: null,
    retries: 0,
    retry_reasons: [],
    usage: { input: null, output: null, cache_read: null, cache_write: null },
    running: true,
    duration_seconds: null,
  } as RunView;
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

/**
 * 拡張ホストとの接続の代わりを挟んで描く。HostBridge が購読した相手に event を送れるよう、返す関数で event の送り口を取る。
 * 既定は readRunning の左パネル
 */
function mountWithBridge(
  client: ReturnType<typeof mockClient>,
  {
    surface = "sidebar",
    readRunning = true,
  }: { surface?: "sidebar" | "panel"; readRunning?: boolean } = {},
) {
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
    <StoreProvider client={client} readRunning={readRunning}>
      <HostProvider host={hostOf(surface)}>
        <HostBridge client={bridge} />
        <App />
      </HostProvider>
    </StoreProvider>,
  );
  return () => send!;
}

/** 左パネルのカンバンのチケットの行を題で引く（Plan の帯にも同じ題が出るので、行の題と一致するものだけ） */
function kanbanRowOf(title: string): Element {
  return [...document.querySelectorAll(".ticket-row")].find(
    (r) => r.querySelector(".row-title")!.textContent === title,
  )!;
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
    expect(
      client.calls.some(
        (c) => c.name === "run.list" && (c.input as { ticket?: string }).ticket === "t3",
      ),
    ).toBe(true);
  });

  it("エディタのパネルのチケット詳細は、編集のボタンをタイトルの行に置き、作成・更新を手元時刻で出し、値のない属性を「なし」の 1 行にまとめる", async () => {
    window.location.hash = "#/tickets/t3";
    mount(mockClient(), hostOf("panel"));
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

  it("チケット詳細の PR は、リモートの Web の URL があれば PR のページへのリンクにし、なければ番号だけを出す", async () => {
    window.location.hash = "#/tickets/t9";
    const data = fixture({
      tickets: [ticket({ id: "t9", title: "PR あり", pr: 12 })],
      status: { ...fixture().status, web_url: "https://github.com/o/r" },
    });
    mount(mockClient(data));
    const link = await screen.findByRole("link", { name: "#12" });
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/12");
    expect(link.getAttribute("target")).toBe("_blank");
    cleanup();

    window.location.hash = "#/tickets/t9";
    mount(mockClient({ ...data, status: { ...data.status, web_url: null } }));
    await screen.findByRole("heading", { level: 1, name: "PR あり" });
    expect(screen.queryByRole("link", { name: "#12" })).toBeNull();
    expect(screen.getByText("PR").nextElementSibling!.textContent).toBe("#12");
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
      hostOf("sidebar", (route) => opened.push(route)),
    );
    fireEvent.click(await screen.findByText("API"));
    expect(opened).toEqual([{ page: "ticket", id: "t2" }]);
    expect(window.location.hash).toBe("#/backlog");
  });

  it("拡張ホストから reload の event が来ると読み直して表示が変わり、navigate の event でハッシュが変わる", async () => {
    const client = mockClient();
    const send = mountWithBridge(client, { readRunning: false });
    await screen.findByText("ログイン");
    // 別の経路（ターミナルの dg など）でチケットが増えた。本物の読み直しと同じく新しい配列を返す
    client.data.tickets = [...client.data.tickets, ticket({ id: "t9", title: "外で起票した" })];
    expect(screen.queryByText("外で起票した")).toBeNull();
    act(() => send()({ kind: "event", name: "reload" }));
    expect(await screen.findByText("外で起票した")).toBeTruthy();

    act(() => send()({ kind: "event", name: "navigate", hash: "#/backlog" }));
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
      const send = mountWithBridge(client, { surface: "panel", readRunning: false });
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
          retry_reasons: [],
          usage: { input: null, output: null, cache_read: null, cache_write: null },
          running: true,
          duration_seconds: null,
        } as RunView,
      ];
      expect(screen.queryByText("外で始めた step")).toBeNull();
      act(() => send()({ kind: "event", name: "reload" }));
      expect((await screen.findAllByText("外で始めた step")).length).toBeGreaterThan(0);
      expect(client.calls.filter((c) => c.name === "run.list").length).toBeGreaterThan(before);
    },
  );

  it.each(["browser", "panel", "sidebar"] as const)(
    "%s でも完了の節は既定で畳み、ほかの節は開く",
    async (surface) => {
      mount(mockClient(), surface === "browser" ? undefined : hostOf(surface));
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

  it("バックログの 1 行表示は担当者を短く出し、全文はツールチップに。担当者がなければ出さない", async () => {
    const client = mockClient();
    client.data.tickets.push(
      ticket({ id: "t8", title: "AI の作業", assignee: "eiki/agent" }),
      ticket({ id: "t7", title: "古い ID", assignee: "eiki@laptop" }),
    );
    window.location.hash = "#/backlog";
    mount(client, hostOf("sidebar"));
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
    expect(rowOf("画面").querySelector(".row-assignee")).toBeNull();
  });

  it("サイドバーのカンバンの行は担当の名前の列を出さず、右端の上の段（Plan の番号の左）に担当の印を出す。人は頭文字の丸、agent は持ち主の丸と Run の agent の種類のアイコン", async () => {
    const client = mockClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "人", assignee: "eiki" }),
      ticket({ id: "t5", title: "Claude", assignee: "eiki/agent", run_agent: "claude-code" }),
      ticket({ id: "t6", title: "Codex", assignee: "hana/agent", run_agent: "codex" }),
      ticket({ id: "t7", title: "汎用", assignee: "eiki/agent", run_agent: "my-bot" }),
      ticket({ id: "t8", title: "Run なし", assignee: "eiki/agent" }),
    );
    client.data.plans.push(plan({ id: "p7", tickets: ["t5"] }));
    mount(client, hostOf("sidebar"));
    await screen.findByText("Run なし");
    expect(document.querySelector(".row-assignee")).toBeNull();
    const markOf = (title: string) => kanbanRowOf(title).querySelector(".assignee-mark");
    const iconOf = (title: string) =>
      markOf(title)!.querySelector<HTMLElement>(".agent-icon")?.dataset.agent ?? null;
    // 人：頭文字の丸だけ。ホバーで主体 ID
    expect(markOf("人")!.querySelector(".assignee-initial")!.textContent).toBe("E");
    expect(iconOf("人")).toBeNull();
    expect(markOf("人")!.getAttribute("title")).toBe("eiki");
    // agent：持ち主の丸と種類のアイコン。ホバーで主体 ID と Run の agent
    expect(markOf("Claude")!.textContent).toBe("EC");
    expect(iconOf("Claude")).toBe("claude");
    expect(markOf("Claude")!.getAttribute("title")).toBe("eiki/agent · claude-code");
    expect(markOf("Claude")!.getAttribute("aria-label")).toBe("eiki/agent · claude-code");
    expect(markOf("Codex")!.textContent).toBe("HX");
    expect(iconOf("Codex")).toBe("codex");
    expect(iconOf("汎用")).toBe("generic");
    expect(markOf("汎用")!.getAttribute("title")).toBe("eiki/agent · my-bot");
    // Run のない agent は汎用のアイコン
    expect(iconOf("Run なし")).toBe("generic");
    expect(markOf("Run なし")!.getAttribute("title")).toBe("eiki/agent · Run なし");
    // 印は上の段の Plan の番号の左
    const top = kanbanRowOf("Claude").querySelector(".row-end-top")!;
    // （先頭の空のセルは medium の優先度の印の場所）
    expect([...top.children].map((c) => c.className.split(" ")[0]).filter(Boolean)).toEqual([
      "assignee-mark",
      "row-plan",
    ]);
    // 担当なし：印を出さず、右端は今までどおり優先度の印だけ
    expect(markOf("画面")).toBeNull();
    expect(kanbanRowOf("画面").querySelector(".row-end")).toBeNull();
  });

  it("サイドバーのカンバンは、前回の描画から Status が変わった行を点滅させ（開き直しても host.state で比べる）、ブラウザでは点滅させない", async () => {
    const host = hostOf("sidebar");
    const client = mockClient();
    mount(client, host);
    await screen.findByText("画面");
    expect(document.querySelector(".row.changed")).toBeNull();
    cleanup();
    client.data.tickets[2]!.status = "in_progress";
    mount(client, host);
    await waitFor(() =>
      expect(screen.getByText("画面").closest(".row")!.classList.contains("changed")).toBe(true),
    );
    expect(screen.getByText("ログイン").closest(".row")!.classList.contains("changed")).toBe(false);
    cleanup();
    mount(mockClient());
    await screen.findByText("画面");
    expect(document.querySelector(".row.changed")).toBeNull();
  });

  it("節の開閉は host.state に残り、開き直しても保たれる", async () => {
    const host = hostOf("sidebar");
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

  it("サイドバーではカンバンの列が折りたためる節になり、チケットは 1 行で出る。空の節は見出しの 1 行だけで「なし」は出さない", async () => {
    mount(mockClient(), hostOf("sidebar"));
    await screen.findByText("ログイン");
    const app = document.querySelector(".app")!;
    expect(app.getAttribute("data-surface")).toBe("sidebar");
    const columns = [...document.querySelectorAll<HTMLDetailsElement>("details.column")];
    expect(columns).toHaveLength(4);
    expect(columns.map((c) => c.open)).toEqual([true, true, true, false]);
    expect(document.querySelectorAll(".card")).toHaveLength(0);
    expect(document.querySelectorAll(".row-drag .row")).toHaveLength(3);
    const review = document.querySelector<HTMLDetailsElement>('details[data-status="review"]')!;
    expect(review.classList.contains("is-empty")).toBe(true);
    expect(review.querySelector(".rows")).toBeNull();
    expect(review.querySelector(".section-count")!.textContent).toBe("0");
    expect(screen.queryByText("なし")).toBeNull();
    expect(screen.queryByText("deguboard")).toBeNull();
  });

  it("サイドバーの節の件数は、終わった状態（Done）の節だけ塗らずに数字だけにする", async () => {
    mount(mockClient(), hostOf("sidebar"));
    await screen.findByText("ログイン");
    const plain = Object.fromEntries(
      [...document.querySelectorAll<HTMLDetailsElement>("details.column")].map((d) => [
        d.dataset.status,
        d.querySelector(".section-count")!.classList.contains("is-plain"),
      ]),
    );
    expect(plain).toEqual({ todo: false, in_progress: false, review: false, done: true });
  });

  it("サイドバーのカンバンの行は状態の丸印を出さず、優先度の印（high・low）を右に出す。バックログの行は変わらない", async () => {
    const client = mockClient();
    client.data.tickets[2]!.priority = "low";
    mount(client, hostOf("sidebar"));
    await screen.findByText("ログイン");
    const rowOf = (title: string) => screen.getByText(title).closest(".row")!;
    expect(document.querySelectorAll(".board .row .status-dot")).toHaveLength(0);
    expect(rowOf("API").classList.contains("kanban-row")).toBe(true);
    expect(rowOf("API").lastElementChild!.textContent).toBe("high");
    expect(rowOf("画面").lastElementChild!.textContent).toBe("low");
    expect(rowOf("画面").querySelector(".row-low")).toBeTruthy();
    cleanup();
    window.location.hash = "#/backlog";
    mount(client, hostOf("sidebar"));
    await screen.findByText("API");
    expect(rowOf("画面").classList.contains("kanban-row")).toBe(false);
    expect(rowOf("画面").querySelector(".status-dot")).toBeTruthy();
    expect(rowOf("画面").querySelector(".row-low")).toBeNull();
  });

  it("サイドバーのカンバンの行は、開いた Plan に入っていれば右端に Plan の番号を Plan の色で出し、todo なら着手可・待ちの相手・承認待ちを出す。バックログの行は変わらない", async () => {
    const client = mockClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "待つ", priority: "high" }),
      ticket({ id: "t5", title: "外", priority: "low" }),
      ticket({ id: "t6", title: "閉じた計画" }),
      ticket({ id: "t7", title: "承認前" }),
    );
    client.data.plans.push(
      plan({
        id: "p7",
        tickets: ["t1", "t2", "t3", "t4"],
        after: { t3: ["t1"], t4: ["t2", "t3"] },
      }),
      plan({ id: "p8", tickets: ["t6"], status: "closed" }),
      plan({ id: "p9", tickets: ["t7"], status: "pending" }),
    );
    mount(client, hostOf("sidebar"));
    await screen.findByText("待つ");
    const endOf = (title: string) => kanbanRowOf(title).querySelector(".row-end");

    // in_progress：上に Plan の番号、下に優先度の印
    const api = endOf("API")!;
    expect(api.querySelector(".row-plan")!.textContent).toBe("p7");
    expect(api.querySelector(".row-plan")!.classList.contains("plan-color-2")).toBe(true);
    expect(api.lastElementChild!.textContent).toBe("high");
    // todo で待ちが終わっている：着手可
    expect(endOf("画面")!.querySelector(".row-ready")!.textContent).toBe("着手可");
    // todo で待ちが残る：先頭の相手と残りの件数。優先度の印は上の段の Plan の番号の左
    const wait = endOf("待つ")!;
    expect(wait.querySelector(".row-wait")!.textContent).toBe("t2+1 待ち");
    expect(wait.querySelector(".row-wait")!.getAttribute("title")).toBe("t2・t3 を待っている");
    expect(wait.querySelector(".row-end-top")!.textContent).toBe("highp7");
    // 承認待ちの Plan の todo は、待ちがなくても「承認待ち」
    expect(endOf("承認前")!.querySelector(".row-wait")!.textContent).toBe("承認待ち");
    expect(endOf("承認前")!.querySelector(".row-ready")).toBeNull();
    // Plan に入っていない・閉じた Plan のチケットは今までどおり優先度の印だけ
    expect(endOf("外")).toBeNull();
    expect(kanbanRowOf("外").lastElementChild!.textContent).toBe("low");
    expect(endOf("閉じた計画")).toBeNull();

    cleanup();
    window.location.hash = "#/backlog";
    mount(client, hostOf("sidebar"));
    await screen.findByText("待つ");
    expect(document.querySelector(".row-end")).toBeNull();
    expect(screen.queryByText("着手可")).toBeNull();
    expect(kanbanRowOf("待つ").lastElementChild!.textContent).toBe("high");
  });

  it("サイドバーのカンバンの行の頭に、実行中の Run があれば回るリングと「実行中」を、Run のない in_progress なら止まった半分塗りの丸を出し、読み直しで変わる", async () => {
    const client = mockClient();
    client.data.plans.push(plan({ id: "p7", tickets: ["t2"] }));
    /** このマシンで実行中の Run（run.list の running: true だけに返す） */
    let running: RunView[] = [runningRun("t3")];
    client.handlers["ticket.list"] = () => [...client.data.tickets];
    client.handlers["run.list"] = (input) =>
      (input as { running?: boolean }).running ? running : [];
    const send = mountWithBridge(client);
    await waitFor(() => expect(document.querySelector(".activity-running")).toBeTruthy());
    expect(
      client.calls.find((c) => c.name === "run.list" && !(c.input as { ticket?: string }).ticket)!
        .input,
    ).toEqual({ project: "default", running: true });
    // todo で Run が実行中（Plan の外）：頭に回るリング、右端の下の段に「実行中」
    const screenRow = kanbanRowOf("画面");
    expect(screenRow.classList.contains("has-head")).toBe(true);
    expect(screenRow.firstElementChild!.classList.contains("activity-running")).toBe(true);
    expect(screenRow.querySelector(".row-end-sub")!.textContent).toBe("実行中");
    // in_progress で Run のない行：止まった半分塗りの丸。右端は今までどおり（Plan の番号と優先度の印）
    const api = kanbanRowOf("API");
    expect(api.firstElementChild!.classList.contains("activity-idle")).toBe(true);
    expect(api.querySelector(".row-running")).toBeNull();
    expect(api.querySelector(".row-end-sub")!.textContent).toBe("high");
    // ほかの状態の行は頭に何も出さない
    expect(kanbanRowOf("ログイン").querySelector(".activity-mark")).toBeNull();
    expect(kanbanRowOf("ログイン").classList.contains("has-head")).toBe(false);

    // ターミナルで t3 の Run を閉じ、t2 の Run を始めた
    running = [runningRun("t2")];
    act(() => send()({ kind: "event", name: "reload" }));
    await waitFor(() =>
      expect(kanbanRowOf("API").firstElementChild!.classList.contains("activity-running")).toBe(
        true,
      ),
    );
    // Plan に入っている行は、優先度の印を上の段の Plan の番号の左に寄せ、下の段に「実行中」
    expect(kanbanRowOf("API").querySelector(".row-end-top")!.textContent).toBe("highp7");
    expect(kanbanRowOf("API").querySelector(".row-end-sub")!.textContent).toBe("実行中");
    expect(kanbanRowOf("画面").querySelector(".activity-mark")).toBeNull();
    expect(kanbanRowOf("画面").querySelector(".row-end")).toBeNull();
  });

  it("サイドバーのカンバンでは、待ちと承認待ちの todo の行だけタイトルを薄くし、実行中の Run がある行は待ちでも薄くしない", async () => {
    const client = mockClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "待つ" }),
      ticket({ id: "t5", title: "外" }),
      ticket({ id: "t7", title: "承認前" }),
      ticket({ id: "t8", title: "待ちで実行中" }),
    );
    client.data.plans.push(
      plan({
        id: "p7",
        tickets: ["t2", "t3", "t4", "t8"],
        // in_progress の t2 にも待ちの相手を残し、todo でなければ薄くしないことを確かめる
        after: { t2: ["t3"], t4: ["t2"], t8: ["t2"] },
      }),
      plan({ id: "p9", tickets: ["t7"], status: "pending" }),
    );
    client.handlers["run.list"] = (input) =>
      (input as { running?: boolean }).running ? [runningRun("t8")] : [];
    mountWithBridge(client);
    await waitFor(() =>
      expect(kanbanRowOf("待ちで実行中").querySelector(".activity-running")).toBeTruthy(),
    );
    const dimmed = (title: string) =>
      kanbanRowOf(title).closest(".row-drag")!.classList.contains("is-waiting");
    // 待ちと承認待ちは薄くする
    expect(kanbanRowOf("待つ").querySelector(".row-wait")!.textContent).toBe("t2 待ち");
    expect(dimmed("待つ")).toBe(true);
    expect(dimmed("承認前")).toBe(true);
    // 着手可・Plan の外・待ちの相手が残る in_progress は薄くしない
    expect(kanbanRowOf("画面").querySelector(".row-ready")).toBeTruthy();
    expect(dimmed("画面")).toBe(false);
    expect(dimmed("外")).toBe(false);
    expect(dimmed("API")).toBe(false);
    // 実行中の Run がある todo は、Plan の待ちが残っていても薄くしない
    expect(dimmed("待ちで実行中")).toBe(false);
  });

  it("実行中の Run を読み終えるまでは、in_progress の行に頭の印を出さず、ほかの一覧はそれを待たずに出す", async () => {
    const client = mockClient();
    let finish: (runs: RunView[]) => void = () => {};
    client.handlers["run.list"] = () => new Promise<RunView[]>((resolve) => (finish = resolve));
    render(
      <StoreProvider client={client} readRunning>
        <HostProvider host={hostOf("sidebar")}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("API");
    await waitFor(() => expect(client.calls.some((c) => c.name === "run.list")).toBe(true));
    const api = () => screen.getByText("API").closest(".ticket-row")!;
    expect(api().querySelector(".activity-mark")).toBeNull();
    expect(api().classList.contains("has-head")).toBe(false);
    act(() => finish([]));
    await waitFor(() => expect(api().querySelector(".activity-idle")).toBeTruthy());
  });

  it("readRunning でなければ（左パネルでなければ）実行中の Run を読まず、行に頭の印を出さない", async () => {
    const client = mockClient();
    mount(client, hostOf("sidebar"));
    await screen.findByText("API");
    expect(client.calls.some((c) => c.name === "run.list")).toBe(false);
    expect(document.querySelector(".activity-mark")).toBeNull();
  });

  it("広い画面のカンバンのカードには Run の印を出さない", async () => {
    const client = mockClient();
    let answered = false;
    client.handlers["run.list"] = () => {
      answered = true;
      return [runningRun("t2")];
    };
    // readRunning で実行中の Run を読ませ、読んだうえで広い画面（ブラウザの host）のカードには出さないことを見る
    render(
      <StoreProvider client={client} readRunning>
        <HostProvider host={hostOf("browser")}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("API");
    await waitFor(() => expect(answered).toBe(true));
    expect(client.calls.find((c) => c.name === "run.list")!.input).toEqual({
      project: "default",
      running: true,
    });
    // run.list の応答を store に入れ終えるまで待つ
    await act(async () => {});
    expect(document.querySelector(".cards")).toBeTruthy();
    expect(document.querySelector(".activity-mark")).toBeNull();
    expect(screen.queryByText("実行中")).toBeNull();
  });

  it("実行中の Run の読み直しが重なり、後から古い結果が返っても、新しい結果のリングを残す", async () => {
    const client = mockClient();
    /** run.list（running）の応答を、呼ばれた順に後から返す */
    const pending: ((runs: RunView[]) => void)[] = [];
    client.handlers["run.list"] = () => new Promise<RunView[]>((resolve) => pending.push(resolve));
    const send = mountWithBridge(client);
    await waitFor(() => expect(pending.length).toBe(1));
    act(() => pending[0]!([runningRun("t3")]));
    await waitFor(() =>
      expect(kanbanRowOf("画面").querySelector(".activity-running")).toBeTruthy(),
    );

    // 読み直しを 2 回起こす。1 回目（古い）は t3、2 回目（新しい）は t2 が実行中と返す
    act(() => send()({ kind: "event", name: "reload" }));
    act(() => send()({ kind: "event", name: "reload" }));
    await waitFor(() => expect(pending.length).toBe(3));
    await act(async () => pending[2]!([runningRun("t2")]));
    await waitFor(() => expect(kanbanRowOf("API").querySelector(".activity-running")).toBeTruthy());
    expect(kanbanRowOf("画面").querySelector(".activity-mark")).toBeNull();
    // 古い 1 回目が後から返っても、新しい結果を上書きしない
    await act(async () => pending[1]!([runningRun("t3")]));
    expect(kanbanRowOf("API").querySelector(".activity-running")).toBeTruthy();
    expect(kanbanRowOf("画面").querySelector(".activity-mark")).toBeNull();
  });

  it("実行中の Run が読み直しで読めなくても、前のリングを残し、エラーの通知を出さない", async () => {
    const client = mockClient();
    let fail = false;
    client.handlers["run.list"] = () => {
      if (fail) throw new Error("runs を読めない");
      return [runningRun("t3")];
    };
    const send = mountWithBridge(client);
    await waitFor(() =>
      expect(kanbanRowOf("画面").querySelector(".activity-running")).toBeTruthy(),
    );
    const before = client.calls.filter((c) => c.name === "run.list").length;

    fail = true;
    act(() => send()({ kind: "event", name: "reload" }));
    await waitFor(() =>
      expect(client.calls.filter((c) => c.name === "run.list").length).toBe(before + 1),
    );
    // 失敗した run.list の後始末を待つ
    await act(async () => {});
    expect(kanbanRowOf("画面").querySelector(".activity-running")).toBeTruthy();
    expect(kanbanRowOf("画面").querySelector(".row-end-sub")!.textContent).toBe("実行中");
    expect(document.querySelector(".notice")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("サイドバーでは同期の印とボタンを出さない（ビューのタイトル行とバッジで代える）", async () => {
    const client = mockClient();
    client.data.status = { ...client.data.status, ahead: 2 };
    mount(client, hostOf("sidebar"));
    await screen.findByText("ログイン");
    expect(screen.queryByRole("button", { name: "同期" })).toBeNull();
    expect(screen.queryByText("未 push 2")).toBeNull();
  });

  it("サイドバーではチケット詳細のルートでもバックログを出す（詳細はエディタのパネル）", async () => {
    window.location.hash = "#/tickets/t3";
    mount(mockClient(), hostOf("sidebar"));
    await screen.findByText("API");
    expect(screen.queryByRole("heading", { level: 1, name: "画面" })).toBeNull();
    expect(document.querySelector("table.list")).toBeNull();
    expect(document.querySelectorAll(".backlog-main ul.rows > li")).toHaveLength(2);
  });

  it("Webview がリンクのクリックを横取りしても（document で preventDefault）、タブを押すとハッシュが変わり aria-current が移る", async () => {
    const intercept = (e: Event) => e.preventDefault();
    document.addEventListener("click", intercept);
    try {
      mount(mockClient(), hostOf("sidebar"));
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
      hostOf(
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
    mount(mockClient(), hostOf("panel"));
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
      hostOf("sidebar", (route) => opened.push(route)),
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

  it("サイドバーの履歴の Iteration の行は期間の記録がなければそう書き、Epic ごとの件数が出て、開くと Epic ごとの小見出しで終わったチケットと持ち越しが出る", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "最初", status: "closed" })];
    client.data.tickets[0]!.iteration = "s1";
    client.data.tickets[0]!.epic = "e1";
    client.data.tickets.push(
      ticket({ id: "t4", title: "やめた", status: "abandoned", iteration: "s1", epic: "e1" }),
      ticket({ id: "t5", title: "持ち越し", status: "todo", iteration: "s1" }),
      ticket({ id: "t6", title: "次へ", status: "todo", iteration: "s2" }),
    );
    client.handlers["history"] = () => ({
      events: [
        {
          kind: "ticket",
          id: "t6",
          at: "2026-10-10T00:00:00Z",
          changes: [{ field: "iteration", from: "s1", to: "s2" }],
        },
      ],
      shallow: false,
      incomplete: [],
    });
    const opened: Route[] = [];
    mount(
      client,
      hostOf("sidebar", (route) => opened.push(route)),
    );
    await screen.findByRole("heading", { level: 1, name: "履歴" });
    const row = document.querySelector(".history-row")!;
    expect(row.querySelector("small")!.textContent).toBe("期間の記録なし ・ Epic: e1 2");
    const item = document.querySelector<HTMLDetailsElement>("details.history-item")!;
    expect(item.open).toBe(false);
    expect(item.classList.contains("fold")).toBe(true);
    item.open = true;
    fireEvent(item, new Event("toggle"));
    await waitFor(() => expect(item.querySelectorAll(".history-group")).toHaveLength(2));
    const groups = [...item.querySelectorAll(".history-group")].map((g) => ({
      head: g.querySelector("h3")!.textContent,
      tickets: [...g.querySelectorAll(".row code")].map((c) => c.textContent),
    }));
    expect(groups).toEqual([
      { head: "e1 最初の版 2 件", tickets: ["t1", "t4"] },
      { head: "持ち越し 1 件", tickets: ["t6"] },
    ]);
    fireEvent.click(item.querySelector(".history-group .row")!);
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
    mount(client, hostOf("panel"));
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
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: /s1 最初/ });
    expect(screen.queryByRole("navigation", { name: "画面" })).toBeNull();
  });

  it("ブラウザではチケットのリンクが詳細へのハッシュ遷移のまま", async () => {
    window.location.hash = "#/backlog";
    mount();
    const link = (await screen.findByText("API")).closest("a")!;
    expect(link.getAttribute("href")).toBe("#/tickets/t2");
  });

  it("サイドバーのバックログは検索だけ出し、絞り込みは畳む。件数と効いている条件は絞り込みの行に出て、消すボタンは条件があるときだけ", async () => {
    window.location.hash = "#/backlog";
    const host = hostOf("sidebar");
    mount(mockClient(), host);
    await screen.findByText("API");
    expect(screen.getByLabelText("検索")).toBeTruthy();
    const fold = document.querySelector<HTMLDetailsElement>("details.filters")!;
    const count = () => fold.querySelector("summary .count")!.textContent;
    expect(count()).toBe("2 件");
    expect(document.querySelector(".toolbar > .muted")).toBeNull();
    expect(fold.open).toBe(false);
    expect(screen.queryByRole("button", { name: "絞り込みを消す" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /最初の版/ }));
    expect(fold.querySelector("summary")!.textContent).toContain("Epic: e1");
    expect(count()).toBe("1 件");
    expect(screen.getByText("× 解除")).toBeTruthy();
    fold.open = true;
    fireEvent(fold, new Event("toggle"));
    expect(host.state.get("backlog.filters")).toBe(true);
    expect(screen.getByRole("button", { name: "絞り込みを消す" })).toBeTruthy();
  });

  it("サイドバーのバックログの区画は、行に優先度の印を付け、見出しを状態の帯と 2 段（番号・名前・件数／状態・月日の期間・目標）にし、「…」と開始・閉じるを出さない", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations = [
      iteration({
        id: "s1",
        name: "今",
        status: "active",
        start: "2026-11-01",
        end: "2026-11-14",
        goal: "左パネルを整える",
      }),
      iteration({ id: "s2", name: "次", status: "planned" }),
    ];
    client.data.tickets[1]!.iteration = "s1";
    client.data.tickets[2]!.iteration = "s1";
    mount(client, hostOf("sidebar"));
    await screen.findByText("API");
    const [s1] = [...document.querySelectorAll<HTMLDetailsElement>("details.backlog-section")];
    expect([...s1!.querySelectorAll(".priority-mark")].map((m) => m.textContent)).toEqual([
      "!",
      "優先度 medium",
    ]);
    expect(s1!.classList.contains("iteration-active")).toBe(true);
    const lines = [...s1!.querySelectorAll("summary > .head-line")];
    expect(lines.map((l) => l.textContent)).toEqual([
      "s1 今2 件",
      "進行中11/1–11/14左パネルを整える",
    ]);
    // 2 段目は 1 行で目標から省略し、目標の全文はツールチップで読む（カンバンの見出しと同じ）
    expect(lines[1]!.querySelector(".goal")!.getAttribute("title")).toBe("左パネルを整える");
    expect(s1!.querySelector(".actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "s1 の操作" })).toBeNull();
    expect(screen.queryByRole("button", { name: "閉じる" })).toBeNull();
    expect(screen.queryByRole("button", { name: "開始する" })).toBeNull();
  });

  it("サイドバーのバックログの 0 件の区画（planned・Iteration なし）は 2 段目のない 1 行に畳み、「Iteration なし」は 1 つの名前で、右端の「+」から作る", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s1", name: "今", status: "active" }),
      iteration({ id: "s2", name: "次", status: "planned", start: "2026-12-01", goal: "次の目標" }),
    ];
    for (const t of client.data.tickets) t.iteration = "s1";
    client.handlers["iteration.create"] = (input) => input;
    mount(client, hostOf("sidebar"));
    await screen.findByText("API");
    const [, s2, none] = [
      ...document.querySelectorAll<HTMLDetailsElement>("details.backlog-section"),
    ];
    for (const s of [s2!, none!]) {
      expect(s.open).toBe(false);
      expect(s.classList.contains("empty-section")).toBe(true);
      expect(s.querySelectorAll("summary > .head-line")).toHaveLength(1);
    }
    expect(s2!.querySelector("summary")!.textContent).toBe("s2 次0 件");
    expect(none!.querySelector("summary .name")!.textContent).toBe("Iteration なし");
    expect(none!.querySelector("summary .name")!.children).toHaveLength(0);
    const create = screen.getByRole("button", { name: "Iteration を作る" });
    expect(create.textContent).toBe("+");
    expect(none!.querySelector("summary > .head-line")!.lastElementChild).toBe(create);
    fireEvent.click(create);
    expect(none!.open).toBe(true);
    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "その次" } });
    fireEvent.click(screen.getByRole("button", { name: "作る" }));
    await waitFor(() => expect(client.calls.some((c) => c.name === "iteration.create")).toBe(true));
  });

  it("サイドバーのバックログの行は high だけ「!」を出し、low の始まりに見出しを入れ、状態の丸印は todo だけ白抜きにする", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "今", status: "active" })];
    client.data.tickets = [
      ticket({ id: "t1", title: "高い", status: "review", priority: "high", iteration: "s1" }),
      ticket({ id: "t2", title: "中くらい", status: "in_progress", iteration: "s1" }),
      ticket({
        id: "t3",
        title: "低い作業中",
        status: "in_progress",
        priority: "low",
        iteration: "s1",
      }),
      ticket({ id: "t4", title: "低い", priority: "low", iteration: "s1" }),
    ];
    mount(client, hostOf("sidebar"));
    await screen.findByText("高い");
    const s1 = document.querySelector<HTMLDetailsElement>("details.backlog-section")!;
    const list = s1.querySelector("ul.rows")!;
    expect(list.classList.contains("backlog-rows")).toBe(true);
    // 行と区切りの並び：区切りは low の始まり（t3 の前）に 1 つだけ
    expect(
      [...list.children].map((li) =>
        li.classList.contains("priority-sep") ? "sep" : li.querySelector("code")!.textContent,
      ),
    ).toEqual(["t1", "t2", "sep", "t3", "t4"]);
    expect(list.querySelector("li.priority-sep")!.textContent).toBe("low");
    // high だけ見える「!」を出し、medium・low は見えない文字で優先度を読み上げる
    const marks = [...list.querySelectorAll(".priority-mark")];
    expect(marks.map((m) => m.textContent)).toEqual([
      "!",
      "優先度 medium",
      "優先度 low",
      "優先度 low",
    ]);
    expect(marks[0]!.getAttribute("aria-label")).toBe("優先度 high");
    expect(marks.slice(1).every((m) => m.querySelector(".visually-hidden"))).toBe(true);
    // 見出しの行は role を付けない（list の項目のまま）
    expect(list.querySelector("li.priority-sep")!.getAttribute("role")).toBeNull();
    // 状態の丸印は 3 種の状態で別のクラス。カンバンの Run の印（activity-mark）は出さない
    expect([...list.querySelectorAll(".status-dot")].map((d) => d.className)).toEqual([
      "status-dot status-review",
      "status-dot status-in_progress",
      "status-dot status-in_progress",
      "status-dot status-todo",
    ]);
    expect(list.querySelector(".activity-mark")).toBeNull();
    // 右端の high の札は左の印と重なるので出さない
    expect(list.querySelector(".badge.priority-high")).toBeNull();
  });

  it("サイドバーのバックログで low から始まる区画にも見出しを入れる", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "今", status: "active" })];
    client.data.tickets = [ticket({ id: "t1", title: "低い", priority: "low", iteration: "s1" })];
    mount(client, hostOf("sidebar"));
    await screen.findByText("低い");
    expect(document.querySelector("li.priority-sep")!.textContent).toBe("low");
  });

  it("サイドバーのバックログの Epic の欄は折りたため、作成フォームは「+」を押したときだけ開く", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.handlers["epic.create"] = (input) => input;
    const host = hostOf("sidebar");
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
    mount(client, hostOf("panel"));
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
    mount(client, hostOf("panel"));
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

  it("サイドバーのカンバンの見出しは Iteration の札の列・漏斗、名前・期間・目標、状態の帯と「n/m done」の 3 段で、件数・詳細・…・開始・閉じるは出さない", async () => {
    const client = mockClient();
    client.data.iterations = [
      iteration({
        id: "s1",
        name: "今",
        status: "planned",
        start: "2026-11-15",
        end: "2026-11-28",
        goal: "左パネルを整える",
      }),
    ];
    for (const t of client.data.tickets) t.iteration = "s1";
    mount(client, hostOf("sidebar"));
    await screen.findByText("API");
    const head = document.querySelector(".sidebar-head")!;
    const lines = [...head.querySelectorAll(":scope > .head-line")].map((l) => l.textContent);
    expect(lines).toEqual(["s11/3なし 0+", "今11/15–11/28左パネルを整える", "1/3 done"]);
    expect(head.querySelector(".goal")!.getAttribute("title")).toBe("左パネルを整える");
    const bar = [...head.querySelectorAll<HTMLElement>(".status-band .bar > span")];
    expect(bar.map((b) => b.className)).toEqual([
      "status-done",
      "status-in_progress",
      "status-todo",
    ]);
    expect(screen.queryByText("詳細")).toBeNull();
    expect(screen.queryByRole("button", { name: "s1 の操作" })).toBeNull();
    expect(screen.queryByRole("button", { name: "開始する" })).toBeNull();
    expect(screen.queryByRole("button", { name: "閉じる" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Iteration を作る" })).toBeNull();
    expect(screen.queryByLabelText("Iteration", { selector: "select" })).toBeNull();
    expect(screen.queryByText(/\d+ 件$/)).toBeNull();
    // 絞り込みの欄は漏斗を押すまで出さない
    expect(head.querySelector(".head-line .filter-toggle")).toBeTruthy();
    expect(document.querySelector(".board-filters.compact")).toBeNull();
  });

  it("サイドバーのカンバンは planned と active の Iteration を番号順の札で並べ、進み・枠・ツールチップで見分け、押すと切り替わる", async () => {
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s3", name: "次の次", status: "planned" }),
      iteration({ id: "s0", name: "前", status: "closed" }),
      iteration({
        id: "s1",
        name: "今",
        status: "active",
        start: "2026-11-01",
        end: "2026-11-14",
        goal: "札で切り替える",
      }),
      iteration({ id: "s2", name: "次", status: "planned" }),
    ];
    client.data.tickets[0]!.iteration = "s1";
    client.data.tickets[1]!.iteration = "s1";
    client.data.tickets[2]!.iteration = "s2";
    mount(client, hostOf("sidebar"));
    await screen.findByText("ログイン");
    const group = screen.getByRole("group", { name: "Iteration" });
    const chips = [...group.querySelectorAll<HTMLButtonElement>(".iteration-chip")];
    // 閉じた Iteration は出さず、番号順に並べ、最後に なし と + を置く
    expect(chips.map((c) => c.textContent)).toEqual(["s11/2", "s20/1", "s30/0", "なし 0", "+"]);
    expect(chips.map((c) => c.className)).toEqual([
      "iteration-chip active",
      "iteration-chip planned",
      "iteration-chip planned",
      "iteration-chip loose",
      "iteration-chip create",
    ]);
    // 既定は active の札を選び、選んでいる札だけが押された状態
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      null,
    ]);
    expect(chips[0]!.querySelector("svg.ring")).toBeTruthy();
    expect(chips[0]!.title).toBe(
      "s1 今（進行中）\n期間 2026-11-01 〜 2026-11-14\n目標 札で切り替える",
    );
    expect(chips[1]!.title).toBe("s2 次（予定）");

    fireEvent.click(chips[1]!);
    await waitFor(() => expect(window.location.hash).toContain("iteration=s2"));
    await screen.findByText("画面");
    expect(screen.queryByText("API")).toBeNull();
    expect(
      [...document.querySelectorAll(".iteration-chip")].map((c) => c.getAttribute("aria-pressed")),
    ).toEqual(["false", "true", "false", "false", null]);
    expect(document.querySelector(".sidebar-head .head-line.sub .name")!.textContent).toBe("次");
  });

  it("サイドバーのカンバンの「なし n」は Iteration に入っていない終わっていないチケットを数え、押すと Iteration なしを選ぶ", async () => {
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "今", status: "active" })];
    client.data.tickets[0]!.iteration = "s1";
    // 残りの 2 件は Iteration なし。done は数えない
    client.data.tickets[2]!.status = "done";
    mount(client, hostOf("sidebar"));
    await screen.findByText("ログイン");
    const loose = document.querySelector<HTMLButtonElement>(".iteration-chip.loose")!;
    expect(loose.textContent).toBe("なし 1");
    fireEvent.click(loose);
    await waitFor(() => expect(window.location.hash).toContain("iteration=-"));
    expect(document.querySelector(".iteration-chip.loose")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.querySelector(".sidebar-head .head-line.sub .name")!.textContent).toBe(
      "Iteration なし",
    );
  });

  it("サイドバーのカンバンの札の done/全体は、すぐ下の進みの帯と同じく閉じた Epic の終わったチケットを数えない", async () => {
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "今", status: "active" })];
    client.data.epics.push({
      ...client.data.epics[0]!,
      id: "e2",
      title: "閉じた",
      status: "closed",
    });
    client.data.tickets[0]!.iteration = "s1";
    client.data.tickets[0]!.epic = "e2";
    client.data.tickets[1]!.iteration = "s1";
    mount(client, hostOf("sidebar"));
    await screen.findByText("API");
    const chip = document.querySelector(".iteration-chip.active")!;
    expect(chip.textContent).toBe("s10/1");
    expect(document.querySelector(".sidebar-head .status-band")!.textContent).toBe("0/1 done");
  });

  it("サイドバーのカンバンの札の done/全体は、閉じた Epic で絞っても変わらない", async () => {
    window.location.hash = "#/board?epic=e2";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "今", status: "active" })];
    client.data.epics.push({
      ...client.data.epics[0]!,
      id: "e2",
      title: "閉じた",
      status: "closed",
    });
    client.data.tickets[0]!.iteration = "s1";
    client.data.tickets[0]!.epic = "e2";
    client.data.tickets[1]!.iteration = "s1";
    mount(client, hostOf("sidebar"));
    // 閉じた Epic で絞ると、その Epic の終わったチケットはカンバンに出る
    await screen.findByText("ログイン");
    expect(document.querySelector(".iteration-chip.active")!.textContent).toBe("s10/1");
  });

  it("サイドバーでは Project が 1 つなら Project の段を出さず、2 つ以上なら出す", async () => {
    mount(mockClient(), hostOf("sidebar"));
    await screen.findByText("ログイン");
    expect(document.querySelector(".project-select")).toBeNull();
    cleanup();
    const client = mockClient();
    client.data.projects.push({ ...client.data.projects[0]!, id: "other", name: "Other" });
    mount(client, hostOf("sidebar"));
    await screen.findByText("ログイン");
    expect(document.querySelector(".project-select")).toBeTruthy();
  });

  it("サイドバーのカンバンの Epic・担当の欄は漏斗で開き（開閉は host.state）、絞っている間は値の札を出して漏斗を色付きにし、× で外せる", async () => {
    const client = mockClient();
    client.data.tickets[1]!.assignee = "eiki/agent";
    const host = hostOf("sidebar");
    mount(client, host);
    await screen.findByText("ログイン");
    const funnel = screen.getByRole("button", { name: "絞り込み" });
    expect(funnel.getAttribute("aria-expanded")).toBe("false");
    // 閉じている間は存在しない欄を指さない
    expect(funnel.hasAttribute("aria-controls")).toBe(false);
    expect(screen.queryByLabelText("担当")).toBeNull();
    expect(document.querySelector(".filter-chips")).toBeNull();

    fireEvent.click(funnel);
    expect(funnel.getAttribute("aria-expanded")).toBe("true");
    expect(host.state.get("board.filters")).toBe(true);
    expect(document.getElementById(funnel.getAttribute("aria-controls")!)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("担当"), { target: { value: "eiki/agent" } });
    await waitFor(() => expect(screen.queryByText("ログイン")).toBeNull());
    const chip = document.querySelector(".filter-chip")!;
    expect(chip.textContent).toBe("担当 eiki/agent×");
    // 長い値で × が隠れないよう、文字は省略できる span に入れ、× のボタンはその外に置く
    expect(chip.querySelector(".filter-chip-text")!.textContent).toBe("担当 eiki/agent");
    expect(chip.lastElementChild!.tagName).toBe("BUTTON");
    expect(funnel.classList.contains("active")).toBe(true);
    // 帯の数は絞り込みの後のチケットで数える
    expect(document.querySelector(".sidebar-head .status-band")!.textContent).toBe("0/1 done");

    // 欄を畳んでも札は残り、× で外せる
    fireEvent.click(funnel);
    expect(screen.queryByLabelText("担当")).toBeNull();
    expect(host.state.get("board.filters")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "担当 eiki/agent の絞り込みを外す" }));
    await screen.findByText("ログイン");
    expect(window.location.hash).not.toContain("assignee");
    expect(document.querySelector(".filter-chips")).toBeNull();
    expect(funnel.classList.contains("active")).toBe(false);

    // Epic の札は番号を出す
    fireEvent.click(funnel);
    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "e1" } });
    await waitFor(() =>
      expect(document.querySelector(".filter-chip")!.textContent).toBe("Epic e1×"),
    );
  });

  it("サイドバーのカンバンでは札の列の最後の「+」で Iteration を作る欄を出す", async () => {
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "今", status: "active" })];
    client.data.tickets[0]!.iteration = "s1";
    mount(client, hostOf("sidebar"));
    await screen.findByText("ログイン");
    fireEvent.click(screen.getByRole("button", { name: "Iteration を作る" }));
    expect(screen.getByLabelText("名前")).toBeTruthy();
    expect(window.location.hash).not.toContain("create");
  });

  it("Iteration のない Project でも、サイドバーのカンバンの「+」から Iteration を作れる（なし の札は出さない）", async () => {
    mount(mockClient(), hostOf("sidebar"));
    await screen.findByText("ログイン");
    expect(document.querySelector(".sidebar-head .head-line.sub .name")!.textContent).toBe(
      "Iteration はない",
    );
    expect(document.querySelector(".iteration-chip.loose")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Iteration を作る" }));
    expect(screen.getByLabelText("名前")).toBeTruthy();
  });

  it("エディタのパネルの Iteration 詳細に開始・閉じるが残り、閉じるは未完了の件数を示す確認を経てから閉じる", async () => {
    window.location.hash = "#/iterations/s1";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "今", status: "active" })];
    client.data.tickets[1]!.iteration = "s1";
    client.data.tickets[2]!.iteration = "s1";
    client.handlers["iteration.show"] = () => ({
      ...client.data.iterations[0],
      items: client.data.tickets.filter((t) => t.iteration === "s1"),
    });
    client.handlers["iteration.close"] = (input) => input;
    mount(client, hostOf("panel"));
    fireEvent.click(await screen.findByRole("button", { name: "閉じる" }));
    const confirm = screen.getByRole("group", { name: "s1 今 を閉じる確認" });
    expect(confirm.textContent).toContain("未完了が 2 件ある");
    expect(client.calls.some((c) => c.name === "iteration.close")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));
    expect(screen.queryByRole("group", { name: "s1 今 を閉じる確認" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "2 件を残して閉じる" }));
    await waitFor(() =>
      expect(client.calls.find((c) => c.name === "iteration.close")?.input).toEqual({
        iteration: "s1",
      }),
    );
  });

  it("エディタのパネルの planned の Iteration 詳細から開始する", async () => {
    window.location.hash = "#/iterations/s2";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s2", name: "次", status: "planned" })];
    client.handlers["iteration.show"] = () => ({ ...client.data.iterations[0], items: [] });
    client.handlers["iteration.start"] = (input) => input;
    mount(client, hostOf("panel"));
    fireEvent.click(await screen.findByRole("button", { name: "開始する" }));
    await waitFor(() =>
      expect(client.calls.find((c) => c.name === "iteration.start")?.input).toEqual({
        iteration: "s2",
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
    mount(client, hostOf("panel"));
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
    client.data.tickets[1]!.iteration = "s1";
    const host = hostOf("sidebar");
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
      hostOf("sidebar", (route) => opened.push(route)),
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
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: /e1 最初の版/ });
    expect(screen.queryByRole("navigation", { name: "画面" })).toBeNull();
  });
});
