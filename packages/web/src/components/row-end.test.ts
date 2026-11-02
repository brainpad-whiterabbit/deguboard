import { describe, expect, it } from "vitest";
import { plan, ticket } from "../test-helpers.js";
import { isWaitingReadiness, kanbanPlanMarks, kanbanReadiness, waitLabel } from "./row-end.js";

describe("左パネルのカンバンの行の Plan の番号と待ち", () => {
  const tickets = [
    ticket({ id: "t1", status: "done" }),
    ticket({ id: "t2", status: "in_progress" }),
    ticket({ id: "t3" }),
    ticket({ id: "t4" }),
    ticket({ id: "t5" }),
    ticket({ id: "t6" }),
  ];

  it("開いた Plan に入っているチケットだけに、Plan の番号・承認待ちか・残っている待ちの相手を持たせる", () => {
    const marks = kanbanPlanMarks(
      [
        plan({
          id: "p1",
          tickets: ["t1", "t2", "t3", "t4"],
          after: { t3: ["t1"], t4: ["t2", "t3"] },
        }),
        plan({ id: "p2", tickets: ["t5"], status: "closed" }),
        plan({ id: "p3", tickets: ["t6"], status: "pending" }),
      ],
      tickets,
    );
    expect(Object.fromEntries(marks)).toEqual({
      t1: { plan: "p1", pending: false, waitingOn: [] },
      t2: { plan: "p1", pending: false, waitingOn: [] },
      t3: { plan: "p1", pending: false, waitingOn: [] },
      t4: { plan: "p1", pending: false, waitingOn: ["t2", "t3"] },
      // 承認待ちの Plan のチケットは pending
      t6: { plan: "p3", pending: true, waitingOn: [] },
    });
  });

  it("Plan の after に加えて、終わっていない depends_on（Plan の外のもの・after に書かれていないもの）も待ちの相手に入れる", () => {
    const withDeps = [
      ticket({ id: "t1", status: "done" }),
      ticket({ id: "t2", status: "in_progress" }),
      // Plan の外：t8 は終わっていない、t9 は abandoned
      ticket({ id: "t8", status: "review" }),
      ticket({ id: "t9", status: "abandoned" }),
      // depends_on だけで Plan の外の t8 を待つ（after はない）
      ticket({ id: "t3", depends_on: ["t1", "t8", "t9"] }),
      // after で t2 を待ち、depends_on でも t2 と Plan の中の t5 を待つ（重ねて数えない）
      ticket({ id: "t4", depends_on: ["t2", "t5"] }),
      ticket({ id: "t5" }),
      // 画面が読んでいないチケット（別の Project のもの）への depends_on は、deps_done で決める
      ticket({ id: "t6", depends_on: ["t99"], deps_done: false }),
      ticket({ id: "t7", depends_on: ["t98"], deps_done: true }),
      // 読めている依存先（t2）が終わっていなければ、別の Project の依存先（t97）は終わっているかもしれないので出さない
      ticket({ id: "t10", depends_on: ["t2", "t97"], deps_done: false }),
    ];
    const marks = kanbanPlanMarks(
      [
        plan({
          id: "p1",
          tickets: ["t2", "t3", "t4", "t5", "t6", "t7", "t10"],
          after: { t4: ["t2"] },
        }),
      ],
      withDeps,
    );
    expect(Object.fromEntries(marks)).toEqual({
      t2: { plan: "p1", pending: false, waitingOn: [] },
      t3: { plan: "p1", pending: false, waitingOn: ["t8"] },
      t4: { plan: "p1", pending: false, waitingOn: ["t2", "t5"] },
      t5: { plan: "p1", pending: false, waitingOn: [] },
      t6: { plan: "p1", pending: false, waitingOn: ["t99"] },
      t7: { plan: "p1", pending: false, waitingOn: [] },
      t10: { plan: "p1", pending: false, waitingOn: ["t2"] },
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
    tickets: Parameters<typeof kanbanPlanMarks>[1],
  ) => {
    const marks = kanbanPlanMarks(plans, tickets);
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
      plan({ id: "p1", tickets: ["t1", "t2", "t3", "t4"], after: { t3: ["t1"] } }),
      plan({ id: "p2", tickets: ["t6", "t7"], status: "pending" }),
    ];
    expect(dimmedIds(plans, tickets)).toEqual(["t3", "t6"]);
    const marks = kanbanPlanMarks(plans, tickets);
    expect(kanbanReadiness(tickets[1]!, marks.get("t2"))).toBe("ready");
    expect(kanbanReadiness(tickets[2]!, marks.get("t3"))).toBe("waiting");
    expect(kanbanReadiness(tickets[4]!, marks.get("t5"))).toBeNull();
    expect(kanbanReadiness(tickets[5]!, marks.get("t6"))).toBe("pending");
    expect(kanbanReadiness(tickets[6]!, marks.get("t7"))).toBeNull();
  });

  it("待ちの相手が終わって着手可になると、読み直した結果では薄くしない", () => {
    const plans = [plan({ id: "p1", tickets: ["t1", "t2", "t3"], after: { t2: ["t1"] } })];
    const before = [
      ticket({ id: "t1", status: "review" }),
      ticket({ id: "t2" }),
      ticket({ id: "t3", depends_on: ["t9"], deps_done: false }),
    ];
    expect(dimmedIds(plans, before)).toEqual(["t2", "t3"]);
    // after の相手 t1 が done になり、Plan の外の depends_on も終わった後に読み直す
    const after = [
      ticket({ id: "t1", status: "done" }),
      ticket({ id: "t2" }),
      ticket({ id: "t3", depends_on: ["t9"], deps_done: true }),
    ];
    expect(dimmedIds(plans, after)).toEqual([]);
  });

  it("Plan が承認されると、承認待ちだった行は薄くしない", () => {
    const tickets = [ticket({ id: "t1" })];
    expect(dimmedIds([plan({ id: "p1", tickets: ["t1"], status: "pending" })], tickets)).toEqual([
      "t1",
    ]);
    expect(dimmedIds([plan({ id: "p1", tickets: ["t1"], status: "approved" })], tickets)).toEqual(
      [],
    );
  });
});
