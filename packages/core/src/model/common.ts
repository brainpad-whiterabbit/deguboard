// モデルで共通に使う語彙（Status、日時、slug）。

import { z } from "zod";

/** 全ワークフロー共通の 5 つの Status（WF-1） */
export const STATUSES = ["todo", "in_progress", "review", "done", "abandoned"] as const;
export type Status = (typeof STATUSES)[number];
export const statusSchema = z.enum(STATUSES);

/** 前進の順。abandoned は前進の軸の外なので null */
const FORWARD_ORDER: Record<Status, number | null> = {
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

/**
 * 「終わった」の判定（Epic・Plan・Iteration の中のチケット）。流れ・lint・ask はこれだけを使う。
 * 数えるのは今あるチケットだけで、消したチケット（undefined）は集まりにないものとして扱う（plan close と同じ）。
 * 数えたものが 1 件以上あり、すべて done か abandoned なら終わり。abandoned だけの集まりも終わりに入れる（閉じられる Epic と同じ）
 */
export function isFinishedSet(statuses: readonly (Status | undefined)[]): boolean {
  const counted = statuses.filter((st): st is Status => st !== undefined);
  return counted.length > 0 && counted.every(isTerminal);
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
  .regex(/^[a-z0-9][a-z0-9-]*$/, "A slug of lowercase letters, digits and hyphens");

/**
 * `git check-ref-format --branch` 相当の検査。先頭の `-` を拒み、git にオプションとして読まれないようにする
 * （`--upload-pack=<コマンド>` のような注入で actions.shell を回り込ませない。AG-7）。
 * config のスキーマ（git.data_branch）も使うので、git の層でなくモデルに置く
 */
export function isSafeBranchName(name: string): boolean {
  if (name === "" || name === "@" || name.startsWith("-")) return false;
  // 制御文字・空白・~ ^ : ? * [ \ と、`..`・`@{`・`//` を含むもの
  // oxlint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\//.test(name)) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

// 依存のない time.ts に置き、PreToolUse の速い経路（zod を読まない）からも使う
export { toIsoDateTime } from "./time.js";
