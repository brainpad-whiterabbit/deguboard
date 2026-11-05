// チケット詳細の Run の一覧（UI-4）。run.list をチケットで絞った結果（実行中の Run を含む）を開始の順に出す。
// VS Code のパネル以外は表、パネルは 1 行に step・結果の丸印・model と再試行・開始と所要を出し、開くと残りを出す。
// パネルの見出しには件数・結果の内訳・トークンの合計を出す。
// 取れなかったトークン数（null）は 0 と見せず「—」で出し、合計でも取れなかった Run があれば「+ —」を付ける（RN-2）。
// 結果と数の書き方は run-parts.tsx で Run の画面と共通

import { useCommandData } from "../command-data.js";
import { useHost } from "../host.js";
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
import { tr } from "../l10n.js";
import { trNode } from "../l10n-node.js";

/** チケット詳細の「Run」の節 */
export function TicketRuns({ id }: { id: string }) {
  const panel = useHost().surface === "panel";
  // 一覧が読み直されたら（書き込みや同期のあと）Run も読み直す
  const { data: runs, warnings, error } = useCommandData<RunView[]>("run.list", { ticket: id });
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
        <p className="muted">{tr("読み込み中…")}</p>
      ) : runs.length === 0 ? (
        <p className="empty">{tr("Run はない")}</p>
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
                <th>{tr("結果")}</th>
                <th title={tr("入力 / 出力")}>{tr("トークン")}</th>
                <th>{tr("開始")}</th>
                <th>{tr("終了")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const u = usageTexts(r);
                return (
                  <tr key={r.id} title={r.id}>
                    <td>{r.step}</td>
                    <td>{r.agent}</td>
                    <td>{r.model ?? <span className="muted">{NO_VALUE}</span>}</td>
                    <td>
                      <RunResult run={r} />
                      {r.retries > 0 ? (
                        <span className="muted">{trNode(" 再試行 {0}", r.retries)}</span>
                      ) : null}
                    </td>
                    <td
                      className="num"
                      title={`cache read ${u.cache_read} / cache write ${u.cache_write}${u.estimated ? tr("（推定を含む）") : ""}`}
                    >
                      {u.input} / {u.output}
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

/** 1 件の Run のトークン数の書き方（表と PanelRunRow で共通）。推定を含めば「~」を前に付ける */
function usageTexts(r: RunView): Record<UsageKey, string> & { estimated: boolean } {
  const estimated = r.usage.estimated === true;
  return {
    input: formatTokens(r.usage.input, estimated),
    output: formatTokens(r.usage.output, estimated),
    cache_read: formatTokens(r.usage.cache_read, estimated),
    cache_write: formatTokens(r.usage.cache_write, estimated),
    estimated,
  };
}

/** トークン数の合計。取れなかった（null の）Run は足さずに数える */
function sumTokens(
  runs: RunView[],
  key: UsageKey,
): { sum: number; missing: number; estimated: boolean } {
  let sum = 0;
  let missing = 0;
  let estimated = false;
  for (const r of runs) {
    const v = r.usage[key];
    if (v === null) missing++;
    else {
      sum += v;
      // 合計に入れた値だけで推定を判断する
      if (r.usage.estimated === true) estimated = true;
    }
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
    .map((k) => `${tr(RESULT_LABELS[k])} ${counts.get(k)}`)
    .join(" · ");
  const missing = Math.max(sumTokens(runs, "input").missing, sumTokens(runs, "output").missing);
  return (
    <small className="ticket-runs-summary">
      <span>{trNode("{0} 件", runs.length)}</span>
      <span>{breakdown}</span>
      <span
        title={tr(
          "トークン（入力 / 出力）{0}",
          missing > 0
            ? tr("。値が取れなかった Run が {0} 件あり、合計に入れていない", missing)
            : "",
        )}
      >
        {formatTokenSum(runs, "input")} / {formatTokenSum(runs, "output")}
      </span>
    </small>
  );
}

/** パネルの Run の 1 行。開くと agent・トークンの内訳・終了・Run ID を出す */
function PanelRunRow({ run: r }: { run: RunView }) {
  const u = usageTexts(r);
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
            <span className="ticket-run-retries muted">{trNode("再試行 {0}", r.retries)}</span>
          ) : null}
          <span className="ticket-run-time muted">
            <time dateTime={r.started_at}>{formatTime(r.started_at)}</time>{" "}
            {formatDuration(r.duration_seconds)}
          </span>
        </summary>
        <dl className="ticket-run-detail">
          <dt>{tr("結果")}</dt>
          <dd>
            <RunResult run={r} />
            {r.error ? <span className="muted"> {r.error}</span> : null}
          </dd>
          <dt>agent</dt>
          <dd>{r.agent}</dd>
          <dt>{tr("トークン")}</dt>
          <dd className="num">
            {trNode(
              "入力 {0} / 出力 {1} / cache read {2} / cache write{3}{4}{5}",
              u.input,
              u.output,
              u.cache_read,
              " ",
              u.cache_write,
              u.estimated ? <span className="muted">{tr("（推定を含む）")}</span> : null,
            )}
          </dd>
          <dt>{tr("終了")}</dt>
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
