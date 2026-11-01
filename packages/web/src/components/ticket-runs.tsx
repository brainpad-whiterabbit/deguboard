// チケット詳細の Run の一覧（UI-4）。run.list をチケットで絞った結果（実行中の Run を含む）を開始の順に出す。
// 取れなかったトークン数（null）は 0 と見せず「—」で出す（RN-2）。結果と数の書き方は run-parts.tsx で Run の画面と共通

import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import type { RunView } from "../types.js";
import { formatTokens, NO_VALUE, RunResult, RunsScroll } from "./run-parts.js";
import { formatTime } from "./timeline.js";

/** チケット詳細の「Run」の節 */
export function TicketRuns({ id }: { id: string }) {
  const store = useStore();
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 一覧が読み直されたら（書き込みや同期のあと）Run も読み直す
  useEffect(() => {
    let alive = true;
    store.client
      .run<RunView[]>("run.list", { ticket: id })
      .then((r) => alive && (setRuns(r.data), setWarnings(r.warnings), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id, store.client, store.tickets]);
  return (
    <section className="runs">
      <h2>Run</h2>
      {warnings.map((w) => (
        <p key={w} className="muted">
          {w}
        </p>
      ))}
      {error ? (
        <p className="error">{error}</p>
      ) : !runs ? (
        <p className="muted">読み込み中…</p>
      ) : runs.length === 0 ? (
        <p className="empty">Run はない</p>
      ) : (
        <RunsScroll>
          <table className="list runs-list">
            <thead>
              <tr>
                <th>step</th>
                <th>agent</th>
                <th>model</th>
                <th>結果</th>
                <th title="入力 / 出力">トークン</th>
                <th>開始</th>
                <th>終了</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const est = r.usage.estimated === true;
                return (
                  <tr key={r.id} title={r.id}>
                    <td>{r.step}</td>
                    <td>{r.agent}</td>
                    <td>{r.model ?? <span className="muted">{NO_VALUE}</span>}</td>
                    <td>
                      <RunResult run={r} />
                      {r.retries > 0 ? <span className="muted"> 再試行 {r.retries}</span> : null}
                    </td>
                    <td
                      className="num"
                      title={`cache read ${formatTokens(r.usage.cache_read, est)} / cache write ${formatTokens(r.usage.cache_write, est)}${est ? "（推定を含む）" : ""}`}
                    >
                      {formatTokens(r.usage.input, est)} / {formatTokens(r.usage.output, est)}
                    </td>
                    <td>
                      <time dateTime={r.started_at}>{formatTime(r.started_at)}</time>
                    </td>
                    <td>
                      {r.finished_at ? (
                        <time dateTime={r.finished_at}>{formatTime(r.finished_at)}</time>
                      ) : (
                        <span className="muted">{NO_VALUE}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </RunsScroll>
      )}
    </section>
  );
}
