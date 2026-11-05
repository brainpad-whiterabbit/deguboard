// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { StoreProvider } from "../store.js";
import { mockClient } from "../test-helpers.js";
import type { MetricsView, RunMetrics, RunView } from "../types.js";
import {
  RESULT_LABELS,
  formatDuration,
  formatTokens,
  runResultKey,
} from "../components/run-parts.js";
import { formatValue, resultsText, splitRuns } from "./runs.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  window.localStorage.clear();
});

function run(partial: Partial<RunView> & { id: string }): RunView {
  return {
    ticket: "t1",
    step: "implement",
    agent: "claude-code",
    model: null,
    started_at: "2026-11-01T00:00:00Z",
    finished_at: null,
    result: null,
    error: null,
    retries: 0,
    retry_reasons: [],
    usage: { input: null, output: null, cache_read: null, cache_write: null },
    tools: null,
    running: false,
    duration_seconds: null,
    ...partial,
  } as RunView;
}

function metrics(partial: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runs: 1,
    results: { success: 1, failure: 0, interrupted: 0, unfinished: 0 },
    retries: 0,
    duration_seconds: 90,
    input: null,
    output: null,
    cache_read: null,
    cache_write: null,
    tools: null,
    missing: {
      duration_seconds: 0,
      input: 1,
      output: 1,
      cache_read: 1,
      cache_write: 1,
      tools: 1,
    },
    estimated_runs: 0,
    ...partial,
  };
}

describe("Run の画面の表示", () => {
  it("時間とトークン数は null を 0 と見せず「—」と出し、推定を含めば「~」を付ける", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("0秒");
    expect(formatDuration(125)).toBe("2分 5秒");
    expect(formatDuration(3720)).toBe("1時間 2分");
    expect(formatDuration(12, true)).toBe("~12秒");
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1234567)).toBe("1,234,567");
    expect(formatValue("input", 1500, true)).toBe("~1,500");
    expect(formatValue("duration_seconds", null, true)).toBe("—");
  });

  it("結果の表示名：実行中、result のないまま終わった Run は「未完了」", () => {
    const label = (r: RunView) => RESULT_LABELS[runResultKey(r)];
    expect(label(run({ id: "r20261101-000000-aaaa", running: true }))).toBe("実行中");
    expect(label(run({ id: "r20261101-000000-aaaa", running: false }))).toBe("未完了");
    expect(label(run({ id: "r20261101-000000-aaaa", result: "failure" }))).toBe("失敗");
  });

  it("結果の内訳は 0 件を省き、すべて 0 なら「—」", () => {
    expect(
      resultsText(metrics({ results: { success: 2, failure: 0, interrupted: 1, unfinished: 0 } })),
    ).toBe("成功 2 ・ 中断 1");
    expect(
      resultsText(metrics({ results: { success: 0, failure: 0, interrupted: 0, unfinished: 0 } })),
    ).toBe("—");
  });

  it("Run を実行中は古い順・完了は新しい順に分ける（Project の絞り込みは run.list が行う）", () => {
    const runs = [
      run({ id: "r20261101-000000-aaaa", running: false }),
      run({ id: "r20261101-010000-bbbb", running: true }),
      run({ id: "r20261101-020000-cccc", running: false }),
      run({ id: "r20261101-030000-dddd", running: true }),
    ];
    const { running, finished } = splitRuns(runs);
    expect(running.map((r) => r.id)).toEqual(["r20261101-010000-bbbb", "r20261101-030000-dddd"]);
    expect(finished.map((r) => r.id)).toEqual(["r20261101-020000-cccc", "r20261101-000000-aaaa"]);
  });
});

describe("Run の画面", () => {
  function setup() {
    const client = mockClient();
    const runs = [
      run({ id: "r20261101-010000-aaaa", ticket: "t2", step: "review", running: true }),
      run({
        id: "r20261101-000000-bbbb",
        ticket: "t1",
        finished_at: "2026-11-01T00:01:30Z",
        duration_seconds: 90,
        result: "success",
        usage: { input: 1200, output: null, cache_read: null, cache_write: null },
      }),
    ];
    client.handlers["run.list"] = () => runs;
    client.handlers["metrics.show"] = (input) => {
      const by = (input as { by: MetricsView["by"] }).by;
      const view: MetricsView = {
        filter: { project: "default" },
        by,
        total: metrics({ input: 1200, estimated_runs: 1 }),
        groups: [
          { key: by === "epic" ? "e1" : "t1", ...metrics({ input: 1200 }) },
          { key: null, ...metrics() },
        ],
      };
      return view;
    };
    window.location.hash = "#/runs";
    render(
      <StoreProvider client={client}>
        <App />
      </StoreProvider>,
    );
    return client;
  }

  it("選んだ Project で絞った run.list の Run を実行中と完了に分けて出し、時間は返った duration_seconds を出す。上のバーに Run のタブがある", async () => {
    const client = setup();
    await screen.findByText("r20261101-010000-aaaa");
    // store の読み直しも行の印のために running だけの run.list を呼ぶので、Run の画面の呼び出しを引く
    expect(
      client.calls.some(
        (c) => c.name === "run.list" && JSON.stringify(c.input) === '{"project":"default"}',
      ),
    ).toBe(true);
    expect(screen.getByRole("link", { name: "Run" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("実行中 1 ・ 完了 1")).toBeTruthy();
    const [runningTable, , finishedTable] = screen.getAllByRole("table");
    expect(within(runningTable!).getByText("review")).toBeTruthy();
    expect(within(runningTable!).getByText("実行中")).toBeTruthy();
    expect(within(finishedTable!).getByText("成功")).toBeTruthy();
    expect(within(finishedTable!).getByText("1分 30秒")).toBeTruthy();
    expect(within(finishedTable!).getByText("1,200")).toBeTruthy();
    expect(within(finishedTable!).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("集計は選んだ Project で絞ってチケットごとに出し、値のない合計は「—」、欠けた数・推定・null の単位も出す", async () => {
    const client = setup();
    await screen.findByText("r20261101-010000-aaaa");
    expect(client.calls.find((c) => c.name === "metrics.show")?.input).toEqual({
      project: "default",
      by: "ticket",
    });
    const cards = document.querySelector(".metric-cards")!;
    // 推定を含む Run があるので合計の値には「~」が付く
    expect(within(cards as HTMLElement).getByText("~1分 30秒")).toBeTruthy();
    expect(within(cards as HTMLElement).getByText("~1,200")).toBeTruthy();
    expect(within(cards as HTMLElement).getAllByText("—")).toHaveLength(3);
    expect(within(cards as HTMLElement).getAllByText("欠け 1").length).toBeGreaterThan(0);
    expect(screen.getByText(/推定の値を含む Run が 1 件ある/)).toBeTruthy();
    const groups = document.querySelector(".metrics-table")!;
    expect(within(groups as HTMLElement).getByText("なし")).toBeTruthy();
    // 画面は常に選んだ Project で絞るので、単位に Project はない
    const options = [...(screen.getByLabelText("単位") as HTMLSelectElement).options].map(
      (o) => o.value,
    );
    expect(options).toEqual(["run", "ticket", "epic", "iteration", "agent", "model", "step"]);
    expect(within(groups as HTMLElement).getByText("t1")).toBeTruthy();
  });

  it("単位を切り替えるとハッシュに残り、その単位で集計し直す", async () => {
    const client = setup();
    await screen.findByText("r20261101-010000-aaaa");
    fireEvent.change(screen.getByLabelText("単位"), { target: { value: "epic" } });
    await waitFor(() => expect(window.location.hash).toBe("#/runs?by=epic"));
    await waitFor(() =>
      expect(client.calls.filter((c) => c.name === "metrics.show").at(-1)?.input).toEqual({
        project: "default",
        by: "epic",
      }),
    );
    const groups = document.querySelector(".metrics-table")!;
    await within(groups as HTMLElement).findByText("e1");
    expect(within(groups as HTMLElement).getByRole("columnheader", { name: "Epic" })).toBeTruthy();
  });

  it("Iteration で絞って開くと run.list と metrics.show をその Iteration で絞り、単位を変えても残し、解除で外す", async () => {
    const client = setup();
    await screen.findByText("r20261101-010000-aaaa");
    window.location.hash = "#/runs?by=iteration&iteration=s4";
    await waitFor(() =>
      expect(client.calls.filter((c) => c.name === "metrics.show").at(-1)?.input).toEqual({
        project: "default",
        iteration: "s4",
        by: "iteration",
      }),
    );
    expect(
      client.calls.some(
        (c) =>
          c.name === "run.list" &&
          JSON.stringify(c.input) === '{"project":"default","iteration":"s4"}',
      ),
    ).toBe(true);
    const filter = await waitFor(() => document.querySelector<HTMLElement>(".runs-filter")!);
    expect(within(filter).getByRole("link", { name: "s4" }).getAttribute("href")).toBe(
      "#/iterations/s4",
    );
    fireEvent.change(screen.getByLabelText("単位"), { target: { value: "epic" } });
    await waitFor(() => expect(window.location.hash).toBe("#/runs?by=epic&iteration=s4"));
    fireEvent.click(within(filter).getByRole("link", { name: "解除" }));
    await waitFor(() => expect(window.location.hash).toBe("#/runs?by=epic"));
    await waitFor(() => expect(document.querySelector(".runs-filter")).toBeNull());
    expect(client.calls.filter((c) => c.name === "metrics.show").at(-1)?.input).toEqual({
      project: "default",
      by: "epic",
    });
  });

  it("Run か集計を取れなければ理由だけを出し、「Run はない」のような空の文言を出さない", async () => {
    const client = mockClient();
    client.handlers["run.list"] = () => [];
    client.handlers["metrics.show"] = () => {
      throw new Error("集計できない");
    };
    window.location.hash = "#/runs";
    render(
      <StoreProvider client={client}>
        <App />
      </StoreProvider>,
    );
    expect((await screen.findByText("集計できない")).className).toBe("error");
    expect(screen.queryByText("実行中の Run はない")).toBeNull();
    expect(screen.queryByText("完了した Run はない")).toBeNull();
    expect(screen.queryByText("読み込み中…")).toBeNull();
  });

  it("run.list と metrics.show の警告（壊れた実行中の記録など）を並べて出す", async () => {
    const client = setup();
    const original = client.run.bind(client);
    client.run = async <O,>(name: string, input?: unknown) => {
      const r = await original<O>(name, input);
      if (name === "run.list")
        return {
          ...r,
          warnings: ["deguboard-local/runs/r20261101-000000-0001.json: JSON を読めない"],
        };
      if (name === "metrics.show") return { ...r, warnings: ["チケット t9 が見つからない"] };
      return r;
    };
    fireEvent.click(await screen.findByRole("button", { name: "読み直す" }));
    const text =
      "deguboard-local/runs/r20261101-000000-0001.json: JSON を読めない / チケット t9 が見つからない";
    expect((await screen.findByText(text)).className).toBe("muted");
    // 一覧は警告があっても出す
    expect(screen.getByText("r20261101-010000-aaaa")).toBeTruthy();
  });

  it("「読み直す」で run.list と metrics.show を取り直し、終わった Run を完了に移し、消えた警告を出さない", async () => {
    const client = setup();
    await screen.findByText("実行中 1 ・ 完了 1");
    const lists = () => client.calls.filter((c) => c.name === "run.list").length;
    const reports = () => client.calls.filter((c) => c.name === "metrics.show").length;
    const before = { lists: lists(), reports: reports() };

    // 1 回目の読み直しでは警告が出る
    const original = client.run.bind(client);
    let warn = true;
    client.run = async <O,>(name: string, input?: unknown) => {
      const r = await original<O>(name, input);
      return name === "run.list" && warn ? { ...r, warnings: ["壊れた記録"] } : r;
    };
    fireEvent.click(screen.getByRole("button", { name: "読み直す" }));
    expect(await screen.findByText("壊れた記録")).toBeTruthy();
    expect(lists()).toBe(before.lists + 1);
    expect(reports()).toBe(before.reports + 1);

    // 実行中だった Run が終わり、警告も消えた
    warn = false;
    client.handlers["run.list"] = () => [
      run({
        id: "r20261101-010000-aaaa",
        ticket: "t2",
        step: "review",
        result: "interrupted",
        finished_at: "2026-11-01T01:00:05Z",
        duration_seconds: 5,
      }),
    ];
    fireEvent.click(screen.getByRole("button", { name: "読み直す" }));
    expect(await screen.findByText("実行中 0 ・ 完了 1")).toBeTruthy();
    expect(screen.getByText("実行中の Run はない")).toBeTruthy();
    expect(screen.getByText("中断")).toBeTruthy();
    expect(screen.queryByText("壊れた記録")).toBeNull();
    expect(lists()).toBe(before.lists + 2);
  });

  it("Project がなければ読み込み中のまま止まらず、そう出す", async () => {
    const client = mockClient();
    client.data.projects = [];
    window.location.hash = "#/runs";
    render(
      <StoreProvider client={client}>
        <App />
      </StoreProvider>,
    );
    expect(await screen.findByText("Project がない")).toBeTruthy();
    expect(client.calls.some((c) => c.name === "metrics.show")).toBe(false);
  });
});
