// 日時の表示。パネルのチケット詳細の作成・更新は経過と同じ手元時刻で、今年なら年を省く（ブラウザは ISO のまま）

import { formatTime } from "./timeline.js";

/** 手元時刻の日時（2026-11-01 13:48）。now と同じ年なら年を省く（11-01 13:48） */
export function formatShortTime(iso: string, now: Date = new Date()): string {
  const text = formatTime(iso);
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getFullYear() === now.getFullYear()
    ? text.slice(text.indexOf("-") + 1)
    : text;
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
