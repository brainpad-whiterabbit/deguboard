// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createHost, HostProvider } from "../host.js";
import { StoreProvider } from "../store.js";
import { mockClient } from "../test-helpers.js";
import type { RunView } from "../types.js";
import { formatTokens } from "./run-parts.js";
import { formatTokenSum, TicketRuns } from "./ticket-runs.js";

afterEach(cleanup);

function run(partial: Partial<RunView> & { id: string }): RunView {
  return {
    ticket: "t3",
    step: "implement",
    agent: "claude-code",
    model: "claude-opus",
    started_at: "2026-11-01T01:00:00Z",
    finished_at: "2026-11-01T01:30:00Z",
    result: "success",
    error: null,
    retries: 0,
    retry_reasons: [],
    usage: { input: 12345, output: 678, cache_read: null, cache_write: null },
    running: false,
    duration_seconds: 1800,
    ...partial,
  } as RunView;
}

function renderPanel(client: ReturnType<typeof mockClient>) {
  return render(
    <HostProvider host={createHost("panel", null)}>
      <StoreProvider client={client}>
        <TicketRuns id="t3" />
      </StoreProvider>
    </HostProvider>,
  );
}

describe("チケット詳細の Run", () => {
  it("run.list をチケットで絞って呼び、終わった Run と実行中の Run を出す。取れなかった値は「—」", async () => {
    const client = mockClient();
    client.handlers["run.list"] = () => [
      run({ id: "r20261101-010000-aaaa" }),
      run({
        id: "r20261101-020000-bbbb",
        step: "review",
        model: null,
        finished_at: null,
        result: null,
        usage: { input: null, output: null, cache_read: null, cache_write: null },
        running: true,
      }),
    ];
    renderPanel(client);
    await screen.findByRole("img", { name: "成功" });
    expect(client.calls.find((c) => c.name === "run.list")?.input).toEqual({ ticket: "t3" });
    const rows = [...document.querySelectorAll(".ticket-run")];
    expect(rows.map((r) => r.querySelector(".ticket-run-step")!.textContent)).toEqual([
      "implement",
      "review",
    ]);
    const second = rows[1]!;
    expect(second.querySelector(".run-dot")!.getAttribute("aria-label")).toBe("実行中");
    expect(second.querySelector(".ticket-run-model")!.textContent).toBe("—");
    const pairs = Object.fromEntries(
      [...second.querySelectorAll("dt")].map((dt) => [
        dt.textContent,
        dt.nextElementSibling!.textContent,
      ]),
    );
    expect(pairs["トークン"]).toBe("入力 — / 出力 — / cache read — / cache write —");
    expect(pairs["終了"]).toBe("—");
  });

  it("Run がなければそう出す", async () => {
    renderPanel(mockClient());
    expect(await screen.findByText("Run はない")).toBeTruthy();
    expect(document.querySelector(".ticket-run")).toBeNull();
  });

  it("推定を含む使用量は「~」を付けて（推定を含む）と添え、run.list の警告を一覧の上に出す", async () => {
    const client = mockClient();
    client.handlers["run.list"] = () => [
      run({
        id: "r20261101-010000-aaaa",
        usage: { input: 1500, output: 20, cache_read: null, cache_write: null, estimated: true },
      }),
    ];
    const original = client.run.bind(client);
    client.run = async <O,>(name: string, input?: unknown) => {
      const r = await original<O>(name, input);
      return name === "run.list"
        ? { ...r, warnings: ["deguboard-local/runs/x.json: 読めない"] }
        : r;
    };
    renderPanel(client);
    await screen.findByRole("img", { name: "成功" });
    const tokens = document.querySelector(".ticket-run-detail dd.num")!.textContent;
    expect(tokens).toContain("入力 ~1,500 / 出力 ~20");
    expect(tokens).toContain("（推定を含む）");
    expect(screen.getByText("deguboard-local/runs/x.json: 読めない").className).toBe("muted");
  });

  it("run.list が失敗したら理由を出す", async () => {
    const client = mockClient();
    client.handlers["run.list"] = () => {
      throw new Error("Run を読めない");
    };
    renderPanel(client);
    expect((await screen.findByText("Run を読めない")).className).toBe("error");
    expect(document.querySelector(".ticket-run")).toBeNull();
  });

  it("トークン数は null を 0 にせず「—」、推定を含めば「~」を付ける", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1500, true)).toBe("~1,500");
  });

  it("1 行に step・結果の丸印・model と再試行・開始と所要を出す", async () => {
    const client = mockClient();
    client.handlers["run.list"] = () => [
      run({ id: "r20261101-010000-aaaa", retries: 2 }),
      run({
        id: "r20261101-020000-bbbb",
        step: "review",
        model: null,
        result: "failure",
        error: "落ちた",
      }),
    ];
    renderPanel(client);
    await screen.findAllByRole("img", { name: "成功" });
    const rows = [...document.querySelectorAll(".ticket-run > summary")];
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.querySelector(".ticket-run-step")!.textContent).toBe("implement");
    expect(first.querySelector(".run-dot")!.getAttribute("aria-label")).toBe("成功");
    expect(first.querySelector(".ticket-run-model")!.textContent).toBe("claude-opus");
    expect(first.querySelector(".ticket-run-retries")!.textContent).toBe("再試行 2");
    expect(first.querySelector(".ticket-run-time time")!.getAttribute("dateTime")).toBe(
      "2026-11-01T01:00:00Z",
    );
    expect(first.querySelector(".ticket-run-time")!.textContent).toContain("30分 0秒");
    // agent は 1 行に出さない
    expect(first.textContent).not.toContain("claude-code");
    const second = rows[1]!;
    expect(second.querySelector(".ticket-run-model")!.textContent).toBe("—");
    expect(second.querySelector(".ticket-run-retries")).toBeNull();
    expect(second.querySelector(".run-dot")!.getAttribute("title")).toBe("失敗：落ちた");
  });

  it("開くと agent・入力 / 出力 / cache のトークン・終了時刻・Run ID を出す", async () => {
    const client = mockClient();
    client.handlers["run.list"] = () => [
      run({
        id: "r20261101-010000-aaaa",
        usage: { input: 12345, output: 678, cache_read: 9000, cache_write: null },
      }),
    ];
    renderPanel(client);
    await screen.findByRole("img", { name: "成功" });
    const detail = document.querySelector(".ticket-run-detail")!;
    const pairs = Object.fromEntries(
      [...detail.querySelectorAll("dt")].map((dt) => [
        dt.textContent,
        dt.nextElementSibling!.textContent,
      ]),
    );
    expect(pairs.agent).toBe("claude-code");
    expect(pairs["トークン"]).toBe("入力 12,345 / 出力 678 / cache read 9,000 / cache write —");
    expect(detail.querySelector("dd time")!.getAttribute("dateTime")).toBe("2026-11-01T01:30:00Z");
    expect(pairs["Run ID"]).toBe("r20261101-010000-aaaa");
  });

  it("見出しに件数・結果の内訳・トークンの合計を出し、取れなかった値は「+ —」で示す", async () => {
    const client = mockClient();
    client.handlers["run.list"] = () => [
      run({ id: "r20261101-010000-aaaa" }),
      run({ id: "r20261101-020000-bbbb", result: "failure" }),
      run({
        id: "r20261101-030000-cccc",
        finished_at: null,
        result: null,
        running: true,
        usage: { input: null, output: null, cache_read: null, cache_write: null },
      }),
    ];
    renderPanel(client);
    await screen.findAllByRole("img", { name: "成功" });
    const parts = [...document.querySelectorAll(".ticket-runs-summary > span")].map(
      (s) => s.textContent,
    );
    expect(parts).toEqual(["3 件", "成功 1 · 失敗 1 · 実行中 1", "24,690 + — / 1,356 + —"]);
    expect(document.querySelector(".ticket-runs-summary")!.closest("h2")).toBeTruthy();
  });

  it("Run がなければ見出しに合計を出さない", async () => {
    renderPanel(mockClient());
    expect(await screen.findByText("Run はない")).toBeTruthy();
    expect(document.querySelector(".ticket-runs-summary")).toBeNull();
  });

  it("合計はすべて取れなければ「—」、一部なら「+ —」、推定を含めば「~」を付け、0 と見せない", () => {
    const empty = { input: null, output: null, cache_read: null, cache_write: null };
    expect(formatTokenSum([run({ id: "ra", usage: empty })], "input")).toBe("—");
    expect(formatTokenSum([run({ id: "ra" }), run({ id: "rb", usage: empty })], "input")).toBe(
      "12,345 + —",
    );
    expect(
      formatTokenSum(
        [run({ id: "ra", usage: { ...empty, input: 10, estimated: true } }), run({ id: "rb" })],
        "input",
      ),
    ).toBe("~12,355");
    expect(formatTokenSum([run({ id: "ra", usage: { ...empty, input: 0 } })], "input")).toBe("0");
    // null の Run の推定は合計に入らないので「~」を付けない
    expect(
      formatTokenSum(
        [run({ id: "ra" }), run({ id: "rb", usage: { ...empty, estimated: true } })],
        "input",
      ),
    ).toBe("12,345 + —");
  });
});
