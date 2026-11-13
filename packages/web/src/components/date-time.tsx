// 日時の表示。履歴の日付は今日・昨日を言葉にし、今年は月/日、それより前は年/月/日にする（formatShortDay）。履歴の閉じた Iteration の期間は時刻と所要時間で出す（formatPeriod）。チケット詳細の作成・更新と Plan 詳細の日時は経過と同じ手元時刻で、今年なら年を省く

import { formatTime } from "./timeline.js";
import { tr } from "../l10n.js";
import { trNode } from "../l10n-node.js";

/** 手元時刻の日時（2026-11-01 13:48）。now と同じ年なら年を省く（11-01 13:48） */
export function formatShortTime(iso: string, now: Date = new Date()): string {
  const text = formatTime(iso);
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getFullYear() === now.getFullYear()
    ? text.slice(text.indexOf("-") + 1)
    : text;
}

/**
 * 履歴用の短い日付。手元の日付で now と同じ日は「今日」、前の日は「昨日」、同じ年なら `11/03`、それより前は `2025/11/03`。
 * 読めなければそのまま出す。now は試験で固定できるよう引数にしている
 */
export function formatShortDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  // 夏時間で 1 日が 24 時間でない日があるので、日付の差は暦の日で数える
  const diff = Math.round((day(now).getTime() - day(d).getTime()) / 86_400_000);
  if (diff === 0) return tr("今日");
  if (diff === 1) return tr("昨日");
  const p = (n: number) => String(n).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

/**
 * 閉じた Iteration の実績の期間を、手元時刻の時刻と所要時間で出す（このリポジトリの Iteration は数時間で閉じることが多く、
 * 日付だけでは「今日 〜 今日」になって長さが読めないので）。
 * - 同じ日：`11/13 09:28–13:24 · 4 時間`（1 時間に満たなければ分で出す）
 * - 次の日に閉じた：`11/12 22:10–11/13 08:00 · 10 時間`
 * - 2 日以上あと：`11/10–11/13 · 4 日`（日数は開始の日を 1 日目に数える暦の日数。activeDay と同じ数え方）
 * - 開始の記録がない：`開始は不明 ・ 11/13 13:24 に閉じた`。閉じた日時がない端は「閉じた日は不明」
 * 日付は now と違う年なら年を付ける（2025/11/13）。読めない値はそのまま出す。now は試験で固定できるよう引数にしている
 */
export function formatPeriod(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  now: Date = new Date(),
): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const parse = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const day = (d: Date) =>
    `${d.getFullYear() === now.getFullYear() ? "" : `${d.getFullYear()}/`}${d.getMonth() + 1}/${d.getDate()}`;
  const time = (d: Date) => `${p(d.getHours())}:${p(d.getMinutes())}`;
  const at = (iso: string) => {
    const d = parse(iso);
    return d ? `${day(d)} ${time(d)}` : iso;
  };
  if (!startIso) {
    return tr("開始は不明 ・ ") + (endIso ? tr("{0} に閉じた", at(endIso)) : tr("閉じた日は不明"));
  }
  if (!endIso) return tr("{0} 〜 ", at(startIso)) + tr("閉じた日は不明");
  const start = parse(startIso);
  const end = parse(endIso);
  if (!start || !end) return `${at(startIso)}–${at(endIso)}`;
  // 夏時間で 1 日が 24 時間でない日があるので、暦の日付を UTC の 0 時に置き直してから差を取る
  const utcDay = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((utcDay(end) - utcDay(start)) / 86_400_000);
  if (days >= 2) return `${day(start)}–${day(end)} · ${tr("{0} 日", days + 1)}`;
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
  const length = minutes < 60 ? tr("{0} 分", minutes) : tr("{0} 時間", Math.round(minutes / 60));
  const ends = days === 0 ? time(end) : `${day(end)} ${time(end)}`;
  return `${day(start)} ${time(start)}–${ends} · ${length}`;
}

/** 履歴の日付。短い書き方で出し、正確な日時（2026-11-01 13:48）をツールチップに。note はツールチップの頭に足す説明 */
export function ShortDay({
  iso,
  approximate = false,
  note,
}: {
  iso: string;
  approximate?: boolean;
  note?: string;
}) {
  const exact = formatTime(iso);
  return (
    <time dateTime={iso} title={note ? tr("{0}（{1}）", note, exact) : exact}>
      {approximate ? "~" : ""}
      {formatShortDay(iso)}
    </time>
  );
}

/**
 * 閉じた Iteration の期間（formatPeriod）。ShortDay と同じく <time> で包み、閉じた日時を dateTime に、
 * 正確な開始と閉じた日時（2026-11-13 09:28 – 2026-11-13 13:24）をツールチップに置く。
 * 開始の記録がなければツールチップは閉じた日時だけ、どちらもなければ文字だけで出す
 */
export function Period({
  start,
  end,
}: {
  start: string | null | undefined;
  end: string | null | undefined;
}) {
  const text = formatPeriod(start, end);
  const iso = end ?? start;
  if (!iso) return <>{text}</>;
  const title = [start, end]
    .filter((x): x is string => !!x)
    .map((x) => formatTime(x))
    .join(" – ");
  return (
    <time dateTime={iso} title={title}>
      {text}
    </time>
  );
}

/** 履歴の「<日付> に閉じた」。closed_at がなければ「閉じた日は不明」 */
export function ClosedOn({ iso }: { iso: string | null | undefined }) {
  return iso ? <>{trNode("{0} に閉じた", <ShortDay iso={iso} />)}</> : <>{tr("閉じた日は不明")}</>;
}

/** 日時。手元時刻で今年なら年を省いて出し、ISO の値はツールチップに */
export function DateTime({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={iso}>
      {formatShortTime(iso)}
    </time>
  );
}
