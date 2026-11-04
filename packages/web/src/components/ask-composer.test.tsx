// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { WebviewEvent } from "@deguboard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import type { WebviewClient } from "../client/webview.js";
import { ASK_OPEN_KEY, HostBridge, HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import { fixture, iteration, mockClient, ticket, type MockClient } from "../test-helpers.js";
import { createUiState, memoryBackend, type UiState } from "../ui-state.js";
import type { AskAction } from "../types.js";
import { ASK_NOTE_KEY } from "./ask-composer.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

/** 読むだけのコマンド。入力欄はこれ以外を呼ばない（データに書き込まない） */
const READS = new Set([
  "project.list",
  "config.show",
  "whoami",
  "ticket.list",
  "epic.list",
  "iteration.list",
  "plan.list",
  "workflow.show",
  "run.list",
  "ask",
  "ask-menu",
]);

function askClient(): MockClient {
  return mockClient(
    fixture({
      iterations: [iteration({ id: "s1", name: "一", status: "active" })],
      tickets: [ticket({ id: "t5", title: "見直す", status: "review", iteration: "s1" })],
    }),
  );
}

/** 拡張ホストとの接続の代わりを挟んで描く。返す send で ask の event を送る */
function mountWebview(
  client: MockClient,
  {
    surface = "sidebar",
    state = createUiState(memoryBackend()),
  }: { surface?: Host["surface"]; state?: UiState } = {},
) {
  let send: ((event: WebviewEvent) => void) | undefined;
  const copied: string[] = [];
  const bridge: WebviewClient = {
    run: (name, input) => client.run(name, input),
    status: () => client.status(),
    open: async () => {},
    show: async () => {},
    copy: async (text) => void copied.push(text),
    onEvent: (listener) => {
      send = listener;
      return () => (send = undefined);
    },
  };
  // Webview の host と同じく、コピーは拡張ホスト（bridge.copy）に頼む
  const host: Host = {
    surface,
    open: () => {},
    show: () => {},
    copy: (text) => bridge.copy(text),
    state,
  };
  render(
    <StoreProvider client={client}>
      <HostProvider host={host}>
        <HostBridge client={bridge} />
        <App />
      </HostProvider>
    </StoreProvider>,
  );
  return {
    copied,
    state,
    ask: (targets: string[], action?: AskAction) =>
      act(() => send!({ kind: "event", name: "ask", targets, ...(action ? { action } : {}) })),
    /** タイトル行の吹き出し：画面の今の対象で開く */
    askCurrent: () => act(() => send!({ kind: "event", name: "ask", targets: [], current: true })),
  };
}

const composer = () => screen.getByRole("region", { name: "エージェントに頼む" });
const suggestions = () =>
  within(within(composer()).getByRole("group", { name: "頼むこと" })).getAllByRole("button");

describe("エージェントに頼む入力欄（UI-15）", () => {
  it("タイトル行・コマンドパレットの ask の event で、対象なしの入力欄を開き、起票・Iteration を作る・Epic を作る・点検するを頼める", async () => {
    const view = mountWebview(askClient());
    await screen.findByText("見直す");
    expect(screen.queryByRole("region", { name: "エージェントに頼む" })).toBeNull();
    view.ask([]);
    await waitFor(() => expect(suggestions().length).toBeGreaterThan(0));
    const labels = suggestions().map((b) => b.textContent);
    expect(labels.slice(0, 4)).toEqual([
      "★起票する",
      "Iteration を作る",
      "Epic を作る",
      "点検する",
    ]);
    // おすすめ（先頭）を選んだ状態で始まり、欄の頭に Skill の札を出す。対象の札はない
    expect(suggestions()[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(within(composer()).getByText("/dgimport")).toBeTruthy();
    expect(within(composer()).queryByRole("button", { name: /を外す$/ })).toBeNull();
    expect(document.activeElement).toBe(within(composer()).getByRole("textbox", { name: "指示" }));
  });

  it("候補・札・指示・全文・形式の切り替え・コピーがあり、対象を × で外すと札と 1 行目から消える", async () => {
    const client = askClient();
    const view = mountWebview(client);
    await screen.findByText("見直す");
    view.ask(["t5", "s1"]);
    // 種類の混ざった対象は点検するがおすすめ
    await waitFor(() => expect(suggestions()[0]!.textContent).toContain("★点検する"));
    const box = within(composer());
    expect(box.getByText("/dgcheck")).toBeTruthy();
    expect(box.getByRole("button", { name: "t5 を外す" })).toBeTruthy();
    expect(box.getByRole("button", { name: "s1 を外す" })).toBeTruthy();
    fireEvent.click(box.getByRole("button", { name: "全文" }));
    await waitFor(() => expect(box.getByLabelText("全文").textContent).toBe("/dgcheck t5 s1"));

    fireEvent.click(box.getByRole("button", { name: "s1 を外す" }));
    // review のチケット 1 件になり、おすすめは片付けるに替わる。1 行目からも s1 が消える
    await waitFor(() => expect(suggestions()[0]!.textContent).toContain("★確かめて片付ける"));
    expect(box.queryByRole("button", { name: "s1 を外す" })).toBeNull();
    await waitFor(() => expect(box.getByLabelText("全文").textContent).toBe("/dgdone t5"));
    expect(box.getByLabelText("全文").textContent).not.toContain("対象:");

    // 形式を文章にすると Skill の札と呼び出しが消え、頼む 1 文と dg の呼び方になる
    fireEvent.click(box.getByRole("button", { name: "形式：Skill" }));
    await waitFor(() =>
      expect(box.getByLabelText("全文").textContent).toMatch(/^t5 の PR のマージを照合し/),
    );
    expect(box.queryByText("/dgdone")).toBeNull();
    expect(box.getByRole("button", { name: "形式：文章" })).toBeTruthy();

    // 指示は複数行で書け、全文の終わりにそのまま入る
    fireEvent.change(box.getByRole("textbox", { name: "指示" }), {
      target: { value: "1 行目\n2 行目" },
    });
    await waitFor(() =>
      expect(box.getByLabelText("全文").textContent).toMatch(/\n1 行目\n2 行目$/),
    );
    expect(box.getByRole("button", { name: "コピー" })).toBeTruthy();
  });

  it("コピーのボタンと ⌘↵（Ctrl+↵）で、core の ask が作った全文を拡張ホストにコピーさせ、欄の下に「コピーしました」と出す", async () => {
    const client = askClient();
    const view = mountWebview(client);
    await screen.findByText("見直す");
    view.ask(["t5"]);
    await waitFor(() => expect(suggestions()[0]!.textContent).toContain("★確かめて片付ける"));
    const box = within(composer());
    fireEvent.click(box.getByRole("button", { name: "コピー" }));
    await waitFor(() => expect(view.copied).toHaveLength(1));
    expect(view.copied[0]).toBe("/dgdone t5");
    // 知らせはコピーが済んでから入るので、描き直されるのを待つ
    await waitFor(() => expect(box.getByRole("status").textContent).toContain("コピーしました"));

    // 頼むことを選び直すと知らせを消し、⌘↵ でも（待たずに）今の指示まで入れてコピーする
    fireEvent.click(suggestions().find((b) => b.textContent === "直す")!);
    expect(box.getByRole("status").textContent).toBe("");
    // 選び直しでもコピーする（t340）
    await waitFor(() => expect(view.copied).toHaveLength(2));
    expect(view.copied[1]).toBe("/dgimport t5");
    const note = box.getByRole("textbox", { name: "指示" });
    fireEvent.change(note, { target: { value: "題を短く" } });
    fireEvent.keyDown(note, { key: "Enter", metaKey: true });
    await waitFor(() => expect(view.copied).toHaveLength(3));
    expect(view.copied[2]).toBe("/dgimport t5\n題を短く");
    fireEvent.keyDown(note, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(view.copied).toHaveLength(4));
    await waitFor(() => expect(box.getByRole("status").textContent).toContain("コピーしました"));
  });

  it("コピーできなければ、欄の下にそう出す", async () => {
    const client = askClient();
    const state = createUiState(memoryBackend());
    let send: ((event: WebviewEvent) => void) | undefined;
    render(
      <StoreProvider client={client}>
        <HostProvider
          host={{
            surface: "browser",
            open: () => {},
            show: () => {},
            copy: () => Promise.reject(new Error("拒まれた")),
            state,
          }}
        >
          <HostBridge
            client={{
              run: (n, i) => client.run(n, i),
              status: () => client.status(),
              open: async () => {},
              show: async () => {},
              copy: async () => {},
              onEvent: (l) => ((send = l), () => {}),
            }}
          />
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("見直す");
    act(() => send!({ kind: "event", name: "ask", targets: [] }));
    await waitFor(() => expect(suggestions().length).toBeGreaterThan(0));
    fireEvent.click(within(composer()).getByRole("button", { name: "コピー" }));
    await waitFor(() =>
      expect(within(composer()).getByRole("status").textContent).toContain(
        "コピーできない: 拒まれた",
      ),
    );
  });

  it("Esc と × で閉じ、指示の下書きは見た目の状態に残って、開き直すと戻る", async () => {
    const view = mountWebview(askClient());
    await screen.findByText("見直す");
    view.ask([]);
    await waitFor(() => expect(suggestions().length).toBeGreaterThan(0));
    fireEvent.change(within(composer()).getByRole("textbox", { name: "指示" }), {
      target: { value: "下書き" },
    });
    fireEvent.keyDown(within(composer()).getByRole("textbox", { name: "指示" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("region", { name: "エージェントに頼む" })).toBeNull();
    expect(view.state.get(ASK_NOTE_KEY)).toBe("下書き");
    expect(view.state.get(ASK_OPEN_KEY)).toBeNull();

    view.ask([]);
    await waitFor(() => expect(suggestions().length).toBeGreaterThan(0));
    expect(
      (within(composer()).getByRole("textbox", { name: "指示" }) as HTMLTextAreaElement).value,
    ).toBe("下書き");
    fireEvent.click(within(composer()).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("region", { name: "エージェントに頼む" })).toBeNull();
    expect(view.state.get(ASK_NOTE_KEY)).toBe("下書き");
  });

  it("開いていることと対象は見た目の状態に残り、描き直しても（拡張が data-ask で渡したときも）その入力欄を出す", async () => {
    const state = createUiState(memoryBackend({ [ASK_OPEN_KEY]: { targets: ["t5"] } }));
    mountWebview(askClient(), { state });
    await waitFor(() => expect(suggestions()[0]!.textContent).toContain("★確かめて片付ける"));
    expect(within(composer()).getByRole("button", { name: "t5 を外す" })).toBeTruthy();
  });

  it("入力欄は依頼文を作るだけで、読み取りのコマンド（ask など）しか呼ばない", async () => {
    const client = askClient();
    const view = mountWebview(client);
    await screen.findByText("見直す");
    view.ask(["t5", "s1"]);
    await waitFor(() => expect(suggestions().length).toBeGreaterThan(0));
    const box = within(composer());
    const picks = suggestions();
    for (const b of picks) fireEvent.click(b);
    fireEvent.click(box.getByRole("button", { name: "t5 を外す" }));
    fireEvent.click(box.getByRole("button", { name: "形式：Skill" }));
    fireEvent.change(box.getByRole("textbox", { name: "指示" }), { target: { value: "x" } });
    fireEvent.click(box.getByRole("button", { name: "コピー" }));
    // 続けて押したコピーは最後の 1 回だけ書き込む（t340）
    expect(picks.length).toBeGreaterThan(1);
    await waitFor(() => expect(view.copied).toHaveLength(1));
    // 最後の指示（x）と最後に選んだ頼むことの文が入っている
    expect(view.copied[0]).toMatch(/^s1 を進める Plan を立て/);
    expect(view.copied[0]?.endsWith("\nx")).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(view.copied).toHaveLength(1);
    expect(client.calls.some((c) => c.name === "ask")).toBe(true);
    expect(client.calls.filter((c) => !READS.has(c.name))).toEqual([]);
  });

  it("ブラウザでは上のバーの吹き出しで入力欄を開け閉めし（対象のない画面では対象なし）、左パネルではバーに出さない（タイトル行にある）", async () => {
    window.location.hash = "#/backlog";
    const client = askClient();
    const host: Host = {
      surface: "browser",
      open: () => {},
      show: () => {},
      copy: vi.fn(async () => {}),
      state: createUiState(memoryBackend()),
    };
    render(
      <StoreProvider client={client}>
        <HostProvider host={host}>
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("見直す");
    const toggle = screen.getByRole("button", { name: "エージェントに頼む" });
    fireEvent.click(toggle);
    await waitFor(() => expect(suggestions()[0]!.textContent).toContain("★起票する"));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByRole("region", { name: "エージェントに頼む" })).toBeNull();
    cleanup();

    mountWebview(askClient());
    await screen.findByText("見直す");
    expect(screen.queryByRole("button", { name: "エージェントに頼む" })).toBeNull();
  });

  describe("タイトル行の吹き出しは画面の今の対象で開く", () => {
    function targetClient(): MockClient {
      return mockClient(
        fixture({
          iterations: [
            iteration({ id: "s1", name: "一", status: "active" }),
            iteration({ id: "s2", name: "二", status: "planned" }),
            iteration({
              id: "s0",
              name: "前",
              status: "closed",
              closed_at: "2026-01-02T00:00:00Z",
            }),
          ],
          tickets: [
            ticket({ id: "t5", title: "見直す", status: "review", iteration: "s1" }),
            ticket({ id: "t4", title: "済んだ", status: "done", iteration: "s0" }),
          ],
        }),
      );
    }
    /** 入力欄の対象のチップ（「x を外す」のボタン）の ID */
    const chips = () =>
      within(composer())
        .queryAllByRole("button", { name: / を外す$/ })
        .map((b) => b.getAttribute("aria-label")!.replace(/ を外す$/, ""));

    it("カンバンで選んでいる Iteration を対象にする（既定の active も、札で選んだ planned も）", async () => {
      const view = mountWebview(targetClient());
      await screen.findByText("見直す");
      view.askCurrent();
      await waitFor(() => expect(chips()).toEqual(["s1"]));

      // 開いていれば対象を入れ替える。ハッシュは代入した時点で変わるので、カンバンが描き直されて s2 の札が選ばれるのを待ってから頼む
      act(() => void (window.location.hash = "#/board?iteration=s2"));
      const s2 = within(screen.getByRole("group", { name: "Iteration" }))
        .getAllByRole("button")
        .find((b) => b.querySelector("code")?.textContent === "s2")!;
      await waitFor(() => expect(s2.getAttribute("aria-pressed")).toBe("true"));
      view.askCurrent();
      await waitFor(() => expect(chips()).toEqual(["s2"]));
    });

    it("履歴で開いている行を対象にし、開いている行がなければ対象なしにする", async () => {
      window.location.hash = "#/history";
      const state = createUiState(memoryBackend({ "history.opened": ["s0"] }));
      const view = mountWebview(targetClient(), { state });
      await screen.findByText("済んだ");
      view.askCurrent();
      await waitFor(() => expect(chips()).toEqual(["s0"]));
      fireEvent.click(within(composer()).getByRole("button", { name: "閉じる" }));

      // 行を閉じると対象なしに戻る。開いた状態を書いただけでは描き直されていないので、行の中のチケットが消えるのを待ってから頼む
      fireEvent.click(screen.getByText("前").closest("summary")!);
      await waitFor(() => expect(state.get("history.opened")).toEqual([]));
      await waitFor(() => expect(screen.queryByText("済んだ")).toBeNull());
      view.askCurrent();
      await waitFor(() => expect(suggestions()[0]!.textContent).toContain("★起票する"));
      expect(chips()).toEqual([]);
    });

    it.each([
      ["カンバンで「すべて」", "#/board?iteration=*"],
      ["バックログ", "#/backlog"],
      ["設定", "#/config"],
    ])("%sでは今までどおり対象なしで開く", async (_name, hash) => {
      window.location.hash = hash;
      const view = mountWebview(targetClient());
      await waitFor(() => expect(screen.queryByText("読み込み中…")).toBeNull());
      view.askCurrent();
      await waitFor(() => expect(suggestions()[0]!.textContent).toContain("★起票する"));
      expect(chips()).toEqual([]);
    });

    it("ブラウザの上のバーの吹き出しも、カンバンで選んでいる Iteration を対象にする", async () => {
      const host: Host = {
        surface: "browser",
        open: () => {},
        show: () => {},
        copy: vi.fn(async () => {}),
        state: createUiState(memoryBackend()),
      };
      render(
        <StoreProvider client={targetClient()}>
          <HostProvider host={host}>
            <App />
          </HostProvider>
        </StoreProvider>,
      );
      await screen.findByText("見直す");
      fireEvent.click(screen.getByRole("button", { name: "エージェントに頼む" }));
      await waitFor(() => expect(chips()).toEqual(["s1"]));
    });
  });

  it("頼むことを選んで開くと、開くと同時に依頼文をコピーして「コピーしました」を出す。開き直しの復元ではコピーしない（t340）", async () => {
    const view = mountWebview(askClient());
    await screen.findByText("見直す");
    view.ask(["t5"], "fix");
    await waitFor(() => expect(view.copied).toHaveLength(1));
    expect(view.copied[0]).toBe("/dgimport t5");
    await waitFor(() =>
      expect(within(composer()).getByRole("status").textContent).toContain("コピーしました"),
    );
    // 札の選び直しでも、その依頼文をコピーする
    fireEvent.click(suggestions().find((b) => b.textContent?.includes("確かめて片付ける"))!);
    await waitFor(() => expect(view.copied).toHaveLength(2));
    expect(view.copied[1]).toBe("/dgdone t5");

    // 見た目の状態から復元して開いたときは、勝手にコピーしない
    cleanup();
    const state = createUiState(
      memoryBackend({ [ASK_OPEN_KEY]: { targets: ["t5"], action: "fix" } }),
    );
    const restored = mountWebview(askClient(), { state });
    await waitFor(() => expect(suggestions().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(restored.copied).toHaveLength(0);
  });

  it("選んで開いたときのコピーに失敗したら、小窓は開いたまま理由を出す（t340）", async () => {
    const client = askClient();
    let send: ((event: WebviewEvent) => void) | undefined;
    render(
      <StoreProvider client={client}>
        <HostProvider
          host={{
            surface: "browser",
            open: () => {},
            show: () => {},
            copy: () => Promise.reject(new Error("拒まれた")),
            state: createUiState(memoryBackend()),
          }}
        >
          <HostBridge
            client={{
              run: (n, i) => client.run(n, i),
              status: () => client.status(),
              open: async () => {},
              show: async () => {},
              copy: async () => {},
              onEvent: (l) => ((send = l), () => {}),
            }}
          />
          <App />
        </HostProvider>
      </StoreProvider>,
    );
    await screen.findByText("見直す");
    act(() => send!({ kind: "event", name: "ask", targets: ["t5"], action: "fix" }));
    await waitFor(() =>
      expect(within(composer()).getByRole("status").textContent).toContain(
        "コピーできない: 拒まれた",
      ),
    );
    expect(composer()).toBeTruthy();
  });
});
