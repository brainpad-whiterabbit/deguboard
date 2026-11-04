// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import { iteration, iterationDetail, mockClient } from "../test-helpers.js";
import type { IterationDetail } from "../types.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { COPY_NOTICE_MS } from "./copyable-code.js";
import { IterationNext } from "./iteration-next.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
});

const withNext = (next: IterationDetail["next"]): IterationDetail => ({
  ...iterationDetail(iteration({ id: "s1", name: "a", status: "active" })),
  next,
});

function mount(it: IterationDetail, copy = vi.fn(async () => {})) {
  const client = mockClient();
  const original = client.run.bind(client);
  const run = vi.fn(async (name: string, input?: unknown) =>
    name === "ask"
      ? { data: { text: `依頼文 ${JSON.stringify(input)}` }, warnings: [] }
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

const WRITES = /update|add|close|reopen|claim|create|check|import|remove/;

describe("Iteration 詳細の案内の表示（core の next を出すだけ）", () => {
  it("next がなければ何も出さない", () => {
    mount(withNext(null));
    expect(document.querySelector(".iteration-next")).toBeNull();
  });

  it("ready は「リリースできる」と出し、next.ask の依頼文を core の ask で作ってコピーする。書き込まない", async () => {
    const { run, copy } = mount(withNext({ kind: "ready", ask: "release" }));
    expect(screen.getByText(/リリースできます/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
    await waitFor(() => expect(copy).toHaveBeenCalled());
    expect(run).toHaveBeenCalledWith("ask", {
      targets: ["s1"],
      action: "release",
      format: "skill",
    });
    expect(run.mock.calls.map((c) => c[0]).filter((n) => WRITES.test(n))).toEqual([]);
    await screen.findByText("コピーした");
  });

  it("overdue は未完了の件数と、carry の依頼文のコピーを出す（close ではない）", async () => {
    const { run } = mount(withNext({ kind: "overdue", unfinished: 2, ask: "carry" }));
    expect(screen.getByText(/未完了が 2 件/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith("ask", {
        targets: ["s1"],
        action: "carry",
        format: "skill",
      }),
    );
  });

  it("planned は「ほかに active がなければ」着手で active になると出し、ボタンは出さない", () => {
    mount(withNext({ kind: "planned", ask: null }));
    expect(screen.getByText(/ほかに active がなければ.*着手（claim）すると active/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("closed は持ち越し先の Iteration へのリンクを出し、先のないものがあれば assign の依頼文をコピーできる", async () => {
    const { run } = mount(
      withNext({
        kind: "closed",
        carried: 3,
        moved: [
          { id: "t1", iteration: "s2", status: "todo" },
          { id: "t2", iteration: null, status: "todo" },
          { id: "t3", iteration: null, status: "done" },
        ],
        ask: "assign",
      }),
    );
    expect(screen.getByRole("link", { name: "s2" }).getAttribute("href")).toContain("s2");
    expect(screen.getByText(/t2 → Iteration なし/)).toBeTruthy();
    expect(screen.getByText(/t3 → 完了済み/)).toBeTruthy();
    expect(screen.queryByText(/コミットすると/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith("ask", {
        targets: ["s1"],
        action: "assign",
        format: "skill",
      }),
    );
  });

  it("closed で持ち越し先が履歴に出ない分は、コミットすると出ると添える", () => {
    mount(withNext({ kind: "closed", carried: 2, moved: [], ask: null }));
    expect(screen.getByText(/持ち越し 2 件/)).toBeTruthy();
    expect(screen.getByText(/コミットすると出ます/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("依頼文のコピーの結果の表示", () => {
  it("コピーに失敗したら「コピーできない」と出し、一定時間で消える（成功の表示は出ない）", async () => {
    const copy = vi.fn(async () => {
      throw new Error("denied");
    });
    mount(withNext({ kind: "ready", ask: "release" }), copy);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
    await act(async () => {});
    expect(screen.getByText("コピーできない")).toBeTruthy();
    expect(screen.queryByText("コピーした")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(COPY_NOTICE_MS);
    });
    expect(screen.queryByText("コピーできない")).toBeNull();
  });

  it("依頼文を引けなかったとき（ask の失敗）も「コピーできない」と出し、コピーはしない", async () => {
    const copy = vi.fn(async () => {});
    const { run } = mount(withNext({ kind: "ready", ask: "release" }), copy);
    run.mockRejectedValueOnce(new Error("ask 失敗"));
    fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
    await screen.findByText("コピーできない");
    expect(copy).not.toHaveBeenCalled();
  });

  it("コピーに成功した「コピーした」も一定時間で消える", async () => {
    mount(withNext({ kind: "ready", ask: "release" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "依頼文をコピー" }));
    await act(async () => {});
    expect(screen.getByText("コピーした")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(COPY_NOTICE_MS);
    });
    expect(screen.queryByText("コピーした")).toBeNull();
  });
});
