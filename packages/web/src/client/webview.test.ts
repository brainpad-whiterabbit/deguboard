// @vitest-environment jsdom
import type { WebviewEvent, WebviewRequest, WebviewResponse } from "@deguboard/core";
import { describe, expect, it } from "vitest";
import { ClientError } from "./http.js";
import { createWebviewClient } from "./webview.js";

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

  it("open は kind: action の要求を送り、応答で解決する", async () => {
    const h = host();
    const client = createWebviewClient(h);
    const p = client.open("#/tickets/t12");
    expect(h.requests).toEqual([{ id: 1, kind: "action", name: "open", route: "#/tickets/t12" }]);
    h.reply({ id: 1, ok: true, data: null, warnings: [], write: null });
    await expect(p).resolves.toBeUndefined();
  });

  it("拡張ホストからの通知（kind: event）は購読者に配り、外した後は届かない。形の違うメッセージは無視する", () => {
    const h = host();
    const client = createWebviewClient(h);
    const received: WebviewEvent[] = [];
    const off = client.onEvent((e) => received.push(e));
    h.reply({ kind: "event", name: "navigate", hash: "#/tickets/t3" });
    h.reply({ kind: "event", name: "reload" });
    h.reply({ kind: "event", name: "unknown" });
    h.reply("文字列");
    h.reply(null);
    expect(received).toEqual([
      { kind: "event", name: "navigate", hash: "#/tickets/t3" },
      { kind: "event", name: "reload" },
    ]);
    off();
    h.reply({ kind: "event", name: "reload" });
    expect(received).toHaveLength(2);
  });
});
