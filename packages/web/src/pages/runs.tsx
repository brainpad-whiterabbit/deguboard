// Run の実行状況と実績（UI-9）。run.list で実行中と完了した Run を、metrics.show で集計（MT-3）を出す。
// 集計の単位はハッシュの ?by= に持ち（既定はチケット）、選んだ Project のチケットの Run だけを出す。
// 取れなかった値は 0 と見せず「値なし」と出し、欠けた Run の数（missing）と推定を含む Run の数（estimated_runs）も出す。
// サイドバーでは Run を 1 行ずつの行で出し、集計の表は横にスクロールさせる

import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { TicketLink } from "../components/parts.js";
import { formatTime } from "../components/timeline.js";
import { useHost } from "../host.js";
import { DEFAULT_UNIT, hrefOf, navigate, type Route } from "../router.js";
import { useStore } from "../store.js";
import {
  METRIC_UNITS,
  UNIT_LABELS,
  type MetricGroup,
  type MetricUnit,
  type MetricsView,
  type RunMetrics,
  type RunView,
  type Ticket,
} from "../types.js";

type ResultKey = keyof RunMetrics["results"];
type ValueKey = keyof RunMetrics["missing"];

export const RESULT_LABELS: Record<ResultKey, string> = {
  success: "成功",
  failure: "失敗",
  interrupted: "中断",
  unfinished: "未完了",
};

const VALUE_LABELS: Record<ValueKey, string> = {
  duration_seconds: "時間",
  input: "入力",
  output: "出力",
  cache_read: "キャッシュ読み",
  cache_write: "キャッシュ書き",
};
const VALUE_KEYS = Object.keys(VALUE_LABELS) as ValueKey[];

/** 秒を `1時間 2分`・`3分 4秒`・`12秒` の形に。null は「値なし」 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "値なし";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}時間 ${m}分`;
  if (m > 0) return `${m}分 ${s % 60}秒`;
  return `${s}秒`;
}

/** トークン数を 3 桁区切りに。null は「値なし」（0 と見せない） */
export function formatCount(n: number | null): string {
  return n === null ? "値なし" : n.toLocaleString("en-US");
}

export function formatValue(key: ValueKey, v: number | null): string {
  return key === "duration_seconds" ? formatDuration(v) : formatCount(v);
}

/** 1 つの Run の実行時間（秒）。終わっていないか日時が前後していれば null */
export function runSeconds(run: RunView): number | null {
  if (!run.finished_at) return null;
  const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

/** 選んだ Project のチケットの Run を、実行中（開始の古い順）と完了（開始の新しい順）に分ける */
export function splitRuns(
  runs: readonly RunView[],
  tickets: readonly Ticket[],
): { running: RunView[]; finished: RunView[] } {
  const ids = new Set(tickets.map((t) => t.id));
  const mine = runs.filter((r) => ids.has(r.ticket));
  return {
    running: mine.filter((r) => r.running).sort((a, b) => a.id.localeCompare(b.id)),
    finished: mine.filter((r) => !r.running).sort((a, b) => b.id.localeCompare(a.id)),
  };
}

export function RunsPage({ by = DEFAULT_UNIT }: { by?: MetricUnit | undefined }) {
  const store = useStore();
  const host = useHost();
  const sidebar = host.surface === "sidebar";
  const project = store.project?.id;
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [metrics, setMetrics] = useState<MetricsView | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // チケットの読み直し（同期・書き込み・拡張ホストの再読み込み）と「読み直す」のたびに取り直す
  useEffect(() => {
    if (!project) return;
    let alive = true;
    Promise.all([
      store.client.run<RunView[]>("run.list", {}),
      store.client.run<MetricsView>("metrics.show", { project, by }),
    ])
      .then(([list, report]) => {
        if (!alive) return;
        setRuns(list.data);
        setMetrics(report.data);
        setWarnings([...list.warnings, ...report.warnings]);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [store.client, store.tickets, project, by, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  const { running, finished } = useMemo(
    () => splitRuns(runs ?? [], store.tickets),
    [runs, store.tickets],
  );

  return (
    <section className="runs">
      <div className="toolbar">
        <h1>Run</h1>
        <button type="button" onClick={reload}>
          読み直す
        </button>
        <span className="muted">
          実行中 {running.length} ・ 完了 {finished.length}
        </span>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {warnings.length > 0 ? <p className="muted">{warnings.join(" / ")}</p> : null}
      {runs === null && !error ? (
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
          {metrics ? <MetricsTables metrics={metrics} by={by} /> : null}

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

/** 詳細へのリンク。Webview では拡張ホストに頼んでエディタ領域に開く */
function DetailLink({ route, children }: { route: Route; children: ReactNode }) {
  const host = useHost();
  return (
    <a
      href={hrefOf(route)}
      onClick={(e: MouseEvent) => {
        e.preventDefault();
        host.open(route);
      }}
    >
      {children}
    </a>
  );
}

function ResultBadge({ run }: { run: RunView }) {
  const key: ResultKey = run.result ?? "unfinished";
  return (
    <span className={`badge result-${key}`} title={run.error ?? undefined}>
      {run.running ? "実行中" : RESULT_LABELS[key]}
    </span>
  );
}

/** Run の一覧。完了した Run には結果・時間・使用量を出す。サイドバーでは 1 行ずつ */
function RunTable({ runs, sidebar }: { runs: readonly RunView[]; sidebar: boolean }) {
  const store = useStore();
  const titleOf = (id: string) => store.tickets.find((t) => t.id === id)?.title;
  if (sidebar) {
    return (
      <ul className="rows run-rows">
        {runs.map((r) => (
          <li key={r.id} title={`${r.id} ・ ${r.agent}${r.model ? ` / ${r.model}` : ""}`}>
            <ResultBadge run={r} />
            <TicketLink id={r.ticket} />
            <span className="row-title">{r.step}</span>
            <small className="muted">
              {r.running ? formatTime(r.started_at) : formatDuration(runSeconds(r))}
            </small>
          </li>
        ))}
      </ul>
    );
  }
  const done = runs.some((r) => !r.running);
  return (
    <div className="table-scroll">
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
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <code>{r.id}</code>
              </td>
              <td>
                <TicketLink id={r.ticket} title={titleOf(r.ticket)} />
              </td>
              <td>{r.step}</td>
              <td>{r.agent}</td>
              <td>{r.model ?? <span className="muted">なし</span>}</td>
              <td>
                <ResultBadge run={r} />
                {r.retries > 0 ? <small className="muted"> リトライ {r.retries}</small> : null}
              </td>
              <td className="nowrap">{formatTime(r.started_at)}</td>
              {done ? (
                <>
                  <Num text={formatDuration(runSeconds(r))} />
                  <Num text={formatCount(r.usage.input)} estimated={r.usage.estimated} />
                  <Num text={formatCount(r.usage.output)} estimated={r.usage.estimated} />
                </>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Num({ text, estimated }: { text: string; estimated?: boolean | undefined }) {
  return (
    <td className={text === "値なし" ? "num muted" : "num"}>
      {text}
      {estimated && text !== "値なし" ? <small title="推定を含む"> (推定)</small> : null}
    </td>
  );
}

/** 集計の合計と単位ごとの表 */
function MetricsTables({ metrics, by }: { metrics: MetricsView; by: MetricUnit }) {
  const t = metrics.total;
  if (t.runs === 0) return <p className="empty">集計する Run はない</p>;
  return (
    <>
      <dl className="metric-cards">
        <div className="wide">
          <dt>結果</dt>
          <dd className="results">{resultsText(t)}</dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd>{t.runs}</dd>
          <small className="muted">リトライ {t.retries}</small>
        </div>
        {VALUE_KEYS.map((k) => (
          <div key={k}>
            <dt>{VALUE_LABELS[k]}</dt>
            <dd className={t[k] === null ? "muted" : undefined}>{formatValue(k, t[k])}</dd>
            {t.missing[k] > 0 ? (
              <small className="muted" title="値が取れず、合計に入れなかった Run の数">
                欠け {t.missing[k]}
              </small>
            ) : null}
          </div>
        ))}
      </dl>
      {t.estimated_runs > 0 ? (
        <p className="muted">推定の値を含む Run が {t.estimated_runs} 件ある（合計も推定を含む）</p>
      ) : null}
      <div className="table-scroll">
        <table className="list metrics-table">
          <thead>
            <tr>
              <th>{UNIT_LABELS[by]}</th>
              <th className="num">Run</th>
              <th>結果</th>
              <th className="num">リトライ</th>
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
                <td>
                  <GroupKey unit={by} group={g} />
                </td>
                <td className="num">{g.runs}</td>
                <td className="nowrap">{resultsText(g)}</td>
                <td className="num">{g.retries}</td>
                {VALUE_KEYS.map((k) => (
                  <td key={k} className={g[k] === null ? "num muted" : "num"}>
                    {formatValue(k, g[k])}
                    {g.missing[k] > 0 ? (
                      <small className="muted" title="値が取れず、合計に入れなかった Run の数">
                        {" "}
                        (欠け {g.missing[k]})
                      </small>
                    ) : null}
                  </td>
                ))}
                <td className="num">{g.estimated_runs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** 結果の内訳。0 件のものは省く */
export function resultsText(m: RunMetrics): string {
  return (
    (Object.keys(RESULT_LABELS) as ResultKey[])
      .filter((k) => m.results[k] > 0)
      .map((k) => `${RESULT_LABELS[k]} ${m.results[k]}`)
      .join(" ・ ") || "なし"
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
