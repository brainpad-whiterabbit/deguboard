// Iteration の部品：見出しに出す短い期間。カンバン（board.tsx）とバックログ（backlog.tsx）の左パネルの見出しで共用する

/** 見出しに出す期間を短くする（2026-11-15 と 2026-11-28 → 11/15–11/28）。どちらもなければ undefined */
export function shortPeriod(start?: string, end?: string): string | undefined {
  if (!start && !end) return undefined;
  const md = (d: string | undefined) => {
    const m = d ? /^\d{4}-(\d{2})-(\d{2})/.exec(d) : null;
    return m ? `${Number(m[1])}/${Number(m[2])}` : (d ?? "?");
  };
  return `${md(start)}–${md(end)}`;
}
