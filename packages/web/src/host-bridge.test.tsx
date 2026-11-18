// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { act, useLayoutEffect, useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebviewEvent } from "@deguboard/core";
import { ClientError } from "./client/http.js";
import type { WebviewClient } from "./client/webview.js";
import {
  ASK_OPEN_KEY,
  HostBridge,
  HostProvider,
  useAsk,
  useAskCurrent,
  type Ask,
  type Host,
} from "./host.js";
import { StoreProvider, useStore, type Store } from "./store.js";
import { mockClient, setupView, type MockClient } from "./test-helpers.js";
import { createUiState, memoryBackend } from "./ui-state.js";

afterEach(() => {
  cleanup();
});

/** 拡張ホストとの接続の代わり。HostBridge が購読した受け手を send で呼ぶ */
function bridgeOf(): { bridge: WebviewClient; send(event: WebviewEvent): void } {
  let listener: ((event: WebviewEvent) => void) | undefined;
  const bridge = {
    onEvent: (next: (event: WebviewEvent) => void) => {
      listener = next;
      return () => (listener = undefined);
    },
  } as WebviewClient;
  return { bridge, send: (event) => listener?.(event) };
}

/** エディタのパネルの Host（推奨の項目の帯を出さない入口） */
const panelHost = (): Host => ({
  surface: "panel",
  open() {},
  show() {},
  copy: async () => {},
  state: createUiState(memoryBackend()),
});

/**
 * store の値が when を満たすように変わった描画のコミットの中（layout effect）で、event を 1 回送る。
 * HostBridge より後ろに置くので、HostBridge の layout effect の後、どの passive effect よりも前に送ることになる
 * （描画のコミットの後、副作用より前に届いた event の代わり）
 */
function SendOnCommit({
  when,
  send,
}: {
  when: (store: Store, first: Store) => boolean;
  send: () => void;
}) {
  const store = useStore();
  const first = useRef(store);
  const sent = useRef(false);
  useLayoutEffect(() => {
    if (sent.current || !when(store, first.current)) return;
    sent.current = true;
    send();
  });
  return null;
}

function tree(client: MockClient, bridge: WebviewClient, sender: ReactNode, host = panelHost()) {
  return (
    <StoreProvider client={client} readRunning={false} setupBand={false}>
      <HostProvider host={host}>
        <HostBridge client={bridge} />
        {sender}
      </HostProvider>
    </StoreProvider>
  );
}

/**
 * 入力欄の開閉（ask）を report に渡し、ask が when を満たした描画のコミットの中（layout effect）で、event を 1 回送る。
 * SendOnCommit と同じく HostBridge より後ろに置く（targets を渡すと、その描画で画面の今の対象として知らせる）
 */
function AskSendOnCommit({
  report,
  when,
  send,
  targets,
}: {
  report: (ask: Ask) => void;
  when: (ask: Ask) => boolean;
  send: () => void;
  targets?: readonly string[];
}) {
  const ask = useAsk();
  useAskCurrent(targets ?? []);
  const sent = useRef(false);
  useLayoutEffect(() => {
    report(ask);
    if (sent.current || !when(ask)) return;
    sent.current = true;
    send();
  });
  return null;
}

const countOf = (client: MockClient, name: string) =>
  client.calls.filter((c) => c.name === name).length;

describe("HostBridge が描画のコミットの後、副作用より前に届いた event を最新の受け手に渡す", () => {
  it("needsSetup が立った描画のコミットの直後に届いた setup の event で、導入の項目と一覧を確かめ直す（帯を出さない入口は、needsSetup が古い値のままなら何もしない）", async () => {
    const client = mockClient();
    client.handlers["config.show"] = () => {
      throw new ClientError({ code: "NOT_INITIALIZED", message: "初期化されていない" });
    };
    const setup = vi.fn(async () =>
      setupView({ board: { status: "unmet", state: "no_remote", fix: ["dg init"] } }),
    );
    client.setup = setup;
    const { bridge, send } = bridgeOf();
    render(
      tree(
        client,
        bridge,
        <SendOnCommit
          when={(store) => store.needsSetup}
          send={() => send({ kind: "event", name: "setup" })}
        />,
      ),
    );

    // 1 回目は最初の読み込み、2 回目は setup の event で確かめ直した分（一覧も読み直す）
    await waitFor(() => expect(setup).toHaveBeenCalledTimes(2));
    expect(countOf(client, "config.show")).toBe(2);
  });

  it("reload が変わった描画のコミットの直後に届いた reload の event は、新しい reload（新しい client）で読み直す", async () => {
    const before = mockClient();
    const after = mockClient();
    const { bridge, send } = bridgeOf();
    const sender = (
      <SendOnCommit
        when={(store, first) => store.reload !== first.reload}
        send={() => send({ kind: "event", name: "reload" })}
      />
    );
    const view = render(tree(before, bridge, sender));
    await waitFor(() => expect(countOf(before, "workflow.show")).toBe(1));
    await act(async () => {});
    const beforeCalls = before.calls.length;

    view.rerender(tree(after, bridge, sender));

    // 新しい client の読み直しは、reload の event の分と、reload が変わったときの store の読み直しの分の 2 回
    await waitFor(() => expect(countOf(after, "config.show")).toBe(2));
    await act(async () => {});
    expect(before.calls.length).toBe(beforeCalls);
  });

  it("入力欄を開いた描画のコミットの直後に届いた toggle つきの ask の event は、開いた欄を閉じる（開く前の request を見て開き直さない）", async () => {
    const { bridge, send } = bridgeOf();
    const seen: { ask?: Ask } = {};
    const report = (ask: Ask) => void (seen.ask = ask);
    render(
      tree(
        mockClient(),
        bridge,
        <AskSendOnCommit
          report={report}
          when={(ask) => ask.request !== null}
          send={() => send({ kind: "event", name: "ask", targets: [], toggle: true })}
        />,
      ),
    );
    await act(async () => {});
    expect(seen.ask!.request).toBeNull();

    await act(async () => seen.ask!.open(["t1"]));

    expect(seen.ask!.request).toBeNull();
    // 開いたのは 1 回だけ（toggle で開き直していない）
    expect(seen.ask!.serial).toBe(1);
  });

  it("入力欄を閉じた描画のコミットの直後に届いた toggle つきの ask の event は、閉じた欄を開く（閉じる前の request を見て閉じたままにしない）", async () => {
    const { bridge, send } = bridgeOf();
    const seen: { ask?: Ask } = {};
    const report = (ask: Ask) => void (seen.ask = ask);
    const host = panelHost();
    host.state.set(ASK_OPEN_KEY, { targets: ["t1"] });
    render(
      tree(
        mockClient(),
        bridge,
        <AskSendOnCommit
          report={report}
          when={(ask) => ask.request === null}
          send={() => send({ kind: "event", name: "ask", targets: ["t2"], toggle: true })}
        />,
        host,
      ),
    );
    await act(async () => {});
    expect(seen.ask!.request).toEqual({ targets: ["t1"] });

    await act(async () => seen.ask!.close());

    expect(seen.ask!.request).toEqual({ targets: ["t2"] });
  });

  it("画面の今の対象が変わった描画のコミットの直後に届いた current つきの ask の event は、新しい対象で開く", async () => {
    const { bridge, send } = bridgeOf();
    const seen: { ask?: Ask } = {};
    const report = (ask: Ask) => void (seen.ask = ask);
    const host = panelHost();
    const client = mockClient();
    const sender = (targets: string[], armed: boolean) => (
      <AskSendOnCommit
        report={report}
        targets={targets}
        when={() => armed}
        send={() => send({ kind: "event", name: "ask", targets: [], current: true })}
      />
    );
    const view = render(tree(client, bridge, sender(["s1"], false), host));
    await act(async () => {});

    view.rerender(tree(client, bridge, sender(["s2"], true), host));
    await act(async () => {});

    expect(seen.ask!.request).toEqual({ targets: ["s2"] });
  });
});
