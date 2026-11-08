// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, INFO_NOTICE_MS } from "./app.js";
import { PICK_SETTLE_MS } from "./components/inline-edit.js";
import { ClientError } from "./client/http.js";
import type { WebviewClient } from "./client/webview.js";
import type { WebviewEvent } from "@deguboard/core";
import { HostBridge, HostProvider, type Host } from "./host.js";
import { parseRoute, type Route } from "./router.js";
import { StoreProvider } from "./store.js";
import {
  boardFixture,
  fixture,
  iteration,
  iterationDetail,
  mockClient,
  plan,
  ticket,
} from "./test-helpers.js";

/** カンバンのテストの client（チケットを active の Iteration に入れた fixture） */
const boardClient = () => mockClient(boardFixture());
import type { RunView } from "./types.js";
import { createUiState, memoryBackend } from "./ui-state.js";

// 履歴の日付の書き方は今に依るので、今を固定する（Date だけ。個別に timer を使う試験は自分で入れ替える）
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-04T12:00:00Z") });
});

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
  return { surface, open, show, copy: async () => {}, state: createUiState(memoryBackend()) };
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
    tools: null,
    session: null,
    review: null,
    waiting_since: null,
    settling_since: null,
    running: true,
    duration_seconds: null,
  } as RunView;
}

/** 左パネルのカンバンの Epic・担当の絞り込みの欄（漏斗）を開いた Host */
function boardFiltersOpen(): Host {
  const host = hostOf("sidebar");
  host.state.set("board.filters", true);
  return host;
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
    copy: async () => {},
    terminals: async () => [],
    sendToTerminal: async () => null,
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
  });

  it("開いた Iteration がなければ、列も帯も出さず、開いた Iteration がないこととバックログへの案内を出す。作るボタンは出さない。「すべて」は選べる", async () => {
    const client = mockClient(
      fixture({ iterations: [iteration({ id: "s1", name: "昔", status: "closed" })] }),
    );
    client.data.tickets[0]!.iteration = "s1";
    client.data.plans.push(plan({ id: "p1", tickets: ["t1"], status: "closed" }));
    mount(client, hostOf("sidebar"));
    await screen.findByText(/開いた Iteration（planned・active）はない/);
    expect(document.querySelector(".board")).toBeNull();
    expect(document.querySelector(".plan-band")).toBeNull();
    expect(screen.queryByText("ログイン")).toBeNull();
    const guide = document.querySelector(".board-empty")!;
    expect(guide.querySelector("a")!.getAttribute("href")).toBe("#/backlog");
    // Iteration を作るのはエージェントに頼む（ADR-027）ので、作るボタンは出さない
    expect(screen.queryByRole("button", { name: "+ Iteration を作る" })).toBeNull();
    expect(guide.querySelector("button")).toBeNull();
    const chips = [...document.querySelectorAll(".iteration-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["すべて0/0"]);
    expect(document.querySelector(".status-band")).toBeNull();
  });

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
  });

  it("Epic の選択肢は open だけ。閉じた Epic は選んでいるときだけ残す", async () => {
    const client = boardClient();
    client.data.epics = [
      ...client.data.epics,
      { ...client.data.epics[0]!, id: "e9", title: "済んだ", status: "closed" },
    ];
    mount(client, boardFiltersOpen());
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
    mount(client, boardFiltersOpen());
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
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "画面" });
    expect(screen.getByText("本文")).toBeTruthy();
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("起票者").nextElementSibling?.textContent).toBe("eiki/agent");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "in_progress" } });
    expect((await screen.findByRole("alert")).textContent).toContain("依存先が終わっていない");
    // タイトルの吹き出しの候補（ask-menu）は読み取りだけなので、書き込みの呼び出しの順からは除く
    expect(client.calls.filter((c) => c.name !== "ask-menu").at(-1)).toMatchObject({
      name: "ticket.move",
      input: { ticket: "t3", status: "in_progress" },
    });
  });

  /**
   * Project の既定（遷移の制約なし）と別に、todo → done を誰にも許さない Workflow strict を持つチケット t9 の client。
   * otherProject なら t9 は workflow を持たず、既定の Workflow が strict の別の Project に入る
   */
  function ownWorkflowClient({ otherProject = false } = {}) {
    const data = fixture({
      tickets: [
        otherProject
          ? ticket({ id: "t9", title: "別の流れ", project: "other" })
          : ticket({ id: "t9", title: "別の流れ", workflow: "strict" }),
      ],
    });
    data.projects.push({
      id: "other",
      name: "Other",
      description: "",
      workflow: "strict",
      status: "active",
    });
    const client = mockClient(data);
    client.handlers["workflow.show"] = (input) =>
      (input as { workflow: string }).workflow === "strict"
        ? {
            definition: {
              id: "strict",
              name: "Strict",
              transitions: [],
              reconcile: [],
              fields: [{ id: "size", label: "規模", type: "string" }],
            },
            labels: { ...data.workflow.labels, todo: "未着手", done: "完了" },
            transitions: [{ from: "todo", to: "done", by: [], requires: [] }],
          }
        : data.workflow;
    return client;
  }
  const statusOptions = () =>
    [...(screen.getByLabelText("Status") as HTMLSelectElement).options].map((o) => o.value);

  it("エディタのパネルの Status の選択は、チケット自身の Workflow の遷移で絞り、by が空の遷移の先を出さない。表示名と任意フィールドもその Workflow のもの", async () => {
    window.location.hash = "#/tickets/t9";
    const client = ownWorkflowClient();
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "別の流れ" });
    await waitFor(() =>
      expect(statusOptions()).toEqual(["todo", "in_progress", "review", "abandoned"]),
    );
    expect(screen.getByLabelText("Status").textContent).toContain("未着手");
    const head = document.querySelector(".detail-meta-status")!;
    expect(head.textContent).toBe("未着手");
    expect(head.querySelector(".status-dot")!.getAttribute("aria-label")).toBe("未着手");
    expect(screen.getByText("なし", { selector: "dt" }).nextElementSibling!.textContent).toContain(
      "規模",
    );
    expect(
      client.calls.some(
        (c) =>
          c.name === "workflow.show" && (c.input as { workflow: string }).workflow === "strict",
      ),
    ).toBe(true);
  });

  it("workflow のないチケットが別の Project にあれば、その Project の既定の Workflow でパネルの Status の選択を絞る", async () => {
    window.location.hash = "#/tickets/t9";
    const client = ownWorkflowClient({ otherProject: true });
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "別の流れ" });
    await waitFor(() =>
      expect(statusOptions()).toEqual(["todo", "in_progress", "review", "abandoned"]),
    );
    expect(document.querySelector(".detail-meta-status")!.textContent).toBe("未着手");
  });

  it("チケットの Workflow が読めなければ理由を通知に出し、パネルの Status の選択は今の Status だけにする", async () => {
    window.location.hash = "#/tickets/t9";
    const client = ownWorkflowClient();
    const show = client.handlers["workflow.show"]!;
    client.handlers["workflow.show"] = (input) => {
      if ((input as { workflow: string }).workflow === "strict")
        throw new ClientError({ code: "NOT_FOUND", message: "Workflow strict が見つからない" });
      return show(input);
    };
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "別の流れ" });
    expect((await screen.findByRole("alert")).textContent).toContain("Workflow strict を読めない");
    expect(statusOptions()).toEqual(["todo"]);
  });

  it("チケットの Workflow が Project の既定と同じなら、チケット詳細で Workflow を引き直さない", async () => {
    window.location.hash = "#/tickets/t3";
    const client = mockClient();
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "画面" });
    expect(statusOptions()).toEqual(["todo", "in_progress", "review", "done", "abandoned"]);
    expect(client.calls.filter((c) => c.name === "workflow.show")).toHaveLength(1);
  });

  it("チケット詳細に Run の節を出す", async () => {
    window.location.hash = "#/tickets/t3";
    const client = mockClient();
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "画面" });
    expect(await screen.findByRole("heading", { level: 2, name: "Run" })).toBeTruthy();
    expect(await screen.findByText("Run はない")).toBeTruthy();
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
    const edit = screen.getByRole("button", { name: "編集" });
    const meta = edit.closest(".detail-meta")!;
    expect(meta.lastElementChild!.contains(edit)).toBe(true);
    expect(meta.closest(".detail-head")).toBe(h1.closest(".detail-head"));
    // 値のない Iteration・担当・PR は帯に出さない
    expect(meta.textContent).toBe("Todomedium編集");
    const created = screen.getByText("作成").nextElementSibling!.querySelector("time")!;
    expect(created.getAttribute("title")).toBe("2026-01-01T00:00:00Z");
    expect(created.textContent).toBe("01-01 00:00");
    expect(screen.queryByText("依存先")).toBeNull();
    expect(screen.queryByText("ブランチ")).toBeNull();
    const empty = screen.getByText("なし", { selector: "dt" }).nextElementSibling!;
    expect(empty.textContent).toBe("Epic・Iteration・依存先・依存元・担当・ブランチ・PR＋足す");
    // 編集のボタンで入力欄になるのはタイトルと本文だけ。属性は入力欄にならず、「なし」の行も残す
    fireEvent.click(edit);
    expect(screen.getByLabelText("タイトル")).toBeTruthy();
    expect(screen.getByLabelText("本文")).toBeTruthy();
    expect(screen.queryByLabelText("Epic")).toBeNull();
    expect(screen.queryByLabelText("優先度")).toBeNull();
    expect(screen.queryByLabelText("ラベル")).toBeNull();
    expect(screen.getByText("なし", { selector: "dt" })).toBeTruthy();
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
      "ラベル・Epic・規模・依存先・依存元・PR＋足す",
    );
    // 「＋足す」で選んだ属性は、値を入れている間だけ見出しの下の行に出る
    fireEvent.click(screen.getByRole("button", { name: "＋足す" }));
    fireEvent.change(screen.getByLabelText("値を入れる属性"), { target: { value: "epic" } });
    expect(groupOf("計画")).toEqual(["Iteration", "Epic", "担当", "優先度"]);
  });

  it("エディタのパネルのチケット詳細は、依存先が終わっていなければ本文の上に依存先の ID と Status の帯を出し、依存先・依存元に Status の丸印を付けて終わった依存先を薄くする", async () => {
    window.location.hash = "#/tickets/t9";
    const data = fixture({
      tickets: [
        ticket({ id: "t1", title: "済み", status: "done" }),
        ticket({ id: "t2", title: "途中", status: "in_progress" }),
        ticket({ id: "t9", title: "待ち", depends_on: ["t1", "t2"] }),
        ticket({ id: "t10", title: "後", status: "review", depends_on: ["t9"] }),
      ],
    });
    const client = mockClient(data);
    const show = client.handlers["ticket.show"]!;
    let depsDone = false;
    client.handlers["ticket.show"] = (input) => ({
      ...(show(input) as object),
      dependents: ["t10"],
      deps_done: depsDone,
      pending_deps: depsDone ? [] : [{ id: "t2", status: "in_progress" }],
    });
    mount(client, hostOf("panel"));
    const h1 = await screen.findByRole("heading", { level: 1, name: "待ち" });
    const main = h1.closest(".detail-main")!;
    const band = main.querySelector(".deps-band")!;
    expect(band.textContent).toBe("依存先が終わっていない：t2In Progress");
    expect(band.querySelector(".status-dot.status-in_progress")).toBeTruthy();
    expect(band.querySelector('a[href="#/tickets/t2"]')).toBeTruthy();
    // 帯は見出しの帯の下、本文の上
    expect(band.previousElementSibling).toBe(main.querySelector(".detail-head"));
    expect(band.nextElementSibling!.classList.contains("markdown")).toBe(true);

    const aside = document.querySelector(".detail > aside") as HTMLElement;
    const deps = within(aside).getByRole("region", { name: "つながり" });
    const rowOf = (id: string) => deps.querySelector(`a[href="#/tickets/${id}"]`)!.parentElement!;
    expect(rowOf("t1").querySelector(".status-dot.status-done")).toBeTruthy();
    expect(rowOf("t1").classList.contains("dep-finished")).toBe(true);
    expect(rowOf("t2").querySelector(".status-dot.status-in_progress")).toBeTruthy();
    expect(rowOf("t2").classList.contains("dep-finished")).toBe(false);
    expect(rowOf("t10").querySelector(".status-dot.status-review")).toBeTruthy();
    // 帯があるので右の列には「依存先が終わっていない」を重ねて出さない
    expect(aside.textContent).not.toContain("依存先が終わっていない");
    cleanup();

    // 依存先が終わっていれば帯は出ない
    depsDone = true;
    window.location.hash = "#/tickets/t9";
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "待ち" });
    expect(document.querySelector(".deps-band")).toBeNull();
  });

  it("エディタのパネルの依存先の帯は ticket.show の pending_deps だけを出し、一覧にない別の Project の終わった依存先は出さない", async () => {
    window.location.hash = "#/tickets/t9";
    // t5 は別の Project で done（今の Project の ticket.list には出ない）。t6 は見つからない依存先
    const data = fixture({
      tickets: [
        ticket({ id: "t2", title: "途中", status: "in_progress" }),
        ticket({ id: "t9", title: "待ち", depends_on: ["t5", "t2", "t6"] }),
      ],
    });
    const client = mockClient(data);
    const show = client.handlers["ticket.show"]!;
    client.handlers["ticket.show"] = (input) => ({
      ...(show(input) as object),
      deps_done: false,
      pending_deps: [
        { id: "t2", status: "in_progress" },
        { id: "t6", status: null },
      ],
    });
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "待ち" });
    const band = document.querySelector(".deps-band")!;
    expect(band.textContent).toBe("依存先が終わっていない：t2In Progresst6");
    expect(band.querySelector('a[href="#/tickets/t5"]')).toBeNull();
    expect(band.querySelectorAll(".status-dot")).toHaveLength(1);
  });

  it("エディタのパネルの右の列の依存先の丸印と薄くする判定は pending_deps に合わせ、一覧にない別の Project の依存先も同じに扱う", async () => {
    window.location.hash = "#/tickets/t9";
    // t5 は別の Project で done、t7 は別の Project で review（どちらも今の Project の ticket.list には出ない）。t6 は見つからない依存先
    const data = fixture({
      tickets: [
        ticket({ id: "t1", title: "済み", status: "done" }),
        ticket({ id: "t2", title: "途中", status: "in_progress" }),
        ticket({ id: "t9", title: "待ち", depends_on: ["t1", "t5", "t2", "t6", "t7"] }),
      ],
    });
    const client = mockClient(data);
    const show = client.handlers["ticket.show"]!;
    client.handlers["ticket.show"] = (input) => ({
      ...(show(input) as object),
      deps_done: false,
      pending_deps: [
        { id: "t2", status: "in_progress" },
        { id: "t6", status: null },
        { id: "t7", status: "review" },
      ],
    });
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "待ち" });
    const aside = document.querySelector(".detail > aside") as HTMLElement;
    const deps = within(aside).getByRole("region", { name: "つながり" });
    const rowOf = (id: string) => deps.querySelector(`a[href="#/tickets/${id}"]`)!.parentElement!;
    const dim = (id: string) => rowOf(id).classList.contains("dep-finished");
    const dot = (id: string) => rowOf(id).querySelector(".status-dot")?.className ?? null;
    // 薄くするのは pending_deps にない依存先だけ（帯と同じ判定）
    expect(["t1", "t5", "t2", "t6", "t7"].filter(dim)).toEqual(["t1", "t5"]);
    // 丸印の Status は、終わっていない依存先は pending_deps、終わった依存先は一覧のもの。分からなければ付けない
    expect(dot("t1")).toContain("status-done");
    expect(dot("t5")).toBeNull();
    expect(dot("t2")).toContain("status-in_progress");
    expect(dot("t6")).toBeNull();
    expect(dot("t7")).toContain("status-review");
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
    expect(meta.textContent).toBe("In Progresshighs1eiki/agent#12編集");
    expect(meta.querySelector('a[href="https://github.com/o/r/pull/12"]')).toBeTruthy();
    expect(meta.querySelector('a[href="#/iterations/s1"]')).toBeTruthy();
  });

  it("チケット詳細の PR は、リモートの Web の URL があれば PR のページへのリンクにし、なければ番号だけを出す", async () => {
    window.location.hash = "#/tickets/t9";
    const data = fixture({
      tickets: [ticket({ id: "t9", title: "PR あり", pr: 12 })],
      status: { ...fixture().status, web_url: "https://github.com/o/r" },
    });
    mount(mockClient(data), hostOf("panel"));
    const links = await screen.findAllByRole("link", { name: "#12" });
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/12");
      expect(link.getAttribute("target")).toBe("_blank");
    }
    cleanup();

    window.location.hash = "#/tickets/t9";
    mount(mockClient({ ...data, status: { ...data.status, web_url: null } }), hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "PR あり" });
    expect(screen.queryByRole("link", { name: "#12" })).toBeNull();
    expect(screen.getByText("PR", { selector: "dt" }).nextElementSibling!.textContent).toContain(
      "#12",
    );
  });

  describe("詳細の本文の受け入れ条件のチェックボックスを押して付け外しする", () => {
    const BODY = [
      "## 概要",
      "",
      "- [ ] 概要の印",
      "",
      "## 受け入れ条件",
      "",
      "- [ ] a",
      "- [ ] ",
      "- [x] b",
      "",
      "## メモ",
      "",
      "- [ ] メモの印",
      "",
    ].join("\n");
    const checks = (client: ReturnType<typeof mockClient>) =>
      client.calls.filter((c) => c.name === "ticket.check").map((c) => c.input);
    const box = (n: number) =>
      screen.getByRole("checkbox", { name: `受け入れ条件 ${n}` }) as HTMLInputElement;

    it("押した項目だけを ticket.check に読んだ本文と渡し、その行だけが変わる", async () => {
      window.location.hash = "#/tickets/t3";
      const client = mockClient();
      const show = client.handlers["ticket.show"]!;
      client.handlers["ticket.show"] = (input) => ({ ...(show(input) as object), body: BODY });
      client.handlers["ticket.check"] = (input) => {
        const { items, undo } = input as { items: number[]; undo: boolean };
        const body = BODY.replace(
          items[0] === 1 ? "- [ ] a" : "- [x] b",
          items[0] === 1 ? `- [${undo ? " " : "x"}] a` : `- [${undo ? " " : "x"}] b`,
        );
        return { ...client.data.tickets.find((t) => t.id === "t3")!, body };
      };
      client.calls.length = 0;
      mount(client, hostOf("panel"));
      await screen.findByRole("heading", { level: 1, name: "画面" });
      // 番号は文のある項目だけに振る（雛形の空の行は数えない）
      expect(box(1).checked).toBe(false);
      expect(box(2).checked).toBe(true);
      expect(screen.queryByRole("checkbox", { name: "受け入れ条件 3" })).toBeNull();
      fireEvent.click(box(2));
      await waitFor(() => expect(checks(client)).toHaveLength(1));
      expect(checks(client)[0]).toEqual({ ticket: "t3", items: [2], undo: true, base: BODY });
      await waitFor(() => expect(box(2).checked).toBe(false));
      expect(box(1).checked).toBe(false);
      expect(screen.getByText("概要の印")).toBeTruthy();
    });

    it("受け入れ条件の節の外のチェックボックスは押せない", async () => {
      window.location.hash = "#/tickets/t3";
      const client = mockClient();
      const show = client.handlers["ticket.show"]!;
      client.handlers["ticket.show"] = (input) => ({ ...(show(input) as object), body: BODY });
      mount(client, hostOf("panel"));
      await screen.findByRole("heading", { level: 1, name: "画面" });
      const all = [...document.querySelectorAll<HTMLInputElement>(".markdown input")];
      expect(all).toHaveLength(5);
      // 概要とメモの印と、受け入れ条件の文のない行
      const outside = all.filter((c) => !c.getAttribute("aria-label"));
      expect(outside).toHaveLength(3);
      for (const c of outside) expect(c.readOnly).toBe(true);
    });

    it("保存の間に別の書き込みがあって拒否されたら、理由を出して印を元に戻す", async () => {
      window.location.hash = "#/tickets/t3";
      const client = mockClient();
      mount(client, hostOf("panel"));
      await screen.findByRole("heading", { level: 1, name: "画面" });
      // 画面が読んだ後に、別の書き込み（CLI やエージェント）が本文を変えた
      await client.run("ticket.check", { ticket: "t3", items: [1] });
      client.calls.length = 0;
      fireEvent.click(box(1));
      // 待つ間は押した印を先に出し、どの項目も押せない
      expect(box(1).checked).toBe(true);
      expect(box(1).disabled).toBe(true);
      expect((await screen.findByRole("alert")).textContent).toContain("読んだ後に変わっている");
      expect(checks(client)).toEqual([
        {
          ticket: "t3",
          items: [1],
          undo: false,
          base: "## 概要\n\n本文\n\n## 受け入れ条件\n\n- [ ] a\n",
        },
      ]);
      // 拒否の後は押す前の印に戻し、また押せる
      await waitFor(() => expect(box(1).disabled).toBe(false));
      expect(box(1).checked).toBe(false);
    });
  });

  describe("エディタのパネルのチケット詳細の属性をその場で直す", () => {
    /** ticket.update の入力を記録する client で t3 を開く */
    async function open(data = fixture()) {
      window.location.hash = "#/tickets/t3";
      const client = mockClient(data);
      mount(client, hostOf("panel"));
      await screen.findByRole("heading", { level: 1, name: "画面" });
      const updates = () =>
        client.calls.filter((c) => c.name === "ticket.update").map((c) => c.input);
      return { client, updates };
    }

    it("値を押すとその属性だけが選択になり、選ぶと ticket.update にその属性だけを渡す", async () => {
      const { updates } = await open();
      fireEvent.click(screen.getByRole("button", { name: "優先度を変える" }));
      const select = screen.getByLabelText("優先度") as HTMLSelectElement;
      expect(select.tagName).toBe("SELECT");
      expect(document.activeElement).toBe(select);
      // ほかの属性は入力欄にならない
      expect(screen.queryByLabelText("ラベル")).toBeNull();
      expect(screen.queryByLabelText("タイトル")).toBeNull();
      fireEvent.change(select, { target: { value: "high" } });
      await waitFor(() => expect(updates()).toEqual([{ ticket: "t3", priority: "high" }]));
      expect(screen.queryByLabelText("優先度")).toBeNull();
    });

    it("優先度の判断基準が読めていないときは、選択の説明（hint）が空になる", async () => {
      window.location.hash = "#/tickets/t3";
      const client = mockClient();
      client.handlers["config.show"] = () => ({ default_project: "default" });
      mount(client, hostOf("panel"));
      await screen.findByRole("heading", { level: 1, name: "画面" });
      fireEvent.click(screen.getByRole("button", { name: "優先度を変える" }));
      expect(screen.getByLabelText("優先度")).toBeTruthy();
      expect(document.querySelector(".inline-hint")!.textContent).toBe("");
    });

    it("優先度の選択は選択肢を記号と値にし、選んでいる値の判断基準を下に出す（TK-8）", async () => {
      await open();
      fireEvent.click(screen.getByRole("button", { name: "優先度を変える" }));
      const select = screen.getByLabelText("優先度") as HTMLSelectElement;
      expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
        ["low", "↓ low"],
        ["medium", "= medium"],
        ["high", "↑ high"],
      ]);
      // t3 は medium。下に medium の判断基準（mockClient の config.show）が出る
      expect(document.querySelector(".inline-hint")!.textContent).toBe(
        "機能の追加と改善・テストの抜け",
      );
    });

    it("入力欄は Enter で確定してその属性だけを渡し、Esc で取り消すと保存しない", async () => {
      const { updates } = await open();
      fireEvent.click(screen.getByRole("button", { name: "ラベルを変える" }));
      const input = screen.getByLabelText("ラベル") as HTMLInputElement;
      expect(input.value).toBe("web");
      fireEvent.change(input, { target: { value: "web, ui" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByLabelText("ラベル")).toBeNull();
      expect(updates()).toEqual([]);

      fireEvent.click(screen.getByRole("button", { name: "ラベルを変える" }));
      const again = screen.getByLabelText("ラベル") as HTMLInputElement;
      // 取り消した入力は残らない
      expect(again.value).toBe("web");
      fireEvent.change(again, { target: { value: "web, ui" } });
      fireEvent.keyDown(again, { key: "Enter" });
      await waitFor(() => expect(updates()).toEqual([{ ticket: "t3", labels: ["web", "ui"] }]));
    });

    it("選択も Esc で取り消せ、値が変わらなければ保存しない", async () => {
      const { updates } = await open();
      fireEvent.click(screen.getByRole("button", { name: "優先度を変える" }));
      fireEvent.keyDown(screen.getByLabelText("優先度"), { key: "Escape" });
      expect(screen.queryByLabelText("優先度")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "ラベルを変える" }));
      fireEvent.keyDown(screen.getByLabelText("ラベル"), { key: "Enter" });
      expect(screen.queryByLabelText("ラベル")).toBeNull();
      expect(updates()).toEqual([]);
    });

    it("編集のボタンで入力欄になるのはタイトルと本文だけで、保存はタイトルと本文だけを渡す", async () => {
      const { updates } = await open();
      fireEvent.click(screen.getByRole("button", { name: "編集" }));
      const aside = document.querySelector(".detail > aside")!;
      // 右の列は Status の選択のほかに入力欄を出さない
      expect(
        [...aside.querySelectorAll("input, select, textarea")].map((e) =>
          e.getAttribute("aria-label"),
        ),
      ).toEqual(["Status"]);
      fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "新しい題" } });
      fireEvent.change(screen.getByLabelText("本文"), { target: { value: "新しい本文" } });
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() =>
        expect(updates()).toEqual([{ ticket: "t3", title: "新しい題", body: "新しい本文" }]),
      );
    });

    it("「なし」の行の「＋足す」から値のない属性を選んで値を入れ、その属性だけを渡す", async () => {
      const { updates } = await open();
      const empty = () => document.querySelector("dd.props-empty")!;
      fireEvent.click(within(empty() as HTMLElement).getByRole("button", { name: "＋足す" }));
      const pick = screen.getByLabelText("値を入れる属性") as HTMLSelectElement;
      // 値を入れられるのは Epic・Iteration・担当（依存・ブランチ・PR は選べない）
      expect([...pick.options].filter((o) => !o.disabled).map((o) => o.text)).toEqual([
        "Epic",
        "Iteration",
        "担当",
      ]);
      fireEvent.change(pick, { target: { value: "epic" } });
      // 選んだ Epic は「なし」から外れて行になり、選択が開く
      expect(empty().textContent).not.toContain("Epic");
      const epic = screen.getByLabelText("Epic") as HTMLSelectElement;
      expect(document.activeElement).toBe(epic);
      fireEvent.change(epic, { target: { value: "e1" } });
      await waitFor(() => expect(updates()).toEqual([{ ticket: "t3", epic: "e1" }]));

      // 担当は入力欄。Esc で取り消すと「なし」に戻る
      fireEvent.click(within(empty() as HTMLElement).getByRole("button", { name: "＋足す" }));
      fireEvent.change(screen.getByLabelText("値を入れる属性"), { target: { value: "assignee" } });
      fireEvent.keyDown(screen.getByLabelText("担当"), { key: "Escape" });
      expect(empty().textContent).toContain("担当");
      fireEvent.click(within(empty() as HTMLElement).getByRole("button", { name: "＋足す" }));
      fireEvent.change(screen.getByLabelText("値を入れる属性"), { target: { value: "assignee" } });
      const assignee = screen.getByLabelText("担当");
      fireEvent.change(assignee, { target: { value: "eiki/agent" } });
      fireEvent.keyDown(assignee, { key: "Enter" });
      await waitFor(() =>
        expect(updates().at(-1)).toEqual({ ticket: "t3", assignee: "eiki/agent" }),
      );
    });

    it("任意フィールドは型に合わせた値で fields にその 1 つだけを渡し、空にすると外す", async () => {
      const data = fixture({
        tickets: [ticket({ id: "t3", title: "画面", size: 3 } as Parameters<typeof ticket>[0])],
      });
      data.workflow.definition.fields = [
        { id: "size", label: "規模", type: "number" },
        { id: "kind", label: "種類", type: "enum", options: ["bug", "feature"] },
      ];
      const { updates } = await open(data);
      fireEvent.click(screen.getByRole("button", { name: "規模を変える" }));
      const size = screen.getByLabelText("規模") as HTMLInputElement;
      expect(size.type).toBe("number");
      fireEvent.change(size, { target: { value: "5" } });
      fireEvent.keyDown(size, { key: "Enter" });
      await waitFor(() => expect(updates()).toEqual([{ ticket: "t3", fields: { size: 5 } }]));

      fireEvent.click(screen.getByRole("button", { name: "＋足す" }));
      fireEvent.change(screen.getByLabelText("値を入れる属性"), {
        target: { value: "field:kind" },
      });
      fireEvent.change(screen.getByLabelText("種類"), { target: { value: "bug" } });
      await waitFor(() =>
        expect(updates().at(-1)).toEqual({ ticket: "t3", fields: { kind: "bug" } }),
      );

      fireEvent.click(screen.getByRole("button", { name: "規模を変える" }));
      const cleared = screen.getByLabelText("規模");
      fireEvent.change(cleared, { target: { value: "" } });
      fireEvent.keyDown(cleared, { key: "Enter" });
      await waitFor(() =>
        expect(updates().at(-1)).toEqual({ ticket: "t3", fields: { size: null } }),
      );
    });

    it("閉じた選択で ↓ を押しても保存せず、Enter で確定する", async () => {
      const { updates } = await open();
      fireEvent.click(screen.getByRole("button", { name: "優先度を変える" }));
      const select = screen.getByLabelText("優先度") as HTMLSelectElement;
      // Chromium は閉じた選択の ↓ で keydown の中で change を出す
      fireEvent.keyDown(select, { key: "ArrowDown" });
      fireEvent.change(select, { target: { value: "high" } });
      fireEvent.keyUp(select, { key: "ArrowDown" });
      expect(screen.getByLabelText("優先度")).toBe(select);
      expect(select.value).toBe("high");
      expect(updates()).toEqual([]);
      fireEvent.keyDown(select, { key: "Enter" });
      await waitFor(() => expect(updates()).toEqual([{ ticket: "t3", priority: "high" }]));
    });

    it("Space か Alt+↓ で開いた一覧から選んだ change は、keyup がなくても確定する（Enter の keyup ならすぐ）", async () => {
      const { updates } = await open();
      fireEvent.click(screen.getByRole("button", { name: "優先度を変える" }));
      let select = screen.getByLabelText("優先度");
      // 一覧が開くと keyup はページに届かない。一覧の中の ↓ と Enter の keydown も届かず、change と Enter の keyup だけが来る
      fireEvent.keyDown(select, { key: " " });
      fireEvent.change(select, { target: { value: "high" } });
      fireEvent.keyUp(select, { key: "Enter" });
      await waitFor(() => expect(updates()).toEqual([{ ticket: "t3", priority: "high" }]));

      fireEvent.click(await screen.findByRole("button", { name: "優先度を変える" }));
      select = screen.getByLabelText("優先度");
      // keyup の来ない確定は PICK_SETTLE_MS を偽のタイマーで進めて確かめる
      vi.useFakeTimers();
      fireEvent.keyDown(select, { key: "ArrowDown", altKey: true });
      fireEvent.change(select, { target: { value: "low" } });
      act(() => vi.advanceTimersByTime(PICK_SETTLE_MS - 1));
      expect(updates().at(-1)).toEqual({ ticket: "t3", priority: "high" });
      act(() => vi.advanceTimersByTime(1));
      expect(updates().at(-1)).toEqual({ ticket: "t3", priority: "low" });
    });

    it("一覧から選んだ後の Esc の keyup では保存せずに取り消す", async () => {
      const { updates } = await open();
      fireEvent.click(screen.getByRole("button", { name: "優先度を変える" }));
      const select = screen.getByLabelText("優先度");
      vi.useFakeTimers();
      // Chromium は一覧で強調した値を Esc で閉じても change を出す
      fireEvent.mouseDown(select);
      fireEvent.change(select, { target: { value: "high" } });
      fireEvent.keyUp(select, { key: "Escape" });
      expect(screen.queryByLabelText("優先度")).toBeNull();
      act(() => vi.advanceTimersByTime(PICK_SETTLE_MS));
      expect(updates()).toEqual([]);
    });

    it("保存の間に Enter をもう一度押しても ticket.update は 1 回だけ", async () => {
      const { updates } = await open();
      fireEvent.click(screen.getByRole("button", { name: "ラベルを変える" }));
      const input = screen.getByLabelText("ラベル");
      fireEvent.change(input, { target: { value: "web, ui" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(screen.queryByLabelText("ラベル")).toBeNull());
      expect(updates()).toEqual([{ ticket: "t3", labels: ["web", "ui"] }]);
    });

    it("1 回の保存で ticket.show は 1 回だけ呼ぶ（一覧の読み直しで本文を読み直す分だけ）", async () => {
      const data = fixture();
      const { client } = await open(data);
      // 本物の client と同じく、一覧は読むたびに別の配列で返す（読み直すと store.tickets が変わる）
      client.handlers["ticket.list"] = () => [...data.tickets];
      const shows = () => client.calls.filter((c) => c.name === "ticket.show").length;
      // 開いたときの読み込みが落ち着いてから数える。mockClient の応答は Promise だけで返るので、
      // タイマーで待たずに act を何度か回して、残りの応答と effect を流し切る
      const settle = async () => {
        for (let i = 0; i < 5; i++) await act(async () => {});
      };
      await settle();
      const before = shows();
      fireEvent.click(screen.getByRole("button", { name: "優先度を変える" }));
      fireEvent.change(screen.getByLabelText("優先度"), { target: { value: "high" } });
      await waitFor(() => expect(screen.queryByLabelText("優先度")).toBeNull());
      await waitFor(() => expect(shows()).toBe(before + 1));
      // 閉じた時点で直した値が出ている（ticket.update の結果で入れる）
      expect(screen.getByRole("button", { name: "優先度を変える" }).textContent).toContain("high");
      await settle();
      expect(shows()).toBe(before + 1);
    });

    it("「＋足す」の属性の選択も ↓ では選ばず、Enter でその属性の欄を開く", async () => {
      await open();
      fireEvent.click(screen.getByRole("button", { name: "＋足す" }));
      const pick = screen.getByLabelText("値を入れる属性") as HTMLSelectElement;
      fireEvent.keyDown(pick, { key: "ArrowDown" });
      fireEvent.change(pick, { target: { value: "epic" } });
      fireEvent.keyUp(pick, { key: "ArrowDown" });
      expect(screen.queryByLabelText("Epic")).toBeNull();
      fireEvent.keyDown(pick, { key: "Enter" });
      expect(screen.getByLabelText("Epic")).toBeTruthy();
    });

    it("確定・取り消しの後はフォーカスを値のボタンに戻す", async () => {
      await open();
      fireEvent.click(screen.getByRole("button", { name: "ラベルを変える" }));
      fireEvent.keyDown(screen.getByLabelText("ラベル"), { key: "Escape" });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "ラベルを変える" }));
      fireEvent.click(screen.getByRole("button", { name: "優先度を変える" }));
      fireEvent.change(screen.getByLabelText("優先度"), { target: { value: "low" } });
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "優先度を変える" })),
      );
    });

    it("保存が拒否されたら欄を開いたままにし、入力した文字を残す", async () => {
      const { client, updates } = await open();
      client.handlers["ticket.update"] = () => {
        throw new ClientError({ code: "REJECTED", message: "担当は直せない" });
      };
      fireEvent.click(screen.getByRole("button", { name: "＋足す" }));
      fireEvent.change(screen.getByLabelText("値を入れる属性"), { target: { value: "assignee" } });
      fireEvent.change(screen.getByLabelText("担当"), { target: { value: "someone" } });
      fireEvent.keyDown(screen.getByLabelText("担当"), { key: "Enter" });
      expect((await screen.findByRole("alert")).textContent).toContain("担当は直せない");
      expect((screen.getByLabelText("担当") as HTMLInputElement).value).toBe("someone");
      // 渡したのは担当だけ（拒否された）
      expect(updates()).toEqual([{ ticket: "t3", assignee: "someone" }]);
    });

    it("ラベルは区切りの空白だけが違えば保存しない", async () => {
      const data = fixture({
        tickets: [ticket({ id: "t3", title: "画面", labels: ["web", "ui"] })],
      });
      const { updates } = await open(data);
      fireEvent.click(screen.getByRole("button", { name: "ラベルを変える" }));
      const input = screen.getByLabelText("ラベル");
      fireEvent.change(input, { target: { value: "web,ui " } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.queryByLabelText("ラベル")).toBeNull();
      expect(updates()).toEqual([]);
    });

    it("別のチケットに移ると、その場で直している欄を持ち越さない", async () => {
      await open();
      fireEvent.click(screen.getByRole("button", { name: "優先度を変える" }));
      expect(screen.getByLabelText("優先度")).toBeTruthy();
      act(() => {
        window.location.hash = "#/tickets/t2";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      await screen.findByRole("heading", { level: 1, name: "API" });
      expect(screen.queryByLabelText("優先度")).toBeNull();
    });

    it("Epic・Iteration の値のリンクと「変える」のボタンは入れ子にならず、どちらも名前が読める", async () => {
      const data = fixture({
        tickets: [ticket({ id: "t3", title: "画面", epic: "e1", iteration: "s1" })],
        iterations: [iteration({ id: "s1", name: "最初" })],
      });
      await open(data);
      for (const [label, linkName] of [
        ["Epic", "e1 最初の版"],
        ["Iteration", "s1"],
      ] as const) {
        const button = screen.getByRole("button", { name: `${label}を変える` });
        // 同じ属性の行の中で、リンクはボタンと並ぶ
        const link = within(button.closest("dd")!).getByRole("link", { name: linkName });
        expect(button.contains(link)).toBe(false);
        expect(link.contains(button)).toBe(false);
        expect(within(button).queryByRole("link")).toBeNull();
        // ボタンを押すと選択になり、Esc で閉じるとフォーカスはボタンに戻る
        fireEvent.click(button);
        const select = screen.getByLabelText(label);
        expect(select.tagName).toBe("SELECT");
        fireEvent.keyDown(select, { key: "Escape" });
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: `${label}を変える` }),
        );
      }
      // リンクを押してもその場では直さない
      fireEvent.click(screen.getByRole("link", { name: "e1 最初の版" }));
      expect(screen.queryByLabelText("Epic")).toBeNull();
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

  it("dg init 前（NOT_INITIALIZED）は始め方を出し、エラーの通知は出さない。init の後の reload の event でいつもの画面に変わる", async () => {
    const client = boardClient();
    const notInitialized = () => {
      throw new ClientError({ code: "NOT_INITIALIZED", message: "初期化されていない" });
    };
    const original = client.handlers["project.list"]!;
    client.handlers["project.list"] = notInitialized;
    const send = mountWithBridge(client, { readRunning: false });
    expect(await screen.findByRole("heading", { name: "deguboard を始める" })).toBeTruthy();
    // dg init のコマンドが出て、押すとコピーする（データには何も書かない）
    expect(screen.getByText("dg init")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(client.calls.some((c) => c.name === "sync" || c.name.endsWith(".create"))).toBe(false);

    client.handlers["project.list"] = original;
    act(() => send()({ kind: "event", name: "reload" }));
    expect(await screen.findByText("ログイン")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "deguboard を始める" })).toBeNull();
  });

  it("拡張ホストから toggle の event が来ると、設定画面と来る前の画面を切り替える（ビューのタイトル行の歯車）", async () => {
    const client = mockClient();
    client.handlers["config.show"] = () => {
      const config = { default_project: "default" };
      return { config, team: config, local: {}, fields: [] };
    };
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

  // Run の画面はない（ADR-027）ので、Run を出すのはパネルのチケット詳細だけ
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
          tools: null,
          session: null,
          review: null,
          waiting_since: null,
          settling_since: null,
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

  it("サイドバーでも完了の節は既定で畳み、ほかの節は開く", async () => {
    mount(boardClient(), hostOf("sidebar"));
    await screen.findByText("ログイン");
    const columns = [...document.querySelectorAll<HTMLDetailsElement>("details.column")];
    expect(columns.map((c) => [c.dataset.status, c.open])).toEqual([
      ["todo", true],
      ["in_progress", true],
      ["review", true],
      ["done", false],
    ]);
  });

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
    // 自分と自分の agent の担当は出さない。優先度 medium は印を出さないので右端は空
    expect(markOf("自分")).toBeNull();
    expect(markOf("自分の AI")).toBeNull();
    expect(rowOf("自分").querySelector(".row-end-top")!.innerHTML).toBe("");
    // 別の人は頭文字の丸（カンバンと同じ印）。全名はツールチップ
    expect(markOf("別の人")!.querySelector(".assignee-initial")!.textContent).toBe("H");
    expect(markOf("別の人")!.getAttribute("title")).toBe("hana");
    // 別の人の agent は持ち主の丸と汎用のアイコン（文字の札は出さない）。ホバーで主体 ID と Run の agent
    expect(markOf("別の人の AI")!.querySelector(".assignee-initial")!.textContent).toBe("H");
    expect(markOf("別の人の AI")!.textContent).toBe("H");
    expect(markOf("別の人の AI")!.querySelector(".agent-icon svg")).not.toBeNull();
    expect(markOf("別の人")!.querySelector(".agent-icon")).toBeNull();
    expect(markOf("別の人の AI")!.getAttribute("title")).toBe("hana/agent · codex");
    // Plan に入っていれば、上の段に担当の印と Plan の番号を出す（medium は優先度の印を出さない）
    const top = rowOf("計画の中").querySelector(".row-end-top")!;
    expect([...top.children].map((c) => c.className.split(" ")[0])).toEqual([
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
    // 担当なし：担当の印を出さない（開いた Plan に入っていない行なので右端は優先度の印と空き枠）
    expect(markOf("画面")).toBeNull();
    expect(kanbanRowOf("画面").querySelector(".row-end .assignee-mark")).toBeNull();
  });

  it("サイドバーのカンバンは、前回の描画から Status が変わった行を点滅させる（開き直しても host.state で比べる）", async () => {
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
    expect(document.querySelectorAll(".row-item .row")).toHaveLength(3);
    const review = document.querySelector<HTMLDetailsElement>('details[data-status="review"]')!;
    expect(review.classList.contains("is-empty")).toBe(true);
    expect(review.querySelector(".rows")).toBeNull();
    expect(review.querySelector(".section-count")!.textContent).toBe("0");
    expect(screen.queryByText("なし")).toBeNull();
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

  it("サイドバーのカンバンの行は状態の丸印を出さず、優先度の印（high・low を矢印と文字で）を右に出す。medium は出さない", async () => {
    const client = boardClient();
    client.data.tickets[2]!.priority = "low";
    mount(client, hostOf("sidebar"));
    await screen.findByText("ログイン");
    const rowOf = (title: string) => screen.getByText(title).closest(".row")!;
    expect(document.querySelectorAll(".board .row .status-dot")).toHaveLength(0);
    expect(rowOf("API").classList.contains("kanban-row")).toBe(true);
    expect(rowOf("API").lastElementChild!.textContent).toBe("high—");
    expect(rowOf("API").querySelector(".priority-high")).toBeTruthy();
    expect(rowOf("画面").lastElementChild!.textContent).toBe("low—");
    expect(rowOf("画面").querySelector(".priority-low")).toBeTruthy();
    // medium の行は優先度の印を出さない（ログインは medium）
    expect(rowOf("ログイン").querySelector(".priority-mark")).toBeNull();
    cleanup();
    window.location.hash = "#/backlog";
    mount(client, hostOf("sidebar"));
    await screen.findByText("API");
    expect(rowOf("画面").classList.contains("kanban-row")).toBe(false);
    expect(rowOf("画面").querySelector(".status-dot")).toBeTruthy();
    // バックログの行も同じ印を出す
    expect(rowOf("画面").querySelector(".priority-low")).toBeTruthy();
  });

  it("サイドバーのカンバンの行は、開いた Plan に入っていれば右端に Plan の番号を Plan の色で出し、todo なら着手可・待ちの相手・承認待ちを出す。入っていない未完了の行には破線の空き枠を出す", async () => {
    const client = boardClient();
    client.data.tickets.push(
      ticket({ id: "t4", title: "待つ", priority: "high", iteration: "s0" }),
      ticket({ id: "t5", title: "外", priority: "low", iteration: "s0" }),
      ticket({ id: "t6", title: "閉じた計画", iteration: "s0" }),
      ticket({ id: "t7", title: "承認前", iteration: "s0" }),
      ticket({ id: "t8", title: "終わり外", status: "done", iteration: "s0" }),
      ticket({ id: "t9", title: "やめた外", status: "abandoned", iteration: "s0" }),
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

    // in_progress：上の段に優先度の印と Plan の番号（下の段は着手可・待ちの todo の行だけ）
    const api = endOf("API")!;
    expect(api.querySelector(".row-plan")!.textContent).toBe("p7");
    expect(api.querySelector(".row-plan")!.classList.contains("plan-color-2")).toBe(true);
    expect(api.querySelector(".priority-high")).toBeTruthy();
    expect(api.querySelector(".row-end-sub")).toBeNull();
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
    // 開いた Plan に入っていない・閉じた Plan だけのチケットは、優先度の印の右に Plan の番号の代わりの破線の空き枠
    const slot = endOf("外")!.querySelector(".row-plan-slot")!;
    expect(slot.textContent).toBe("—");
    expect(slot.getAttribute("title")).toBe("開いた Plan に入っていない");
    expect(endOf("外")!.querySelector(".row-plan")).toBeNull();
    expect(endOf("外")!.querySelector(".row-end-top")!.textContent).toBe("low—");
    expect(endOf("閉じた計画")!.querySelector(".row-plan-slot")).toBeTruthy();
    // 開いた Plan に入っている行・done と中止の行には出ない
    expect(endOf("API")!.querySelector(".row-plan-slot")).toBeNull();
    expect(endOf("待つ")!.querySelector(".row-plan-slot")).toBeNull();
    expect(kanbanRowOf("終わり外").querySelector(".row-plan-slot")).toBeNull();
    expect(kanbanRowOf("やめた外").querySelector(".row-plan-slot")).toBeNull();
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

    // in_progress：上の段は Plan の番号（medium は優先度の印を出さない）。着手可・待ちは todo の行だけで、下の段は出さない
    expect(endOf("前")!.querySelector(".row-plan")!.textContent).toBe("p7");
    expect(endOf("前")!.querySelector(".row-plan")!.classList.contains("plan-color-2")).toBe(true);
    expect(endOf("前")!.querySelector(".row-end-sub")).toBeNull();
    expect(endOf("前")!.querySelector(".priority-mark")).toBeNull();
    expect(endOf("着手できる")!.querySelector(".row-ready")!.textContent).toBe("着手可");
    const wait = endOf("待つ")!;
    expect(wait.querySelector(".row-wait")!.textContent).toBe("t1 待ち");
    expect(wait.querySelector(".row-wait")!.getAttribute("title")).toBe("t1 を待っている");
    // 優先度の印（high）は上の段の左端、Plan の番号の左。下の段は待ちだけ
    expect(wait.querySelector(".row-end-top")!.textContent).toBe("highp7");
    expect(wait.querySelector(".priority-high")).toBeTruthy();
    expect(endOf("承認前")!.querySelector(".row-wait")!.textContent).toBe("承認待ち");
    // Plan に入っていない・閉じた Plan の行は medium なので右端に何も出さない
    for (const title of ["外", "閉じた計画"]) {
      expect(endOf(title)!.querySelector(".row-end-sub")).toBeNull();
      expect(endOf(title)!.querySelector(".row-end-top")!.innerHTML).toBe("");
    }
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

  it("サイドバーのバックログの行に右クリックのメニューの文脈（data-vscode-context）を付ける", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations.push(iteration({ id: "s1", name: "最初", status: "active" }));
    client.data.tickets.push(ticket({ id: "t4", title: "入った", iteration: "s1" }));
    mount(client, hostOf("sidebar"));
    await screen.findByText("入った");
    const contextOf = (title: string) =>
      JSON.parse(screen.getByText(title).closest("li")!.getAttribute("data-vscode-context")!);
    // 「詳細を開く」「ID をコピー」が使う文脈だけで、エージェントに頼む対象・候補・おすすめは載せない
    expect(contextOf("入った")).toEqual({
      webviewSection: "backlogTicket",
      ticket: "t4",
      preventDefaultContextMenuItems: true,
    });
    expect(contextOf("画面")).toMatchObject({ ticket: "t3" });
  });

  it("サイドバーのカンバンの行と節の見出しの右クリックの文脈は、既定のメニューを止めるだけで、頼む対象も「詳細を開く」などの文脈も付けない", async () => {
    mount(boardClient(), hostOf("sidebar"));
    await screen.findByText("ログイン");
    const contexts = [...document.querySelectorAll("[data-vscode-context]")].map(
      (el) => JSON.parse(el.getAttribute("data-vscode-context")!) as Record<string, unknown>,
    );
    expect(contexts.length).toBeGreaterThan(0);
    for (const c of contexts) expect(c).toEqual({ preventDefaultContextMenuItems: true });
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
    // in_progress で Run のない行：止まった半分塗りの丸。優先度の印と Plan の番号は上の段、着手可・待ちのない行は下の段を出さない
    const api = kanbanRowOf("API");
    expect(api.firstElementChild!.classList.contains("activity-idle")).toBe(true);
    expect(api.querySelector(".row-running")).toBeNull();
    expect(api.querySelector(".row-end-top")!.textContent).toBe("highp7");
    expect(api.querySelector(".row-end-sub")).toBeNull();
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
    expect(kanbanRowOf("画面").querySelector(".row-end-sub")).toBeNull();
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
      kanbanRowOf(title).closest(".row-item")!.classList.contains("is-waiting");
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
      kanbanRowOf(title).closest(".row-item")!.classList.contains("is-waiting");
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

  it("サイドバーではチケット詳細のルートでもバックログを出す（詳細はエディタのパネル）", async () => {
    window.location.hash = "#/tickets/t3";
    mount(mockClient(), hostOf("sidebar"));
    await screen.findByText("API");
    expect(screen.queryByRole("heading", { level: 1, name: "画面" })).toBeNull();
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

  it("エディタのパネルはチケット詳細にタブのヘッダーを出さない", async () => {
    window.location.hash = "#/tickets/t3";
    mount(mockClient(), hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "画面" });
    expect(screen.queryByRole("navigation", { name: "画面" })).toBeNull();
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
    // 目標のある s1 は目標だけを 1 段目に出し（名前は出さない）、目標のない s2 は「目標なし」を薄く出す
    expect(names()).toEqual(["目標なし", "core"]);
    expect(document.querySelector(".history-row .name.history-none")!.textContent).toBe("目標なし");
    const rowOf = (id: string) =>
      [...document.querySelectorAll(".history-row")].find(
        (r) => r.querySelector("code")?.textContent === id,
      )!;
    const chips = (id: string) =>
      [...rowOf(id).querySelectorAll(".counts > span")].map((b) => b.textContent);
    expect(chips("s1")).toEqual(["3", "持ち越し 1"]);
    expect(rowOf("s1").querySelector("small")!.textContent).toBe("10/10 に閉じた");
    // s2 には閉じたときの記録がないので、web で数え直さず「—」と出し、持ち越しのチップは出さない
    expect(chips("s2")).toEqual(["—"]);
    expect(rowOf("s2").querySelector("small")!.textContent).toBe("10/24 に閉じた");
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

  it("サイドバーの履歴の Iteration の行は閉じた日の記録がなければ「閉じた日は不明」と書き、終わったチケットの Epic ごとの件数（見出しなし）と中止の件数が出て、開くと番号の順の 1 本の一覧で終わったチケットが出て、最後に持ち越しが出る", async () => {
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
    expect(row.querySelector("small")!.textContent).toBe("閉じた日は不明 ・ e1 2");
    expect([...row.querySelectorAll(".counts > span")].map((b) => b.textContent)).toEqual([
      "—",
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
      "PR なし ・ 今は s2",
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
    expect(document.querySelector(".history-row small")!.textContent).toBe("10/20 に閉じた ・ s1");
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
        const list = [...document.querySelectorAll(".timeline-list .timeline-text")];
        expect(list).toHaveLength(3);
        return list.map((e) => e.textContent);
      });
    expect(await items()).toEqual([
      "起票 ・ Todo",
      "Todo → In Progress ・ 担当: eiki/agent",
      "Iteration s1 から外した ・ PR #5",
    ]);
    expect(screen.getByText(/これより前の経過は欠けている/)).toBeTruthy();
    // 同じ日付なので日付の行は 1 つ。各行は時刻だけと作者を出し、Status の変わらない行は中の空いた丸
    const days = [...document.querySelectorAll(".timeline-day")].map((e) => e.textContent);
    expect(days).toEqual(["2026-11-01"]);
    const times = [...document.querySelectorAll(".timeline-list li:not(.timeline-day) > time")];
    expect(times.map((e) => e.textContent)).toEqual(["00:00", "01:00", "02:00"]);
    const authors = [...document.querySelectorAll(".timeline-author")].map((e) => e.textContent);
    expect(authors).toEqual(["eiki", "eiki", "eiki"]);
    expect(document.querySelectorAll(".timeline-list .status-dot-empty")).toHaveLength(1);
  });

  it("エディタのパネルで Iteration の詳細を出すときもヘッダーを出さない", async () => {
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "最初", status: "closed" })];
    client.handlers["iteration.show"] = () => iterationDetail(client.data.iterations[0]!);
    window.location.hash = "#/iterations/s1";
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: /s1 最初/ });
    expect(screen.queryByRole("navigation", { name: "画面" })).toBeNull();
  });

  it("サイドバーのバックログは検索欄の右端の漏斗で絞り込みの欄を開閉し、漏斗は条件が効いている間だけ色付き。件数は絞っているときだけ「n / m 件」でチップの行の右端に出て、消すボタンは条件があるときだけ", async () => {
    window.location.hash = "#/backlog";
    const host = hostOf("sidebar");
    mount(mockClient(), host);
    await screen.findByText("API");
    expect(screen.getByLabelText("検索")).toBeTruthy();
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

  it("サイドバーのバックログの区画は、行の右端に優先度の印（high・low）を付け、見出しを状態の帯と 2 段（番号・名前・件数／状態・月日の期間・目標）にし、「…」と開始・閉じるを出さない", async () => {
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
    // API は high なので印を出し、画面は medium なので印を出さない
    expect(
      [...s1!.querySelectorAll(".row .priority-mark .priority-text")].map((m) => m.textContent),
    ).toEqual(["high"]);
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

  it("サイドバーのバックログの 0 件の区画（planned・Iteration なし）は 2 段目のない 1 行に畳み、「Iteration なし」は 1 つの名前で、作るボタンは出さない", async () => {
    window.location.hash = "#/backlog";
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s1", name: "今", status: "active" }),
      iteration({ id: "s2", name: "次", status: "planned", start: "2026-12-01", goal: "次の目標" }),
    ];
    for (const t of client.data.tickets) t.iteration = "s1";
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
    expect(none!.textContent).toBe("Iteration なし0 件");
    // Iteration を作るのはエージェントに頼む（ADR-027）
    expect(screen.queryByRole("button", { name: "Iteration を作る" })).toBeNull();
  });

  it("サイドバーのバックログの行は区画の中も区画なしの一覧も右端に high・low の印（矢印と文字）を出し medium は出さず、low の区切りの行を入れず、状態の丸印は todo だけ白抜きにする", async () => {
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
    // 行だけが並ぶ
    expect([...list.children].map((li) => li.querySelector("code")!.textContent)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
    // 右端の 1 段目の左端に high・low の印（矢印と文字）。medium（中くらい）は出さない
    const marks = [...list.querySelectorAll(".row")].map((r) =>
      r.querySelector(".row-end-top > .priority-mark"),
    );
    expect(
      marks.map((m) => m && [m.className, m.querySelector(".priority-text")!.textContent]),
    ).toEqual([
      ["priority-mark priority-high", "high"],
      null,
      ["priority-mark priority-low", "low"],
      ["priority-mark priority-low", "low"],
    ]);
    // 「Iteration なし」の区画の行（区画の外 t5 low）も同じ印を出す
    expect(none!.querySelector(".row .priority-mark")!.className).toBe(
      "priority-mark priority-low",
    );
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
    await screen.findByText("設計");
    // チケットの足し外しはエージェントに頼む（ADR-027）ので、外すボタンと足す欄は出さない
    expect(screen.queryByRole("button", { name: "外す" })).toBeNull();
    expect(screen.queryByLabelText("足すチケット")).toBeNull();
    expect(document.querySelectorAll(".column")).toHaveLength(0);
    const sections = [
      ...document.querySelectorAll<HTMLDetailsElement>(".ticket-sections > details"),
    ];
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

  it("エディタのパネルの Iteration 詳細は「← カンバン」を出さず、「この Iteration でカンバンを見る」でその Iteration で絞ったカンバンをサイドバーに出してもらう", async () => {
    window.location.hash = "#/iterations/s1";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "最初", status: "active" })];
    client.handlers["iteration.show"] = () => iterationDetail(client.data.iterations[0]!);
    const shown: Route[] = [];
    mount(
      client,
      hostOf(
        "panel",
        () => {},
        (route) => shown.push(route),
      ),
    );
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("link", { name: "← カンバン" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "この Iteration でカンバンを見る" }));
    expect(shown).toEqual([{ page: "board", iteration: "s1" }]);
    expect(window.location.hash).toBe("#/iterations/s1");
  });

  it("エディタのパネルの閉じた Iteration の詳細は、カンバンで選べないので「この Iteration でカンバンを見る」を出さない", async () => {
    window.location.hash = "#/iterations/s1";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "最初", status: "closed" })];
    client.handlers["iteration.show"] = () => iterationDetail(client.data.iterations[0]!);
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("link", { name: "この Iteration でカンバンを見る" })).toBeNull();
  });

  it("エディタのパネルの Iteration 詳細はチケットを未完了・完了・中止の段に分け、完了と中止は畳み、Iteration の列を出さない（UI-5）", async () => {
    window.location.hash = "#/iterations/s1";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s1", name: "最初", status: "active" })];
    const items = [
      ticket({ id: "t2", title: "API", status: "in_progress", iteration: "s1" }),
      ticket({ id: "t4", title: "設計", status: "todo", priority: "high", iteration: "s1" }),
      ticket({ id: "t5", title: "調査", status: "done", iteration: "s1" }),
      ticket({ id: "t6", title: "古い案", status: "abandoned", iteration: "s1" }),
    ];
    client.handlers["iteration.show"] = () => iterationDetail(client.data.iterations[0]!, items);
    mount(client, hostOf("panel"));
    await screen.findByText("設計");
    const sections = [
      ...document.querySelectorAll<HTMLDetailsElement>(".ticket-sections > details"),
    ];
    expect(sections.map((d) => d.querySelector("summary")!.textContent)).toEqual([
      "未完了 2",
      "完了 1",
      "中止 1",
    ]);
    expect(sections.map((d) => d.open)).toEqual([true, false, false]);
    expect([...sections[0]!.querySelectorAll(".row code")].map((c) => c.textContent)).toEqual([
      "t4",
      "t2",
    ]);
  });

  it("Iteration 詳細の見出しの下は期間（短い形と残り・超過の日数）・目標・進捗を別の行に出す（UI-5）", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 17, 12) });
    const client = mockClient();
    client.data.iterations = [
      iteration({
        id: "s1",
        name: "今",
        status: "active",
        start: "2026-11-17",
        end: "2026-11-30",
        goal: "見出しを分ける",
      }),
    ];
    client.data.tickets[0]!.iteration = "s1";
    client.data.tickets[1]!.iteration = "s1";
    client.data.tickets[0]!.status = "done";
    client.data.tickets[1]!.status = "todo";
    const items = () => client.data.tickets.filter((t) => t.iteration === "s1");
    client.handlers["iteration.show"] = () => iterationDetail(client.data.iterations[0]!, items());
    window.location.hash = "#/iterations/s1";
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: /s1 今/ });
    const summary = document.querySelector(".iteration-summary")!;
    const rows = () =>
      [...summary.querySelectorAll("dt")].map((dt) => [
        dt.textContent,
        dt.nextElementSibling!.textContent,
      ]);
    expect(rows()).toEqual([
      ["期間", "11/17–11/30残り 13 日"],
      ["目標", "見出しを分ける"],
      ["進捗", "完了 1/2"],
    ]);
    expect(summary.querySelector(".progress")).toBeTruthy();

    // 終了日を過ぎたら超過日数。期間がどちらもなければ期間の行を出さない
    cleanup();
    vi.setSystemTime(new Date(2026, 11, 2, 9));
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: /s1 今/ });
    expect(document.querySelector(".period-note.overdue")!.textContent).toBe("2 日超過");
    cleanup();
    client.data.iterations[0] = iteration({ id: "s1", name: "今", status: "active" });
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: /s1 今/ });
    expect(
      [...document.querySelectorAll(".iteration-summary dt")].map((dt) => dt.textContent),
    ).toEqual(["進捗"]);
    expect(screen.queryByText(/\?/)).toBeNull();
  });

  it("閉じた Iteration の詳細は、進捗の位置に完了・持ち越しの件数を出す", async () => {
    const client = mockClient();
    client.data.iterations = [
      iteration({
        id: "s0",
        name: "前",
        status: "closed",
        start: "2026-10-01",
        end: "2026-10-14",
        completed: 3,
        carried_over: 1,
      }),
    ];
    client.handlers["iteration.show"] = () => iterationDetail(client.data.iterations[0]!);
    window.location.hash = "#/iterations/s0";
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: /s0 前/ });
    const summary = document.querySelector(".iteration-summary")!;
    expect(
      [...summary.querySelectorAll("dt")].map((dt) => [
        dt.textContent,
        dt.nextElementSibling!.textContent,
      ]),
    ).toEqual([
      ["期間", "10/1–10/14"],
      ["進捗", "完了 3 ・ 持ち越し 1"],
    ]);
    expect(summary.querySelector(".progress")).toBeNull();
  });

  it("info の通知（コマンドの警告）は数秒で消える", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.location.hash = "#/tickets/t3";
    const client = mockClient();
    mount(client, hostOf("panel"));
    await screen.findByRole("heading", { level: 1, name: "画面" });
    // 警告つきの応答。mockClient の handlers は data しか返せないので run を差し替える
    const original = client.run.bind(client);
    client.run = (async (name: string, input?: unknown) =>
      name === "ticket.move"
        ? { data: {}, warnings: ["push できない: offline"] }
        : original(name, input)) as typeof client.run;
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "in_progress" } });
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

  it("Epic の詳細ではタブのバックログを選ぶ（タブは カンバン・バックログ・履歴 の 3 つ）", async () => {
    window.location.hash = "#/epics/e1";
    const client = mockClient();
    client.handlers["epic.show"] = () => ({ ...client.data.epics[0], body: "", tickets: [] });
    mount(client);
    await screen.findByRole("heading", { level: 1, name: /e1 最初の版/ });
    const tabs = screen.getByRole("navigation", { name: "画面" });
    expect([...tabs.querySelectorAll("a")].map((a) => a.textContent)).toEqual([
      "カンバン",
      "バックログ",
      "履歴",
    ]);
    expect(tabs.querySelector("[aria-current=page]")!.textContent).toBe("バックログ");
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
    expect(lines).toEqual(["すべて1/3s11/3", "今11/15–11/28左パネルを整える", "1/3 done"]);
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
    const opened: Route[] = [];
    mount(
      client,
      hostOf("sidebar", (route) => opened.push(route)),
    );
    await screen.findByText("ログイン");
    const group = screen.getByRole("group", { name: "Iteration" });
    const chips = [...group.querySelectorAll<HTMLButtonElement>(".iteration-chip")];
    // 先頭に すべて、閉じた Iteration は出さず番号順に並べる（作る「+」は置かない。ADR-027）
    expect(chips.map((c) => c.textContent)).toEqual(["すべて1/3", "s11/2", "s20/1", "s30/0"]);
    expect(chips.map((c) => c.className)).toEqual([
      "iteration-chip all",
      "iteration-chip active",
      "iteration-chip planned",
      "iteration-chip planned",
    ]);
    // 既定は active の札を選び、選んでいる札だけが押された状態
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
      "false",
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
    ).toEqual(["false", "false", "true", "false"]);
    expect(document.querySelector(".sidebar-head .head-line.sub .name")!.textContent).toBe("次");
    // 名前を押すと、ハッシュを変えずにホストにエディタのパネルで Iteration 詳細を開いてもらう
    fireEvent.click(document.querySelector(".sidebar-head .head-line.sub .name a")!);
    expect(opened).toEqual([{ page: "iterations", id: "s2" }]);
    expect(window.location.hash).toContain("iteration=s2");
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
    const all = document.querySelector<HTMLButtonElement>(".iteration-chip.all")!;
    expect(all.textContent).toBe("すべて0/2");
    fireEvent.click(all);
    await waitFor(() => expect(window.location.hash).toContain("iteration=*"));
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".sidebar-head .head-line.sub .name")!.textContent).toBe(
      "planned・active のすべて",
    );
    expect(document.querySelector(".sidebar-head .head-line.sub .name a")).toBeNull();
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
    const host = hostOf("sidebar");
    for (const [key, value] of Object.entries(saved)) host.state.set(key, value);
    return host;
  }

  it("カンバンで Iteration・Epic・担当者を絞ってから他のタブへ移り、カンバンのタブで戻ると同じ絞り込みで出る", async () => {
    const host = hostOf("sidebar");
    host.state.set("board.filters", true);
    mount(navClient(), host);
    await screen.findByRole("button", { name: /^s2/ });
    fireEvent.click(screen.getByRole("button", { name: /^s2/ }));
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
    expect(screen.getByRole("button", { name: /^s2/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText<HTMLSelectElement>("Epic").value).toBe("e1");
    expect(screen.getByLabelText<HTMLSelectElement>("担当").value).toBe("eiki/agent");
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
  ])("残したハッシュが%sなら、タブは既定の行き先を指す", async (_, key, href, fallback) => {
    window.location.hash = "#/backlog";
    mount(navClient(), hostWith({ [key]: { project: "default", href } }));
    await screen.findByText("API");
    expect(tab("カンバン").getAttribute("href")).toBe(fallback);
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

  it("Project を切り替えると、カンバン・履歴のタブは既定の行き先に戻る", async () => {
    window.location.hash = "#/backlog";
    const client = navClient();
    client.data.projects.push({ ...client.data.projects[0]!, id: "other", name: "Other" });
    mount(
      client,
      hostWith({
        "nav.board": { project: "default", href: "#/board?iteration=s2" },
        "nav.history": { project: "default", href: "#/history?view=ticket" },
      }),
    );
    await screen.findByText("API");
    expect(tab("カンバン").getAttribute("href")).toBe("#/board?iteration=s2");
    expect(tab("履歴").getAttribute("href")).toBe("#/history?view=ticket");
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "other" } });
    await waitFor(() => expect(tab("カンバン").getAttribute("href")).toBe("#/board"));
    expect(tab("履歴").getAttribute("href")).toBe("#/history");
    // 元の Project に戻っても、切り替えの前のハッシュには戻らない
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "default" } });
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>("Project").value).toBe("default"),
    );
    expect(tab("カンバン").getAttribute("href")).toBe("#/board");
  });

  it.each([["カンバン", "#/board?iteration=s2&epic=e1", "#/board"]])(
    "%sの画面にいるまま Project を切り替えると、前の Project の絞り込みを残さず、タブは既定の行き先を指す。絞り直せばまた残す",
    async (name, href, fallback) => {
      window.location.hash = href;
      const client = navClient();
      client.data.projects.push({ ...client.data.projects[0]!, id: "other", name: "Other" });
      mount(client, hostOf("sidebar"));
      await waitFor(() => expect(tab(name).getAttribute("href")).toBe(href));
      fireEvent.change(screen.getByLabelText("Project"), { target: { value: "other" } });
      await waitFor(() => expect(tab(name).getAttribute("href")).toBe(fallback));
      // 他のタブへ移って戻っても、前の Project の絞り込みに戻らない
      fireEvent.click(tab("バックログ"));
      await waitFor(() => expect(window.location.hash).toBe("#/backlog"));
      expect(tab(name).getAttribute("href")).toBe(fallback);
      // 新しい Project で絞り直したハッシュはまた残す
      const again = "#/board?iteration=s1";
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
