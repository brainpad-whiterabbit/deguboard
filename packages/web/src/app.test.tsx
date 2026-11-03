// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, INFO_NOTICE_MS } from "./app.js";
import { ClientError } from "./client/http.js";
import type { WebviewClient } from "./client/webview.js";
import type { WebviewEvent } from "@deguboard/core";
import { HostBridge, HostProvider, type Host } from "./host.js";
import { parseRoute, type Route } from "./router.js";
import { StoreProvider } from "./store.js";
import { boardFixture, fixture, iteration, mockClient, plan, ticket } from "./test-helpers.js";

/** カンバンのテストの client（チケットを active の Iteration に入れた fixture） */
const boardClient = () => mockClient(boardFixture());
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
  it("カンバンは Workflow の表示名の 4 列で、チケットを Status の列に出す。中止は 0 件なら出さない", async () => {
    mount(boardClient());
    await screen.findByText("ログイン");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Todo1", "In Progress1", "Code Review0", "Done1"]);
    expect(screen.queryByText("Abandoned")).toBeNull();
    expect(screen.queryByLabelText("abandoned を出す")).toBeNull();
    expect(screen.getByText("3 件")).toBeTruthy();
  });

  it.each(["browser", "sidebar"] as const)(
    "開いた Iteration がなければ（%s）、列も帯も出さず、開いた Iteration がないことと、バックログと Iteration の作成への案内を出す。「すべて」は選べる",
    async (surface) => {
      const client = mockClient(
        fixture({ iterations: [iteration({ id: "s1", name: "昔", status: "closed" })] }),
      );
      client.data.tickets[0]!.iteration = "s1";
      client.data.plans.push(plan({ id: "p1", tickets: ["t1"], status: "closed" }));
      mount(client, hostOf(surface));
      await screen.findByText(/開いた Iteration（planned・active）はない/);
      expect(document.querySelector(".board")).toBeNull();
      expect(document.querySelector(".plan-band")).toBeNull();
      expect(screen.queryByText("ログイン")).toBeNull();
      const guide = document.querySelector(".board-empty")!;
      expect(guide.querySelector("a")!.getAttribute("href")).toBe("#/backlog");
      // 作るボタンは案内の中の 1 つだけ（ブラウザの上の欄には出さない）
      expect(screen.getAllByRole("button", { name: "+ Iteration を作る" })).toHaveLength(1);
      expect(guide.querySelector("button")!.textContent).toBe("+ Iteration を作る");
      if (surface === "browser") {
        const select = screen.getByLabelText<HTMLSelectElement>("Iteration");
        expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
          "すべて（planned と active）",
        ]);
      } else {
        const chips = [...document.querySelectorAll(".iteration-chip")].map((c) => c.textContent);
        expect(chips).toEqual(["すべて0/0", "+"]);
        expect(document.querySelector(".status-band")).toBeNull();
      }
    },
  );

  it("中止のチケットがあるときだけ、畳んだ「中止」の列を完了の右（最後）に出す", async () => {
    const client = boardClient();
    client.data.tickets.push(
      ticket({ id: "t9", title: "やめた", status: "abandoned", iteration: "s0" }),
    );
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

  it("Iteration の選択肢は「すべて」と planned と active で、既定は active。選ぶとその Iteration のチケットだけになり、ハッシュに残る。「すべて」は開いた Iteration のチケットだけを出す", async () => {
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s1", name: "最初", status: "active" }),
      iteration({ id: "s2", name: "次", status: "planned" }),
      iteration({ id: "s0", name: "昔", status: "closed" }),
    ];
    client.data.tickets[0]!.iteration = "s0";
    client.data.tickets[1]!.iteration = "s1";
    client.data.tickets[2]!.iteration = "s2";
    client.data.tickets.push(ticket({ id: "t4", title: "入っていない" }));
    mount(client);
    await screen.findByText("API");
    const select = screen.getByLabelText<HTMLSelectElement>("Iteration");
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "すべて（planned と active）",
      "s1 最初（進行中）",
      "s2 次（予定）",
    ]);
    expect(select.value).toBe("s1");
    expect(document.querySelector(".iteration-table")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("s1 最初");
    expect(screen.queryByText("画面")).toBeNull();
    fireEvent.change(select, { target: { value: "s2" } });
    expect(window.location.hash).toBe("#/board?iteration=s2");
    await screen.findByText("画面");
    expect(screen.queryByText("API")).toBeNull();
    fireEvent.change(screen.getByLabelText("Iteration"), { target: { value: "*" } });
    expect(window.location.hash).toBe("#/board?iteration=*");
    await screen.findByText("API");
    expect(screen.getByText("画面")).toBeTruthy();
    // Iteration に入っていないチケットと、閉じた Iteration のチケットは出さない
    expect(screen.queryByText("入っていない")).toBeNull();
    expect(screen.queryByText("ログイン")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("Epic の選択肢は open だけ。閉じた Epic は選んでいるときだけ残す", async () => {
    const client = boardClient();
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
    const client = boardClient();
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

  it("エディタのパネルのチケット詳細は、編集のボタンをタイトルの下の属性の行の右端に置き、作成・更新を手元時刻で今年なら年を省いて出し、値のない属性を「なし」の 1 行にまとめる", async () => {
    // 作成（2026-01-01）が今年になるよう、今を 2026 年にする
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-06-01T00:00:00Z") });
    window.location.hash = "#/tickets/t3";
    mount(mockClient(), hostOf("panel"));
    const h1 = await screen.findByRole("heading", { level: 1, name: "画面" });
    const edit = screen.getByRole("button", { name: "本文と属性を編集" });
    const meta = edit.closest(".detail-meta")!;
    expect(meta.lastElementChild!.contains(edit)).toBe(true);
    expect(meta.closest(".detail-head")).toBe(h1.closest(".detail-head"));
    // 値のない Iteration・担当・PR は帯に出さない
    expect(meta.textContent).toBe("Todomedium本文と属性を編集");
    const created = screen.getByText("作成").nextElementSibling!.querySelector("time")!;
    expect(created.getAttribute("title")).toBe("2026-01-01T00:00:00Z");
    expect(created.textContent).toBe("01-01 00:00");
    expect(screen.queryByText("依存先")).toBeNull();
    expect(screen.queryByText("ブランチ")).toBeNull();
    const empty = screen.getByText("なし", { selector: "dt" }).nextElementSibling!;
    expect(empty.textContent).toBe("Epic・Iteration・依存先・依存元・担当・ブランチ・PR");
    // 編集中はすべての属性を出す
    fireEvent.click(edit);
    expect(screen.getByLabelText("Epic")).toBeTruthy();
    expect(screen.queryByText("なし", { selector: "dt" })).toBeNull();
    vi.useRealTimers();
  });

  it("エディタのパネルのチケット詳細の右の列は、Status の選択を先頭に置き、属性を「計画・つながり・作業・記録」の見出しで分け、「なし」の 1 行を最後に出す", async () => {
    window.location.hash = "#/tickets/t9";
    const data = fixture({
      tickets: [
        ticket({ id: "t9", title: "分け", iteration: "s1", assignee: "eiki", branch: "feat/x" }),
      ],
    });
    data.workflow.definition.fields = [{ id: "size", label: "規模", type: "string" }];
    mount(mockClient(data), hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "分け" });
    const aside = document.querySelector(".detail > aside")!;
    const dts = () => [...aside.querySelectorAll("dt")].map((d) => d.textContent);
    expect(aside.querySelector("dt")!.textContent).toBe("Status");
    expect(aside.querySelector("dd select[aria-label='Status']")).toBeTruthy();
    const titles = [...aside.querySelectorAll("h2")].map((h) => h.textContent);
    // 依存先・依存元がともにないので「つながり」の見出しは出さない
    expect(titles).toEqual(["計画", "作業", "記録"]);
    const groupOf = (title: string) =>
      [
        ...within(aside as HTMLElement)
          .getByRole("region", { name: title })
          .querySelectorAll("dt"),
      ].map((d) => d.textContent);
    expect(groupOf("計画")).toEqual(["Iteration", "担当", "優先度"]);
    expect(groupOf("作業")).toEqual(["ブランチ"]);
    expect(groupOf("記録")).toEqual(["起票者", "作成", "更新"]);
    expect(dts().at(-1)).toBe("なし");
    expect(aside.querySelector("dd.props-empty")!.textContent).toBe(
      "ラベル・Epic・規模・依存先・依存元・PR",
    );
    // 編集中はすべての属性を見出しの下に出す
    fireEvent.click(screen.getByRole("button", { name: "本文と属性を編集" }));
    expect(groupOf("計画")).toEqual(["Iteration", "Epic", "担当", "優先度", "ラベル", "規模"]);
    expect(groupOf("つながり")).toEqual(["依存先", "依存元"]);
    expect(groupOf("作業")).toEqual(["ブランチ", "PR"]);
    expect(dts().includes("なし")).toBe(false);
  });

  it("エディタのパネルのチケット詳細は、タイトルの直下の帯に Status の丸印・優先度・Iteration・担当・PR を 1 行で出す", async () => {
    window.location.hash = "#/tickets/t9";
    const data = fixture({
      tickets: [
        ticket({
          id: "t9",
          title: "帯",
          status: "in_progress",
          priority: "high",
          iteration: "s1",
          assignee: "eiki/agent",
          pr: 12,
        }),
      ],
      status: { ...fixture().status, web_url: "https://github.com/o/r" },
    });
    mount(mockClient(data), hostOf("panel"));
    const h1 = await screen.findByRole("heading", { level: 1, name: "帯" });
    const head = h1.closest(".detail-head")!;
    const meta = head.querySelector(".detail-meta")!;
    expect(head.firstElementChild).toBe(h1.closest("header"));
    expect(meta.querySelector(".status-dot.status-in_progress")).toBeTruthy();
    expect(meta.textContent).toBe("In Progresshighs1eiki/agent#12本文と属性を編集");
    expect(meta.querySelector('a[href="https://github.com/o/r/pull/12"]')).toBeTruthy();
    expect(meta.querySelector('a[href="#/iterations/s1"]')).toBeTruthy();
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
    // 見出しの帯と属性の見出し分けはパネルだけ。属性は 1 つの並びのまま
    expect(document.querySelector(".detail-head")).toBeNull();
    expect(document.querySelector(".props-groups")).toBeNull();
    expect([...document.querySelectorAll(".detail > aside dt")].map((d) => d.textContent)).toEqual([
      "Status",
      "優先度",
      "ラベル",
      "Epic",
      "Iteration",
      "依存先",
      "依存元",
      "担当",
      "ブランチ",
      "PR",
      "起票者",
      "作成",
      "更新",
    ]);
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
    const client = boardClient();
    const send = mountWithBridge(client, { readRunning: false });
    await screen.findByText("ログイン");
    // 別の経路（ターミナルの dg など）でチケットが増えた。本物の読み直しと同じく新しい配列を返す
    client.data.tickets = [
      ...client.data.tickets,
      ticket({ id: "t9", title: "外で起票した", iteration: "s0" }),
    ];
    expect(screen.queryByText("外で起票した")).toBeNull();
    act(() => send()({ kind: "event", name: "reload" }));
    expect(await screen.findByText("外で起票した")).toBeTruthy();

    act(() => send()({ kind: "event", name: "navigate", hash: "#/backlog" }));
    expect(window.location.hash).toBe("#/backlog");
  });

  it("拡張ホストから toggle の event が来ると、設定画面と来る前の画面を切り替える（ビューのタイトル行の歯車）", async () => {
    const client = mockClient();
    client.handlers["config.show"] = () => ({ config: { default_project: "default" }, fields: [] });
    window.location.hash = "#/backlog";
    const send = mountWithBridge(client, { readRunning: false });
    await waitFor(() => expect(client.calls.some((c) => c.name === "ticket.list")).toBe(true));
    // 左パネルではビューのタイトル行に歯車があるので、上のバーには出さない
    expect(screen.queryByRole("button", { name: "設定" })).toBeNull();
    act(() => send()({ kind: "event", name: "toggle", hash: "#/config" }));
    expect(window.location.hash).toBe("#/config");
    expect(await screen.findByRole("heading", { name: "設定" })).toBeTruthy();
    act(() => send()({ kind: "event", name: "toggle", hash: "#/config" }));
    expect(window.location.hash).toBe("#/backlog");
  });

  // VS Code では Run の画面を出さない（UI-12）ので、Run を出すのはパネルのチケット詳細だけ
  it.each(["#/tickets/t3"])(
    "拡張ホストから reload の event が来ると、%s の Run を取り直す（ターミナルの dg run start はチケットを変えない）",
    async (hash) => {
      window.location.hash = hash;
      const client = mockClient();
      // 本物の読み直しと同じく、チケットが変わらなくても新しい配列を返す
      client.handlers["ticket.list"] = () => [...client.data.tickets];
      let runs: RunView[] = [];
      client.handlers["run.list"] = () => runs;
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
      mount(boardClient(), surface === "browser" ? undefined : hostOf(surface));
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

  it("サイドバーのバックログの行は担当者の列を出さず、自分か自分の agent の担当は出さず、別の人の担当だけ右端に頭文字の丸（agent なら汎用のアイコンを添える）で出す（全名はツールチップ）", async () => {
    const client = mockClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "自分", assignee: "eiki" }),
      ticket({ id: "t5", title: "自分の AI", assignee: "eiki/agent", run_agent: "claude-code" }),
      ticket({ id: "t6", title: "別の人", assignee: "hana" }),
      ticket({ id: "t7", title: "別の人の AI", assignee: "hana/agent", run_agent: "codex" }),
      ticket({ id: "t8", title: "計画の中", assignee: "bob" }),
    );
    client.data.plans.push(plan({ id: "p7", tickets: ["t8"] }));
    window.location.hash = "#/backlog";
    mount(client, hostOf("sidebar"));
    await screen.findByText("別の人");
    expect(client.calls.some((c) => c.name === "whoami")).toBe(true);
    // 題が「自分」の行は、検索欄の下の「自分」のチップと文字が重なるので、行の題から引く
    const rowOf = (title: string) =>
      screen.getByText(title, { selector: ".row-title" }).closest(".row")!;
    const markOf = (title: string) => rowOf(title).querySelector(".assignee-mark");
    // 名前の列はどの行にも出さず、列がないぶんタイトルが広がる（backlog の行の格子）
    expect(document.querySelector(".row-assignee")).toBeNull();
    expect(rowOf("自分").classList.contains("backlog-row")).toBe(true);
    // 自分と自分の agent の担当は出さない。右端は優先度の札だけ
    expect(markOf("自分")).toBeNull();
    expect(markOf("自分の AI")).toBeNull();
    expect(rowOf("自分").querySelector(".row-end-top")!.innerHTML).toBe(
      '<span class="badge priority-medium">medium</span>',
    );
    // 別の人は頭文字の丸（カンバンと同じ印）。全名はツールチップ
    expect(markOf("別の人")!.querySelector(".assignee-initial")!.textContent).toBe("H");
    expect(markOf("別の人")!.getAttribute("title")).toBe("hana");
    // 別の人の agent は持ち主の丸と汎用のアイコン（文字の札は出さない）。ホバーで主体 ID と Run の agent
    expect(markOf("別の人の AI")!.querySelector(".assignee-initial")!.textContent).toBe("H");
    expect(markOf("別の人の AI")!.textContent).toBe("H");
    expect(markOf("別の人の AI")!.querySelector(".agent-icon svg")).not.toBeNull();
    expect(markOf("別の人")!.querySelector(".agent-icon")).toBeNull();
    expect(markOf("別の人の AI")!.getAttribute("title")).toBe("hana/agent · codex");
    // Plan に入っていれば、上の段の Plan の番号の左に出す（todo で着手可を下の段に出すので、優先度の札は先頭）
    const top = rowOf("計画の中").querySelector(".row-end-top")!;
    expect([...top.children].map((c) => c.className.split(" ")[0])).toEqual([
      "badge",
      "assignee-mark",
      "row-plan",
    ]);
    // 担当なしは何も出さない
    expect(markOf("画面")).toBeNull();
  });

  it("操作している人が別のユーザなら、そのユーザの担当を出さず、eiki の担当を頭文字の丸で出す", async () => {
    const client = mockClient();
    client.handlers["whoami"] = () => ({
      id: "hana",
      user: "hana",
      kind: "human",
      own_ids: ["hana", "hana/agent"],
    });
    client.data.tickets.push(
      ticket({ id: "t4", title: "eiki の", assignee: "eiki" }),
      ticket({ id: "t5", title: "hana の AI", assignee: "hana/agent" }),
    );
    window.location.hash = "#/backlog";
    mount(client, hostOf("sidebar"));
    await screen.findByText("eiki の");
    const markOf = (title: string) =>
      screen.getByText(title).closest(".row")!.querySelector(".assignee-mark");
    await waitFor(() => expect(markOf("hana の AI")).toBeNull());
    expect(markOf("eiki の")!.getAttribute("title")).toBe("eiki");
  });

  it("サイドバーのカンバンの行は担当の名前の列を出さず、右端の上の段（Plan の番号の左）に担当の印を出す。人は頭文字の丸、agent は持ち主の丸と Run の agent によらない汎用のアイコン", async () => {
    const client = boardClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "人", assignee: "eiki", iteration: "s0" }),
      ticket({
        id: "t5",
        title: "Claude",
        assignee: "eiki/agent",
        run_agent: "claude-code",
        iteration: "s0",
      }),
      ticket({
        id: "t6",
        title: "Codex",
        assignee: "hana/agent",
        run_agent: "codex",
        iteration: "s0",
      }),
      ticket({
        id: "t7",
        title: "汎用",
        assignee: "eiki/agent",
        run_agent: "my-bot",
        iteration: "s0",
      }),
      ticket({ id: "t8", title: "Run なし", assignee: "eiki/agent", iteration: "s0" }),
    );
    client.data.plans.push(plan({ id: "p7", tickets: ["t5"] }));
    mount(client, hostOf("sidebar"));
    await screen.findByText("Run なし");
    expect(document.querySelector(".row-assignee")).toBeNull();
    const markOf = (title: string) => kanbanRowOf(title).querySelector(".assignee-mark");
    const iconOf = (title: string) =>
      markOf(title)!.querySelector(".agent-icon svg")?.outerHTML ?? null;
    // 人：頭文字の丸だけ。ホバーで主体 ID
    expect(markOf("人")!.querySelector(".assignee-initial")!.textContent).toBe("E");
    expect(iconOf("人")).toBeNull();
    expect(markOf("人")!.getAttribute("title")).toBe("eiki");
    // agent：持ち主の丸と汎用のアイコン（文字は出さない）。Run の agent によらず同じ形で、ホバーで主体 ID と Run の agent
    expect(markOf("Claude")!.textContent).toBe("E");
    expect(iconOf("Claude")).not.toBeNull();
    expect(markOf("Claude")!.getAttribute("title")).toBe("eiki/agent · claude-code");
    expect(markOf("Claude")!.getAttribute("aria-label")).toBe("eiki/agent · claude-code");
    expect(markOf("Codex")!.textContent).toBe("H");
    expect(["Codex", "汎用", "Run なし"].map(iconOf)).toEqual(Array(3).fill(iconOf("Claude")));
    expect(markOf("汎用")!.getAttribute("title")).toBe("eiki/agent · my-bot");
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
    const client = boardClient();
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
    mount(boardClient());
    await screen.findByText("画面");
    expect(document.querySelector(".row.changed")).toBeNull();
  });

  it("節の開閉は host.state に残り、開き直しても保たれる", async () => {
    const host = hostOf("sidebar");
    mount(boardClient(), host);
    await screen.findByText("ログイン");
    const done = document.querySelector<HTMLDetailsElement>('details[data-status="done"]')!;
    expect(done.open).toBe(false);
    done.open = true;
    fireEvent(done, new Event("toggle"));
    expect(host.state.get("board.section.done")).toBe(true);
    cleanup();
    mount(boardClient(), host);
    await screen.findByText("ログイン");
    expect(document.querySelector<HTMLDetailsElement>('details[data-status="done"]')!.open).toBe(
      true,
    );
  });

  it("サイドバーではカンバンの列が折りたためる節になり、チケットは 1 行で出る。空の節は見出しの 1 行だけで「なし」は出さない", async () => {
    mount(boardClient(), hostOf("sidebar"));
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
    mount(boardClient(), hostOf("sidebar"));
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
    const client = boardClient();
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

  it("サイドバーのカンバンの行は、開いた Plan に入っていれば右端に Plan の番号を Plan の色で出し、todo なら着手可・待ちの相手・承認待ちを出す", async () => {
    const client = boardClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "待つ", priority: "high", iteration: "s0" }),
      ticket({ id: "t5", title: "外", priority: "low", iteration: "s0" }),
      ticket({ id: "t6", title: "閉じた計画", iteration: "s0" }),
      ticket({ id: "t7", title: "承認前", iteration: "s0" }),
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
  });

  it("サイドバーのバックログの行は、開いた Plan に入っていればカンバンと同じ Plan の番号と着手可・待ちの相手・承認待ちを出し、入っていない行には優先度の札だけを出す", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "今", status: "active" })];
    client.data.tickets = [
      ticket({ id: "t1", title: "前", status: "in_progress", iteration: "s1" }),
      ticket({ id: "t2", title: "着手できる", iteration: "s1" }),
      ticket({ id: "t3", title: "待つ", priority: "high", iteration: "s1" }),
      ticket({ id: "t4", title: "外", iteration: "s1" }),
      ticket({ id: "t5", title: "閉じた計画", iteration: "s1" }),
      ticket({ id: "t6", title: "承認前", iteration: "s1" }),
    ];
    client.data.plans.push(
      plan({ id: "p7", tickets: ["t1", "t2", "t3"], after: { t3: ["t1"] } }),
      plan({ id: "p8", tickets: ["t5"], status: "closed" }),
      plan({ id: "p9", tickets: ["t6"], status: "pending" }),
    );
    mount(client, hostOf("sidebar"));
    await screen.findByText("待つ");
    const rowOf = (title: string) => screen.getByText(title).closest(".row")!;
    const endOf = (title: string) => rowOf(title).querySelector(".row-end");

    // in_progress：上の段は Plan の番号、下の段は優先度の札（着手可・待ちは todo の行だけ）
    expect(endOf("前")!.querySelector(".row-plan")!.textContent).toBe("p7");
    expect(endOf("前")!.querySelector(".row-plan")!.classList.contains("plan-color-2")).toBe(true);
    expect(endOf("前")!.querySelector(".row-end-sub")!.textContent).toBe("medium");
    expect(endOf("着手できる")!.querySelector(".row-ready")!.textContent).toBe("着手可");
    const wait = endOf("待つ")!;
    expect(wait.querySelector(".row-wait")!.textContent).toBe("t1 待ち");
    expect(wait.querySelector(".row-wait")!.getAttribute("title")).toBe("t1 を待っている");
    // 下の段に待ちを出すので、優先度の札は上の段の Plan の番号の左
    expect(wait.querySelector(".row-end-top")!.textContent).toBe("highp7");
    expect(endOf("承認前")!.querySelector(".row-wait")!.textContent).toBe("承認待ち");
    // Plan に入っていない・閉じた Plan の行は右端に優先度の札だけを出す
    for (const title of ["外", "閉じた計画"]) {
      // 札は .row-end で包み、Plan の行の札と同じ高さにする
      expect(endOf(title)!.querySelector(".row-end-sub")).toBeNull();
      expect(endOf(title)!.querySelector(".row-end-top")!.innerHTML).toBe(
        '<span class="badge priority-medium">medium</span>',
      );
    }
    // 左の優先度の印は出さない
    expect(document.querySelector(".priority-mark")).toBeNull();
  });

  it("サイドバーの Iteration のないバックログの行にも Plan の番号と着手可を出し、Plan の外の行は優先度の札だけ", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "待つ", priority: "high" }),
      ticket({ id: "t5", title: "外", priority: "high" }),
    );
    client.data.plans.push(plan({ id: "p7", tickets: ["t3", "t4"], after: { t4: ["t3"] } }));
    mount(client, hostOf("sidebar"));
    await screen.findByText("待つ");
    const rowOf = (title: string) => screen.getByText(title).closest(".row")!;
    const wait = rowOf("待つ").querySelector(".row-end")!;
    expect(wait.querySelector(".row-wait")!.textContent).toBe("t3 待ち");
    expect(rowOf("画面").querySelector(".row-ready")!.textContent).toBe("着手可");
    // 下の段に待ちを出すので、優先度の札は上の段の Plan の番号の左
    expect(wait.querySelector(".row-end-top")!.textContent).toBe("highp7");
    expect(rowOf("外").querySelector(".row-end-top")!.textContent).toBe("high");
    expect(rowOf("外").querySelector(".row-end-sub")).toBeNull();
  });

  it("サイドバーのバックログの行に右クリックのメニューの文脈（data-vscode-context）を付け、ドラッグの行はそのまま", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations.push(iteration({ id: "s1", name: "最初", status: "active" }));
    client.data.tickets.push(ticket({ id: "t4", title: "入った", iteration: "s1" }));
    mount(client, hostOf("sidebar"));
    await screen.findByText("入った");
    const contextOf = (title: string) =>
      JSON.parse(screen.getByText(title).closest("li")!.getAttribute("data-vscode-context")!);
    expect(contextOf("入った")).toEqual({
      webviewSection: "backlogTicket",
      ticket: "t4",
      iteration: "s1",
      project: "default",
      preventDefaultContextMenuItems: true,
    });
    expect(contextOf("画面")).toMatchObject({ ticket: "t3", iteration: null });
    // 見た目は変えない：行はドラッグできる行のまま
    expect(screen.getByText("入った").closest(".row-drag")).not.toBeNull();
  });

  it("サイドバーのカンバンの行には右クリックのメニューの文脈を付けない", async () => {
    mount(boardClient(), hostOf("sidebar"));
    await screen.findByText("ログイン");
    expect(document.querySelector("[data-vscode-context]")).toBeNull();
  });

  it("サイドバーのカンバンの行の頭に、実行中の Run があれば回るリングと「実行中」を、Run のない in_progress なら止まった半分塗りの丸を出し、読み直しで変わる", async () => {
    const client = boardClient();
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
    const client = boardClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "待つ", iteration: "s0" }),
      ticket({ id: "t5", title: "外", iteration: "s0" }),
      ticket({ id: "t7", title: "承認前", iteration: "s0" }),
      ticket({ id: "t8", title: "待ちで実行中", iteration: "s0" }),
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
    const client = boardClient();
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

  it("実行中の Run を読み終えるまでは待ちの行を薄くせず、読み終えると実行中でない待ちの行だけ薄くする", async () => {
    const client = boardClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "待つ", iteration: "s0" }),
      ticket({ id: "t8", title: "待ちで実行中", iteration: "s0" }),
    );
    client.data.plans.push(
      plan({ id: "p7", tickets: ["t2", "t4", "t8"], after: { t4: ["t2"], t8: ["t2"] } }),
    );
    let finish: (runs: RunView[]) => void = () => {};
    client.handlers["run.list"] = () => new Promise<RunView[]>((resolve) => (finish = resolve));
    render(
      <StoreProvider client={client} readRunning>
        <HostProvider host={hostOf("sidebar")}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("待つ");
    await waitFor(() => expect(client.calls.some((c) => c.name === "run.list")).toBe(true));
    const dimmed = (title: string) =>
      kanbanRowOf(title).closest(".row-drag")!.classList.contains("is-waiting");
    // 読み終える前：待ちの印は出すが、どの行も薄くしない
    await waitFor(() =>
      expect(kanbanRowOf("待つ").querySelector(".row-wait")!.textContent).toBe("t2 待ち"),
    );
    expect(dimmed("待つ")).toBe(false);
    expect(dimmed("待ちで実行中")).toBe(false);
    // 読み終えた後：実行中でない待ちの行だけ薄くする
    act(() => finish([runningRun("t8")]));
    await waitFor(() => expect(dimmed("待つ")).toBe(true));
    expect(kanbanRowOf("待ちで実行中").querySelector(".activity-running")).toBeTruthy();
    expect(dimmed("待ちで実行中")).toBe(false);
  });

  it("readRunning でなければ（左パネルでなければ）実行中の Run を読まず、行に頭の印を出さない", async () => {
    const client = boardClient();
    mount(client, hostOf("sidebar"));
    await screen.findByText("API");
    expect(client.calls.some((c) => c.name === "run.list")).toBe(false);
    expect(document.querySelector(".activity-mark")).toBeNull();
  });

  it("広い画面のカンバンのカードには Run の印を出さない", async () => {
    const client = boardClient();
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
    const client = boardClient();
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
    const client = boardClient();
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
    const client = boardClient();
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
      mount(boardClient(), hostOf("sidebar"));
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
    // 目標のある s1 は目標を 1 段目に出し、名前は 2 段目に出す
    expect(names()).toEqual(["次", "core"]);
    const rowOf = (id: string) =>
      [...document.querySelectorAll(".history-row")].find(
        (r) => r.querySelector("code")?.textContent === id,
      )!;
    const chips = (id: string) =>
      [...rowOf(id).querySelectorAll(".counts .badge")].map((b) => b.textContent);
    expect(chips("s1")).toEqual(["完了 3", "持ち越し 1"]);
    expect(rowOf("s1").querySelector("small")!.textContent).toBe(
      "最初 ・ 2026-09-29 〜 2026-10-10 ・ 内訳: Epic なし 1",
    );
    // s2 には閉じたときの記録がないので、web で数え直さず「—」と出し、持ち越しのチップは出さない
    expect(chips("s2")).toEqual(["完了 —"]);
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "ログイン" } });
    expect(names()).toEqual(["core"]);
    // 件数の行はなく、見方のバッジが「当たった数 / 全体」になる
    expect(screen.queryByText(/件$/, { selector: ".toolbar span" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Iteration/ }).textContent).toBe(
      "Iteration 1\u2009/\u20092",
    );
    fireEvent.click(screen.getByText("s1"));
    expect(opened).toEqual([{ page: "iterations", id: "s1" }]);
    // 検索語はハッシュに入り、詳細はホストに開いてもらうので履歴の画面のまま
    expect(parseRoute(window.location.hash)).toEqual({ page: "history", q: "ログイン" });
  });

  it("サイドバーの履歴の Iteration の行は期間の記録がなければ何も書かず、終わったチケットの Epic ごとの件数と中止のチップが出て、開くと番号の順の 1 本の一覧で終わったチケットが出て、最後に持ち越しが出る", async () => {
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
    expect(row.querySelector("small")!.textContent).toBe("内訳: e1 2");
    expect([...row.querySelectorAll(".counts .badge")].map((b) => b.textContent)).toEqual([
      "完了 —",
      "中止 1",
    ]);
    expect(row.querySelector(".count-abandoned")).toBeTruthy();
    const item = document.querySelector<HTMLDetailsElement>("details.history-item")!;
    expect(item.open).toBe(false);
    expect(item.classList.contains("fold")).toBe(true);
    item.open = true;
    fireEvent(item, new Event("toggle"));
    await waitFor(() => expect(item.querySelector(".history-carried")).toBeTruthy());
    const lists = [...item.querySelectorAll(".history-list")].map((l) =>
      [...l.querySelectorAll(".row code")].map((c) => c.textContent),
    );
    expect(lists).toEqual([["t1", "t4"], ["t6"]]);
    expect(item.querySelector(".history-carried h3")!.textContent).toBe("持ち越し 1 件");
    expect(item.querySelector(".history-carried .history-ticket-meta")!.textContent).toBe(
      "Epic なし ・ PR なし ・ 今は s2",
    );
    fireEvent.click(item.querySelector(".history-list .row")!);
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
    fireEvent.click(screen.getByRole("button", { name: /^Epic/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/history?view=epic"));
    const names = () =>
      [...document.querySelectorAll(".history-row .name")].map((e) => e.textContent);
    await waitFor(() => expect(names()).toEqual(["新しい", "古い"]));
    expect(screen.getByRole("button", { name: /^Epic/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Iteration/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(document.querySelector(".history-row small")!.textContent).toBe(
      "2026-10-20 に閉じた ・ s1",
    );
    expect(screen.getByRole("link", { name: "s1" }).getAttribute("href")).toBe("#/iterations/s1");
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "t1" } });
    expect(names()).toEqual(["新しい"]);
    expect(screen.getByRole("button", { name: /^Epic/ }).textContent).toBe("Epic 1\u2009/\u20092");
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

  it("履歴のチケットの見方は終わったチケットを終えた新しい順に出し、分からないものは更新日で並べてそう出す。結果・検索で絞れ、Epic のセレクトはない", async () => {
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
    expect(screen.getByRole("button", { name: /^チケット/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // 絞り込みがなければバッジは全体の件数
    expect(screen.getByRole("button", { name: /^チケット/ }).textContent).toBe("チケット 3");
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
    // 結果の絞り込みもチケットのバッジに映す
    expect(screen.getByRole("button", { name: /^チケット/ }).textContent).toBe(
      "チケット 1\u2009/\u20093",
    );
    fireEvent.change(screen.getByLabelText("結果"), { target: { value: "" } });
    expect(screen.queryByLabelText("Epic")).toBeNull();
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "web" } });
    expect(ids()).toEqual(["t2"]);
    expect(screen.getByRole("button", { name: /^チケット/ }).textContent).toBe(
      "チケット 1\u2009/\u20093",
    );
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

  it("サイドバーのバックログは検索欄の右端の漏斗で絞り込みの欄を開閉し、漏斗は条件が効いている間だけ色付き。件数は絞っているときだけ「n / m 件」でチップの行の右端に出て、消すボタンは条件があるときだけ", async () => {
    window.location.hash = "#/backlog";
    const host = hostOf("sidebar");
    mount(mockClient(), host);
    await screen.findByText("API");
    expect(screen.getByLabelText("検索")).toBeTruthy();
    expect(document.querySelector("details.filters")).toBeNull();
    const funnel = () => screen.getByRole("button", { name: /^絞り込み(（絞っている）)?$/ });
    const fields = () => document.getElementById("backlog-filters");
    const count = () => document.querySelector(".quick-filters .count")?.textContent ?? null;
    // 漏斗は検索欄と同じ行の右端にある
    expect(funnel().previousElementSibling).toBe(screen.getByLabelText("検索"));
    expect(count()).toBeNull();
    expect(document.querySelector(".toolbar > .muted")).toBeNull();
    expect(fields()).toBeNull();
    expect(funnel().getAttribute("aria-expanded")).toBe("false");
    expect(funnel().classList.contains("active")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /最初の版/ }));
    expect(count()).toBe("1 / 2 件");
    expect(funnel().classList.contains("active")).toBe(true);
    expect(funnel().getAttribute("aria-label")).toBe("絞り込み（絞っている）");
    // Epic の条件は Epic のチップで見えているので、札にはしない
    expect(document.querySelector(".quick-filters .filter-chip")).toBeNull();
    fireEvent.click(funnel());
    expect(host.state.get("backlog.filters")).toBe(true);
    expect(funnel().getAttribute("aria-expanded")).toBe("true");
    expect(funnel().getAttribute("aria-controls")).toBe("backlog-filters");
    expect(within(fields()!).getByRole("button", { name: "絞り込みを消す" })).toBeTruthy();
    fireEvent.click(funnel());
    expect(host.state.get("backlog.filters")).toBe(false);
    expect(fields()).toBeNull();
  });

  it("サイドバーのバックログの区画は、行の右端に優先度の札を付け、見出しを状態の帯と 2 段（番号・名前・件数／状態・月日の期間・目標）にし、「…」と開始・閉じるを出さない", async () => {
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
    expect([...s1!.querySelectorAll(".row .badge")].map((m) => m.textContent)).toEqual([
      "high",
      "medium",
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

  it("サイドバーのバックログの行は区画の中も区画なしの一覧も右端に low・medium・high の札を出し、low の区切りの行を入れず、状態の丸印は todo だけ白抜きにする", async () => {
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
      ticket({ id: "t5", title: "区画の外", priority: "low" }),
    ];
    mount(client, hostOf("sidebar"));
    await screen.findByText("高い");
    const [s1, none] = [
      ...document.querySelectorAll<HTMLDetailsElement>("details.backlog-section"),
    ];
    const list = s1!.querySelector("ul.rows")!;
    expect(list.classList.contains("backlog-rows")).toBe(true);
    // 行だけが並び、low の始まりに区切りの行を入れない
    expect([...list.children].map((li) => li.querySelector("code")!.textContent)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
    expect(document.querySelector(".priority-sep")).toBeNull();
    expect(document.querySelector(".priority-mark")).toBeNull();
    // 右端（行の格子の最後のセル。.row-end で包み、札の高さを揃える）にカンバンと同じ優先度の札
    const ends = [...list.querySelectorAll(".row")].map((r) =>
      r.lastElementChild!.querySelector(".row-end-top > .badge")!,
    );
    expect(ends.map((e) => [e.className, e.textContent])).toEqual([
      ["badge priority-high", "high"],
      ["badge priority-medium", "medium"],
      ["badge priority-low", "low"],
      ["badge priority-low", "low"],
    ]);
    // 「Iteration なし」の区画の行も同じ
    expect(none!.querySelector(".row > .row-end .badge")!.className).toBe("badge priority-low");
    // 状態の丸印は 3 種の状態で別のクラス。カンバンの Run の印（activity-mark）は出さない
    expect([...list.querySelectorAll(".status-dot")].map((d) => d.className)).toEqual([
      "status-dot status-review",
      "status-dot status-in_progress",
      "status-dot status-in_progress",
      "status-dot status-todo",
    ]);
    expect(list.querySelector(".activity-mark")).toBeNull();
  });

  it("サイドバーの Iteration のないバックログ（区画なし）の行も右端に優先度の札を出し、todo の丸を白抜きにする", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations = [];
    client.data.tickets = [
      ticket({ id: "t1", title: "高い", priority: "high" }),
      ticket({ id: "t2", title: "低い", priority: "low" }),
    ];
    mount(client, hostOf("sidebar"));
    await screen.findByText("低い");
    expect(document.querySelector("details.backlog-section")).toBeNull();
    const list = document.querySelector("ul.rows")!;
    expect(list.classList.contains("backlog-rows")).toBe(true);
    expect([...list.querySelectorAll(".row")].map((r) => r.lastElementChild!.textContent)).toEqual([
      "high",
      "low",
    ]);
    expect(document.querySelector(".priority-sep")).toBeNull();
  });

  it("サイドバーのバックログは open の Epic が 0 本なら Epic の欄を出さない", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.epics = client.data.epics.map((e) => ({ ...e, status: "closed" as const }));
    mount(client, hostOf("sidebar"));
    await screen.findByText("API");
    expect(document.querySelector(".epic-chips")).toBeNull();
    expect(screen.queryByRole("group", { name: "Epic で絞る" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Epic なし/ })).toBeNull();
  });

  it("サイドバーのバックログは検索欄の下に「自分」「作業中」「high」のチップを 1 行で出し、押すと絞り、効いているチップは塗る。もう一度押すと外れる", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "設定", status: "review", priority: "high" }),
    );
    mount(client, hostOf("sidebar"));
    await screen.findByText("API");
    const group = screen.getByRole("group", { name: "絞り込み" });
    // 検索欄の toolbar のすぐ後に置く
    expect(group.previousElementSibling!.querySelector("input[type=search]")).toBeTruthy();
    const chip = (name: string) => within(group).getByRole("button", { name });
    expect(
      [...group.querySelectorAll(".chip")].map((c) => [
        c.textContent,
        c.getAttribute("aria-pressed"),
      ]),
    ).toEqual([
      ["自分", "false"],
      ["作業中", "false"],
      ["high", "false"],
    ]);
    const count = () => document.querySelector(".quick-filters .count")?.textContent ?? null;
    fireEvent.click(chip("作業中"));
    expect(chip("作業中").getAttribute("aria-pressed")).toBe("true");
    expect(count()).toBe("1 / 3 件");
    expect(screen.queryByText("画面")).toBeNull();
    expect(screen.queryByText("設定")).toBeNull();
    fireEvent.click(chip("作業中"));
    expect(chip("作業中").getAttribute("aria-pressed")).toBe("false");
    expect(count()).toBeNull();
    fireEvent.click(chip("high"));
    expect(chip("high").getAttribute("aria-pressed")).toBe("true");
    expect(count()).toBe("2 / 3 件");
    expect(screen.getByText("設定")).toBeTruthy();
    expect(screen.queryByText("画面")).toBeNull();
    // 「作業中」と「high」の条件はチップで見えているので、× の札にはしない
    expect(group.querySelector(".filter-chip")).toBeNull();
  });

  it("サイドバーのバックログの「自分」のチップは、操作している人（whoami）か、その人の agent が担当のチケットに絞る", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "本人の", assignee: "eiki" }),
      ticket({ id: "t5", title: "本人の AI の", assignee: "eiki/agent" }),
      ticket({ id: "t6", title: "別の人の", assignee: "hana" }),
    );
    mount(client, hostOf("sidebar"));
    await screen.findByText("本人の");
    const group = screen.getByRole("group", { name: "絞り込み" });
    const mine = within(group).getByRole("button", { name: "自分" });
    expect(mine.getAttribute("title")).toBe("自分か自分の agent の担当 で絞る");
    fireEvent.click(mine);
    expect(mine.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("本人の")).toBeTruthy();
    expect(screen.getByText("本人の AI の")).toBeTruthy();
    expect(screen.queryByText("別の人の")).toBeNull();
    expect(screen.queryByText("API")).toBeNull();
    expect(document.querySelector(".quick-filters .count")!.textContent).toBe("2 / 5 件");
    // 「自分」はチップで見えているので札にしない。「絞り込みを消す」で外れる
    expect(group.querySelector(".filter-chip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^絞り込み(（絞っている）)?$/ }));
    fireEvent.click(screen.getByRole("button", { name: "絞り込みを消す" }));
    expect(mine.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("別の人の")).toBeTruthy();
  });

  it("サイドバーのバックログは、選んだ Epic のチップが Epic の欄に出ていなければ、Epic の条件を × の札にする", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    const send = mountWithBridge(client, { readRunning: false });
    await screen.findByText("API");
    const group = screen.getByRole("group", { name: "絞り込み" });
    fireEvent.click(screen.getByRole("button", { name: /最初の版/ }));
    // Epic の欄にチップがある間は札にしない
    expect(group.querySelector(".filter-chip")).toBeNull();
    // Epic が閉じて欄から消えたら、効いている条件を札で見せる
    client.data.epics = client.data.epics.map((e) => ({ ...e, status: "closed" as const }));
    act(() => send()({ kind: "event", name: "reload" }));
    await waitFor(() => expect(document.querySelector(".epic-chips")).toBeNull());
    expect(group.querySelector(".filter-chip-text")!.textContent).toBe("Epic e1");
    fireEvent.click(screen.getByRole("button", { name: "Epic e1 の絞り込みを外す" }));
    expect(group.querySelector(".filter-chip")).toBeNull();
    expect(screen.getByText("画面")).toBeTruthy();
  });

  it("サイドバーのバックログは漏斗で開いた欄で効いている条件を検索欄の下に札で出し、× で外せる。× の読み上げは何を外すかを言う", async () => {
    window.location.hash = "#/backlog";
    mount(mockClient(), hostOf("sidebar"));
    await screen.findByText("API");
    const group = screen.getByRole("group", { name: "絞り込み" });
    fireEvent.click(screen.getByRole("button", { name: /^絞り込み(（絞っている）)?$/ }));
    const fields = document.getElementById("backlog-filters")!;
    const select = (name: string) => within(fields).getByLabelText<HTMLSelectElement>(name);
    fireEvent.change(select("Status"), { target: { value: "todo" } });
    fireEvent.change(select("ラベル"), { target: { value: "web" } });
    const texts = () => [...group.querySelectorAll(".filter-chip-text")].map((c) => c.textContent);
    expect(texts()).toEqual(["Status Todo", "ラベル web"]);
    expect(document.querySelector(".quick-filters .count")!.textContent).toBe("1 / 2 件");
    fireEvent.click(screen.getByRole("button", { name: "ラベル web の絞り込みを外す" }));
    expect(select("ラベル").value).toBe("");
    expect(texts()).toEqual(["Status Todo"]);
    fireEvent.click(screen.getByRole("button", { name: "Status Todo の絞り込みを外す" }));
    expect(select("Status").value).toBe("");
    expect(group.querySelector(".filter-chip")).toBeNull();
    expect(document.querySelector(".quick-filters .count")).toBeNull();
    // 「作業中」以外の Status と「high」以外の優先度は札になる。「作業中」を押すと Status の札は消える
    fireEvent.change(select("優先度"), { target: { value: "low" } });
    expect(texts()).toEqual(["優先度 low"]);
    fireEvent.change(select("Status"), { target: { value: "review" } });
    fireEvent.click(within(group).getByRole("button", { name: "作業中" }));
    expect(texts()).toEqual(["優先度 low"]);
    expect(select("Status").value).toBe("in_progress");
  });

  it("サイドバーのバックログの Epic のチップは番号・題・進捗を出し、押すと絞り、もう一度押すと外れる。「Epic なし」でも絞れる", async () => {
    window.location.hash = "#/backlog";
    mount(mockClient(), hostOf("sidebar"));
    await screen.findByText("API");
    const group = screen.getByRole("group", { name: "Epic で絞る" });
    const chips = [...group.querySelectorAll<HTMLButtonElement>(".chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["e1最初の版0/1", "Epic なし1"]);
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
    expect(document.querySelector(".epic-list")).toBeNull();
    const count = () => document.querySelector(".quick-filters .count")?.textContent ?? null;
    fireEvent.click(chips[0]!);
    expect(chips[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(count()).toBe("1 / 2 件");
    expect(screen.queryByText("画面")).toBeNull();
    fireEvent.click(chips[0]!);
    expect(chips[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(count()).toBeNull();
    fireEvent.click(chips[1]!);
    expect(chips[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("画面")).toBeTruthy();
    expect(screen.queryByText("API")).toBeNull();
  });

  it("サイドバーのバックログの Epic のチップは 2 行で止めて残りを「ほか N」にまとめ、押すとすべて出し「畳む」で戻す。選んだチップは隠さない", async () => {
    // jsdom は配置をしないので、1 行に 3 つ並ぶとして位置を返す
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")!;
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        const row = this.parentElement;
        if (!row?.classList.contains("chip-row")) return 0;
        return Math.floor([...row.children].indexOf(this) / 3) * 20;
      },
    });
    try {
      window.location.hash = "#/backlog";
      const client = mockClient();
      const base = client.data.epics[0]!;
      client.data.epics = [1, 2, 3, 4, 5, 6].map((n) => ({ ...base, id: `e${n}`, title: `E${n}` }));
      mount(client, hostOf("sidebar"));
      await screen.findByText("API");
      const group = screen.getByRole("group", { name: "Epic で絞る" });
      const labels = () =>
        [...group.querySelectorAll(".chip")].map(
          (c) => c.querySelector("code")?.textContent ?? c.textContent,
        );
      // 6 本と「Epic なし」で 3 行になるので、2 行目の終わりに「ほか N」を置ける数まで減らす
      await waitFor(() => expect(labels()).toEqual(["e1", "e2", "e3", "e4", "e5", "ほか 2"]));
      const more = screen.getByRole("button", { name: "Epic をあと 2 本出す" });
      expect(more.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(more);
      expect(labels()).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "Epic なし1", "畳む"]);
      const less = screen.getByRole("button", { name: "Epic を畳む" });
      expect(less.getAttribute("aria-expanded")).toBe("true");
      // 隠れる側の e6 を選んで畳むと、e6 を出す分の最後に回す
      fireEvent.click(screen.getByRole("button", { name: /E6/ }));
      fireEvent.click(less);
      await waitFor(() => expect(labels()).toEqual(["e1", "e2", "e3", "e4", "e6", "ほか 2"]));
      const e6 = [...group.querySelectorAll(".chip")].find((c) => c.textContent?.startsWith("e6"))!;
      expect(e6.getAttribute("aria-pressed")).toBe("true");
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetTop", original);
    }
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
    const client = boardClient();
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
    const client = mockClient(fixture({ tickets: [] }));
    mount(client);
    expect(screen.getByText("読み込み中…")).toBeTruthy();
    expect(screen.queryByText(/開いた Iteration（planned・active）はない/)).toBeNull();
    await screen.findByText(/開いた Iteration（planned・active）はない/);
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

  it("ブラウザのバックログは絞り込みの欄を検索と同じ行に常に出し、漏斗を出さない。件数は「n 件」", async () => {
    window.location.hash = "#/backlog";
    mount();
    await screen.findByText("API");
    const toolbar = screen.getByLabelText("検索").closest(".toolbar")!;
    for (const name of ["Status", "優先度", "ラベル"])
      expect(within(toolbar as HTMLElement).getByLabelText(name)).toBeTruthy();
    expect(
      within(toolbar as HTMLElement).getByRole("button", { name: "絞り込みを消す" }),
    ).toBeTruthy();
    expect(document.querySelector(".filter-toggle")).toBeNull();
    expect(document.getElementById("backlog-filters")).toBeNull();
    expect(document.querySelector(".quick-filters")).toBeNull();
    expect(document.querySelector(".toolbar > .muted")!.textContent).toBe("2 件");
  });

  it("左パネルのタブはカンバン・バックログ・履歴の 3 つで、#/runs はカンバンとして開く", async () => {
    window.location.hash = "#/runs";
    const client = mockClient();
    mount(client, hostOf("sidebar"));
    await waitFor(() => expect(document.querySelector(".sidebar-head")).toBeTruthy());
    const tabs = screen.getByRole("navigation", { name: "画面" });
    expect([...tabs.querySelectorAll("a")].map((a) => a.textContent)).toEqual([
      "カンバン",
      "バックログ",
      "履歴",
    ]);
    expect(tabs.querySelector("[aria-current=page]")!.textContent).toBe("カンバン");
    expect(client.calls.some((c) => c.name === "metrics.show")).toBe(false);
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
    expect(lines).toEqual(["すべて1/3s11/3+", "今11/15–11/28左パネルを整える", "1/3 done"]);
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

  it("サイドバーのカンバンは「すべて」と planned と active の Iteration を番号順の札で並べ、進み・枠・ツールチップで見分け、押すと切り替わる", async () => {
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
    // 先頭に すべて、閉じた Iteration は出さず番号順に並べ、最後に + を置く
    expect(chips.map((c) => c.textContent)).toEqual(["すべて1/3", "s11/2", "s20/1", "s30/0", "+"]);
    expect(chips.map((c) => c.className)).toEqual([
      "iteration-chip all",
      "iteration-chip active",
      "iteration-chip planned",
      "iteration-chip planned",
      "iteration-chip create",
    ]);
    // 既定は active の札を選び、選んでいる札だけが押された状態
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
      "false",
      null,
    ]);
    expect(chips[1]!.querySelector("svg.ring")).toBeTruthy();
    expect(chips[1]!.title).toBe(
      "s1 今（進行中）\n期間 2026-11-01 〜 2026-11-14\n目標 札で切り替える",
    );
    expect(chips[2]!.title).toBe("s2 次（予定）");

    fireEvent.click(chips[2]!);
    await waitFor(() => expect(window.location.hash).toContain("iteration=s2"));
    await screen.findByText("画面");
    expect(screen.queryByText("API")).toBeNull();
    expect(
      [...document.querySelectorAll(".iteration-chip")].map((c) => c.getAttribute("aria-pressed")),
    ).toEqual(["false", "false", "true", "false", null]);
    expect(document.querySelector(".sidebar-head .head-line.sub .name")!.textContent).toBe("次");
  });

  it("サイドバーのカンバンの「すべて」は planned と active の Iteration のチケットを数えて出し、Iteration に入っていないチケットと閉じた Iteration のチケットは出さない。「なし」の札はない", async () => {
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s1", name: "今", status: "active" }),
      iteration({ id: "s2", name: "次", status: "planned" }),
      iteration({ id: "s0", name: "前", status: "closed" }),
    ];
    client.data.tickets[0]!.iteration = "s0";
    client.data.tickets[1]!.iteration = "s1";
    client.data.tickets[2]!.iteration = "s2";
    client.data.tickets.push(ticket({ id: "t4", title: "入っていない" }));
    client.data.plans.push(
      plan({ id: "p1", tickets: ["t1"], status: "closed" }),
      plan({ id: "p2", tickets: ["t2", "t4"], status: "closed" }),
      plan({ id: "p3", tickets: ["t4"] }),
    );
    mount(client, hostOf("sidebar"));
    await screen.findByText("API");
    expect(document.querySelector(".iteration-chip.loose")).toBeNull();
    const all = document.querySelector<HTMLButtonElement>(".iteration-chip.all")!;
    expect(all.textContent).toBe("すべて0/2");
    fireEvent.click(all);
    await waitFor(() => expect(window.location.hash).toContain("iteration=*"));
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".sidebar-head .head-line.sub .name")!.textContent).toBe(
      "planned・active のすべて",
    );
    await screen.findByText("画面");
    expect(kanbanRowOf("API")).toBeTruthy();
    expect(kanbanRowOf("画面")).toBeTruthy();
    expect(kanbanRowOf("入っていない")).toBeUndefined();
    expect(kanbanRowOf("ログイン")).toBeUndefined();
    // 帯は範囲のチケットを含む Plan だけ。範囲の閉じた Plan は「閉じた計画」に畳む
    const band = document.querySelector(".plan-band")!;
    expect(band.querySelector(".plan-closed summary")!.textContent).toBe("閉じた計画 1");
    expect(band.textContent).toContain("p2");
    expect(band.textContent).not.toContain("p1");
    expect(band.textContent).not.toContain("p3");
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
    mount(boardClient(), hostOf("sidebar"));
    await screen.findByText("ログイン");
    expect(document.querySelector(".project-select")).toBeNull();
    cleanup();
    const client = boardClient();
    client.data.projects.push({ ...client.data.projects[0]!, id: "other", name: "Other" });
    mount(client, hostOf("sidebar"));
    await screen.findByText("ログイン");
    expect(document.querySelector(".project-select")).toBeTruthy();
  });

  it("サイドバーのカンバンの Epic・担当の欄は漏斗で開き（開閉は host.state）、絞っている間は値の札を出して漏斗を色付きにし、× で外せる", async () => {
    const client = boardClient();
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

  it("開いた Iteration のない Project でも、サイドバーのカンバンの「+」から Iteration を作れる", async () => {
    mount(mockClient(), hostOf("sidebar"));
    await screen.findByText(/開いた Iteration（planned・active）はない/);
    expect(document.querySelector(".sidebar-head .head-line.sub .name")!.textContent).toBe(
      "開いた Iteration はない",
    );
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
      "s2 次予定0 件s1 が進行中開始する閉じる",
      "Iteration なし1 件+ Iteration を作る",
    ]);
    expect(sections[1]!.querySelector("table")).toBeNull();
    // ほかに active（s1）があるので開始は押せず、title に理由を出す（IT-1）
    const start = screen.getByRole("button", { name: "開始する" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toContain("s1 今 が進行中なので s2 を開始できない");
    fireEvent.click(start);
    expect(client.calls.some((c) => c.name === "iteration.start")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "+ Iteration を作る" }));
    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "その次" } });
    fireEvent.click(screen.getByRole("button", { name: "作る" }));
    await waitFor(() => expect(client.calls.some((c) => c.name === "iteration.create")).toBe(true));
  });

  it("バックログの見出しの開始は、ほかに active がなければ押せて開始する", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s1", name: "前", status: "closed" }),
      iteration({ id: "s2", name: "次", status: "planned" }),
    ];
    client.handlers["iteration.start"] = (input) => input;
    mount(client);
    await screen.findByText("API");
    expect(screen.queryByText(/が進行中/)).toBeNull();
    const start = screen.getByRole("button", { name: "開始する" }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    expect(start.title).toBe("");
    fireEvent.click(start);
    await waitFor(() =>
      expect(client.calls.find((c) => c.name === "iteration.start")?.input).toEqual({
        iteration: "s2",
      }),
    );
  });

  it("Iteration 詳細の開始・再開は、ほかに active があると押せず、理由を文と title に出す", async () => {
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s1", name: "今", status: "active" }),
      iteration({ id: "s2", name: "次", status: "planned" }),
      iteration({ id: "s0", name: "前", status: "closed" }),
    ];
    client.handlers["iteration.show"] = (input) => ({
      ...client.data.iterations.find((i) => i.id === (input as { iteration: string }).iteration),
      items: [],
    });
    window.location.hash = "#/iterations/s2";
    mount(client);
    const start = (await screen.findByRole("button", { name: "開始する" })) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe(
      "s1 今 が進行中なので s2 を開始できない（進行中の Iteration は Project に 1 つ）。先に s1 を閉じる",
    );
    expect(screen.getByText(start.title).tagName).toBe("P");
    cleanup();
    window.location.hash = "#/iterations/s0";
    mount(client);
    const reopen = (await screen.findByRole("button", { name: "再開する" })) as HTMLButtonElement;
    expect(reopen.disabled).toBe(true);
    expect(reopen.title).toContain("s1 今 が進行中なので s0 を再開できない");
    fireEvent.click(reopen);
    expect(client.calls.some((c) => c.name === "iteration.reopen")).toBe(false);
  });

  it("Iteration 詳細の再開は、ほかに active がなければ押せて再開する。active の詳細には理由の文を出さない", async () => {
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s0", name: "前", status: "closed" })];
    client.handlers["iteration.show"] = () => ({ ...client.data.iterations[0], items: [] });
    client.handlers["iteration.reopen"] = (input) => input;
    window.location.hash = "#/iterations/s0";
    mount(client);
    const reopen = (await screen.findByRole("button", { name: "再開する" })) as HTMLButtonElement;
    expect(reopen.disabled).toBe(false);
    expect(screen.queryByText(/が進行中/)).toBeNull();
    fireEvent.click(reopen);
    await waitFor(() =>
      expect(client.calls.find((c) => c.name === "iteration.reopen")?.input).toEqual({
        iteration: "s0",
      }),
    );
    // active の詳細は開始・再開のボタンがないので、ほかに active があっても（壊れたデータ）理由の文を出さない
    cleanup();
    client.data.iterations = [
      iteration({ id: "s1", name: "今", status: "active" }),
      iteration({ id: "s2", name: "も", status: "active" }),
    ];
    client.handlers["iteration.show"] = (input) => ({
      ...client.data.iterations.find((i) => i.id === (input as { iteration: string }).iteration),
      items: [],
    });
    window.location.hash = "#/iterations/s2";
    mount(client);
    await screen.findByRole("button", { name: "閉じる" });
    expect(screen.queryByText(/が進行中/)).toBeNull();
    expect(screen.queryByRole("button", { name: /開始する|再開する/ })).toBeNull();
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

  it("エディタのパネルで Epic の詳細を出すときもヘッダーを出さない", async () => {
    window.location.hash = "#/epics/e1";
    const client = mockClient();
    client.handlers["epic.show"] = () => ({ ...client.data.epics[0], body: "", tickets: [] });
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: /e1 最初の版/ });
    expect(screen.queryByRole("navigation", { name: "画面" })).toBeNull();
  });
});

describe("上のタブの行き先", () => {
  const tab = (name: string) => screen.getByRole("link", { name });
  /** Iteration と Epic のある Project。s1 は active、s2 は planned、s4 は closed。e9 は閉じた Epic */
  function navClient() {
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s1", name: "sprint1", status: "active" }),
      iteration({ id: "s2", name: "sprint2" }),
      iteration({ id: "s4", name: "sprint4", status: "closed" }),
    ];
    client.data.epics.push({
      ...client.data.epics[0]!,
      id: "e9",
      title: "済んだ",
      status: "closed",
    });
    for (const t of client.data.tickets) t.iteration = "s2";
    client.data.tickets[1]!.assignee = "eiki/agent";
    client.handlers["metrics.show"] = () => null;
    return client;
  }
  /** 見た目の状態に残したハッシュを置いた Host */
  function hostWith(saved: Record<string, unknown>): Host {
    const host = hostOf("browser");
    for (const [key, value] of Object.entries(saved)) host.state.set(key, value);
    return host;
  }

  it("カンバンで Iteration・Epic・担当者を絞ってから他のタブへ移り、カンバンのタブで戻ると同じ絞り込みで出る", async () => {
    mount(navClient(), hostOf("browser"));
    await screen.findByLabelText("Iteration");
    fireEvent.change(screen.getByLabelText("Iteration"), { target: { value: "s2" } });
    await waitFor(() => expect(window.location.hash).toBe("#/board?iteration=s2"));
    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "e1" } });
    await waitFor(() => expect(window.location.hash).toBe("#/board?iteration=s2&epic=e1"));
    fireEvent.change(screen.getByLabelText("担当"), { target: { value: "eiki/agent" } });
    const filtered = "#/board?iteration=s2&epic=e1&assignee=eiki%2Fagent";
    await waitFor(() => expect(window.location.hash).toBe(filtered));
    fireEvent.click(tab("バックログ"));
    await waitFor(() => expect(window.location.hash).toBe("#/backlog"));
    expect(tab("カンバン").getAttribute("href")).toBe(filtered);
    fireEvent.click(tab("カンバン"));
    await waitFor(() => expect(window.location.hash).toBe(filtered));
    expect(screen.getByLabelText<HTMLSelectElement>("Iteration").value).toBe("s2");
    expect(screen.getByLabelText<HTMLSelectElement>("Epic").value).toBe("e1");
    expect(screen.getByLabelText<HTMLSelectElement>("担当").value).toBe("eiki/agent");
  });

  it("Run の集計の単位と Iteration の絞り込みは、他のタブから Run のタブで戻ると残る", async () => {
    window.location.hash = "#/runs?by=iteration&iteration=s2";
    mount(navClient(), hostOf("browser"));
    await waitFor(() => expect(tab("Run").getAttribute("aria-current")).toBe("page"));
    fireEvent.click(tab("カンバン"));
    await waitFor(() => expect(window.location.hash).toBe("#/board"));
    await waitFor(() =>
      expect(tab("Run").getAttribute("href")).toBe("#/runs?by=iteration&iteration=s2"),
    );
    // 履歴のタブも同じ形で残す
    expect(tab("履歴").getAttribute("href")).toBe("#/history");
  });

  it.each([
    ["閉じた Iteration を指すカンバン", "nav.board", "#/board?iteration=s4", "#/board"],
    ["閉じた Epic を指すカンバン", "nav.board", "#/board?epic=e9", "#/board"],
    [
      "前の版の「Iteration なし」（-）を指すカンバン",
      "nav.board",
      "#/board?iteration=-",
      "#/board",
    ],
    [
      "今の Project にない Iteration を指すカンバン",
      "nav.board",
      "#/board?iteration=s7",
      "#/board",
    ],
    ["今の Project にない Iteration を指す Run", "nav.runs", "#/runs?iteration=s7", "#/runs"],
    ["閉じた Iteration を指す Run", "nav.runs", "#/runs?by=iteration&iteration=s4", "#/runs"],
  ])("残したハッシュが%sなら、タブは既定の行き先を指す", async (_, key, href, fallback) => {
    window.location.hash = "#/backlog";
    mount(navClient(), hostWith({ [key]: { project: "default", href } }));
    await screen.findByText("API");
    const name = key === "nav.board" ? "カンバン" : "Run";
    expect(tab(name).getAttribute("href")).toBe(fallback);
  });

  it("残したハッシュが別の Project のもの、または前の版の文字列なら、タブは既定の行き先を指す", async () => {
    window.location.hash = "#/backlog";
    mount(
      navClient(),
      hostWith({
        "nav.board": { project: "other", href: "#/board?iteration=s2" },
        "nav.history": "#/history?view=ticket",
      }),
    );
    await screen.findByText("API");
    expect(tab("カンバン").getAttribute("href")).toBe("#/board");
    expect(tab("履歴").getAttribute("href")).toBe("#/history");
  });

  it("Project を切り替えると、カンバン・履歴・Run のタブは既定の行き先に戻る", async () => {
    window.location.hash = "#/backlog";
    const client = navClient();
    client.data.projects.push({ ...client.data.projects[0]!, id: "other", name: "Other" });
    mount(
      client,
      hostWith({
        "nav.board": { project: "default", href: "#/board?iteration=s2" },
        "nav.history": { project: "default", href: "#/history?view=ticket" },
        "nav.runs": { project: "default", href: "#/runs?by=iteration" },
      }),
    );
    await screen.findByText("API");
    expect(tab("カンバン").getAttribute("href")).toBe("#/board?iteration=s2");
    expect(tab("履歴").getAttribute("href")).toBe("#/history?view=ticket");
    expect(tab("Run").getAttribute("href")).toBe("#/runs?by=iteration");
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "other" } });
    await waitFor(() => expect(tab("カンバン").getAttribute("href")).toBe("#/board"));
    expect(tab("履歴").getAttribute("href")).toBe("#/history");
    expect(tab("Run").getAttribute("href")).toBe("#/runs");
    // 元の Project に戻っても、切り替えの前のハッシュには戻らない
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "default" } });
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>("Project").value).toBe("default"),
    );
    expect(tab("カンバン").getAttribute("href")).toBe("#/board");
  });

  it.each([
    ["カンバン", "#/board?iteration=s2&epic=e1", "#/board"],
    ["Run", "#/runs?by=iteration&iteration=s2", "#/runs"],
  ])(
    "%sの画面にいるまま Project を切り替えると、前の Project の絞り込みを残さず、タブは既定の行き先を指す。絞り直せばまた残す",
    async (name, href, fallback) => {
      window.location.hash = href;
      const client = navClient();
      client.data.projects.push({ ...client.data.projects[0]!, id: "other", name: "Other" });
      mount(client, hostOf("browser"));
      await waitFor(() => expect(tab(name).getAttribute("href")).toBe(href));
      fireEvent.change(screen.getByLabelText("Project"), { target: { value: "other" } });
      await waitFor(() => expect(tab(name).getAttribute("href")).toBe(fallback));
      // 他のタブへ移って戻っても、前の Project の絞り込みに戻らない
      fireEvent.click(tab("バックログ"));
      await waitFor(() => expect(window.location.hash).toBe("#/backlog"));
      expect(tab(name).getAttribute("href")).toBe(fallback);
      // 新しい Project で絞り直したハッシュはまた残す
      const again = name === "カンバン" ? "#/board?iteration=s1" : "#/runs?by=iteration";
      act(() => {
        window.location.hash = again;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      await waitFor(() => expect(tab(name).getAttribute("aria-current")).toBe("page"));
      fireEvent.click(tab("バックログ"));
      await waitFor(() => expect(tab(name).getAttribute("href")).toBe(again));
    },
  );
});
