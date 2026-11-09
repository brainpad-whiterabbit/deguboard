// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { HostProvider, type Host } from "../host.js";
import { parseRoute } from "../router.js";
import { StoreProvider } from "../store.js";
import { iteration, mockClient, ticket } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";
// 持ち越しの求め方の写しを照らすためだけに core の実行時のコード（carriedOverFrom）を取り込む（画面のコードは型だけを取る。ADR-033）
import { carriedOverFrom as coreCarriedOverFrom } from "@deguboard/core";
import { carriedOverFrom, epicCountsOf, groupByEpic, historyAskTarget } from "./history.js";

// 日付の書き方（今日・昨日・月/日）は今に依るので、今を固定する（Date だけ。待ち合わせの timer は本物のまま）
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-04T12:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  window.location.hash = "";
});

describe("履歴のタイトル行の吹き出しの対象（UI-15）", () => {
  const openOf = (ids: string[]) => (id: string) => ids.includes(id);

  it("開いている行のうち最後に開いたものを対象にする", () => {
    expect(historyAskTarget(["s3", "s2", "s1"], openOf(["s1", "s3"]), ["s1", "s3"])).toEqual([
      "s3",
    ]);
    expect(historyAskTarget(["s3", "s2", "s1"], openOf(["s1", "s3"]), ["s3", "s1"])).toEqual([
      "s1",
    ]);
  });

  it("出ていない行・閉じた行は対象にしない", () => {
    expect(historyAskTarget(["s2"], openOf(["s2"]), ["s2", "s5"])).toEqual(["s2"]);
    expect(historyAskTarget(["s2", "s1"], openOf(["s2"]), ["s2", "s1"])).toEqual(["s2"]);
  });

  it("検索で開いた行だけなら、1 つのときだけ対象にする", () => {
    expect(historyAskTarget(["s2"], openOf(["s2"]), [])).toEqual(["s2"]);
    expect(historyAskTarget(["s2", "s1"], openOf(["s2", "s1"]), [])).toEqual([]);
  });

  it("開いている行がなければ対象なし", () => {
    expect(historyAskTarget(["s2", "s1"], openOf([]), ["s1"])).toEqual([]);
  });
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

  it("core の carriedOverFrom（iteration.show の next）と同じ入力で同じ結果を返す（写しがずれたら落ちる）", () => {
    const ev = (id: string, from: string | null, to: string | null) =>
      ({ kind: "ticket", id, at: "x", changes: [{ field: "iteration", from, to }] }) as never;
    const events = [
      ev("t10", "s1", null),
      ev("t2", "s1", "s2"),
      ev("t3", "s1", null),
      ev("t4", null, "s1"),
      ev("t6", "s1", "s1"),
      ev("t7", "s2", "s3"),
      ev("t2", "s2", "s1"),
      {
        kind: "epic",
        id: "e1",
        at: "x",
        changes: [{ field: "iteration", from: "s1", to: null }],
      } as never,
      {
        kind: "ticket",
        id: "t8",
        at: "x",
        changes: [{ field: "status", from: "todo", to: "done" }],
      } as never,
    ];
    for (const [it, tickets] of [
      ["s1", [ticket({ id: "t3", iteration: "s1" })]],
      ["s1", []],
      ["s2", [ticket({ id: "t7", iteration: "s2" })]],
      ["s9", []],
    ] as const) {
      expect(carriedOverFrom(it, events, tickets)).toEqual(
        coreCarriedOverFrom(it, events, tickets),
      );
    }
  });
});

function sidebarHost(): Host {
  return {
    surface: "sidebar",
    open: () => {},
    show: () => {},
    copy: async () => {},
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
        // 予定の期間は実際に閉じた日と食い違うので出さない
        start: "2026-11-15",
        end: "2026-11-28",
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
    expect(row.querySelector("small")!.textContent).toBe("11/01 に閉じた ・ e1 2, Epic なし 2");
    expect([...row.querySelectorAll(".counts > span")].map((b) => b.textContent)).toEqual([
      "3",
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

describe("Iteration の行の 1 段目と 2 段目", () => {
  it("目標がなければ名前（sprint4）ではなく「目標なし」を出し、目標があれば名前を出さない。閉じた日は今日・昨日を言葉で出し、正確な日時をツールチップに置く。内訳は終わったチケットがすべて Epic なしなら出さない", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s4", name: "sprint4", status: "closed", closed_at: "2026-11-01T00:00:00Z" }),
      iteration({
        id: "s5",
        name: "sprint5",
        goal: "目標あり",
        status: "closed",
        closed_at: "2026-11-02T00:00:00Z",
      }),
      iteration({
        id: "s6",
        name: "n6",
        goal: "きのう",
        status: "closed",
        closed_at: "2026-11-03T08:30:00Z",
      }),
      iteration({
        id: "s7",
        name: "n7",
        goal: "きょう",
        status: "closed",
        closed_at: "2026-11-04T01:00:00Z",
      }),
    ];
    client.data.tickets = [
      ticket({ id: "t1", status: "done", iteration: "s4" }),
      ticket({ id: "t2", status: "done", iteration: "s5" }),
    ];
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    const none = (await screen.findByText("目標なし")).closest(".history-row")!;
    expect(none.querySelector("small")!.textContent).toBe("11/01 に閉じた");
    const goal = screen.getByText("目標あり").closest(".history-row")!;
    expect(goal.querySelector("small")!.textContent).toBe("11/02 に閉じた");
    const yesterday = screen.getByText("きのう").closest(".history-row")!;
    expect(yesterday.querySelector("small")!.textContent).toBe("昨日 に閉じた");
    expect(yesterday.querySelector("time")!.getAttribute("title")).toBe("2026-11-03 08:30");
    const today = screen.getByText("きょう").closest(".history-row")!;
    expect(today.querySelector("small")!.textContent).toBe("今日 に閉じた");
    expect(document.body.textContent).not.toContain("sprint4");
    expect(document.body.textContent).not.toContain("sprint5");
    expect(document.body.textContent).not.toContain("内訳");
  });
});

describe("サイドバーの履歴", () => {
  it("開いた Iteration のチケットは Epic で分けず番号の順の 1 本の一覧で出し、持ち越しがなければ持ち越しの節を出さない", async () => {
    window.location.hash = "#/history";
    const client = mockClient();
    client.data.iterations = [
      iteration({ id: "s4", name: "sprint4", goal: "sprint4", status: "closed" }),
    ];
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
    expect([...row.querySelectorAll(".counts > span")].map((b) => b.textContent)).toEqual(["0"]);
    expect(row.querySelector("small")!.textContent).toBe(
      "終わったチケットなし ・ 10/31 に閉じた ・ s1",
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
    expect([...row.querySelectorAll(".counts > span")].map((b) => b.textContent)).toEqual([
      "2",
      "中止 1",
    ]);
    expect(row.querySelector("small")!.textContent).toBe("10/31 に閉じた ・ s1");
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
      "Iteration なし ・ PR なし ・ 10/dd",
      "s1 ・ #12 ・ 10/dd",
      "Abandoned ・ Iteration なし ・ PR なし ・ ~01/dd",
    ]);
    const abandoned = document.querySelectorAll(".history-ticket")[2]!;
    expect(abandoned.classList.contains("abandoned")).toBe(true);
    // 絞り込みは検索と結果だけ
    expect(screen.getByLabelText("結果")).toBeTruthy();
    expect(screen.queryByLabelText("Epic")).toBeNull();
  });

  it("チケットの見方は history の結果が届く前から更新日の新しい順で出し、届いたら終えた時刻の順に並べ直す。失敗しても更新日の順のまま出す", async () => {
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
    const setup = (history: () => unknown) => {
      window.location.hash = "#/history?view=ticket";
      const client = mockClient();
      client.data.tickets = [
        ticket({
          id: "t1",
          title: "更新が古い",
          status: "done",
          updated_at: "2026-10-01T00:00:00Z",
        }),
        ticket({
          id: "t2",
          title: "更新が新しい",
          status: "done",
          updated_at: "2026-10-20T00:00:00Z",
        }),
      ];
      client.handlers["history"] = history;
      render(
        <StoreProvider client={client}>
          <HostProvider host={sidebarHost()}>
            <App />
          </HostProvider>
        </StoreProvider>,
      );
    };
    const ids = () =>
      [...document.querySelectorAll(".history-list code")].map((c) => c.textContent);
    const dates = () =>
      [...document.querySelectorAll(".history-ticket-meta time")].map((c) => c.textContent);

    // 結果が届く前
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setup(async () => {
      await gate;
      return {
        events: [finished("t1", "2026-10-25T12:00:00Z"), finished("t2", "2026-10-10T12:00:00Z")],
        shallow: false,
        incomplete: [],
      };
    });
    await waitFor(() => expect(ids()).toEqual(["t2", "t1"]));
    expect(screen.getByRole("status").textContent).toContain("終えた時刻を読み込み中");
    expect(dates()).toEqual(["~10/20", "~10/01"]);
    // 届いたら終えた時刻の順に並べ直し、日付も置き換わり、読み中の表示は消える
    release();
    await waitFor(() => expect(ids()).toEqual(["t1", "t2"]));
    expect(dates()).toEqual(["10/25", "10/10"]);
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();

    // 失敗しても更新日の順のまま出す
    setup(async () => {
      throw new Error("history が読めない");
    });
    await waitFor(() => expect(document.querySelector(".error")).not.toBeNull());
    expect(ids()).toEqual(["t2", "t1"]);
    expect(screen.queryByRole("status")).toBeNull();
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
      iteration({
        id: "s4",
        name: "sprint4",
        goal: "sprint4",
        status: "closed",
        closed_at: "2026-10-02T00:00:00Z",
      }),
      iteration({
        id: "s3",
        name: "sprint3",
        goal: "sprint3",
        status: "closed",
        closed_at: "2026-10-01T00:00:00Z",
      }),
      iteration({
        id: "s2",
        name: "sprint2",
        goal: "sprint2",
        status: "closed",
        closed_at: "2026-09-01T00:00:00Z",
      }),
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
    client.data.iterations = [
      iteration({ id: "s4", name: "sprint4", goal: "sprint4", status: "closed" }),
    ];
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

  it("検索の番号はバックログと同じく部分一致で当たり（t1 で t12）、番号の当たった部分に印を付ける", async () => {
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
      ticket({ id: "t12", title: "欄", status: "done", epic: "e1" }),
      ticket({ id: "t2", title: "一覧", status: "done", epic: "e1" }),
      ticket({ id: "t3", title: "設定", status: "done", epic: "e2" }),
    ];
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("二番目");
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "T1" } });
    const items = [...document.querySelectorAll<HTMLDetailsElement>("details.history-item")];
    expect(items).toHaveLength(1);
    expect([...items[0]!.querySelectorAll(".history-list code")].map((c) => c.textContent)).toEqual(
      ["t12"],
    );
    expect(items[0]!.querySelector(".history-list code mark")!.textContent).toBe("t1");
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
    fireEvent.click(
      within(screen.getByRole("group", { name: "結果" })).getByRole("button", { name: /^Done/ }),
    );
    expect(codes()).toEqual(["t1"]);
    expect(window.location.hash).toBe("#/history?view=ticket&q=%E3%83%AD%E3%82%B0&result=done");
    nav("カンバン");
    await waitFor(() => expect(window.location.hash).toBe("#/board"));
    nav("履歴");
    await waitFor(() => expect(codes()).toEqual(["t1"]));
    expect(screen.getByLabelText<HTMLInputElement>("チケットを探す").value).toBe("ログ");
    expect(
      within(screen.getByRole("group", { name: "結果" })).getByRole("button", { name: /^Done/ }),
    ).toHaveProperty("ariaPressed", "true");
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
      iteration({ id: "s4", name: "sprint4", goal: "sprint4", status: "closed" }),
      iteration({ id: "s5", name: "sprint5", goal: "sprint5", status: "closed" }),
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

describe("履歴のハッシュ", () => {
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
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".history-list .ticket-row code")].map((c) => c.textContent),
      ).toEqual(["t2"]),
    );
    expect(screen.getByLabelText<HTMLInputElement>("チケットを探す").value).toBe("ログ");
    expect(
      within(screen.getByRole("group", { name: "結果" })).getByRole("button", {
        name: /^Abandoned/,
      }),
    ).toHaveProperty("ariaPressed", "true");
  });

  it("結果の切り替えは検索に当たった数を出し、中止が 0 件なら中止を出さない", async () => {
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
    const group = await screen.findByRole("group", { name: "結果" });
    const names = () =>
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent);
    expect(names()).toEqual(["すべて 3", "Done 2", "Abandoned 1"]);
    fireEvent.change(screen.getByLabelText("チケットを探す"), { target: { value: "一覧" } });
    expect(names()).toEqual(["すべて 1", "Done 1"]);
    // 中止を選んでいるときは、検索に当たらず 0 件でも中止を残す
    window.location.hash = "#/history?view=ticket&result=abandoned&q=%E4%B8%80%E8%A6%A7";
    await waitFor(() => expect(names()).toEqual(["すべて 1", "Done 1", "Abandoned 0"]));
  });
});

describe("履歴のタブ・Iteration の行・Epic の見方", () => {
  it("履歴のタブは closed の Iteration を閉じた新しい順に出し、チケットで絞れ、行はホストに開いてもらう", async () => {
    window.location.hash = "";
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
    const opened: unknown[] = [];
    render(
      <StoreProvider client={client}>
        <HostProvider host={{ ...sidebarHost(), open: (r) => opened.push(r) }}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    const tab = await screen.findByRole("link", { name: /履歴/ });
    expect(tab.textContent).toBe("履歴");
    fireEvent.click(tab);
    await screen.findByRole("heading", { level: 1, name: "履歴" });
    const names = () =>
      [...document.querySelectorAll(".history-row .name")].map((e) => e.textContent);
    // 目標のある s1 は目標だけを 1 段目に出し（名前は出さない）、目標のない s2 は「目標なし」を薄く出す
    expect(names()).toEqual(["目標なし", "core"]);
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
    expect(screen.getByRole("button", { name: /^Iteration/ }).textContent).toBe("Iteration 1 / 2");
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
    const opened: unknown[] = [];
    render(
      <StoreProvider client={client}>
        <HostProvider host={{ ...sidebarHost(), open: (r) => opened.push(r) }}>
          <App />
        </HostProvider>
      </StoreProvider>,
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
    render(
      <StoreProvider client={client}>
        <HostProvider host={sidebarHost()}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
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
    expect(screen.getByRole("button", { name: /^Epic/ }).textContent).toBe("Epic 1 / 2");
  });
});
