// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import { iteration, mockClient, ticket } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { carriedOverFrom, epicCountsOf, groupByEpic } from "./history.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("履歴のまとめ方", () => {
  it("Epic ごとにチケットの多い順でまとめ、Epic なしは最後", () => {
    const groups = groupByEpic([
      ticket({ id: "t3", epic: "e2" }),
      ticket({ id: "t1" }),
      ticket({ id: "t2", epic: "e1" }),
      ticket({ id: "t4", epic: "e2" }),
    ]);
    expect(groups.map((g) => [g.epic, g.tickets.map((t) => t.id)])).toEqual([
      ["e2", ["t3", "t4"]],
      ["e1", ["t2"]],
      [null, ["t1"]],
    ]);
  });

  it("持ち越しは、その Iteration から外れる出来事のあったチケット。今も入っているものは除く", () => {
    const events = [
      {
        kind: "ticket",
        id: "t2",
        at: "x",
        changes: [{ field: "iteration", from: "s1", to: "s2" }],
      },
      {
        kind: "ticket",
        id: "t3",
        at: "x",
        changes: [{ field: "iteration", from: "s1", to: null }],
      },
      {
        kind: "ticket",
        id: "t4",
        at: "x",
        changes: [{ field: "iteration", from: null, to: "s1" }],
      },
      {
        kind: "ticket",
        id: "t5",
        at: "x",
        changes: [{ field: "iteration", from: "s1", to: "s2" }],
      },
    ] as unknown as Parameters<typeof carriedOverFrom>[1];
    const tickets = [ticket({ id: "t5", iteration: "s1" })];
    expect(carriedOverFrom("s1", events, tickets)).toEqual(["t2", "t3"]);
  });
});

function sidebarHost(): Host {
  return {
    surface: "sidebar",
    open: () => {},
    show: () => {},
    state: createUiState(memoryBackend()),
  };
}

describe("Iteration の行", () => {
  it("内訳は Epic なしを含み、合計が Iteration に入っている終わったチケットの件数と合う", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    client.data.iterations = [
      iteration({
        id: "s4",
        name: "sprint4",
        goal: "左パネルを主画面にする",
        status: "closed",
        closed_at: "2026-11-01T00:00:00Z",
        completed: 3,
        carried_over: 2,
      }),
    ];
    client.data.tickets = [
      ticket({ id: "t1", status: "done", iteration: "s4", epic: "e1" }),
      ticket({ id: "t2", status: "done", iteration: "s4" }),
      ticket({ id: "t3", status: "done", iteration: "s4" }),
      ticket({ id: "t4", status: "abandoned", iteration: "s4", epic: "e1" }),
      // 終わっていないチケットと、ほかの Iteration のチケットは数えない
      ticket({ id: "t5", status: "todo", iteration: "s4", epic: "e1" }),
      ticket({ id: "t6", status: "done", iteration: "s5" }),
    ];
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    const row = (await screen.findByText("左パネルを主画面にする")).closest(".history-row")!;
    expect(row.querySelector("small")!.textContent).toBe("sprint4 ・ 内訳: e1 2, Epic なし 2");
    expect([...row.querySelectorAll(".counts .badge")].map((b) => b.textContent)).toEqual([
      "完了 3",
      "中止 1",
      "持ち越し 2",
    ]);
    const finished = client.data.tickets.filter(
      (t) => t.iteration === "s4" && (t.status === "done" || t.status === "abandoned"),
    );
    const counts = epicCountsOf(finished);
    expect(counts.reduce((n, c) => n + c.count, 0)).toBe(finished.length);
  });
});

describe("サイドバーの履歴", () => {
  it("開いた Iteration のチケットは Epic で分けず番号の順の 1 本の一覧で出し、持ち越しがなければ持ち越しの節を出さない", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s4", name: "sprint4", status: "closed" })];
    client.data.tickets = [
      ticket({ id: "t10", status: "done", iteration: "s4", epic: "e1", pr: 30 }),
      ticket({ id: "t2", status: "done", iteration: "s4", epic: "e2" }),
      ticket({ id: "t3", status: "abandoned", iteration: "s4" }),
    ];
    client.handlers["history"] = () => ({ events: [], shallow: false, incomplete: [] });
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("sprint4");
    const item = document.querySelector<HTMLDetailsElement>("details.history-item")!;
    item.open = true;
    fireEvent(item, new Event("toggle"));
    await waitFor(() => expect(item.querySelectorAll(".history-list")).toHaveLength(1));
    expect([...item.querySelectorAll(".history-list code")].map((c) => c.textContent)).toEqual([
      "t2",
      "t3",
      "t10",
    ]);
    expect(item.querySelector(".history-group")).toBeNull();
    expect(item.querySelector(".history-ticket.abandoned code")!.textContent).toBe("t3");
    expect(item.querySelector(".history-ticket:last-child .history-ticket-meta")!.textContent).toBe(
      "e1 ・ #30",
    );
  });

  it("終わったチケットのない Epic は薄く出して開けず、チップは完了 0 だけ、2 段目にチケットなし・閉じた日・Iteration を出す", async () => {
    window.location.hash = "#/history?view=epic";
    const client = mockClient();
    client.data.epics[0] = {
      ...client.data.epics[0]!,
      status: "closed",
      closed_at: "2026-10-31T00:00:00Z",
    };
    // e1 のチケットは t2（in_progress）だけで、終わったものはない
    client.data.tickets[1]!.iteration = "s1";
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    const row = (await screen.findByText("最初の版")).closest(".history-epic")!;
    expect(row.querySelector(".progress")).toBeNull();
    expect(row.closest("details")).toBeNull();
    expect(row.closest(".history-item")!.classList.contains("history-empty")).toBe(true);
    expect([...row.querySelectorAll(".counts .badge")].map((b) => b.textContent)).toEqual([
      "完了 0",
    ]);
    expect(row.querySelector("small")!.textContent).toBe(
      "終わったチケットなし ・ 2026-10-31 に閉じた ・ s1",
    );
    expect(screen.getByRole("searchbox").getAttribute("placeholder")).toBe(
      "番号・タイトル・ラベルで検索",
    );
  });

  it("開いた Epic の終わったチケットは番号の順の 1 本の一覧で、2 段目に Iteration（なければ Iteration なし）と PR を出し、Epic は出さない", async () => {
    window.location.hash = "#/history?view=epic";
    const client = mockClient();
    client.data.epics[0] = {
      ...client.data.epics[0]!,
      status: "closed",
      closed_at: "2026-10-31T00:00:00Z",
    };
    client.data.tickets = [
      ticket({ id: "t10", status: "done", iteration: "s1", epic: "e1", pr: 30 }),
      ticket({ id: "t2", status: "done", epic: "e1" }),
      ticket({ id: "t3", status: "abandoned", iteration: "s1", epic: "e1" }),
      // 終わっていないチケットとほかの Epic のチケットは出さない
      ticket({ id: "t4", status: "todo", epic: "e1" }),
      ticket({ id: "t5", status: "done", epic: "e2" }),
    ];
    const opened: unknown[] = [];
    render(
      <StoreProvider client={client}>
        <HostProvider host={{ ...sidebarHost(), open: (r) => opened.push(r) }}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    const row = (await screen.findByText("最初の版")).closest(".history-epic")!;
    expect([...row.querySelectorAll(".counts .badge")].map((b) => b.textContent)).toEqual([
      "完了 2",
      "中止 1",
    ]);
    expect(row.querySelector("small")!.textContent).toBe("2026-10-31 に閉じた ・ s1");
    const item = row.closest<HTMLDetailsElement>("details.history-item")!;
    item.open = true;
    fireEvent(item, new Event("toggle"));
    await waitFor(() => expect(item.querySelectorAll(".history-list")).toHaveLength(1));
    expect([...item.querySelectorAll(".history-list code")].map((c) => c.textContent)).toEqual([
      "t2",
      "t3",
      "t10",
    ]);
    expect([...item.querySelectorAll(".history-ticket-meta")].map((m) => m.textContent)).toEqual([
      "Iteration なし ・ PR なし",
      "Abandoned ・ s1 ・ PR なし",
      "s1 ・ #30",
    ]);
    // 番号を押すと詳細を開く
    fireEvent.click(item.querySelector(".history-list .history-ticket-main")!);
    expect(opened).toEqual([{ page: "ticket", id: "t2" }]);
  });

  it("チケットの見方は日付の見出しなしの終えた新しい順の 1 本の一覧で、2 段目に Iteration・PR・終えた日を出し、中止の行は薄く出す", async () => {
    window.location.hash = "#/history?view=ticket";
    const client = mockClient();
    client.data.tickets = [
      ticket({ id: "t1", title: "古い", status: "done", iteration: "s1", epic: "e1", pr: 12 }),
      ticket({ id: "t2", title: "新しい", status: "done" }),
      ticket({
        id: "t4",
        title: "やめた",
        status: "abandoned",
        updated_at: "2026-01-01T00:00:00Z",
      }),
      ticket({ id: "t5", title: "途中", status: "todo" }),
    ];
    const finished = (id: string, at: string) => ({
      kind: "ticket",
      id,
      commit: id,
      author: "a",
      subject: "s",
      type: "changed",
      at,
      changes: [{ field: "status", from: "review", to: "done" }],
    });
    client.handlers["history"] = () => ({
      events: [finished("t1", "2026-10-01T12:00:00Z"), finished("t2", "2026-10-20T12:00:00Z")],
      shallow: false,
      incomplete: [],
    });
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll(".history-ticket")).toHaveLength(3));
    // 日付の見出しはなく、1 本の一覧
    expect(document.querySelector(".history-group")).toBeNull();
    expect(document.querySelectorAll(".history-list")).toHaveLength(1);
    expect([...document.querySelectorAll(".history-list code")].map((c) => c.textContent)).toEqual([
      "t2",
      "t1",
      "t4",
    ]);
    // 2 段目は Iteration・PR・終えた日。Epic は出さず、終えた日が分からないものは更新日に ~ を付ける
    expect(
      [...document.querySelectorAll(".history-ticket-meta")].map((m) =>
        m.textContent!.replace(/\d\d$/, "dd"),
      ),
    ).toEqual([
      "Iteration なし ・ PR なし ・ 2026-10-dd",
      "s1 ・ #12 ・ 2026-10-dd",
      "Abandoned ・ Iteration なし ・ PR なし ・ ~2026-01-dd",
    ]);
    const abandoned = document.querySelectorAll(".history-ticket")[2]!;
    expect(abandoned.classList.contains("abandoned")).toBe(true);
    expect(document.querySelector(".history-finished")).toBeNull();
    // 絞り込みは検索と結果だけ
    expect(screen.getByLabelText("結果")).toBeTruthy();
    expect(screen.queryByLabelText("Epic")).toBeNull();
  });

  it("チケットの見方の「ほか N 件」は、検索や結果の絞り込みを変えると閉じた状態に戻る", async () => {
    window.location.hash = "#/history?view=ticket";
    const client = mockClient();
    client.data.tickets = Array.from({ length: 12 }, (_, n) =>
      ticket({ id: `t${n + 1}`, title: `チケット ${n + 1}`, status: "done" }),
    );
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    const more = await screen.findByRole("button", { name: "ほか 4 件" });
    fireEvent.click(more);
    expect(document.querySelectorAll(".history-ticket")).toHaveLength(12);
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "チケット" } });
    expect(document.querySelectorAll(".history-ticket")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "ほか 4 件" })).toBeTruthy();
  });

  it("検索中は残った Iteration の行を開いて当たったチケットだけを印付きで出し、「すべて見る」で全件に戻せ、検索語を消すと検索前の開閉に戻る", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s4", name: "sprint4", status: "closed", closed_at: "2026-10-02T00:00:00Z" }),
      iteration({ id: "s3", name: "sprint3", status: "closed", closed_at: "2026-10-01T00:00:00Z" }),
      iteration({ id: "s2", name: "sprint2", status: "closed", closed_at: "2026-09-01T00:00:00Z" }),
    ];
    client.data.tickets = [
      ticket({ id: "t1", title: "検索の欄", status: "done", iteration: "s4" }),
      ticket({ id: "t2", title: "一覧", status: "done", iteration: "s4" }),
      ticket({ id: "t3", title: "検索の印", status: "abandoned", iteration: "s3" }),
      ticket({ id: "t4", title: "設定", status: "done", iteration: "s3" }),
      ticket({ id: "t5", title: "別の題", status: "done", iteration: "s2" }),
    ];
    client.handlers["history"] = () => ({ events: [], shallow: false, incomplete: [] });
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("sprint4");
    const items = () => [...document.querySelectorAll<HTMLDetailsElement>("details.history-item")];
    const codes = (d: Element) =>
      [...d.querySelectorAll(".history-list code")].map((c) => c.textContent);
    // 検索の前に s3 だけ開いておく
    const s3 = items()[1]!;
    s3.open = true;
    fireEvent(s3, new Event("toggle"));
    await waitFor(() => expect(codes(s3)).toEqual(["t3", "t4"]));

    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "検索" } });
    expect(items()).toHaveLength(2);
    expect(items().map((d) => d.open)).toEqual([true, true]);
    expect(codes(items()[0]!)).toEqual(["t1"]);
    expect(codes(items()[1]!)).toEqual(["t3"]);
    expect([...items()[0]!.querySelectorAll(".row-title mark")].map((m) => m.textContent)).toEqual([
      "検索",
    ]);
    expect(items()[0]!.querySelector(".history-hits")!.textContent).toBe(
      "当たった 1 / 2 件すべて見る",
    );

    // 「すべて見る」で、その行の全件の一覧に戻せる（印は残る）
    fireEvent.click(within(items()[0]!).getByRole("button", { name: "すべて見る" }));
    expect(codes(items()[0]!)).toEqual(["t1", "t2"]);
    expect(items()[0]!.querySelectorAll(".row-title mark")).toHaveLength(1);
    expect(codes(items()[1]!)).toEqual(["t3"]);

    // 検索語を消すと、検索前の開閉（s3 だけ開いた）に戻る
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "" } });
    expect(items().map((d) => d.open)).toEqual([false, true, false]);
    expect(codes(items()[1]!)).toEqual(["t3", "t4"]);
    expect(document.querySelector("mark")).toBeNull();
  });

  it("検索中に閉じた行と「すべて見る」は、検索語を変えると捨てる", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    client.data.iterations = [iteration({ id: "s4", name: "sprint4", status: "closed" })];
    client.data.tickets = [
      ticket({ id: "t1", title: "検索の欄", status: "done", iteration: "s4" }),
      ticket({ id: "t2", title: "一覧", status: "done", iteration: "s4" }),
    ];
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("sprint4");
    const item = () => document.querySelector<HTMLDetailsElement>("details.history-item")!;
    const search = screen.getByLabelText("チケットを探す");
    fireEvent.change(search, { target: { value: "検索" } });
    item().open = false;
    fireEvent(item(), new Event("toggle"));
    expect(item().open).toBe(false);
    fireEvent.change(search, { target: { value: "検索の" } });
    expect(item().open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "すべて見る" }));
    expect(item().querySelectorAll(".history-ticket")).toHaveLength(2);
    fireEvent.change(search, { target: { value: "検索の欄" } });
    expect(item().querySelectorAll(".history-ticket")).toHaveLength(1);
  });

  it("検索中は残った Epic の行を開いて当たったチケットだけを出し、終わっていないチケットだけが当たる Epic は残さない", async () => {
    window.location.hash = "#/history?view=epic";
    const client = mockClient();
    client.data.epics = [
      { ...client.data.epics[0]!, id: "e1", status: "closed", closed_at: "2026-10-31T00:00:00Z" },
      {
        ...client.data.epics[0]!,
        id: "e2",
        title: "二番目",
        status: "closed",
        closed_at: "2026-10-30T00:00:00Z",
      },
    ];
    client.data.tickets = [
      ticket({ id: "t1", title: "検索の欄", status: "done", iteration: "s1", epic: "e1" }),
      ticket({ id: "t2", title: "一覧", status: "done", epic: "e1" }),
      ticket({ id: "t3", title: "検索の印", status: "todo", epic: "e2" }),
      ticket({ id: "t4", title: "設定", status: "done", epic: "e2" }),
    ];
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("二番目");
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "検索" } });
    const items = [...document.querySelectorAll<HTMLDetailsElement>("details.history-item")];
    expect(items).toHaveLength(1);
    expect(items[0]!.open).toBe(true);
    expect([...items[0]!.querySelectorAll(".history-list code")].map((c) => c.textContent)).toEqual(
      ["t1"],
    );
    expect(items[0]!.querySelector(".history-ticket-meta")!.textContent).toBe("s1 ・ PR なし");
    expect(items[0]!.querySelector(".row-title mark")!.textContent).toBe("検索");
    fireEvent.click(within(items[0]!).getByRole("button", { name: "すべて見る" }));
    expect([...items[0]!.querySelectorAll(".history-list code")].map((c) => c.textContent)).toEqual(
      ["t1", "t2"],
    );
  });
});

describe("タブを移って戻ったとき", () => {
  const nav = (name: string) => fireEvent.click(screen.getByRole("link", { name }));

  it("検索語と結果の絞り込みはハッシュに入り、他のタブから履歴のタブで戻ると同じ検索語と絞り込みで出る", async () => {
    window.location.hash = "#/history?view=ticket";
    const client = mockClient();
    client.data.tickets = [
      ticket({ id: "t1", title: "ログイン", status: "done" }),
      ticket({ id: "t2", title: "ログアウト", status: "abandoned" }),
      ticket({ id: "t3", title: "一覧", status: "done" }),
    ];
    client.handlers["history"] = () => ({ events: [], shallow: false, incomplete: [] });
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    const codes = () =>
      [...document.querySelectorAll(".history-list code")].map((c) => c.textContent);
    await waitFor(() => expect(codes()).toHaveLength(3));
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "ログ" } });
    fireEvent.change(screen.getByLabelText("結果"), { target: { value: "done" } });
    expect(codes()).toEqual(["t1"]);
    expect(window.location.hash).toBe("#/history?view=ticket&q=%E3%83%AD%E3%82%B0&result=done");
    nav("カンバン");
    await waitFor(() => expect(window.location.hash).toBe("#/board"));
    nav("履歴");
    await waitFor(() => expect(codes()).toEqual(["t1"]));
    expect(screen.getByLabelText<HTMLInputElement>("チケットを探す").value).toBe("ログ");
    expect(screen.getByLabelText<HTMLSelectElement>("結果").value).toBe("done");
    // 見方を変えても検索語は残る
    fireEvent.click(screen.getByRole("button", { name: /^Iteration/ }));
    await waitFor(() =>
      expect(window.location.hash).toBe("#/history?q=%E3%83%AD%E3%82%B0&result=done"),
    );
    expect(screen.getByLabelText<HTMLInputElement>("チケットを探す").value).toBe("ログ");
  });

  it("開いた Iteration・Epic の行は他のタブから戻っても開いたままで、開いた行はハッシュに入らず、持ち越しの履歴は開き直しても読み直さない", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s4", name: "sprint4", status: "closed" }),
      iteration({ id: "s5", name: "sprint5", status: "closed" }),
    ];
    client.data.epics[0] = { ...client.data.epics[0]!, status: "closed" };
    client.data.tickets = [
      ticket({ id: "t1", status: "done", iteration: "s4", epic: client.data.epics[0]!.id }),
      ticket({ id: "t2", status: "done", iteration: "s5" }),
    ];
    let reads = 0;
    client.handlers["history"] = () => {
      reads++;
      return { events: [], shallow: false, incomplete: [] };
    };
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("sprint4");
    const itemOf = (text: string) =>
      screen.getByText(text).closest<HTMLDetailsElement>("details.history-item")!;
    const toggle = (item: HTMLDetailsElement, open: boolean) => {
      item.open = open;
      fireEvent(item, new Event("toggle"));
    };
    toggle(itemOf("sprint4"), true);
    await waitFor(() => expect(itemOf("sprint4").querySelector(".history-list")).toBeTruthy());
    // 閉じて開き直しても履歴は読み直さない
    toggle(itemOf("sprint4"), false);
    toggle(itemOf("sprint4"), true);
    await waitFor(() => expect(itemOf("sprint4").querySelector(".history-list")).toBeTruthy());
    expect(reads).toBe(1);
    expect(window.location.hash).toBe("#/history");
    nav("バックログ");
    await waitFor(() => expect(window.location.hash).toBe("#/backlog"));
    nav("履歴");
    await screen.findByText("sprint4");
    expect(itemOf("sprint4").open).toBe(true);
    expect(itemOf("sprint5").open).toBe(false);
    await waitFor(() => expect(itemOf("sprint4").querySelector(".history-list")).toBeTruthy());
    // Epic の見方でも開いた行を残す
    fireEvent.click(screen.getByRole("button", { name: /^Epic/ }));
    const epicTitle = client.data.epics[0]!.title;
    await screen.findByText(epicTitle);
    toggle(itemOf(epicTitle), true);
    expect(window.location.hash).toBe("#/history?view=epic");
    nav("カンバン");
    await waitFor(() => expect(window.location.hash).toBe("#/board"));
    nav("履歴");
    await screen.findByText(epicTitle);
    expect(itemOf(epicTitle).open).toBe(true);
  });
});

describe("ブラウザの履歴", () => {
  it("検索語と結果の絞り込みをハッシュから戻す", async () => {
    window.location.hash = "#/history?view=ticket&q=%E3%83%AD%E3%82%B0&result=abandoned";
    const client = mockClient();
    client.data.tickets = [
      ticket({ id: "t1", title: "ログイン", status: "done" }),
      ticket({ id: "t2", title: "ログアウト", status: "abandoned" }),
    ];
    client.handlers["history"] = () => ({ events: [], shallow: false, incomplete: [] });
    render(
      <StoreProvider client={client}>
        <HostProvider host={{ ...sidebarHost(), surface: "browser" }}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".history-finished code")].map((c) => c.textContent),
      ).toEqual(["t2"]),
    );
    expect(screen.getByLabelText<HTMLInputElement>("チケットを探す").value).toBe("ログ");
    expect(screen.getByLabelText<HTMLSelectElement>("結果").value).toBe("abandoned");
  });
});
