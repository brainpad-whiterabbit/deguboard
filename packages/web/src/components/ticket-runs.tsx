// チケット詳細の Run の一覧（UI-4）。run.list をチケットで絞った結果（実行中の Run を含む）を開始の順に出す。
// ブラウザとサイドバーは表、VS Code のパネルは 1 行に step・結果の丸印・model と再試行・開始と所要を出し、開くと残りを出す。
// パネルの見出しには件数・結果の内訳・トークンの合計を出す。
// 取れなかったトークン数（null）は 0 と見せず「—」で出し、合計でも取れなかった Run があれば「+ —」を付ける（RN-2）。
// 結果と数の書き方は run-parts.tsx で Run の画面と共通

import { useEffect, useState } from "react";
import { useHost } from "../host.js";
import { useStore } from "../store.js";
import type { RunView } from "../types.js";
import {
  formatDuration,
  formatTokens,
  NO_VALUE,
  RESULT_KEYS,
  RESULT_LABELS,
  RunResult,
  RunResultDot,
  runResultKey,
  RunsScroll,
} from "./run-parts.js";
import { formatTime } from "./timeline.js";

/** チケット詳細の「Run」の節 */
export function TicketRuns({ id }: { id: string }) {
  const store = useStore();
  const panel = useHost().surface === "panel";
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
      {panel && runs && runs.length > 0 ? (
        <h2>
          Run <RunsSummary runs={runs} />
        </h2>
      ) : (
        <h2>Run</h2>
      )}
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
      ) : panel ? (
        <ul className="ticket-runs">
          {runs.map((r) => (
            <PanelRunRow key={r.id} run={r} />
          ))}
        </ul>
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

type UsageKey = "input" | "output" | "cache_read" | "cache_write";

/** トークン数の合計。取れなかった（null の）Run は足さずに数える */
export function sumTokens(
  runs: RunView[],
  key: UsageKey,
): { sum: number; missing: number; estimated: boolean } {
  let sum = 0;
  let missing = 0;
  let estimated = false;
  for (const r of runs) {
    const v = r.usage[key];
    if (v === null) missing++;
    else sum += v;
    if (r.usage.estimated === true) estimated = true;
  }
  return { sum, missing, estimated };
}

/** 合計の書き方。すべて取れなければ「—」、一部が取れなければ足した値に「+ —」を付ける（0 と見せない、RN-2） */
export function formatTokenSum(runs: RunView[], key: UsageKey): string {
  const { sum, missing, estimated } = sumTokens(runs, key);
  if (missing === runs.length) return NO_VALUE;
  const text = formatTokens(sum, estimated);
  return missing > 0 ? `${text} + ${NO_VALUE}` : text;
}

/** パネルの Run の見出しの合計：件数・結果の内訳・トークン（入力 / 出力） */
function RunsSummary({ runs }: { runs: RunView[] }) {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(runResultKey(r), (counts.get(runResultKey(r)) ?? 0) + 1);
  const breakdown = RESULT_KEYS.filter((k) => counts.has(k))
    .map((k) => `${RESULT_LABELS[k]} ${counts.get(k)}`)
    .join(" · ");
  const missing = Math.max(sumTokens(runs, "input").missing, sumTokens(runs, "output").missing);
  return (
    <small className="ticket-runs-summary">
      <span>{runs.length} 件</span>
      <span>{breakdown}</span>
      <span
        title={`トークン（入力 / 出力）${missing > 0 ? `。値が取れなかった Run が ${missing} 件あり、合計に入れていない` : ""}`}
      >
        {formatTokenSum(runs, "input")} / {formatTokenSum(runs, "output")}
      </span>
    </small>
  );
}

/** パネルの Run の 1 行。開くと agent・トークンの内訳・終了・Run ID を出す */
function PanelRunRow({ run: r }: { run: RunView }) {
  const est = r.usage.estimated === true;
  return (
    <li>
      <details className="ticket-run fold">
        <summary>
          <span className="ticket-run-step">{r.step}</span>
          <RunResultDot run={r} />
          <span className="ticket-run-model">
            {r.model ?? <span className="muted">{NO_VALUE}</span>}
          </span>
          {r.retries > 0 ? (
            <span className="ticket-run-retries muted">再試行 {r.retries}</span>
          ) : null}
          <span className="ticket-run-time muted">
            <time dateTime={r.started_at}>{formatTime(r.started_at)}</time>{" "}
            {formatDuration(r.duration_seconds)}
          </span>
        </summary>
        <dl className="ticket-run-detail">
          <dt>結果</dt>
          <dd>
            <RunResult run={r} />
            {r.error ? <span className="muted"> {r.error}</span> : null}
          </dd>
          <dt>agent</dt>
          <dd>{r.agent}</dd>
          <dt>トークン</dt>
          <dd className="num">
            入力 {formatTokens(r.usage.input, est)} / 出力 {formatTokens(r.usage.output, est)} /
            cache read {formatTokens(r.usage.cache_read, est)} / cache write{" "}
            {formatTokens(r.usage.cache_write, est)}
            {est ? <span className="muted">（推定を含む）</span> : null}
          </dd>
          <dt>終了</dt>
          <dd>
            {r.finished_at ? (
              <time dateTime={r.finished_at}>{formatTime(r.finished_at)}</time>
            ) : (
              <span className="muted">{NO_VALUE}</span>
            )}
          </dd>
          <dt>Run ID</dt>
          <dd>
            <code>{r.id}</code>
          </dd>
        </dl>
      </details>
    </li>
  );
}
