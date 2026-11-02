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

/** 見た目の状態はテストごとのメモリ（グラフの開閉がテストをまたがない） */
function browserHost(surface: Host["surface"] = "browser"): Host {
  return {
    surface,
    open: () => {},
    show: () => {},
    state: createUiState(memoryBackend()),
  };
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

  it("帯全体の開閉はなく、いつも Plan ごとの行を出す。閉じた Plan は既定で畳んだ節に入れ、グラフは開かない", async () => {
    mount(withPlans());
    const band = await screen.findByRole("region", { name: "実行計画" });
    expect(band.querySelector("h2")?.textContent).toBe("実行計画 1");
    const lines = [...document.querySelectorAll(".plan-line")].map((l) => l.textContent);
    expect(lines).toEqual(["p2承認済み1/2", "p1閉じた0/0"]);
    const closed = document.querySelector<HTMLDetailsElement>(".plan-closed")!;
    expect(closed.textContent).toContain("閉じた計画 1");
    expect(closed.open).toBe(false);
    expect(document.querySelector(".plan-graph")).toBeNull();
  });

  it("2 行目に作業中の番号と次に着手するチケットを出す。待ちがあれば待っているチケットと「t2 待ち」、承認待ちは承認を待っていること", async () => {
    const client = mockClient();
    client.data.plans = [
      plan({ id: "p2", tickets: ["t1", "t3"], after: { t3: ["t1"] } }),
      plan({ id: "p3", tickets: ["t2", "t3"], after: { t3: ["t2"] } }),
      plan({ id: "p4", tickets: ["t3"], pending_approval: true }),
      plan({ id: "p5", tickets: ["t1"] }),
    ];
    mount(client, browserHost("sidebar"));
    await screen.findByRole("region", { name: "実行計画" });
    const items = new Map(
      [...document.querySelectorAll(".plan-item")].map((i) => [
        i.querySelector(".plan-line code")!.textContent,
        i,
      ]),
    );
    const sub = (id: string) => items.get(id)!.querySelector(".plan-sub")?.textContent ?? null;
    expect(sub("p2")).toBe("次t3画面");
    expect(items.get("p2")!.querySelector("a.plan-next-ticket")!.getAttribute("href")).toBe(
      "#/tickets/t3",
    );
    expect(sub("p3")).toBe("作業中t2次t3t2待ち");
    expect(
      [...items.get("p3")!.querySelectorAll(".plan-sub a")].map((a) => a.getAttribute("href")),
    ).toEqual(["#/tickets/t2", "#/tickets/t3", "#/tickets/t2"]);
    expect(sub("p4")).toBe("人の承認を待っている");
    expect(sub("p5")).toBeNull();
  });

  it("Plan の行を押すとその Plan の承認者と依存グラフだけを行の下に開閉し、開閉を Plan ごとに覚える", async () => {
    const host = browserHost();
    const client = withPlans();
    client.data.plans.push(plan({ id: "p3", tickets: ["t2"] }));
    mount(client, host);
    await screen.findByRole("region", { name: "実行計画" });
    const itemOf = (id: string) =>
      [...document.querySelectorAll(".plan-item")].find(
        (i) => i.querySelector(".plan-line code")!.textContent === id,
      )!;
    const toggle = itemOf("p2").querySelector<HTMLButtonElement>("button.plan-line")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const p2 = itemOf("p2");
    expect(p2.querySelector(".plan-detail")!.textContent).toContain("承認 eiki");
    const nodes = [...p2.querySelectorAll<HTMLAnchorElement>("a.plan-node")];
    expect(nodes.map((a) => a.getAttribute("href"))).toEqual(["#/tickets/t1", "#/tickets/t3"]);
    expect(nodes.map((a) => a.style.left)).toEqual(["0px", "108px"]);
    const edges = p2.querySelectorAll(".plan-graph-edge");
    expect(edges[0]!.classList.contains("plan-graph-edge-pending")).toBe(false);
    // ほかの Plan のグラフは開かない
    expect(itemOf("p3").querySelector(".plan-graph")).toBeNull();
    expect(document.querySelectorAll(".plan-graph")).toHaveLength(1);
    // 2 行目（リンクでない所）を押しても開閉する
    fireEvent.click(itemOf("p3").querySelector(".plan-row")!);
    expect(document.querySelectorAll(".plan-graph")).toHaveLength(2);
    fireEvent.click(itemOf("p3").querySelector(".plan-row")!);
    expect(itemOf("p3").querySelector(".plan-graph")).toBeNull();
    cleanup();
    mount(client, host);
    await screen.findByRole("region", { name: "実行計画" });
    expect(itemOf("p2").querySelector(".plan-graph")).toBeTruthy();
    expect(itemOf("p3").querySelector(".plan-graph")).toBeNull();
  });

  it("行の中のチケットの番号を押すとチケットを開き、グラフは開閉しない", async () => {
    const opened: unknown[] = [];
    const host = { ...browserHost("sidebar"), open: (r: unknown) => opened.push(r) };
    mount(withPlans(), host);
    await screen.findByRole("region", { name: "実行計画" });
    fireEvent.click(document.querySelector<HTMLAnchorElement>("a.plan-next-ticket")!);
    expect(opened).toEqual([{ page: "ticket", id: "t3" }]);
    expect(document.querySelector(".plan-graph")).toBeNull();
    expect(document.querySelector("button.plan-line")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("閉じた計画を開くと 1 Plan 1 行で並び、押せばグラフを開ける。節の開閉は覚える", async () => {
    const host = browserHost();
    mount(withPlans(), host);
    await screen.findByRole("region", { name: "実行計画" });
    const closed = document.querySelector<HTMLDetailsElement>(".plan-closed")!;
    closed.open = true;
    fireEvent(closed, new Event("toggle"));
    const item = closed.querySelector(".plan-item")!;
    expect(item.classList.contains("plan-item-closed")).toBe(true);
    expect(item.querySelector(".plan-sub")).toBeNull();
    fireEvent.click(item.querySelector("button.plan-line")!);
    expect([...item.querySelectorAll("a.plan-node")].map((a) => a.getAttribute("href"))).toEqual([
      "#/tickets/t2",
    ]);
    cleanup();
    mount(withPlans(), host);
    await screen.findByRole("region", { name: "実行計画" });
    expect(document.querySelector<HTMLDetailsElement>(".plan-closed")!.open).toBe(true);
  });

  it("前の版の帯全体の開閉の鍵を消す", async () => {
    const host = browserHost();
    host.state.set("board.plansExpanded", true);
    mount(withPlans(), host);
    await screen.findByRole("region", { name: "実行計画" });
    expect(host.state.get("board.plansExpanded")).toBeUndefined();
  });

  it("サイドバーでは待ちの辺のない Plan をチップで出し、チップに状態の丸印・番号・タイトルを出す。辺のある Plan はグラフのまま", async () => {
    const client = withPlans();
    client.data.plans.push(plan({ id: "p3", tickets: ["t2", "t3"] }));
    const host = browserHost("sidebar");
    for (const id of ["p2", "p3"]) host.state.set(`board.planGraph.${id}`, true);
    mount(client, host);
    await screen.findByRole("region", { name: "実行計画" });
    const cards = [...document.querySelectorAll(".plan-item")];
    const p3 = cards.find((c) => c.textContent?.startsWith("p3"))!;
    expect(p3.querySelector(".plan-graph-canvas")).toBeNull();
    const chips = [...p3.querySelectorAll<HTMLAnchorElement>("a.plan-chip")];
    expect(chips.map((a) => a.getAttribute("href"))).toEqual(["#/tickets/t2", "#/tickets/t3"]);
    expect(chips.map((a) => a.querySelector(".plan-chip-title")?.textContent)).toEqual([
      "API",
      "画面",
    ]);
    expect(chips[0]!.querySelector(".status-dot")).toBeTruthy();
    const p2 = cards.find((c) => c.textContent?.startsWith("p2"))!;
    expect(p2.querySelector(".plan-graph-canvas")).toBeTruthy();
    expect(p2.querySelector(".plan-chip")).toBeNull();
  });

  it("依存グラフのノードは、done のチケットにだけ status-done のクラスを付ける（番号の取り消し線）", async () => {
    const host = browserHost();
    for (const id of ["p1", "p2"]) host.state.set(`board.planGraph.${id}`, true);
    mount(withPlans(), host);
    await screen.findByRole("region", { name: "実行計画" });
    // p2 の t1（done）・t3（todo）と、閉じた p1 の t2（in_progress）
    const nodes = [...document.querySelectorAll<HTMLAnchorElement>("a.plan-node")];
    expect(nodes.map((a) => [a.getAttribute("href"), a.classList.contains("status-done")])).toEqual(
      [
        ["#/tickets/t1", true],
        ["#/tickets/t3", false],
        ["#/tickets/t2", false],
      ],
    );
  });

  it("サイドバーのチップは、done のチケットにだけ status-done のクラスを付ける（番号の取り消し線）", async () => {
    const client = mockClient();
    // t1 は done、t2 は in_progress、t3 は todo。待ちの辺がないのでチップで出す
    client.data.plans = [plan({ id: "p3", tickets: ["t1", "t2", "t3"] })];
    const host = browserHost("sidebar");
    host.state.set("board.planGraph.p3", true);
    mount(client, host);
    await screen.findByRole("region", { name: "実行計画" });
    const chips = [...document.querySelectorAll<HTMLAnchorElement>("a.plan-chip")];
    expect(chips.map((a) => [a.getAttribute("href"), a.classList.contains("status-done")])).toEqual(
      [
        ["#/tickets/t1", true],
        ["#/tickets/t2", false],
        ["#/tickets/t3", false],
      ],
    );
  });

  it("ブラウザでは待ちの辺のない Plan もグラフで出す", async () => {
    const client = mockClient();
    client.data.plans = [plan({ id: "p3", tickets: ["t2", "t3"] })];
    const host = browserHost();
    host.state.set("board.planGraph.p3", true);
    mount(client, host);
    await screen.findByRole("region", { name: "実行計画" });
    expect(document.querySelector(".plan-graph-canvas")).toBeTruthy();
    expect(document.querySelector(".plan-chip")).toBeNull();
  });

  it("ノードにホバーすると繋がるノードを強調する", async () => {
    const host = browserHost();
    for (const id of ["p1", "p2"]) host.state.set(`board.planGraph.${id}`, true);
    mount(withPlans(), host);
    await screen.findByRole("region", { name: "実行計画" });
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
    const band = await screen.findByRole("region", { name: "実行計画" });
    expect(band.querySelector("h2")?.textContent).toBe("実行計画 1");
    expect(document.querySelector(".plan-closed")).toBeNull();
    expect([...document.querySelectorAll(".card .plan-tag")].map((t) => t.textContent)).toEqual([
      "p2",
      "p2",
    ]);
    fireEvent.change(screen.getByLabelText("Iteration"), { target: { value: "s2" } });
    await screen.findByText("別");
    expect(screen.getByRole("region", { name: "実行計画" }).querySelector("h2")?.textContent).toBe(
      "実行計画 0",
    );
    expect(document.querySelector(".plan-closed")?.textContent).toContain("閉じた計画 1");
  });
});
