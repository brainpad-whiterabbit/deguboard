// Run の表示部品（チケット詳細の Run の節と Run の画面で共通）：結果の表示名と印・丸印、トークン数・件数・時間の書き方、横にスクロールする表の枠。
// 取れなかった値（null）は 0 と見せず「—」で出し（RN-2）、推定を含む値には「~」を前に付ける

import type { ReactNode } from "react";
import type { RunView } from "../types.js";

/** 値がないときの表示 */
export const NO_VALUE = "—";

/** 結果の種類。running は実行中、unfinished は result を記録せずに終わった Run（core の集計の unfinished と同じ） */
export type RunResultKey = "success" | "failure" | "interrupted" | "running" | "unfinished";

export const RESULT_LABELS: Record<RunResultKey, string> = {
  success: "成功",
  failure: "失敗",
  interrupted: "中断",
  running: "実行中",
  unfinished: "未完了",
};

/** 結果の種類（実行中・未完了を含む） */
export function runResultKey(run: RunView): RunResultKey {
  if (run.running) return "running";
  return run.result ?? "unfinished";
}

/** 結果の表示名 */
export function runResultLabel(run: RunView): string {
  return RESULT_LABELS[runResultKey(run)];
}

/** 結果の印（色つきの文字）。失敗・中断の理由はツールチップで読む */
export function RunResult({ run }: { run: RunView }) {
  const key = runResultKey(run);
  return (
    <span className={`run-result run-${key}`} title={run.error ?? undefined}>
      {RESULT_LABELS[key]}
    </span>
  );
}

/** 結果の丸印（パネルのチケット詳細の Run の 1 行）。表示名は読み上げとツールチップで、失敗・中断の理由もツールチップで読む */
export function RunResultDot({ run }: { run: RunView }) {
  const key = runResultKey(run);
  const label = RESULT_LABELS[key];
  return (
    <span
      className={`run-dot run-${key}`}
      role="img"
      aria-label={label}
      title={run.error ? `${label}：${run.error}` : label}
    />
  );
}

/** 結果の種類の並び（件数の内訳を出す順） */
export const RESULT_KEYS: RunResultKey[] = [
  "success",
  "failure",
  "interrupted",
  "running",
  "unfinished",
];

/** トークン数・件数。null は「—」、推定を含めば「~」を前に付ける */
export function formatTokens(value: number | null, estimated = false): string {
  if (value === null) return NO_VALUE;
  return `${estimated ? "~" : ""}${value.toLocaleString("en-US")}`;
}

/** 秒を `1時間 2分`・`3分 4秒`・`12秒` の形に。null は「—」 */
export function formatDuration(seconds: number | null, estimated = false): string {
  if (seconds === null) return NO_VALUE;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const text = h > 0 ? `${h}時間 ${m}分` : m > 0 ? `${m}分 ${s % 60}秒` : `${s}秒`;
  return `${estimated ? "~" : ""}${text}`;
}

/** 狭い配置（サイドバー・詳細のパネル）で横にスクロールする表の枠 */
export function RunsScroll({ children }: { children: ReactNode }) {
  return <div className="runs-scroll">{children}</div>;
}
