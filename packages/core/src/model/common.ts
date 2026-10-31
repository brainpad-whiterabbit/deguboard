// モデルで共通に使う語彙（Status、日時、slug）。

import { z } from "zod";

/** 全ワークフロー共通の 5 つの Status（WF-1、ADR-003） */
export const STATUSES = ["todo", "in_progress", "review", "done", "abandoned"] as const;
export type Status = (typeof STATUSES)[number];
export const statusSchema = z.enum(STATUSES);

/** 前進の順。abandoned は前進の軸の外なので null */
export const FORWARD_ORDER: Record<Status, number | null> = {
  todo: 1,
  in_progress: 2,
  review: 3,
  done: 4,
  abandoned: null,
};

/** 終端の Status。照合はここに触れない */
export function isTerminal(status: Status): boolean {
  return status === "done" || status === "abandoned";
}

/** a から b への移動が前進（順が増える）か */
export function isForward(from: Status, to: Status): boolean {
  const a = FORWARD_ORDER[from];
  const b = FORWARD_ORDER[to];
  return a !== null && b !== null && b > a;
}

/** 日時は ISO 8601 の文字列のまま持つ。Date にしない（YAML の往復で形を変えないため） */
export const isoDateTime = z.iso.datetime({ offset: true });

/** Project や Workflow の ID に使う slug */
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "小文字の英数字とハイフンの slug");

/** 現在時刻を ISO 8601（UTC、ミリ秒なし）で返す */
export function toIsoDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
