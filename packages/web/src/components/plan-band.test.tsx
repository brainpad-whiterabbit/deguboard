// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { HostProvider, type Host } from "../host.js";
import { StoreProvider } from "../store.js";
import { iteration, mockClient, plan, ticket } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  window.localStorage.clear();
});

/** 見た目の状態はテストごとのメモリ（帯の開閉がテストをまたがない） */
function browserHost(): Host {
  return { surface: "browser", open: () => {}, state: createUiState(memoryBackend()) };
}

function mount(client = mockClient(), host = browserHost()) {
  render(
    <StoreProvider client={client}>
      <HostProvider host={host}>
        <App />
      </HostProvider>
    </StoreProvider>,
  );
  return client;
}

/** t1（done）→ t3 を待つ承認済みの Plan と、閉じた Plan を持つ */
function withPlans() {
  const client = mockClient();
  client.data.plans = [
    plan({ id: "p1", tickets: ["t2"], status: "closed" }),
    plan({
      id: "p2",
      tickets: ["t1", "t3"],
      after: { t3: ["t1"] },
      approved_by: "eiki",
      progress: {
        total: 2,
        done: 1,
        by_status: { todo: 1, in_progress: 0, review: 0, done: 1, abandoned: 0 },
      },
    }),
  ];
  return client;
}

describe("実行計画の帯", () => {
  it("Plan がなければ帯を出さない", async () => {
    mount();
    await screen.findByText("ログイン");
    expect(screen.queryByRole("region", { name: "実行計画" })).toBeNull();
  });

  it("既定で畳み、開いた Plan を 1 行ずつ出す。閉じた Plan は畳んだ節に入れる", async () => {
    mount(withPlans());
    const toggle = await screen.findByRole("button", { name: "実行計画 1" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const lines = [...document.querySelectorAll(".plan-line")].map((l) => l.textContent);
    expect(lines).toEqual(["p2承認済み1/2", "p1閉じた0/0"]);
    expect(document.querySelector(".plan-closed")?.textContent).toContain("閉じた計画 1");
    expect(document.querySelector(".plan-graph")).toBeNull();
  });

  it("開くと承認者と依存グラフを出し、ノードはチケットへのリンクで、待ち終わった辺は実線。開閉は残る", async () => {
    const host = browserHost();
    mount(withPlans(), host);
    fireEvent.click(await screen.findByRole("button", { name: "実行計画 1" }));
    const card = document.querySelector(".plan-card")!;
    expect(card.textContent).toContain("承認 eiki");
    const nodes = [...card.querySelectorAll<HTMLAnchorElement>("a.plan-node")];
    expect(nodes.map((a) => a.getAttribute("href"))).toEqual(["#/tickets/t1", "#/tickets/t3"]);
    expect(nodes.map((a) => a.style.left)).toEqual(["0px", "108px"]);
    const edges = card.querySelectorAll(".plan-graph-edge");
    expect(edges[0]!.classList.contains("plan-graph-edge-pending")).toBe(false);
    cleanup();
    mount(withPlans(), host);
    expect(
      (await screen.findByRole("button", { name: "実行計画 1" })).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("ノードにホバーすると繋がるノードを強調する", async () => {
    mount(withPlans());
    fireEvent.click(await screen.findByRole("button", { name: "実行計画 1" }));
    const [t1, t3] = [...document.querySelectorAll<HTMLAnchorElement>("a.plan-node")];
    fireEvent.mouseEnter(t1!);
    expect(document.querySelector(".plan-graph-tracing")).toBeTruthy();
    expect(t3!.classList.contains("related")).toBe(true);
    fireEvent.mouseLeave(t1!);
    expect(document.querySelector(".plan-graph-tracing")).toBeNull();
  });

  it("選んだ Iteration のチケットを含む Plan だけを出し、カードに開いた Plan のタグを付ける", async () => {
    const client = withPlans();
    client.data.iterations = [
      iteration({ id: "s1", name: "最初", status: "active" }),
      iteration({ id: "s2", name: "次", status: "planned" }),
    ];
    client.data.tickets[0]!.iteration = "s1";
    client.data.tickets[2]!.iteration = "s1";
    client.data.tickets[1]!.iteration = "s2";
    client.data.tickets.push(ticket({ id: "t4", title: "別", iteration: "s2" }));
    mount(client);
    await screen.findByText("画面");
    expect(screen.getByRole("button", { name: "実行計画 1" })).toBeTruthy();
    expect(document.querySelector(".plan-closed")).toBeNull();
    expect([...document.querySelectorAll(".card .plan-tag")].map((t) => t.textContent)).toEqual([
      "p2",
      "p2",
    ]);
    fireEvent.change(screen.getByLabelText("Iteration"), { target: { value: "s2" } });
    await screen.findByText("別");
    expect(screen.getByRole("button", { name: "実行計画 0" })).toBeTruthy();
    expect(document.querySelector(".plan-closed")?.textContent).toContain("閉じた計画 1");
  });
});
