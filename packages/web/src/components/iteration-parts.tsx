// Iteration の部品：見出しに出す短い実績の期間と目標、詳細の見出しの下の期間・目標・進捗の欄。
// 期間は実績の started_at（active になった日時）〜 closed_at（閉じた日時）で出す（UI-5）。
// 短い期間と目標はカンバン（board.tsx）とバックログ（backlog.tsx）の左パネルの見出しでも共用する。何日目か（activeDay）はカンバンの見出しが出す

import { calendarDayDiff, DateTime, formatMonthDay } from "./date-time.js";
import { IdLinkedText, ProgressBar } from "./parts.js";
import { NO_VALUE } from "./run-parts.js";
import type { Iteration, IterationDetail } from "../types.js";
import { tr } from "../l10n.js";
import { trNode } from "../l10n-node.js";

type PeriodOf = Pick<Iteration, "status" | "started_at" | "closed_at">;

/**
 * 見出しに出す実績の期間を短くする（11/15–11/28）。月日は履歴と同じ formatMonthDay で出す（ゼロ埋め、今年でなければ年を付ける）。
 * active は開始だけ（11/05–）、planned は期間がないので undefined。
 * started_at のない（記録する前に始めた）Iteration は開始を「不明」と出し、読めない日時はそのまま出す
 */
export function shortPeriod(it: PeriodOf, now: Date = new Date()): string | undefined {
  if (it.status === "planned") return undefined;
  const monthDay = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : formatMonthDay(d, now);
  };
  const start = it.started_at ? monthDay(it.started_at) : tr("不明");
  if (it.status === "active") return `${start}–`;
  return `${start}–${it.closed_at ? monthDay(it.closed_at) : tr("不明")}`;
}

/**
 * active の Iteration が今日で何日目か（開始の日を 1 日目に、手元の暦の日付で数える。時刻は見ない）。
 * planned・closed と、started_at のない・読めない Iteration は undefined。開始が未来（時計のずれ）なら 1 日目にする
 */
export function activeDay(
  it: Pick<Iteration, "status" | "started_at">,
  now: Date = new Date(),
): number | undefined {
  if (it.status !== "active" || !it.started_at) return undefined;
  const start = new Date(it.started_at);
  if (Number.isNaN(start.getTime())) return undefined;
  return Math.max(1, calendarDayDiff(start, now) + 1);
}

/**
 * 見出しの目標。カンバンの見出し（board.tsx の BoardHead）とバックログの区画の見出し（backlog.tsx）で共用する。
 * 中の ID は詳細へのリンクにし（IdLinkedText）、全文をツールチップに置く。行の形は className で選ぶ（カンバンは head-goal で 3 行まで折り返し、バックログは goal で 1 行に省略）
 */
export function IterationGoal({ goal, className }: { goal: string; className: string }) {
  return (
    <span className={className} title={goal}>
      <IdLinkedText text={goal} />
    </span>
  );
}

/** 詳細の期間：開始と終了の日時（active は開始だけ）。記録のない端は「不明」 */
function PeriodTimes({ it }: { it: PeriodOf }) {
  const at = (iso: string | undefined) => (iso ? <DateTime iso={iso} /> : tr("不明"));
  return (
    <>
      {it.status === "closed"
        ? trNode("{0} 〜 {1}", at(it.started_at), at(it.closed_at))
        : trNode("{0} 〜", at(it.started_at))}
    </>
  );
}

/**
 * Iteration 詳細の見出しの下の欄：期間（実績の日時）・目標・進捗を別の行に出す（UI-5）。
 * planned は期間の行を出さず、目標が空なら目標の行を出さない。閉じた Iteration は進捗の位置に完了・持ち越しの件数を出す
 */
export function IterationSummary({ it }: { it: IterationDetail }) {
  return (
    <dl className="iteration-summary">
      {it.status !== "planned" ? (
        <>
          <dt>{tr("期間")}</dt>
          <dd>
            <PeriodTimes it={it} />
          </dd>
        </>
      ) : null}
      {it.goal ? (
        <>
          <dt>{tr("目標")}</dt>
          <dd>{it.goal}</dd>
        </>
      ) : null}
      <dt>{tr("進捗")}</dt>
      <dd>
        {it.status === "closed" ? (
          tr("完了 {0} ・ 持ち越し {1}", it.completed ?? NO_VALUE, it.carried_over ?? NO_VALUE)
        ) : (
          <ProgressBar progress={it.progress} />
        )}
      </dd>
    </dl>
  );
}
