import { describe, expect, it } from "vitest";
import { plan, ticket } from "../test-helpers.js";
import type { PlanRow, TicketRow } from "../types.js";
import {
  openPlanByTicket,
  planColor,
  planGraph,
  planProgressLine,
  planState,
  plansInScope,
} from "./plan-graph.js";

const byIdOf = (tickets: TicketRow[]) => new Map(tickets.map((t) => [t.id, t]));

describe("Plan の状態", () => {
  const progress = (counts: Partial<PlanRow["progress"]["by_status"]>): PlanRow["progress"] => {
    const by_status = { todo: 0, in_progress: 0, review: 0, done: 0, abandoned: 0, ...counts };
    return { total: 0, done: by_status.done, by_status };
  };
  const byId = byIdOf([
    ticket({ id: "t1", status: "done" }),
    ticket({ id: "t2", status: "in_progress" }),
    ticket({ id: "t3", status: "todo" }),
    ticket({ id: "t4", status: "abandoned" }),
  ]);

  it("閉じた Plan は閉じた、Plan の progress に終わっていないチケットがなければ完了", () => {
    expect(planState(plan({ id: "p1", tickets: ["t2"], status: "closed" }))).toBe("closed");
    expect(
      planState(
        plan({ id: "p1", tickets: ["t1", "t4"], progress: progress({ done: 1, abandoned: 1 }) }),
      ),
    ).toBe("finished");
    // チケットが 1 枚も見つからない Plan は完了にしない
    expect(planState(plan({ id: "p1", tickets: ["t9"] }))).toBe("approved");
  });

  it("承認待ちはそのまま、承認済みで in_progress・review があれば進行中、なければ承認済み", () => {
    expect(
      planState(
        plan({
          id: "p1",
          tickets: ["t2"],
          pending_approval: true,
          progress: progress({ in_progress: 1 }),
        }),
      ),
    ).toBe("pending");
    expect(
      planState(
        plan({ id: "p1", tickets: ["t1", "t2"], progress: progress({ done: 1, review: 1 }) }),
      ),
    ).toBe("working");
    expect(
      planState(
        plan({ id: "p1", tickets: ["t1", "t3"], progress: progress({ done: 1, todo: 1 }) }),
      ),
    ).toBe("approved");
  });

  it("範囲のチケットを含む Plan だけを、進行中・承認待ち・承認済み・完了・閉じたの順に並べる", () => {
    const plans = [
      plan({ id: "p1", tickets: ["t1"], status: "closed" }),
      plan({ id: "p2", tickets: ["t3"] }),
      plan({ id: "p3", tickets: ["t3"], pending_approval: true }),
      plan({ id: "p4", tickets: ["t2"], progress: progress({ in_progress: 1 }) }),
      plan({ id: "p5", tickets: ["t9"] }),
    ];
    const scope = [...byId.values()];
    expect(plansInScope(plans, scope).map((i) => `${i.plan.id}:${i.state}`)).toEqual([
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
  it("after だけのとき、段の中は Plan の順に並べる。待ち中かは core の waiting を読む", () => {
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
        // t4 は t2・t3 を待つ。t3 の待ち t1 は done
        waiting: { t1: [], t2: [], t3: [], t4: ["t2", "t3"] },
      }),
      byId,
    );
    expect(g.nodes.map((n) => [n.id, n.layer, n.row, n.waiting])).toEqual([
      ["t1", 0, 0, false],
      ["t2", 0, 1, false],
      ["t3", 1, 0, false],
      ["t4", 2, 0, true],
    ]);
    // 辺は待つ側の waiting に待たれる側が残れば待ち中
    expect(g.edges).toEqual([
      { from: "t1", to: "t3", done: true, kind: "after" },
      { from: "t2", to: "t4", done: false, kind: "after" },
      { from: "t3", to: "t4", done: false, kind: "after" },
    ]);
    expect([g.layers, g.rows]).toEqual([3, 2]);
  });

  it("Plan の中の depends_on も辺と段になり、同じ組に after もあれば after の 1 本にまとめ、Plan の外は描かない", () => {
    const byId = byIdOf([
      ticket({ id: "t1", status: "done" }),
      ticket({ id: "t2", depends_on: ["t1", "t9"] }),
      ticket({ id: "t3", depends_on: ["t2", "t1"] }),
      ticket({ id: "t4" }),
    ]);
    const g = planGraph(
      plan({
        id: "p1",
        tickets: ["t1", "t2", "t3", "t4"],
        after: { t3: ["t2"] },
        // t3 は t2 を待つ（t1 は done）。t2 の depends_on t1 は終わっている
        waiting: { t1: [], t2: [], t3: ["t2"], t4: [] },
      }),
      byId,
    );
    expect(g.nodes.map((n) => [n.id, n.layer])).toEqual([
      ["t1", 0],
      ["t2", 1],
      ["t3", 2],
      ["t4", 0],
    ]);
    expect(g.edges).toEqual([
      { from: "t1", to: "t2", done: true, kind: "depends_on" },
      { from: "t2", to: "t3", done: false, kind: "after" },
      { from: "t1", to: "t3", done: true, kind: "depends_on" },
    ]);
  });

  it("after と depends_on をまたぐ循環でも段の計算は止まる", () => {
    const byId = byIdOf([ticket({ id: "t1" }), ticket({ id: "t2", depends_on: ["t1"] })]);
    const g = planGraph(plan({ id: "p1", tickets: ["t1", "t2"], after: { t1: ["t2"] } }), byId);
    // t1 から先にたどるので、t2 の待ち t1 は数えず t2 が 0 段、t1 が 1 段
    expect(g.nodes.map((n) => [n.id, n.layer])).toEqual([
      ["t1", 1],
      ["t2", 0],
    ]);
    expect(g.edges.map((e) => `${e.from}>${e.to}:${e.kind}`)).toEqual([
      "t2>t1:after",
      "t1>t2:depends_on",
    ]);
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

describe("帯の行の作業中と次", () => {
  const byId = byIdOf([
    ticket({ id: "t1", status: "done" }),
    ticket({ id: "t2", status: "in_progress" }),
    ticket({ id: "t3", status: "todo" }),
    ticket({ id: "t4", status: "todo" }),
    ticket({ id: "t5", status: "in_progress" }),
    ticket({ id: "t6", status: "review" }),
  ]);

  it("作業中は in_progress を Plan の順に出し、次は core の next が着手できるならそのチケット", () => {
    const p = plan({
      id: "p1",
      tickets: ["t5", "t1", "t2", "t3", "t4"],
      next: { id: "t4", waiting: [] },
    });
    expect(planProgressLine(p, "working", byId)).toEqual({
      working: ["t5", "t2"],
      next: { kind: "ready", id: "t4" },
    });
  });

  it("core の next に待ちの相手が残れば、そのチケットと待っている相手を出す", () => {
    const p = plan({ id: "p1", tickets: ["t2", "t3"], next: { id: "t3", waiting: ["t2"] } });
    expect(planProgressLine(p, "working", byId).next).toEqual({
      kind: "blocked",
      id: "t3",
      waitFor: ["t2"],
    });
  });

  it("core の next がなければ（todo が残らない）次を出さない。review は作業中に数えない", () => {
    const p = plan({ id: "p1", tickets: ["t1", "t6"] });
    expect(planProgressLine(p, "working", byId)).toEqual({ working: [], next: null });
  });

  it("承認待ちは次の代わりに承認待ち、完了・閉じたは何も出さない", () => {
    const p = plan({ id: "p1", tickets: ["t2", "t3"], next: { id: "t3", waiting: [] } });
    expect(planProgressLine(p, "pending", byId)).toEqual({
      working: ["t2"],
      next: { kind: "approval" },
    });
    expect(planProgressLine(p, "finished", byId)).toEqual({ working: [], next: null });
    expect(planProgressLine(p, "closed", byId)).toEqual({ working: [], next: null });
  });
});
