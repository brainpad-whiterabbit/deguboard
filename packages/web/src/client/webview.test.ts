// @vitest-environment jsdom
// 拡張と合わせる値の写しを照らすためだけに core の実行時のコード（WEBVIEW_CONTRACT と詳細のルート）を取り込む（画面のコードは型だけを取る。ADR-033）
import {
  detailOfRoute,
  detailRouteOf,
  WEBVIEW_CONTRACT,
  type WebviewEvent,
  type WebviewRequest,
  type WebviewResponse,
} from "@deguboard/core";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../l10n.js";
import { hrefOf, isDetailRoute, parseRoute, type Route } from "../router.js";
import { ClientError } from "./http.js";
import { createWebviewClient, WEBVIEW_CONTRACT_COPY } from "./webview.js";

/** 拡張ホストの代わり。受け取った要求を記録し、答えを window に流す */
function host() {
  const requests: WebviewRequest[] = [];
  const reply = (response: WebviewResponse | WebviewEvent | unknown) =>
    window.dispatchEvent(new MessageEvent("message", { data: response }));
  return {
    requests,
    reply,
    postMessage(message: unknown) {
      requests.push(message as WebviewRequest);
    },
  };
}

afterEach(() => setLanguage("ja"));

describe("postMessage の CommandClient", () => {
  it("run は kind: run の要求を送り、同じ id の応答を結果にする。順番が入れ替わっても対応づく", async () => {
    const h = host();
    const client = createWebviewClient(h);
    const first = client.run("ticket.list", { project: "default" });
    const second = client.status();
    expect(h.requests).toEqual([
      { id: 1, kind: "run", name: "ticket.list", input: { project: "default" } },
      { id: 2, kind: "status" },
    ]);
    h.reply({
      id: 2,
      ok: true,
      data: {
        ahead: 1,
        behind: 0,
        dirty: false,
        remote: "origin",
        issues: 0,
        data_dir: "/x",
        web_url: null,
      },
      warnings: [],
      write: null,
    });
    h.reply({ id: 1, ok: true, data: [{ id: "t1" }], warnings: ["注意"], write: null });
    expect(await first).toEqual({ data: [{ id: "t1" }], warnings: ["注意"], write: undefined });
    expect((await second).ahead).toBe(1);
  });

  it("ok: false の応答は ClientError（code と message）になり、知らない id の応答は無視する", async () => {
    const h = host();
    const client = createWebviewClient(h);
    const p = client.run("ticket.move", { ticket: "t1", status: "done" });
    h.reply({ id: 99, ok: true, data: null, warnings: [], write: null });
    h.reply({
      id: 1,
      ok: false,
      error: { code: "TRANSITION_REJECTED", message: "遷移できない", detail: "review から" },
    });
    const error = await p.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({ code: "TRANSITION_REJECTED", message: "遷移できない" });
  });

  it("英語の表示では core の決まった警告とエラーの文を訳し、表にない文は core の文のまま渡す（UI-11）", async () => {
    setLanguage("en");
    const h = host();
    const client = createWebviewClient(h);
    const warned = client.run("plan.show", { plan: "p1" });
    h.reply({
      id: 1,
      ok: true,
      data: null,
      warnings: ["t9 not found (deleted)", "訳のない警告"],
      write: null,
    });
    expect((await warned).warnings).toEqual(["t9 not found (deleted)", "訳のない警告"]);
    const rejected = client.run("config.set", { key: "commit.mode", value: "x" });
    h.reply({
      id: 2,
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Invalid value for commit.mode",
        detail: "A value is required. Options: immediate, batch, manual",
      },
    });
    expect(await rejected.catch((e: unknown) => e)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Invalid value for commit.mode",
      detail: "A value is required. Options: immediate, batch, manual",
    });
  });

  it.each([
    [
      "open は kind: action の name: open で route を送り、応答で解決する",
      (client: ReturnType<typeof createWebviewClient>) => client.open("#/tickets/t12"),
      { id: 1, kind: "action", name: "open", route: "#/tickets/t12" },
    ],
    [
      "copy は kind: action の name: copy で text を送り、応答で解決する",
      (client: ReturnType<typeof createWebviewClient>) => client.copy("feat/x"),
      { id: 1, kind: "action", name: "copy", text: "feat/x" },
    ],
  ])("%s", async (_name, send, request) => {
    const h = host();
    const client = createWebviewClient(h);
    const p = send(client);
    expect(h.requests).toEqual([request]);
    h.reply({ id: 1, ok: true, data: null, warnings: [], write: null });
    await expect(p).resolves.toBeUndefined();
  });

  it("拡張ホストからの通知（kind: event）は購読者に配り、外した後は届かない。core の通知の名前はどれも届き、形の違うメッセージと知らない名前は無視する", () => {
    const h = host();
    const client = createWebviewClient(h);
    const received: WebviewEvent[] = [];
    const off = client.onEvent((e) => received.push(e));
    h.reply({ kind: "event", name: "navigate", hash: "#/tickets/t3" });
    h.reply({ kind: "event", name: "reload" });
    h.reply({ kind: "event", name: "toggle", hash: "#/config" });
    h.reply({ kind: "event", name: "unknown" });
    h.reply("文字列");
    h.reply(null);
    expect(received).toEqual([
      { kind: "event", name: "navigate", hash: "#/tickets/t3" },
      { kind: "event", name: "reload" },
      { kind: "event", name: "toggle", hash: "#/config" },
    ]);
    off();
    h.reply({ kind: "event", name: "reload" });
    expect(received).toHaveLength(3);
    // core の通知の名前はどれも届き、知らない名前（prototype の名前を含む）は応答として扱う
    const names: string[] = [];
    const offAll = client.onEvent((e) => names.push(e.name));
    for (const name of WEBVIEW_CONTRACT.eventNames)
      h.reply({ kind: "event", name, hash: "#/board" });
    h.reply({ kind: "event", name: "toString" });
    offAll();
    expect(names).toEqual([...WEBVIEW_CONTRACT.eventNames]);
  });
});

describe("拡張と合わせる値（core の WEBVIEW_CONTRACT の写し）", () => {
  it("バックログの行の文脈名と通知の名前は core と同じ", () => {
    expect(WEBVIEW_CONTRACT_COPY.backlogRowSection).toBe(WEBVIEW_CONTRACT.backlogRowSection);
    expect(Object.values(WEBVIEW_CONTRACT_COPY.askSections).sort()).toEqual(
      [...WEBVIEW_CONTRACT.askSections].sort(),
    );
    expect(Object.keys(WEBVIEW_CONTRACT_COPY.eventNames).sort()).toEqual(
      [...WEBVIEW_CONTRACT.eventNames].sort(),
    );
  });

  it("拡張が開くルートは router の hrefOf が返すハッシュと同じで、その画面に戻る", () => {
    expect(hrefOf({ page: "board" })).toBe(WEBVIEW_CONTRACT.routes.board);
    expect(hrefOf({ page: "config" })).toBe(WEBVIEW_CONTRACT.routes.config);
    expect(parseRoute(WEBVIEW_CONTRACT.routes.board).page).toBe("board");
    expect(parseRoute(WEBVIEW_CONTRACT.routes.config).page).toBe("config");
  });

  it("拡張が開く詳細のルート（core の detailRouteOf）は router の hrefOf と同じで、その詳細の画面に戻る", () => {
    const pages = {
      ticket: "ticket",
      iteration: "iterations",
      epic: "epics",
      plan: "plans",
    } as const satisfies Record<keyof typeof WEBVIEW_CONTRACT.detailRoutes, Route["page"]>;
    for (const [id, kind] of [
      ["t12", "ticket"],
      ["s3", "iteration"],
      ["e2", "epic"],
      ["p5", "plan"],
    ] as const) {
      const route = detailRouteOf(id)!;
      expect(route).toBe(`${WEBVIEW_CONTRACT.detailRoutes[kind]}${id}`);
      expect(hrefOf({ page: pages[kind], id })).toBe(route);
      const parsed = parseRoute(route);
      expect(parsed).toEqual({ page: pages[kind], id });
      expect(isDetailRoute(parsed)).toBe(true);
      expect(detailOfRoute(hrefOf(parsed))).toEqual({ kind, id });
    }
  });
});
