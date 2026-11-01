import { describe, expect, it } from "vitest";
import { plan, ticket } from "../test-helpers.js";
import type { Ticket } from "../types.js";
import { openPlanByTicket, planColor, planGraph, planState, plansInScope } from "./plan-graph.js";

const byIdOf = (tickets: Ticket[]) => new Map(tickets.map((t) => [t.id, t]));

describe("Plan の状態", () => {
  const byId = byIdOf([
    ticket({ id: "t1", status: "done" }),
    ticket({ id: "t2", status: "in_progress" }),
    ticket({ id: "t3", status: "todo" }),
    ticket({ id: "t4", status: "abandoned" }),
  ]);

  it("閉じた Plan は閉じた、すべて done・abandoned なら完了", () => {
    expect(planState(plan({ id: "p1", tickets: ["t2"], status: "closed" }), byId)).toBe("closed");
    expect(planState(plan({ id: "p1", tickets: ["t1", "t4"] }), byId)).toBe("finished");
  });

  it("承認待ちはそのまま、承認済みで in_progress・review があれば進行中、なければ承認済み", () => {
    expect(planState(plan({ id: "p1", tickets: ["t2"], pending_approval: true }), byId)).toBe(
      "pending",
    );
    expect(planState(plan({ id: "p1", tickets: ["t1", "t2"] }), byId)).toBe("working");
    expect(planState(plan({ id: "p1", tickets: ["t1", "t3"] }), byId)).toBe("approved");
  });

  it("範囲のチケットを含む Plan だけを、進行中・承認待ち・承認済み・完了・閉じたの順に並べる", () => {
    const plans = [
      plan({ id: "p1", tickets: ["t1"], status: "closed" }),
      plan({ id: "p2", tickets: ["t3"] }),
      plan({ id: "p3", tickets: ["t3"], pending_approval: true }),
      plan({ id: "p4", tickets: ["t2"] }),
      plan({ id: "p5", tickets: ["t9"] }),
    ];
    const scope = [...byId.values()];
    expect(plansInScope(plans, scope, byId).map((i) => `${i.plan.id}:${i.state}`)).toEqual([
      "p4:working",
      "p3:pending",
      "p2:approved",
      "p1:closed",
    ]);
  });

  it("色は番号を 5 色で回し、チケットの Plan は開いたものだけ引く", () => {
    expect([planColor("p0"), planColor("p7"), planColor("p10")]).toEqual([0, 2, 0]);
    const map = openPlanByTicket([
      plan({ id: "p1", tickets: ["t1"], status: "closed" }),
      plan({ id: "p2", tickets: ["t2"] }),
    ]);
    expect([...map]).toEqual([["t2", "p2"]]);
  });
});

describe("依存グラフ", () => {
  it("after から段を求め、段の中は Plan の順に並べる。待ちが終わっていなければ待ち中", () => {
    const byId = byIdOf([
      ticket({ id: "t1", status: "done" }),
      ticket({ id: "t2", status: "in_progress" }),
      ticket({ id: "t3" }),
      ticket({ id: "t4" }),
    ]);
    const g = planGraph(
      plan({
        id: "p1",
        tickets: ["t1", "t2", "t3", "t4"],
        after: { t3: ["t1"], t4: ["t2", "t3"] },
      }),
      byId,
    );
    expect(g.nodes.map((n) => [n.id, n.layer, n.row, n.waiting])).toEqual([
      ["t1", 0, 0, false],
      ["t2", 0, 1, false],
      ["t3", 1, 0, false],
      ["t4", 2, 0, true],
    ]);
    // 残っている待ちの相手は終わっていないものだけ（t4 は t2・t3 を待つ。t3 の待ち t1 は done）
    expect(g.nodes.map((n) => n.waitingOn)).toEqual([[], [], [], ["t2", "t3"]]);
    expect(g.edges).toEqual([
      { from: "t1", to: "t3", done: true },
      { from: "t2", to: "t4", done: false },
      { from: "t3", to: "t4", done: false },
    ]);
    expect([g.layers, g.rows]).toEqual([3, 2]);
  });

  it("after がなければ 1 段に並べる", () => {
    const byId = byIdOf([ticket({ id: "t1" }), ticket({ id: "t2" })]);
    const g = planGraph(plan({ id: "p1", tickets: ["t1", "t2"] }), byId);
    expect([g.layers, g.rows, g.edges.length]).toEqual([1, 2, 0]);
  });

  it("消えたチケットと Plan の外への待ちは飛ばし、循環しても止まらない", () => {
    const byId = byIdOf([ticket({ id: "t1" }), ticket({ id: "t2" })]);
    const g = planGraph(
      plan({ id: "p1", tickets: ["t1", "t2", "t9"], after: { t1: ["t2"], t2: ["t1", "t8"] } }),
      byId,
    );
    expect(g.nodes.map((n) => n.id)).toEqual(["t1", "t2"]);
    expect(g.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["t2>t1", "t1>t2"]);
  });
});
