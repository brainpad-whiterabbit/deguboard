// チケット詳細の Run の一覧（UI-4）。run.list をチケットで絞った結果（実行中の Run を含む）を開始の順に出す。
// 取れなかったトークン数（null）は 0 と見せず「—」で出す（RN-2）

import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import type { RunView } from "../types.js";
import { formatTime } from "./timeline.js";

/** 結果の表示名。実行中の Run は result が null */
export function runResultLabel(run: RunView): string {
  if (run.running || run.result === null) return "実行中";
  return { success: "成功", failure: "失敗", interrupted: "中断" }[run.result];
}

/** トークン数。null は「—」、推定を含めば「~」を前に付ける */
export function formatTokens(value: number | null, estimated = false): string {
  if (value === null) return "—";
  return `${estimated ? "~" : ""}${value.toLocaleString("en-US")}`;
}

/** チケット詳細の「Run」の節 */
export function TicketRuns({ id }: { id: string }) {
  const store = useStore();
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 一覧が読み直されたら（書き込みや同期のあと）Run も読み直す
  useEffect(() => {
    let alive = true;
    store.client
      .run<RunView[]>("run.list", { ticket: id })
      .then((r) => alive && (setRuns(r.data), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id, store.client, store.tickets]);
  return (
    <section className="runs">
      <h2>Run</h2>
      {error ? (
        <p className="error">{error}</p>
      ) : !runs ? (
        <p className="muted">読み込み中…</p>
      ) : runs.length === 0 ? (
        <p className="empty">Run はない</p>
      ) : (
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
                  <td>{r.model ?? <span className="muted">—</span>}</td>
                  <td>
                    <span
                      className={`run-result run-${r.running || r.result === null ? "running" : r.result}`}
                      title={r.error ?? undefined}
                    >
                      {runResultLabel(r)}
                    </span>
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
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
