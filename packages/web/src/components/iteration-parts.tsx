// Iteration の部品：見出しに出す短い実績の期間、詳細の見出しの下の期間・目標・進捗の欄。
// 期間は実績の started_at（active になった日時）〜 closed_at（閉じた日時）で出す（UI-5）。
// 短い期間はカンバン（board.tsx）とバックログ（backlog.tsx）の左パネルの見出しでも共用する

import { DateTime } from "./date-time.js";
import { ProgressBar } from "./parts.js";
import { NO_VALUE } from "./run-parts.js";
import type { Iteration, IterationDetail } from "../types.js";
import { tr } from "../l10n.js";
import { trNode } from "../l10n-node.js";

type PeriodOf = Pick<Iteration, "status" | "started_at" | "closed_at">;

/** 日時を手元の暦の月/日にする（2026-11-15T03:00:00Z → 11/15）。読めなければそのまま */
function monthDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 見出しに出す実績の期間を短くする（11/15–11/28）。active は開始だけ（11/15–）、planned は期間がないので undefined。
 * started_at のない（記録する前に始めた）Iteration は開始を「不明」と出す
 */
export function shortPeriod(it: PeriodOf): string | undefined {
  if (it.status === "planned") return undefined;
  const start = it.started_at ? monthDay(it.started_at) : tr("不明");
  if (it.status === "active") return `${start}–`;
  return `${start}–${it.closed_at ? monthDay(it.closed_at) : tr("不明")}`;
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
