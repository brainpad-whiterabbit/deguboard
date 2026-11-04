// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import { iteration, iterationDetail, mockClient, ticket } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { IterationNext, nextStepOf } from "./iteration-next.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const items = (...s: Array<"todo" | "done" | "abandoned">) =>
  s.map((status, n) => ticket({ id: `t${n + 1}`, title: `題${n + 1}`, status, iteration: "s1" }));

describe("Iteration の次の操作の案内（UI-5）", () => {
  it("active で全件が done か abandoned なら ready", () => {
    const it = iterationDetail(
      iteration({ id: "s1", name: "a", status: "active" }),
      items("done", "abandoned"),
    );
    expect(nextStepOf(it, "2026-11-04")).toEqual({ kind: "ready" });
  });

  it("active で終了日を過ぎて未完了があれば overdue（件数つき）。終了日の前や当日は案内しない", () => {
    const base = iteration({ id: "s1", name: "a", status: "active", end: "2026-11-03" });
    const it = iterationDetail(base, items("done", "todo", "todo"));
    expect(nextStepOf(it, "2026-11-04")).toEqual({ kind: "overdue", unfinished: 2 });
    expect(nextStepOf(it, "2026-11-03")).toBeNull();
  });

  it("active でチケットがない・期限内の未完了だけなら案内しない", () => {
    const base = iteration({ id: "s1", name: "a", status: "active", end: "2026-12-01" });
    expect(nextStepOf(iterationDetail(base, []), "2026-11-04")).toBeNull();
    expect(nextStepOf(iterationDetail(base, items("todo")), "2026-11-04")).toBeNull();
  });

  it("planned は active になる条件を案内し、closed は持ち越しがあるときだけ案内する", () => {
    expect(nextStepOf(iterationDetail(iteration({ id: "s1", name: "a" })))).toEqual({
      kind: "planned",
    });
    const closed = { ...iterationDetail(iteration({ id: "s1", name: "a", status: "closed" })) };
    expect(nextStepOf(closed)).toBeNull();
    expect(nextStepOf({ ...closed, carried_over: 2 })).toEqual({ kind: "closed", carried: 2 });
  });
});

describe("Iteration 詳細の案内の表示", () => {
  function mount(it: ReturnType<typeof iterationDetail>, copy = vi.fn(async () => {})) {
    const client = mockClient();
    const original = client.run.bind(client);
    const run = vi.fn(async (name: string, input?: unknown) =>
      name === "ask"
        ? { data: { text: `依頼文 ${JSON.stringify(input)}` }, warnings: [] }
        : name === "history"
          ? { data: { events: [] }, warnings: [] }
          : original(name, input),
    );
    client.run = run as never;
    const host: Host = {
      surface: "panel",
      open: () => {},
      show: () => {},
      copy,
      state: createUiState(memoryBackend()),
    };
    render(
      <StoreProvider client={client}>
        <HostProvider host={host}>
          <IterationNext it={it} />
        </HostProvider>
      </StoreProvider>,
    );
    return { run, copy };
  }

  it("全件が終わった active は「リリースできる」と出し、core の ask で作ったリリースの依頼文をコピーする", async () => {
    const it = iterationDetail(iteration({ id: "s1", name: "a", status: "active" }), items("done"));
    const { run, copy } = mount(it);
    expect(screen.getByText(/リリースできます/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
    await waitFor(() => expect(copy).toHaveBeenCalled());
    expect(run).toHaveBeenCalledWith("ask", {
      targets: ["s1"],
      action: "release",
      format: "skill",
    });
    // 書き込むコマンドは呼ばない
    expect(
      run.mock.calls
        .map((c) => c[0])
        .filter((n) => /update|add|close|reopen|claim|create|check|import|remove/.test(n)),
    ).toEqual([]);
    await screen.findByText("コピーした");
  });

  it("終了日を過ぎた未完了があれば件数と、持ち越しを相談する依頼文のコピーを出す", async () => {
    const base = iteration({ id: "s1", name: "a", status: "active", end: "2000-01-01" });
    const it = iterationDetail(base, items("todo", "todo"));
    const { run, copy } = mount(it);
    expect(screen.getByText(/未完了が 2 件/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
    await waitFor(() => expect(copy).toHaveBeenCalled());
    const input = run.mock.calls.find((c) => c[0] === "ask")![1] as {
      action: string;
      note: string;
    };
    expect(input.action).toBe("close");
    expect(input.note).toContain("持ち越す");
  });

  it("planned は claim で active になると出し、コピーのボタンは出さない", () => {
    mount(iterationDetail(iteration({ id: "s1", name: "a" })));
    expect(screen.getByText(/着手（claim）すると active/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
