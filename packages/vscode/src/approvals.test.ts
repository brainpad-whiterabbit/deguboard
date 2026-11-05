import { describe, expect, it } from "vitest";
import {
  approvalItems,
  approvalMessage,
  approvalRoute,
  newApprovals,
  viewTitle,
} from "./approvals.js";

const items = approvalItems([{ id: "p58" }], [{ id: "t1", title: "一つ目" }, { id: "t2" }]);

describe("approvalItems", () => {
  it("承認待ちの Plan を先に、review のチケットを後に並べる", () => {
    expect(items.map((i) => i.id)).toEqual(["p58", "t1", "t2"]);
    expect(items[0]?.kind).toBe("plan");
    expect(items[1]?.title).toBe("一つ目");
    expect(items[2]).not.toHaveProperty("title");
  });
  it("どちらもなければ空", () => {
    expect(approvalItems([], [])).toEqual([]);
  });
});

describe("newApprovals", () => {
  it("前の集合がない（初めて読めた）ときは知らせない", () => {
    expect(newApprovals(undefined, items)).toEqual([]);
  });
  it("前の集合にない ID だけを返す", () => {
    expect(newApprovals(new Set(["p58", "t1"]), items).map((i) => i.id)).toEqual(["t2"]);
  });
  it("読み直して同じ集合なら知らせない", () => {
    expect(newApprovals(new Set(["p58", "t1", "t2"]), items)).toEqual([]);
  });
  it("減っただけなら知らせない", () => {
    expect(newApprovals(new Set(["p58", "t1", "t2", "t3"]), items)).toEqual([]);
  });
  it("1 件減って別の 1 件が増えたときは増えた分を知らせる", () => {
    expect(newApprovals(new Set(["p58", "t1", "t9"]), items).map((i) => i.id)).toEqual(["t2"]);
  });
});

describe("viewTitle", () => {
  it("0 件なら素のタイトル、あれば件数を足す", () => {
    expect(viewTitle(0)).toBe("deguboard");
    expect(viewTitle(3)).toBe("承認待ち 3");
  });
});

describe("approvalMessage", () => {
  it("Plan だけなら承認待ち、チケットだけならレビュー待ち、両方なら併記する", () => {
    expect(approvalMessage([{ kind: "plan", id: "p1" }])).toContain("承認待ちが増えた（Plan p1）");
    expect(approvalMessage([{ kind: "ticket", id: "t1" }])).toContain("レビュー待ちが増えた（t1）");
    expect(
      approvalMessage([
        { kind: "plan", id: "p1" },
        { kind: "ticket", id: "t1" },
      ]),
    ).toContain("承認待ち・レビュー待ち");
  });
  it("3 件以上は先頭の 2 件と残りの数を出す", () => {
    expect(approvalMessage(items)).toBe(
      "deguboard: 承認待ち・レビュー待ちが増えた（Plan p58・t1 ほか 1 件）",
    );
  });
});

describe("approvalRoute", () => {
  it("Plan は #/plans/<id>、チケットは詳細のルート", () => {
    expect(approvalRoute({ kind: "plan", id: "p58" })).toBe("#/plans/p58");
    expect(approvalRoute({ kind: "ticket", id: "t3" })).toMatch(/^#\/tickets\/t3/);
  });
});
