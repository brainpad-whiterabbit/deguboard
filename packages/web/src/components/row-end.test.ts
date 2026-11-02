import { describe, expect, it } from "vitest";
import { plan, ticket } from "../test-helpers.js";
import { isWaitingReadiness, kanbanPlanMarks, kanbanReadiness, waitLabel } from "./row-end.js";

describe("左パネルのカンバンの行の Plan の番号と待ち", () => {
  it("開いた Plan に入っているチケットだけに、Plan の番号・承認待ちか・core の waiting の待ちの相手を持たせる", () => {
    const marks = kanbanPlanMarks([
      plan({
        id: "p1",
        tickets: ["t1", "t2", "t3", "t4", "t9"],
        after: { t3: ["t1"], t4: ["t2", "t3"] },
        // 消えた t9 は core の waiting にない
        waiting: { t1: [], t2: [], t3: [], t4: ["t2", "t3", "t8"] },
      }),
      plan({ id: "p2", tickets: ["t5"], status: "closed", waiting: { t5: [] } }),
      plan({ id: "p3", tickets: ["t6"], status: "pending", waiting: { t6: [] } }),
    ]);
    expect(Object.fromEntries(marks)).toEqual({
      t1: { plan: "p1", pending: false, waitingOn: [] },
      t2: { plan: "p1", pending: false, waitingOn: [] },
      t3: { plan: "p1", pending: false, waitingOn: [] },
      t4: { plan: "p1", pending: false, waitingOn: ["t2", "t3", "t8"] },
      // 承認待ちの Plan のチケットは pending
      t6: { plan: "p3", pending: true, waitingOn: [] },
    });
  });

  it("待ちの相手は 1 件なら番号、2 件以上なら先頭と残りの件数で書く", () => {
    expect(waitLabel(["t137"])).toBe("t137 待ち");
    expect(waitLabel(["t2", "t3", "t9"])).toBe("t2+2 待ち");
    expect(waitLabel([])).toBe("");
  });
});

describe("左パネルのカンバンの待ち・承認待ちの行を薄くする", () => {
  const dimmedIds = (
    plans: Parameters<typeof kanbanPlanMarks>[0],
    tickets: ReturnType<typeof ticket>[],
  ) => {
    const marks = kanbanPlanMarks(plans);
    return tickets
      .filter((t) => isWaitingReadiness(kanbanReadiness(t, marks.get(t.id))))
      .map((t) => t.id);
  };

  it("待ちの相手が残る todo と承認待ちの Plan の todo だけを薄くし、着手可・Plan の外・todo でない行は薄くしない", () => {
    const tickets = [
      ticket({ id: "t1", status: "in_progress" }),
      ticket({ id: "t2" }),
      ticket({ id: "t3" }),
      ticket({ id: "t4" }),
      // Plan に入っていない todo
      ticket({ id: "t5" }),
      // 承認待ちの Plan の、待ちの相手のない todo と in_progress
      ticket({ id: "t6" }),
      ticket({ id: "t7", status: "in_progress" }),
    ];
    const plans = [
      plan({
        id: "p1",
        tickets: ["t1", "t2", "t3", "t4"],
        after: { t3: ["t1"] },
        // in_progress の t1 に待ちの相手が残っても、todo でなければ薄くしない
        waiting: { t1: ["t9"], t2: [], t3: ["t1"], t4: [] },
      }),
      plan({ id: "p2", tickets: ["t6", "t7"], status: "pending", waiting: { t6: [], t7: [] } }),
    ];
    expect(dimmedIds(plans, tickets)).toEqual(["t3", "t6"]);
    const marks = kanbanPlanMarks(plans);
    expect(kanbanReadiness(tickets[1]!, marks.get("t2"))).toBe("ready");
    expect(kanbanReadiness(tickets[2]!, marks.get("t3"))).toBe("waiting");
    expect(kanbanReadiness(tickets[4]!, marks.get("t5"))).toBeNull();
    expect(kanbanReadiness(tickets[5]!, marks.get("t6"))).toBe("pending");
    expect(kanbanReadiness(tickets[6]!, marks.get("t7"))).toBeNull();
  });

  it("Plan が承認されると、承認待ちだった行は薄くしない", () => {
    const tickets = [ticket({ id: "t1" })];
    const waiting = { t1: [] };
    expect(
      dimmedIds([plan({ id: "p1", tickets: ["t1"], status: "pending", waiting })], tickets),
    ).toEqual(["t1"]);
    expect(
      dimmedIds([plan({ id: "p1", tickets: ["t1"], status: "approved", waiting })], tickets),
    ).toEqual([]);
  });
});
