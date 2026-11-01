// Run の実行状況と実績（UI-9）。run.list で実行中と完了した Run を、metrics.show で集計（MT-3）を出す。
// 集計の単位はハッシュの ?by= に持ち（既定はチケット）、run.list・metrics.show とも選んだ Project で絞って取る。
// 取れなかった値は 0 と見せず「—」と出し、欠けた Run の数（missing）と推定を含む Run の数（estimated_runs）も出す。
// 結果・数の書き方はチケット詳細の Run の節と共通（components/run-parts.tsx）。
// サイドバーでは Run を 1 行ずつの行で出し、集計の表は横にスクロールさせる

import { useCallback, useEffect, useMemo, useState } from "react";
import { DetailLink, TicketLink } from "../components/parts.js";
import {
  formatDuration,
  formatTokens,
  NO_VALUE,
  RESULT_LABELS,
  RunResult,
  RunsScroll,
} from "../components/run-parts.js";
import { formatTime } from "../components/timeline.js";
import { useHost } from "../host.js";
import { DEFAULT_UNIT, navigate } from "../router.js";
import { useStore } from "../store.js";
import {
  METRIC_UNITS,
  UNIT_LABELS,
  type MetricGroup,
  type MetricUnit,
  type MetricsView,
  type RunMetrics,
  type RunView,
} from "../types.js";

type ResultKey = keyof RunMetrics["results"];
type ValueKey = keyof RunMetrics["missing"];

const VALUE_LABELS: Record<ValueKey, string> = {
  duration_seconds: "時間",
  input: "入力",
  output: "出力",
  cache_read: "キャッシュ読み",
  cache_write: "キャッシュ書き",
};
const VALUE_KEYS = Object.keys(VALUE_LABELS) as ValueKey[];
/** 結果の内訳の順。satisfies で core の RunMetrics["results"] の全件と照らす */
const RESULT_KEYS = Object.keys({
  success: true,
  failure: true,
  interrupted: true,
  unfinished: true,
} satisfies Record<ResultKey, true>) as ResultKey[];

/** 集計の値。null は「—」、推定を含む Run があれば「~」を付ける */
export function formatValue(key: ValueKey, v: number | null, estimated = false): string {
  return key === "duration_seconds" ? formatDuration(v, estimated) : formatTokens(v, estimated);
}

/** 結果の内訳。0 件のものは省き、すべて 0 なら「—」 */
export function resultsText(m: RunMetrics): string {
  return (
    RESULT_KEYS.filter((k) => m.results[k] > 0)
      .map((k) => `${RESULT_LABELS[k]} ${m.results[k]}`)
      .join(" ・ ") || NO_VALUE
  );
}

/** Run を実行中（開始の古い順）と完了（開始の新しい順）に分ける */
export function splitRuns(runs: readonly RunView[]): { running: RunView[]; finished: RunView[] } {
  return {
    running: runs.filter((r) => r.running).sort((a, b) => a.id.localeCompare(b.id)),
    finished: runs.filter((r) => !r.running).sort((a, b) => b.id.localeCompare(a.id)),
  };
}

export function RunsPage({ by = DEFAULT_UNIT }: { by?: MetricUnit | undefined }) {
  const store = useStore();
  const project = store.project?.id;
  // Project がなければ集計できない（読み込み中のまま止めない）
  if (!project) return <p className="empty">Project がない</p>;
  return <RunsView project={project} by={by} />;
}

function RunsView({ project, by }: { project: string; by: MetricUnit }) {
  const store = useStore();
  const host = useHost();
  const sidebar = host.surface === "sidebar";
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [metrics, setMetrics] = useState<MetricsView | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // チケットの読み直し（同期・書き込み・拡張ホストの再読み込み）と「読み直す」のたびに取り直す。
  // 取り直す間は前の集計とエラーを出さない（単位を変えたときに見出しと中身が食い違わないように）
  useEffect(() => {
    let alive = true;
    setError(null);
    setMetrics(null);
    Promise.all([
      store.client.run<RunView[]>("run.list", { project }),
      store.client.run<MetricsView>("metrics.show", { project, by }),
    ])
      .then(([list, report]) => {
        if (!alive) return;
        setRuns(list.data);
        setMetrics(report.data);
        setWarnings([...list.warnings, ...report.warnings]);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [store.client, store.tickets, project, by, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  const { running, finished } = useMemo(() => splitRuns(runs ?? []), [runs]);

  return (
    <section className="runs-page">
      <div className="toolbar">
        <h1>Run</h1>
        <button type="button" onClick={reload}>
          読み直す
        </button>
        {runs && !error ? (
          <span className="muted">
            実行中 {running.length} ・ 完了 {finished.length}
          </span>
        ) : null}
      </div>
      {warnings.length > 0 && !error ? <p className="muted">{warnings.join(" / ")}</p> : null}
      {error ? (
        // 取れなかったときは一覧を出さない（「Run はない」と事実と違うことを言わない）
        <p className="error">{error}</p>
      ) : runs === null ? (
        <p className="muted">読み込み中…</p>
      ) : (
        <>
          <h2>実行中</h2>
          {running.length === 0 ? (
            <p className="empty">実行中の Run はない</p>
          ) : (
            <RunTable runs={running} sidebar={sidebar} />
          )}

          <div className="toolbar runs-metrics-head">
            <h2>実績</h2>
            <label>
              単位
              <select
                value={by}
                onChange={(e) => navigate({ page: "runs", by: e.target.value as MetricUnit })}
              >
                {METRIC_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABELS[u]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {metrics ? <MetricsTables metrics={metrics} /> : <p className="muted">読み込み中…</p>}

          <h2>完了した Run</h2>
          {finished.length === 0 ? (
            <p className="empty">完了した Run はない</p>
          ) : (
            <RunTable runs={finished} sidebar={sidebar} />
          )}
        </>
      )}
    </section>
  );
}

/** Run の一覧。完了した Run には時間と使用量を出す。サイドバーでは 1 行ずつ */
function RunTable({ runs, sidebar }: { runs: readonly RunView[]; sidebar: boolean }) {
  const store = useStore();
  const titleOf = (id: string) => store.tickets.find((t) => t.id === id)?.title;
  if (sidebar) {
    return (
      <ul className="rows run-rows">
        {runs.map((r) => (
          <li key={r.id} title={`${r.id} ・ ${r.agent}${r.model ? ` / ${r.model}` : ""}`}>
            <RunResult run={r} />
            <TicketLink id={r.ticket} />
            <span className="row-title">{r.step}</span>
            <small className="muted">
              {r.running ? formatTime(r.started_at) : formatDuration(r.duration_seconds)}
            </small>
          </li>
        ))}
      </ul>
    );
  }
  const done = runs.some((r) => !r.running);
  return (
    <RunsScroll>
      <table className="list runs-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>チケット</th>
            <th>工程</th>
            <th>Agent</th>
            <th>Model</th>
            <th>結果</th>
            <th>開始</th>
            {done ? (
              <>
                <th className="num">時間</th>
                <th className="num">入力</th>
                <th className="num">出力</th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const est = r.usage.estimated === true;
            return (
              <tr key={r.id}>
                <td>
                  <code>{r.id}</code>
                </td>
                <td>
                  <TicketLink id={r.ticket} title={titleOf(r.ticket)} />
                </td>
                <td>{r.step}</td>
                <td>{r.agent}</td>
                <td>{r.model ?? <span className="muted">{NO_VALUE}</span>}</td>
                <td className="nowrap">
                  <RunResult run={r} />
                  {r.retries > 0 ? <small className="muted"> 再試行 {r.retries}</small> : null}
                </td>
                <td className="nowrap">{formatTime(r.started_at)}</td>
                {done ? (
                  <>
                    <Num value={r.duration_seconds} text={formatDuration(r.duration_seconds)} />
                    <Num value={r.usage.input} text={formatTokens(r.usage.input, est)} />
                    <Num value={r.usage.output} text={formatTokens(r.usage.output, est)} />
                  </>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </RunsScroll>
  );
}

function Num({ value, text }: { value: number | null; text: string }) {
  return <td className={value === null ? "num muted" : "num"}>{text}</td>;
}

/** 欠けた Run の数の注記 */
function Missing({ count, inline = false }: { count: number; inline?: boolean }) {
  if (count === 0) return null;
  return (
    <small className="muted" title="値が取れず、合計に入れなかった Run の数">
      {inline ? ` (欠け ${count})` : `欠け ${count}`}
    </small>
  );
}

/** 集計の合計と単位ごとの表。見出しとキーは取得した集計の単位（metrics.by）で決める */
function MetricsTables({ metrics }: { metrics: MetricsView }) {
  const t = metrics.total;
  const by = metrics.by ?? DEFAULT_UNIT;
  if (t.runs === 0) return <p className="empty">集計する Run はない</p>;
  const est = t.estimated_runs > 0;
  return (
    <>
      <dl className="metric-cards">
        <div className="wide">
          <dt>結果</dt>
          <dd className="results">{resultsText(t)}</dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd>{formatTokens(t.runs)}</dd>
          <small className="muted">再試行 {formatTokens(t.retries)}</small>
        </div>
        {VALUE_KEYS.map((k) => (
          <div key={k}>
            <dt>{VALUE_LABELS[k]}</dt>
            <dd className={t[k] === null ? "muted" : undefined}>{formatValue(k, t[k], est)}</dd>
            <Missing count={t.missing[k]} />
          </div>
        ))}
      </dl>
      {est ? (
        <p className="muted">
          推定の値を含む Run が {t.estimated_runs} 件ある（「~」を付けた値は推定を含む）
        </p>
      ) : null}
      <RunsScroll>
        <table className="list metrics-table">
          <thead>
            <tr>
              <th>{UNIT_LABELS[by]}</th>
              <th className="num">Run</th>
              <th>結果</th>
              <th className="num">再試行</th>
              {VALUE_KEYS.map((k) => (
                <th key={k} className="num">
                  {VALUE_LABELS[k]}
                </th>
              ))}
              <th className="num">推定</th>
            </tr>
          </thead>
          <tbody>
            {metrics.groups.map((g) => (
              <tr key={g.key ?? ""}>
                <td className="nowrap">
                  <GroupKey unit={by} group={g} />
                </td>
                <td className="num">{formatTokens(g.runs)}</td>
                <td className="nowrap">{resultsText(g)}</td>
                <td className="num">{formatTokens(g.retries)}</td>
                {VALUE_KEYS.map((k) => (
                  <td key={k} className={g[k] === null ? "num muted" : "num"}>
                    {formatValue(k, g[k], g.estimated_runs > 0)}
                    <Missing count={g.missing[k]} inline />
                  </td>
                ))}
                <td className="num">{formatTokens(g.estimated_runs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </RunsScroll>
    </>
  );
}

/** 単位の値。チケット・Epic・Iteration は詳細へのリンク、null は「なし」 */
function GroupKey({ unit, group }: { unit: MetricUnit; group: MetricGroup }) {
  const store = useStore();
  const host = useHost();
  const key = group.key;
  if (key === null) return <span className="muted">なし</span>;
  switch (unit) {
    case "ticket":
      // サイドバーでは幅を取らないよう番号だけ
      return (
        <TicketLink
          id={key}
          title={
            host.surface === "sidebar" ? undefined : store.tickets.find((t) => t.id === key)?.title
          }
        />
      );
    case "epic":
      return <DetailLink route={{ page: "epics", id: key }}>{key}</DetailLink>;
    case "iteration":
      return <DetailLink route={{ page: "iterations", id: key }}>{key}</DetailLink>;
    case "run":
      return <code>{key}</code>;
    default:
      return <>{key}</>;
  }
}
