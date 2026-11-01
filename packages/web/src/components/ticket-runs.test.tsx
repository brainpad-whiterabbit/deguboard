// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../store.js";
import { mockClient } from "../test-helpers.js";
import type { RunView } from "../types.js";
import { formatTokens, TicketRuns } from "./ticket-runs.js";

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
    usage: { input: 12345, output: 678, cache_read: null, cache_write: null },
    running: false,
    ...partial,
  } as RunView;
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
    render(
      <StoreProvider client={client}>
        <TicketRuns id="t3" />
      </StoreProvider>,
    );
    await screen.findByText("成功");
    expect(client.calls.find((c) => c.name === "run.list")?.input).toEqual({ ticket: "t3" });
    const rows = [...document.querySelectorAll(".runs-list tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent),
    );
    expect(rows[0]!.slice(0, 5)).toEqual([
      "implement",
      "claude-code",
      "claude-opus",
      "成功",
      "12,345 / 678",
    ]);
    expect(rows[1]!.slice(0, 5)).toEqual(["review", "claude-code", "—", "実行中", "— / —"]);
    expect(rows[1]![6]).toBe("—");
  });

  it("Run がなければそう出す", async () => {
    render(
      <StoreProvider client={mockClient()}>
        <TicketRuns id="t3" />
      </StoreProvider>,
    );
    expect(await screen.findByText("Run はない")).toBeTruthy();
    expect(document.querySelector(".runs-list")).toBeNull();
  });

  it("トークン数は null を 0 にせず「—」、推定を含めば「~」を付ける", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1500, true)).toBe("~1,500");
  });
});
