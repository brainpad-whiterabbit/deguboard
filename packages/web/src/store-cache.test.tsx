// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./app.js";
import { HostProvider, type Host } from "./host.js";
import { SNAPSHOT_KEY, StoreProvider } from "./store.js";
import { fixture, mockClient, ticket } from "./test-helpers.js";
import { createUiState, memoryBackend, type UiState } from "./ui-state.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function sidebarHost(state: UiState): Host {
  return { surface: "sidebar", open: () => {}, show: () => {}, state };
}

/** 一覧の読み込みを止めておける client。release で読み込みを進める */
function slowClient() {
  const client = mockClient();
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const run = client.run.bind(client);
  client.run = (async (name: string, input?: unknown) => {
    if (name === "ticket.list") await gate;
    return run(name, input);
  }) as typeof client.run;
  return { client, release };
}

function mount(client: ReturnType<typeof mockClient>, state: UiState, cache?: UiState) {
  render(
    <StoreProvider client={client} cache={cache}>
      <HostProvider host={sidebarHost(state)}>
        <App />
      </HostProvider>
    </StoreProvider>,
  );
}

describe("前回の一覧の cache", () => {
  it("cache に前回の一覧があれば読み込みを待たずに描き、読み終えたら差し替えて cache を書き換える", async () => {
    const state = createUiState(memoryBackend());
    const before = fixture();
    state.set(SNAPSHOT_KEY, {
      projectId: "default",
      projects: before.projects,
      tickets: [ticket({ id: "t9", title: "前回の題" })],
      epics: before.epics,
      iterations: before.iterations,
      plans: before.plans,
      workflow: before.workflow,
    });
    const { client, release } = slowClient();
    mount(client, state, state);
    expect(screen.getByText("前回の題")).toBeTruthy();
    expect(screen.queryByText("読み込み中…")).toBeNull();
    release();
    await screen.findByText("ログイン");
    expect(screen.queryByText("前回の題")).toBeNull();
    const saved = state.get<{ tickets: { id: string }[] }>(SNAPSHOT_KEY)!;
    expect(saved.tickets.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("読み直しで cache を書くとき、前の版の鍵（store.snapshot.v1）を消す", async () => {
    const backend = memoryBackend({ "store.snapshot.v1": { tickets: [] }, other: 1 });
    const state = createUiState(backend);
    mount(mockClient(), state, state);
    await screen.findByText("ログイン");
    const saved = backend.getState() as Record<string, unknown>;
    expect("store.snapshot.v1" in saved).toBe(false);
    expect(saved[SNAPSHOT_KEY]).toBeTruthy();
    expect(saved["other"]).toBe(1);
  });

  it("cache がなければ「読み込み中…」と節と行の骨組みを出し、読み終えたら消す", async () => {
    const state = createUiState(memoryBackend());
    const { client, release } = slowClient();
    mount(client, state, state);
    expect(screen.getByText("読み込み中…")).toBeTruthy();
    expect(document.querySelectorAll(".skeleton-section")).toHaveLength(3);
    release();
    await screen.findByText("ログイン");
    expect(document.querySelector(".skeleton")).toBeNull();
  });

  it("ブラウザでは cache を渡さず、骨組みも出さない（今のまま「読み込み中…」だけ）", async () => {
    const { client, release } = slowClient();
    render(
      <StoreProvider client={client}>
        <App />
      </StoreProvider>,
    );
    expect(screen.getByText("読み込み中…")).toBeTruthy();
    expect(document.querySelector(".skeleton")).toBeNull();
    release();
    await screen.findByText("ログイン");
  });
});
