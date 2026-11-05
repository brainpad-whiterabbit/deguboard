// 日時の表示。履歴の日付は今日・昨日を言葉にし、今年は月/日、それより前は年/月/日にする（formatShortDay）。パネルのチケット詳細の作成・更新は経過と同じ手元時刻で、今年なら年を省く（ブラウザは ISO のまま）

import { formatTime } from "./timeline.js";

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
  if (diff === 0) return "今日";
  if (diff === 1) return "昨日";
  const p = (n: number) => String(n).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`;
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
    <time dateTime={iso} title={note ? `${note}（${exact}）` : exact}>
      {approximate ? "~" : ""}
      {formatShortDay(iso)}
    </time>
  );
}

/** 履歴の「<日付> に閉じた」。closed_at がなければ「閉じた日は不明」 */
export function ClosedOn({ iso }: { iso: string | null | undefined }) {
  return iso ? (
    <>
      <ShortDay iso={iso} /> に閉じた
    </>
  ) : (
    <>閉じた日は不明</>
  );
}

/** 日時。local なら手元時刻で今年なら年を省いて出し、ISO の値はツールチップに。そうでなければ ISO のまま */
export function DateTime({ iso, local }: { iso: string; local: boolean }) {
  if (!local) return <>{iso}</>;
  return (
    <time dateTime={iso} title={iso}>
      {formatShortTime(iso)}
    </time>
  );
}
