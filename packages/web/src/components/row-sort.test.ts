import { describe, expect, it } from "vitest";
import { ticket } from "../test-helpers.js";
import { byPriorityThenNumber } from "../types.js";
import {
  BACKLOG_SORT_KEYS,
  BOARD_SORT_KEYS,
  compareRows,
  DEFAULT_ROW_SORT,
  pickRowSort,
  rowSortChanged,
  rowSortOf,
  sortRows,
  type RowSort,
} from "./row-sort.js";

// 基準ごとに値が入れ違うよう組んだ行。同じ値の行どうし（t2 と t5 は優先度・Status・更新日が同じ）は、向きによらず既定の並びで決まる
const rows = [
  ticket({
    id: "t5",
    priority: "high",
    status: "todo",
    updated_at: "2026-11-02T00:00:00Z",
  }),
  ticket({
    id: "t2",
    priority: "high",
    status: "todo",
    updated_at: "2026-11-02T00:00:00Z",
  }),
  ticket({
    id: "t10",
    priority: "low",
    status: "review",
    updated_at: "2026-11-03T00:00:00Z",
  }),
  ticket({
    id: "t1",
    priority: "medium",
    status: "in_progress",
    updated_at: "2026-11-01T00:00:00Z",
  }),
  ticket({
    id: "t7",
    priority: "medium",
    status: "todo",
    updated_at: "2026-11-04T00:00:00Z",
  }),
];

const ids = (sort: RowSort) => sortRows(rows, sort).map((t) => t.id);

describe("行の並べ替え（基準と向きの組み合わせ）", () => {
  it.each<[RowSort, string[]]>([
    // 優先度 ↓ は high → low、同じなら番号の小さい順（既定）
    [{ key: "priority", dir: "desc" }, ["t2", "t5", "t1", "t7", "t10"]],
    // 優先度 ↑ は low → high。同じ優先度の中は向きによらず番号の小さい順
    [{ key: "priority", dir: "asc" }, ["t10", "t1", "t7", "t2", "t5"]],
    [{ key: "number", dir: "asc" }, ["t1", "t2", "t5", "t7", "t10"]],
    [{ key: "number", dir: "desc" }, ["t10", "t7", "t5", "t2", "t1"]],
    // 更新日 ↓ は新しい順。同じ時刻（t2・t5）は既定の並び
    [{ key: "updated", dir: "desc" }, ["t7", "t10", "t2", "t5", "t1"]],
    [{ key: "updated", dir: "asc" }, ["t1", "t2", "t5", "t10", "t7"]],
    // Status ↓ は review → in_progress → todo。同じ Status の中は既定の並び
    [{ key: "status", dir: "desc" }, ["t10", "t1", "t2", "t5", "t7"]],
    [{ key: "status", dir: "asc" }, ["t2", "t5", "t7", "t1", "t10"]],
  ])("%o", (sort, expected) => {
    expect(ids(sort)).toEqual(expected);
  });

  it("既定（優先度 ↓）は今までの並び（byPriorityThenNumber）と同じで、元の配列は変えない", () => {
    const before = rows.map((t) => t.id);
    expect(ids(DEFAULT_ROW_SORT)).toEqual([...rows].sort(byPriorityThenNumber).map((t) => t.id));
    expect(rows.map((t) => t.id)).toEqual(before);
  });

  it("読めない更新日は一番古いものとして扱う", () => {
    const broken = ticket({ id: "t3", updated_at: "x" });
    const cmp = compareRows({ key: "updated", dir: "desc" });
    expect(cmp(rows[0]!, broken)).toBeLessThan(0);
    expect(cmp(broken, rows[0]!)).toBeGreaterThan(0);
  });
});

describe("基準の選び方と残した値", () => {
  it("ほかの基準を選ぶとその基準の向き（更新日と Status と優先度は ↓、番号は ↑）、選んでいる基準を押すと向きを入れ替える", () => {
    expect(pickRowSort(DEFAULT_ROW_SORT, "updated")).toEqual({ key: "updated", dir: "desc" });
    expect(pickRowSort(DEFAULT_ROW_SORT, "number")).toEqual({ key: "number", dir: "asc" });
    expect(pickRowSort(DEFAULT_ROW_SORT, "status")).toEqual({ key: "status", dir: "desc" });
    expect(pickRowSort(DEFAULT_ROW_SORT, "priority")).toEqual({ key: "priority", dir: "asc" });
    expect(pickRowSort({ key: "number", dir: "asc" }, "number")).toEqual({
      key: "number",
      dir: "desc",
    });
    expect(pickRowSort({ key: "number", dir: "desc" }, "updated")).toEqual({
      key: "updated",
      dir: "desc",
    });
  });

  it("既定と違うのは、基準か向きが違うときだけ", () => {
    expect(rowSortChanged(DEFAULT_ROW_SORT)).toBe(false);
    expect(rowSortChanged({ key: "priority", dir: "asc" })).toBe(true);
    expect(rowSortChanged({ key: "updated", dir: "desc" })).toBe(true);
  });

  it("残した値が壊れている・そのタブで選べない基準（カンバンの Status）なら既定で読む", () => {
    expect(rowSortOf(undefined, BACKLOG_SORT_KEYS)).toEqual(DEFAULT_ROW_SORT);
    expect(rowSortOf("updated", BACKLOG_SORT_KEYS)).toEqual(DEFAULT_ROW_SORT);
    expect(rowSortOf({ key: "updated" }, BACKLOG_SORT_KEYS)).toEqual(DEFAULT_ROW_SORT);
    expect(rowSortOf({ key: "size", dir: "asc" }, BACKLOG_SORT_KEYS)).toEqual(DEFAULT_ROW_SORT);
    expect(rowSortOf({ key: "status", dir: "asc" }, BACKLOG_SORT_KEYS)).toEqual({
      key: "status",
      dir: "asc",
    });
    expect(rowSortOf({ key: "status", dir: "asc" }, BOARD_SORT_KEYS)).toEqual(DEFAULT_ROW_SORT);
    expect(rowSortOf({ key: "updated", dir: "desc" }, BOARD_SORT_KEYS)).toEqual({
      key: "updated",
      dir: "desc",
    });
  });
});
