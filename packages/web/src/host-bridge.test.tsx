// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { act, useLayoutEffect, useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebviewEvent } from "@deguboard/core";
import { ClientError } from "./client/http.js";
import type { WebviewClient } from "./client/webview.js";
import { HostBridge, HostProvider, type Host } from "./host.js";
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

function tree(client: MockClient, bridge: WebviewClient, sender: ReactNode) {
  return (
    <StoreProvider client={client} readRunning={false} setupBand={false}>
      <HostProvider host={panelHost()}>
        <HostBridge client={bridge} />
        {sender}
      </HostProvider>
    </StoreProvider>
  );
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
});
