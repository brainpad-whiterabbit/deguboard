// バックログとカンバンの行の並び順（UI-2・UI-3）。「表示」のメニュー（components/view-menu.tsx）で基準を選び、選んでいる基準をもう一度押すと向きを入れ替える。
// 並べるのはバックログの Iteration の区画の中（区画に分けない一覧ではその中）とカンバンの状態の節の中だけで、区画と節の順は変えない
// （並べた一覧を区画・節に分ける側が、並びを保ったまま分ける）。
// 値はタブごとに host.state に残す（useUiState の鍵 backlog.sort・board.sort）。行のラベルを出すか（rows.view）はタブで共有するが、
// 並び順はタブで見たいものが違う（カンバンは節が Status なので Status の基準を持たない）ので分ける。
// 並べる判定は描画から分けた関数（compareRows・sortRows）に置き、基準と向きの組み合わせを row-sort.test.ts で確かめる

import { createContext, useContext } from "react";
import { useUiState } from "../host.js";
import { msg } from "../l10n.js";
import { byPriorityThenNumber, PRIORITY_RANK, type Status, type Ticket } from "../types.js";

/** 並べる基準。updated は updated_at、status は review → in_progress → todo */
export type RowSortKey = "priority" | "number" | "updated" | "status";

/** 向き。desc は「大きいほうが先」（優先度は high、番号は大きい番号、更新日は新しいもの、Status は review が先） */
export type RowSortDir = "asc" | "desc";

export interface RowSort {
  key: RowSortKey;
  dir: RowSortDir;
}

/** 基準を選んだときの向き。既定（優先度 desc）は今までの並び（byPriorityThenNumber）と同じ */
export const NATURAL_DIR: Readonly<Record<RowSortKey, RowSortDir>> = {
  priority: "desc",
  number: "asc",
  updated: "desc",
  status: "desc",
};

export const DEFAULT_ROW_SORT: RowSort = { key: "priority", dir: "desc" };

/** バックログで選べる基準（メニューの並び） */
export const BACKLOG_SORT_KEYS: readonly RowSortKey[] = ["priority", "number", "updated", "status"];

/** カンバンで選べる基準。節が Status なので Status は持たない */
export const BOARD_SORT_KEYS: readonly RowSortKey[] = ["priority", "number", "updated"];

/** 基準の名前（メニューと札。描くときに tr で訳す） */
export const ROW_SORT_LABELS: Readonly<Record<RowSortKey, string>> = {
  priority: msg("優先度"),
  number: msg("番号"),
  updated: msg("更新日"),
  status: "Status",
};

/** 向きの矢印（メニューと札） */
export function rowSortArrow(dir: RowSortDir): string {
  return dir === "desc" ? "↓" : "↑";
}

/** Status の順位（大きいほど先に進んでいる）。done・abandoned はバックログに出ないが、来ても todo の手前に置かず端に寄せる */
const STATUS_RANK: Readonly<Record<Status, number>> = {
  abandoned: -2,
  done: -1,
  todo: 0,
  in_progress: 1,
  review: 2,
};

/** 更新日の時刻。読めない値は一番古いものとして扱う */
function updatedMs(t: Pick<Ticket, "updated_at">): number {
  const ms = Date.parse(t.updated_at);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function idNumber(t: Pick<Ticket, "id">): number {
  return Number(t.id.slice(1));
}

/** 基準ごとの小さい順（asc）の比べ方 */
const ASCENDING: Readonly<Record<RowSortKey, (a: Ticket, b: Ticket) => number>> = {
  priority: (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority],
  number: (a, b) => idNumber(a) - idNumber(b),
  updated: (a, b) => {
    const x = updatedMs(a);
    const y = updatedMs(b);
    return x === y ? 0 : x < y ? -1 : 1;
  },
  status: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status],
};

/**
 * 行の比べ方。基準と向きで比べ、同じなら向きによらず既定の並び（優先度 high → low、番号の小さい順）で決める
 * （向きを入れ替えても、同じ値の行どうしの並びは変えない）
 */
export function compareRows(sort: RowSort): (a: Ticket, b: Ticket) => number {
  const base = ASCENDING[sort.key];
  const sign = sort.dir === "asc" ? 1 : -1;
  return (a, b) => sign * base(a, b) || byPriorityThenNumber(a, b);
}

/** 並べた写し（元の配列は変えない） */
export function sortRows<T extends Ticket>(tickets: readonly T[], sort: RowSort): T[] {
  return [...tickets].sort(compareRows(sort));
}

/** 基準を選ぶ：選んでいる基準なら向きを入れ替え、ほかの基準ならその基準の向き（NATURAL_DIR）で選ぶ */
export function pickRowSort(current: RowSort, key: RowSortKey): RowSort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: NATURAL_DIR[key] };
}

/** 既定と違う並びか（札を出し、「表示」ボタンを色付きにする） */
export function rowSortChanged(sort: RowSort): boolean {
  return sort.key !== DEFAULT_ROW_SORT.key || sort.dir !== DEFAULT_ROW_SORT.dir;
}

/** 残した値から並び順を読む。壊れた値・そのタブで選べない基準（keys にない）は既定にする */
export function rowSortOf(stored: unknown, keys: readonly RowSortKey[]): RowSort {
  if (typeof stored !== "object" || stored === null) return DEFAULT_ROW_SORT;
  const { key, dir } = stored as Record<string, unknown>;
  if (!keys.includes(key as RowSortKey) || (dir !== "asc" && dir !== "desc")) {
    return DEFAULT_ROW_SORT;
  }
  return { key: key as RowSortKey, dir };
}

/** 並び順を残すタブ */
export type RowSortTab = "backlog" | "board";

/** タブの並び順と、それを変える関数。値は host.state の `<tab>.sort` に残す */
export function useRowSort(tab: RowSortTab): [RowSort, (sort: RowSort) => void] {
  const [stored, setStored] = useUiState<unknown>(`${tab}.sort`, undefined);
  return [rowSortOf(stored, tab === "board" ? BOARD_SORT_KEYS : BACKLOG_SORT_KEYS), setStored];
}

/**
 * 行の 2 段目に相対の更新時刻を出すか（更新日で並べている間だけ画面が true を渡す）。
 * 渡さない一覧（履歴など）は出さない。出す形は components/parts.tsx の TicketRow
 */
export const RowUpdatedContext = createContext(false);

export function useRowUpdated(): boolean {
  return useContext(RowUpdatedContext);
}
