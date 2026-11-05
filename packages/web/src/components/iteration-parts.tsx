import { ProgressBar } from "./parts.js";
import { NO_VALUE } from "./run-parts.js";
import type { IterationDetail } from "../types.js";
import { tr } from "../l10n.js";

/** 見出しに出す期間を短くする（2026-11-15 と 2026-11-28 → 11/15–11/28）。どちらもなければ undefined */
export function shortPeriod(start?: string, end?: string): string | undefined {
  if (!start && !end) return undefined;
  const md = (d: string | undefined) => {
    const m = d ? /^\d{4}-(\d{2})-(\d{2})/.exec(d) : null;
    return m ? `${Number(m[1])}/${Number(m[2])}` : (d ?? "?");
  };
  return `${md(start)}–${md(end)}`;
}

/** 手元の時刻の暦日（YYYY-MM-DD）。残り日数は利用者の暦で数える */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 期間に添える残り・超過の日数（active の Iteration だけ）。today は YYYY-MM-DD で、既定は手元の今日。
 * 終了日の前は「残り n 日」、終了日の当日は「今日まで」、過ぎたら「n 日超過」（overdue が true）。終了日がない・active でなければ undefined
 */
export function periodNote(
  it: Pick<IterationDetail, "status" | "end">,
  today: string = localDate(),
): { text: string; overdue: boolean } | undefined {
  if (it.status !== "active" || !it.end) return undefined;
  const end = Date.parse(it.end.slice(0, 10));
  const now = Date.parse(today);
  if (Number.isNaN(end) || Number.isNaN(now)) return undefined;
  const days = Math.round((end - now) / DAY_MS);
  if (days > 0) return { text: tr("残り {0} 日", days), overdue: false };
  if (days === 0) return { text: tr("今日まで"), overdue: false };
  return { text: tr("{0} 日超過", -days), overdue: true };
}

/**
 * Iteration 詳細の見出しの下の欄：期間（短い形と残り・超過の日数）・目標・進捗を別の行に出す（UI-5）。
 * 期間の開始・終了がどちらもない・目標が空なら、その行を出さない。閉じた Iteration は進捗の位置に完了・持ち越しの件数を出す
 */
export function IterationSummary({ it }: { it: IterationDetail }) {
  const period = shortPeriod(it.start, it.end);
  const note = periodNote(it);
  return (
    <dl className="iteration-summary">
      {period ? (
        <>
          <dt>{tr("期間")}</dt>
          <dd>
            {period}
            {note ? (
              <span className={note.overdue ? "period-note overdue" : "period-note"}>
                {note.text}
              </span>
            ) : null}
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
