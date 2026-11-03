// チケットの経過（UI-4）。history のコマンドの結果（deguboard ブランチの履歴）を時刻の順に 1 行ずつ出す。
// 日付が変わるところに日付の行を挟み、各行は時刻・丸印・変化・作者にする。Status の変わらない行は中の空いた丸で列をそろえる。
// 履歴が浅く起票が欠けていれば、それより前が欠けていることを出す

import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import type { HistoryChange, HistoryEvent, HistoryLog, Status } from "../types.js";
import { StatusDot } from "./parts.js";

/** ISO の時刻を手元の時刻で `2026-11-01 13:48` の形に */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ISO の時刻を手元の日付で `2026-11-01` の形に。読めなければそのまま */
export function formatDay(iso: string): string {
  const t = formatTime(iso);
  return t === iso ? iso : t.slice(0, 10);
}

/** ISO の時刻を手元の時刻で `13:48` の形に。読めなければそのまま */
export function formatClock(iso: string): string {
  const t = formatTime(iso);
  return t === iso ? iso : t.slice(11);
}

/** 時刻の順の出来事を、手元の日付が同じものごとにまとめる（順は変えない） */
export function groupByDay<T extends { at: string }>(events: T[]): { day: string; events: T[] }[] {
  const groups: { day: string; events: T[] }[] = [];
  for (const e of events) {
    const day = formatDay(e.at);
    const last = groups.at(-1);
    if (last && last.day === day) last.events.push(e);
    else groups.push({ day, events: [e] });
  }
  return groups;
}

/** 1 つの変化を短い文に。Status は Workflow の表示名 */
function describeChange(c: HistoryChange, labelOf: (s: string) => string): string {
  switch (c.field) {
    case "status":
      return c.from ? `${labelOf(c.from)} → ${labelOf(c.to ?? "")}` : labelOf(c.to ?? "");
    case "iteration":
    case "epic": {
      const name = c.field === "iteration" ? "Iteration" : "Epic";
      if (!c.from) return `${name} ${c.to} に入れた`;
      if (!c.to) return `${name} ${c.from} から外した`;
      return `${name} ${c.from} → ${c.to}`;
    }
    case "assignee":
      return c.to ? `担当: ${c.to}` : "担当を外した";
    case "pr":
      return c.to ? `PR #${c.to}` : "PR を外した";
  }
}

/** 1 つの出来事を短い文に */
function describeEvent(e: HistoryEvent, labelOf: (s: string) => string): string {
  if (e.type === "deleted") return "消した";
  const changes = e.changes.map((c) => describeChange(c, labelOf));
  return e.type === "created" ? ["起票", ...changes].join(" ・ ") : changes.join(" ・ ");
}

/** チケット詳細の「経過」の節 */
export function TicketTimeline({ id }: { id: string }) {
  const store = useStore();
  const [log, setLog] = useState<HistoryLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 一覧が読み直されたら（書き込みや同期のあと）経過も読み直す
  useEffect(() => {
    let alive = true;
    store.client
      .run<HistoryLog>("history", { ticket: id })
      .then((r) => alive && (setLog(r.data), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id, store.client, store.tickets]);
  const labelOf = (s: string) => store.labelOf(s as Status);
  return (
    <section className="timeline">
      <h2>経過</h2>
      {error ? (
        <p className="error">{error}</p>
      ) : !log ? (
        <p className="muted">読み込み中…</p>
      ) : (
        <>
          {log.incomplete.includes(id) ? (
            <p className="muted">履歴が浅い clone なので、これより前の経過は欠けている</p>
          ) : null}
          {log.events.length === 0 ? (
            <p className="empty">経過はない（まだコミットされていない）</p>
          ) : (
            <ol className="timeline-list">
              {groupByDay(log.events).flatMap((g) => [
                <li key={`day-${g.day}`} className="timeline-day">
                  <time dateTime={g.day}>{g.day}</time>
                </li>,
                ...g.events.map((e) => {
                  const status = e.changes.find((c) => c.field === "status")?.to as
                    | Status
                    | undefined;
                  return (
                    <li key={`${e.commit}-${e.id}`} title={e.subject}>
                      <time dateTime={e.at}>{formatClock(e.at)}</time>
                      {status ? (
                        <StatusDot status={status} />
                      ) : (
                        <span className="status-dot status-dot-empty" aria-hidden="true" />
                      )}
                      <span className="timeline-text">{describeEvent(e, labelOf)}</span>
                      <span className="timeline-author" title={e.author}>
                        {e.author}
                      </span>
                    </li>
                  );
                }),
              ])}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
