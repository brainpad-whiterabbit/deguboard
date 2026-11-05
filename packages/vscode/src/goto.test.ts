import { describe, expect, it } from "vitest";
import { gotoItems } from "./goto.js";
import { buildIdIndex } from "./ids.js";

const index = buildIdIndex({
  tickets: [
    { id: "t2", title: "ログイン画面を直す", status: "done", assignee: "maji/agent" },
    { id: "t10", title: "検索を足す", status: "abandoned" },
  ],
  iterations: [{ id: "s3", name: "第 3 回", status: "closed", goal: "検索" }],
  epics: [{ id: "e1", title: "認証", status: "open", progress: { total: 4, done: 1 } }],
  plans: [{ id: "p7", status: "approved", tickets: ["t2", "t10"] }],
});

describe("gotoItems", () => {
  const items = gotoItems(index);

  it("チケット・Iteration・Epic・Plan の順で、同じ種類では番号の新しい順に並べる", () => {
    expect(items.map((i) => i.id)).toEqual(["t10", "t2", "s3", "e1", "p7"]);
  });

  it("ID と見出しを label に、種類と Status を description に出す（abandoned・closed も見分けられる）", () => {
    expect(items[0]).toMatchObject({
      label: "t10  検索を足す",
      description: "チケット・abandoned",
    });
    expect(items[2]?.description).toBe("Iteration・closed");
  });

  it("Plan は見出しがないので ID だけを label にし、チケットを detail に出す", () => {
    expect(items[4]).toMatchObject({ label: "p7", detail: "チケット: t2 t10" });
  });

  it("索引が空なら項目も空", () => {
    expect(gotoItems(new Map())).toEqual([]);
  });
});
