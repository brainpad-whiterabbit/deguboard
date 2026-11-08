// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { HostProvider, type Host } from "../host.js";
import type { Route } from "../router.js";
import { StoreProvider } from "../store.js";
import { boardFixture, iterationDetail, mockClient, plan } from "../test-helpers.js";
import { createUiState, memoryBackend } from "../ui-state.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  window.localStorage.clear();
});

function hostOf(surface: Host["surface"], open: (route: Route) => void = () => {}): Host {
  return {
    surface,
    open,
    show: () => {},
    copy: async () => {},
    state: createUiState(memoryBackend()),
  };
}

function mount(client: ReturnType<typeof mockClient>, host: Host) {
  render(
    <StoreProvider client={client}>
      <HostProvider host={host}>
        <App />
      </HostProvider>
    </StoreProvider>,
  );
}

/** t1（done）→ t3 を待つ承認済みの Plan p2（t3 にだけ details がある）と、閉じた Plan p1 */
function withPlans() {
  const client = mockClient(boardFixture());
  client.data.plans = [
    plan({
      id: "p1",
      tickets: ["t2"],
      status: "closed",
      approved_by: "eiki",
      approved_at: "2026-01-02T00:00:00Z",
      closed_at: "2026-01-05T00:00:00Z",
    }),
    plan({
      id: "p2",
      tickets: ["t1", "t3"],
      after: { t3: ["t1"] },
      approved_by: "eiki@example.com",
      approved_at: "2026-01-03T00:00:00Z",
      details: {
        t3: { scope: "画面だけを直す", approach: "部品を足す\n既存の部品を使う", tier: "light" },
      },
    }),
  ];
  return client;
}

describe("Plan 詳細（UI-13）", () => {
  it("#/plans/<id> を開くと、状態・進み・Iteration・承認・次・依存グラフと、Plan の順のチケットの範囲・進め方・tier を出す", async () => {
    window.location.hash = "#/plans/p2";
    mount(withPlans(), hostOf("panel"));
    const title = await screen.findByRole("heading", { level: 1 });
    expect(title.textContent).toContain("p2");
    expect(title.textContent).toContain("承認済み");
    const summary = document.querySelector(".plan-summary")!;
    const rows = Object.fromEntries(
      [...summary.querySelectorAll("dt")].map((dt) => [
        dt.textContent,
        (dt.nextElementSibling as HTMLElement).textContent,
      ]),
    );
    expect(rows["進み"]).toContain("1/2");
    expect(rows["Iteration"]).toBe("s0 既定");
    expect(rows["承認"]).toContain("eiki");
    expect(summary.querySelector("dd time")?.getAttribute("dateTime")).toBe("2026-01-03T00:00:00Z");
    expect(rows["次"]).toContain("t3");
    expect(rows["閉じた"]).toBeUndefined();
    // 依存グラフは帯と同じ部品で出す（t1 → t3）
    const nodes = [...document.querySelectorAll<HTMLAnchorElement>(".plan-graph a.plan-node")];
    expect(nodes.map((a) => a.getAttribute("href"))).toEqual(["#/tickets/t1", "#/tickets/t3"]);
    // チケットは Plan の順。details のないチケット（t1）は題と状態だけ
    const items = [...document.querySelectorAll(".plan-ticket")];
    expect(items.map((li) => li.querySelector("a code")!.textContent)).toEqual(["t1", "t3"]);
    expect(items[0]!.textContent).toContain("ログイン");
    expect(items[0]!.querySelector(".plan-ticket-details")).toBeNull();
    expect(items[0]!.querySelector(".plan-tier")).toBeNull();
    const t3 = within(items[1] as HTMLElement);
    expect(t3.getByText("画面")).toBeTruthy();
    expect(t3.getByText("light")).toBeTruthy();
    expect(t3.getByText("画面だけを直す")).toBeTruthy();
    expect(items[1]!.querySelector(".plan-ticket-details")!.textContent).toContain(
      "進め方部品を足す\n既存の部品を使う",
    );
  });

  it("閉じた Plan は状態を閉じたにし、閉じた日時を出して次を出さない", async () => {
    window.location.hash = "#/plans/p1";
    mount(withPlans(), hostOf("panel"));
    const title = await screen.findByRole("heading", { level: 1 });
    expect(title.textContent).toContain("閉じた");
    const summary = document.querySelector(".plan-summary")!;
    const dts = [...summary.querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(dts).toContain("閉じた");
    expect(dts).not.toContain("次");
    expect([...summary.querySelectorAll("time")].map((t) => t.getAttribute("dateTime"))).toEqual([
      "2026-01-02T00:00:00Z",
      "2026-01-05T00:00:00Z",
    ]);
  });

  it("承認待ちの Plan は承認の欄に人の承認を待っていることを出す", async () => {
    const client = mockClient(boardFixture());
    client.data.plans = [plan({ id: "p3", tickets: ["t3"], pending_approval: true })];
    window.location.hash = "#/plans/p3";
    mount(client, hostOf("panel"));
    const title = await screen.findByRole("heading", { level: 1 });
    expect(title.textContent).toContain("承認待ち");
    expect(document.querySelector(".plan-summary")!.textContent).toContain("人の承認を待っている");
    expect(client.calls.some((c) => c.name === "plan.show")).toBe(true);
  });

  it("Iteration 詳細の Plan の節の番号を押すと Plan 詳細を開く", async () => {
    const opened: Route[] = [];
    const client = withPlans();
    client.handlers["iteration.show"] = () => ({
      ...iterationDetail(client.data.iterations[0]!),
      plans: [
        {
          id: "p2",
          status: "approved",
          progress: { total: 2, done: 1, by_status: { done: 1, todo: 1 } },
        },
      ],
    });
    window.location.hash = `#/iterations/${client.data.iterations[0]!.id}`;
    mount(
      client,
      hostOf("sidebar", (route) => opened.push(route)),
    );
    const section = await screen.findByRole("region", { name: "Plan" });
    fireEvent.click(within(section).getByRole("link", { name: "p2" }));
    expect(opened).toEqual([{ page: "plans", id: "p2" }]);
  });
});
