import type { CommandClient, CommandResult } from "@deguboard/core";
import { OperationError, UsageError } from "@deguboard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askDelivery,
  askEvent,
  badgeOf,
  handleRequest,
  isWebviewRequest,
  coalesce,
  currentAskDelivery,
  renderMessageHtml,
  renderWebviewHtml,
  sidebarDelivery,
  subjectOfRoute,
} from "./webview.js";

const INDEX = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <title>deguboard</title>
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-def.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("Webview の HTML", () => {
  it("相対パスを Webview の URI にし、crossorigin を外し、nonce つきの CSP を入れる", () => {
    const html = renderWebviewHtml(INDEX, {
      asset: (p) => `https://cdn.test/ext/dist/web/${p}`,
      cspSource: "https://cdn.test",
      nonce: "n0nce",
      surface: "panel",
      route: "#/board",
    });
    expect(html).toContain(
      '<script nonce="n0nce" type="module" src="https://cdn.test/ext/dist/web/assets/index-abc.js">',
    );
    expect(html).toContain(
      '<link rel="stylesheet" href="https://cdn.test/ext/dist/web/assets/index-def.css">',
    );
    expect(html).not.toContain("crossorigin");
    expect(html).toContain("script-src 'nonce-n0nce'");
    expect(html).toContain("style-src https://cdn.test;");
    expect(html).not.toContain("unsafe-inline");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
  });

  it("<html> に surface と初期ルートを data 属性で付け、値は属性として escape する", () => {
    const html = renderWebviewHtml(INDEX, {
      asset: (p) => p,
      cspSource: "https://cdn.test",
      nonce: "n",
      surface: "sidebar",
      route: '#/tickets/t12?x="<a>"&y',
    });
    expect(html).toContain(
      '<html data-surface="sidebar" data-route="#/tickets/t12?x=&quot;&lt;a&gt;&quot;&amp;y" lang="ja">',
    );
  });

  it("画面を出せないときの HTML はスクリプトを持たず、文言を escape する", () => {
    const html = renderMessageHtml("<フォルダ> を開く");
    expect(html).toContain("&lt;フォルダ&gt; を開く");
    expect(html).not.toContain("<script");
  });
});

function fakeClient(): CommandClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async run<O>(name: string, input?: unknown): Promise<CommandResult<O>> {
      calls.push({ name, input });
      if (name === "ticket.move")
        throw new OperationError("TRANSITION_REJECTED", "遷移できない", "理由");
      if (name === "ticket.create") throw new UsageError("入力が正しくない");
      return { data: { name }, warnings: ["注意"], write: { pushed: true } } as CommandResult<O>;
    },
    async status() {
      return {
        ahead: 1,
        behind: 0,
        dirty: false,
        remote: "origin",
        issues: 0,
        data_dir: "/x",
        web_url: null,
      };
    },
  };
}

describe("Webview の要求", () => {
  it("run は CommandClient に通し、同じ id で data・warnings・write を返す", async () => {
    const client = fakeClient();
    const res = await handleRequest(client, {
      id: 7,
      kind: "run",
      name: "ticket.list",
      input: { a: 1 },
    });
    expect(res).toEqual({
      id: 7,
      ok: true,
      data: { name: "ticket.list" },
      warnings: ["注意"],
      write: { pushed: true },
    });
    expect(client.calls).toEqual([{ name: "ticket.list", input: { a: 1 } }]);
  });

  it("status は同期の状態を返す", async () => {
    const res = await handleRequest(fakeClient(), { id: 1, kind: "status" });
    expect(res).toMatchObject({ id: 1, ok: true, data: { ahead: 1 } });
  });

  it("失敗は ok: false と code・message・detail に写す（HTTP の本文と同じ形）", async () => {
    const rejected = await handleRequest(fakeClient(), {
      id: 2,
      kind: "run",
      name: "ticket.move",
      input: {},
    });
    expect(rejected).toEqual({
      id: 2,
      ok: false,
      error: { code: "TRANSITION_REJECTED", message: "遷移できない", detail: "理由" },
    });
    const invalid = await handleRequest(fakeClient(), {
      id: 3,
      kind: "run",
      name: "ticket.create",
      input: {},
    });
    expect(invalid).toMatchObject({ id: 3, ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("action の open は actions に渡して data: null で答え、actions のない画面からは拒否する", async () => {
    const opened: string[] = [];
    const ok = await handleRequest(
      fakeClient(),
      { id: 4, kind: "action", name: "open", route: "#/tickets/t12" },
      {
        open: (route) => void opened.push(route),
        show: () => {},
        copy: () => {},
        terminals: () => [],
        openFolder: () => {},
        sendToTerminal: () => {},
      },
    );
    expect(ok).toEqual({ id: 4, ok: true, data: null, warnings: [], write: null });
    expect(opened).toEqual(["#/tickets/t12"]);
    const refused = await handleRequest(fakeClient(), {
      id: 5,
      kind: "action",
      name: "open",
      route: "#/tickets/t12",
    });
    expect(refused).toMatchObject({ id: 5, ok: false, error: { code: "UNSUPPORTED_ACTION" } });
  });

  it("action の show は actions.show に渡す（一覧の画面をサイドバーに出す）", async () => {
    const opened: string[] = [];
    const shown: string[] = [];
    const ok = await handleRequest(
      fakeClient(),
      { id: 6, kind: "action", name: "show", route: "#/board?epic=e2" },
      {
        open: (route) => void opened.push(route),
        show: (route) => void shown.push(route),
        copy: () => {},
        terminals: () => [],
        openFolder: () => {},
        sendToTerminal: () => {},
      },
    );
    expect(ok).toEqual({ id: 6, ok: true, data: null, warnings: [], write: null });
    expect(shown).toEqual(["#/board?epic=e2"]);
    expect(opened).toEqual([]);
  });

  it("パネルの Iteration 詳細の「この Iteration でカンバンを見る」の show は、絞り込みのハッシュをそのまま actions.show に渡す", async () => {
    const opened: string[] = [];
    const shown: string[] = [];
    await handleRequest(
      fakeClient(),
      { id: 8, kind: "action", name: "show", route: "#/board?iteration=s3" },
      {
        open: (route) => void opened.push(route),
        show: (route) => void shown.push(route),
        copy: () => {},
        terminals: () => [],
        openFolder: () => {},
        sendToTerminal: () => {},
      },
    );
    expect(shown).toEqual(["#/board?iteration=s3"]);
    expect(opened).toEqual([]);
  });

  it("action の copy は actions.copy に text を渡す（Webview の画面のコピーはすべてこの道で vscode.env.clipboard に書く）", async () => {
    const copied: string[] = [];
    const ok = await handleRequest(
      fakeClient(),
      { id: 7, kind: "action", name: "copy", text: "feat/branch-copy-button" },
      {
        open: () => {},
        show: () => {},
        copy: (text) => void copied.push(text),
        terminals: () => [],
        openFolder: () => {},
        sendToTerminal: () => {},
      },
    );
    expect(ok).toEqual({ id: 7, ok: true, data: null, warnings: [], write: null });
    expect(copied).toEqual(["feat/branch-copy-button"]);
  });

  it("action の terminals は開いているターミナルの一覧を data で返し、sendToTerminal は送り先と text を actions に渡す（Enter も起動もここでは扱わない）", async () => {
    const sent: [number, string][] = [];
    const actions = {
      open: () => {},
      show: () => {},
      copy: () => {},
      terminals: () => [{ id: 3, label: "zsh" }],
      openFolder: () => {},
      sendToTerminal: (id: number, text: string) => void sent.push([id, text]),
    };
    const list = await handleRequest(
      fakeClient(),
      { id: 9, kind: "action", name: "terminals" },
      actions,
    );
    expect(list).toEqual({
      id: 9,
      ok: true,
      data: [{ id: 3, label: "zsh" }],
      warnings: [],
      write: null,
    });
    const ok = await handleRequest(
      fakeClient(),
      { id: 10, kind: "action", name: "sendToTerminal", terminal: 3, text: "/dgwork t1" },
      actions,
    );
    expect(ok).toEqual({ id: 10, ok: true, data: null, warnings: [], write: null });
    expect(sent).toEqual([[3, "/dgwork t1"]]);
  });

  it("action の openWorktree は ticket.show で引いた worktree のパスだけを actions に渡し、なければ NOT_FOUND で返す（t381）", async () => {
    const opened: string[] = [];
    const actions = {
      open: () => {},
      show: () => {},
      copy: () => {},
      terminals: () => [],
      sendToTerminal: () => {},
      openFolder: (folder: string) => void opened.push(folder),
    };
    const client = fakeClient();
    const base = client.run.bind(client);
    client.run = async <O>(name: string, input?: unknown) =>
      name === "ticket.show"
        ? ({
            data: { worktree: "/w/t1" },
            warnings: [],
            write: undefined,
          } as unknown as CommandResult<O>)
        : base<O>(name, input);
    const ok = await handleRequest(
      client,
      { id: 1, kind: "action", name: "openWorktree", ticket: "t1" },
      actions,
    );
    expect(ok).toEqual({ id: 1, ok: true, data: null, warnings: [], write: null });
    expect(opened).toEqual(["/w/t1"]);
    client.run = async <O>() =>
      ({ data: { worktree: null }, warnings: [], write: undefined }) as unknown as CommandResult<O>;
    const none = await handleRequest(
      client,
      { id: 2, kind: "action", name: "openWorktree", ticket: "t1" },
      actions,
    );
    expect(none).toMatchObject({ id: 2, ok: false, error: { code: "NOT_FOUND" } });
    expect(opened).toHaveLength(1);
    expect(isWebviewRequest({ id: 1, kind: "action", name: "openWorktree", ticket: "t1" })).toBe(
      true,
    );
    expect(isWebviewRequest({ id: 1, kind: "action", name: "openWorktree", path: "/x" })).toBe(
      false,
    );
  });

  it("送り先が閉じていて actions が投げたときは ok: false で返す", async () => {
    const res = await handleRequest(
      fakeClient(),
      { id: 11, kind: "action", name: "sendToTerminal", terminal: 9, text: "x" },
      {
        open: () => {},
        show: () => {},
        copy: () => {},
        terminals: () => [],
        openFolder: () => {},
        sendToTerminal: () => {
          throw new Error("送り先のターミナルが閉じている");
        },
      },
    );
    expect(res).toMatchObject({ id: 11, ok: false });
  });

  it("要求の形を確かめる", () => {
    expect(isWebviewRequest({ id: 1, kind: "action", name: "terminals" })).toBe(true);
    expect(
      isWebviewRequest({ id: 1, kind: "action", name: "sendToTerminal", terminal: 2, text: "x" }),
    ).toBe(true);
    expect(isWebviewRequest({ id: 1, kind: "action", name: "sendToTerminal", text: "x" })).toBe(
      false,
    );
    expect(
      isWebviewRequest({ id: 1, kind: "action", name: "sendToTerminal", terminal: "2", text: "x" }),
    ).toBe(false);
    expect(isWebviewRequest({ id: 1, kind: "status" })).toBe(true);
    expect(isWebviewRequest({ id: 1, kind: "run", name: "x", input: {} })).toBe(true);
    expect(isWebviewRequest({ id: 1, kind: "action", name: "open", route: "#/tickets/t12" })).toBe(
      true,
    );
    expect(isWebviewRequest({ id: 1, kind: "action", name: "show", route: "#/board" })).toBe(true);
    // クエリ付きのルート（Iteration で絞ったカンバン）も show で受ける
    expect(
      isWebviewRequest({ id: 1, kind: "action", name: "show", route: "#/board?iteration=s3" }),
    ).toBe(true);
    expect(isWebviewRequest({ id: 1, kind: "action", name: "open", route: "https://x" })).toBe(
      false,
    );
    expect(isWebviewRequest({ id: 1, kind: "action", name: "copy", text: "feat/x" })).toBe(true);
    expect(isWebviewRequest({ id: 1, kind: "action", name: "copy" })).toBe(false);
    expect(isWebviewRequest({ id: "1", kind: "status" })).toBe(false);
    expect(isWebviewRequest({ id: 1, kind: "run" })).toBe(false);
    expect(isWebviewRequest({ id: 1, kind: "action", name: "other", ticket: "t1" })).toBe(false);
    expect(isWebviewRequest({ kind: "event", name: "reload" })).toBe(false);
    expect(isWebviewRequest(null)).toBe(false);
  });
});

describe("ファイルの変化のまとめ", () => {
  afterEach(() => vi.useRealTimers());

  it("短い間に続けて来た変化は最後の 1 回にまとめ、cancel で捨てる", () => {
    vi.useFakeTimers();
    let count = 0;
    const c = coalesce(() => count++, 200);
    c.fire();
    c.fire();
    vi.advanceTimersByTime(150);
    c.fire();
    vi.advanceTimersByTime(150);
    expect(count).toBe(0);
    vi.advanceTimersByTime(100);
    expect(count).toBe(1);
    c.fire();
    c.cancel();
    vi.advanceTimersByTime(500);
    expect(count).toBe(1);
  });
});

describe("パネルの題", () => {
  it("チケットと Iteration の詳細のルートから対象を取り、それ以外は undefined", () => {
    expect(subjectOfRoute("#/tickets/t12")).toEqual({ kind: "ticket", id: "t12" });
    expect(subjectOfRoute("#/tickets/t12?x=1")).toEqual({ kind: "ticket", id: "t12" });
    expect(subjectOfRoute("#/iterations/s3")).toEqual({ kind: "iteration", id: "s3" });
    expect(subjectOfRoute("#/epics/e2")).toEqual({ kind: "epic", id: "e2" });
    expect(subjectOfRoute("#/plans/p5")).toEqual({ kind: "plan", id: "p5" });
    // Plan の一覧の画面はないので、ID のないルートは詳細でない
    expect(subjectOfRoute("#/plans")).toBeUndefined();
    expect(subjectOfRoute("#/board")).toBeUndefined();
    expect(subjectOfRoute("#/tickets")).toBeUndefined();
    expect(subjectOfRoute("#/tickets/")).toBeUndefined();
  });
});

describe("サイドバーへの画面の届け方（歯車の toggleInSidebar と showInSidebar）", () => {
  it("サイドバーが描かれていれば toggle の event を送り、初期ルートは覚えない", () => {
    expect(sidebarDelivery(true, "toggle", "#/config")).toEqual({
      post: { kind: "event", name: "toggle", hash: "#/config" },
    });
  });

  it("サイドバーがまだ描かれていなければ event を送らず、その画面を初期ルート（pendingSidebarRoute）にする", () => {
    expect(sidebarDelivery(false, "toggle", "#/config")).toEqual({ pending: "#/config" });
  });

  it("一覧の画面を出すときも同じく、描かれていれば navigate を送り、なければ初期ルートにする", () => {
    expect(sidebarDelivery(true, "navigate", "#/backlog")).toEqual({
      post: { kind: "event", name: "navigate", hash: "#/backlog" },
    });
    expect(sidebarDelivery(false, "navigate", "#/backlog")).toEqual({ pending: "#/backlog" });
  });

  it("Iteration で絞ったカンバンは、描かれていれば絞り込みつきの navigate を送り、なければ絞り込みつきのハッシュを初期ルートにする", () => {
    expect(sidebarDelivery(true, "navigate", "#/board?iteration=s3")).toEqual({
      post: { kind: "event", name: "navigate", hash: "#/board?iteration=s3" },
    });
    expect(sidebarDelivery(false, "navigate", "#/board?iteration=s3")).toEqual({
      pending: "#/board?iteration=s3",
    });
  });
});

describe("エージェントに頼む入力欄の届け方（UI-15）", () => {
  it("Webview が描かれていれば ask の event を対象つきで送る", () => {
    expect(askDelivery(true, [])).toEqual({ post: { kind: "event", name: "ask", targets: [] } });
    expect(askDelivery(true, ["t1", "s2"])).toEqual({
      post: { kind: "event", name: "ask", targets: ["t1", "s2"] },
    });
  });

  it("パネルに送る event は描かれたサイドバーに送るものと同じ", () => {
    expect(askEvent(["t1"])).toEqual((askDelivery(true, ["t1"]) as { post: unknown }).post);
    expect(askEvent([])).toEqual({ kind: "event", name: "ask", targets: [] });
  });

  it("まだ描かれていなければ event を送らず、対象を覚えて HTML に埋める", () => {
    expect(askDelivery(false, [])).toEqual({ pending: [] });
  });

  it("タイトル行の吹き出しは current つきの ask の event を送り、画面に今の対象を問う。描かれていなければ対象なしを覚える", () => {
    expect(currentAskDelivery(true)).toEqual({
      post: { kind: "event", name: "ask", targets: [], current: true },
    });
    expect(currentAskDelivery(false)).toEqual({ pending: [] });
  });

  it("HTML の data-ask は core の askMenuKey の形（空白区切りの ID）で、対象なしは空の値。省けば付けない", () => {
    const base = {
      asset: (p: string) => p,
      cspSource: "c",
      nonce: "n",
      surface: "sidebar" as const,
    };
    expect(renderWebviewHtml(INDEX, { ...base, route: "#/board", ask: [] })).toContain(
      'data-route="#/board" data-ask="" lang="ja"',
    );
    expect(renderWebviewHtml(INDEX, { ...base, route: "#/board", ask: ["t1", "s2"] })).toContain(
      'data-ask="t1 s2"',
    );
    expect(renderWebviewHtml(INDEX, { ...base, route: "#/board" })).not.toContain("data-ask");
  });
});

describe("サイドバーのバッジ", () => {
  const base = { dirty: false, remote: "origin", issues: 0, data_dir: "/x", web_url: null };
  it("未 push と未取り込みの合計を出し、どちらもなければ消す", () => {
    expect(badgeOf({ ...base, ahead: 2, behind: 1 })).toEqual({
      value: 3,
      tooltip: "未 push 2 / 未取り込み 1",
    });
    expect(badgeOf({ ...base, ahead: 0, behind: 1 })).toEqual({
      value: 1,
      tooltip: "未取り込み 1",
    });
    expect(badgeOf({ ...base, ahead: 0, behind: 0 })).toBeUndefined();
  });

  it("ツールチップには未コミットの変更と読めないファイルも足す。数に入れず、それだけならバッジは出さない", () => {
    expect(badgeOf({ ...base, ahead: 1, behind: 0, dirty: true, issues: 2 })).toEqual({
      value: 1,
      tooltip: "未 push 1 / 未コミットの変更 / 読めないファイル 2",
    });
    expect(badgeOf({ ...base, ahead: 0, behind: 0, dirty: true, issues: 2 })).toBeUndefined();
  });
});
