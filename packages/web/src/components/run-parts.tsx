import type { ReactNode } from "react";
import type { RunView } from "../types.js";
import { tr, msg } from "../l10n.js";

/** 値がないときの表示 */
export const NO_VALUE = "—";

/** 結果の種類。running は実行中、unfinished は result を記録せずに終わった Run（core の集計の unfinished と同じ） */
export type RunResultKey = "success" | "failure" | "interrupted" | "running" | "unfinished";

export const RESULT_LABELS: Record<RunResultKey, string> = {
  success: msg("成功"),
  failure: msg("失敗"),
  interrupted: msg("中断"),
  running: msg("実行中"),
  unfinished: msg("未完了"),
};

/** 結果の種類（実行中・未完了を含む） */
export function runResultKey(run: RunView): RunResultKey {
  if (run.running) return "running";
  return run.result ?? "unfinished";
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
      title={run.error ? tr("{0}：{1}", label, run.error) : label}
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
  const text =
    h > 0 ? tr("{0}時間 {1}分", h, m) : m > 0 ? tr("{0}分 {1}秒", m, s % 60) : tr("{0}秒", s);
  return `${estimated ? "~" : ""}${text}`;
}

/** 狭い配置（サイドバー・詳細のパネル）で横にスクロールする表の枠 */
export function RunsScroll({ children }: { children: ReactNode }) {
  return <div className="runs-scroll">{children}</div>;
}
