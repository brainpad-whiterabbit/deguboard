// Plan の詳細（UI-13）。plan.show の出力を出すだけで、着手できるか・待ち・次（PL-6）は求め直さない。
// 見出しの下に状態・進み・Iteration・承認（閉じた Plan は閉じた日時）・作業中と次を、その下に依存グラフ（帯と共用の PlanGraphView）と、
// Plan の順のチケットごとの範囲・進め方・tier を出す（details のないチケットは題と状態だけ）。
// 表示だけで書き込まない。承認・組み直し・閉じるは、タイトルの吹き出しからエージェントに頼む（ADR-010・UI-15）。一覧の画面はなく、開いた Plan はカンバンの帯で見る

import { useMemo } from "react";
import { ASK_SECTIONS, AskSpotBox } from "../components/ask-menu.js";
import { DateTime } from "../components/date-time.js";
import { DetailLink, ProgressBar, StatusDot, TicketLink } from "../components/parts.js";
import { PlanGraphView } from "../components/plan-band.js";
import {
  PLAN_STATE_LABELS,
  planColor,
  planProgressLine,
  planRowOf,
  planState,
} from "../components/plan-graph.js";
import { useCommandData } from "../command-data.js";
import { useHost } from "../host.js";
import { hrefOf } from "../router.js";
import { useStore } from "../store.js";
import { actorLabel, type PlanDetail, type Ticket } from "../types.js";

export function PlansPage({ id }: { id: string }) {
  const store = useStore();
  // 一覧のチケットか Plan が読み直されたら Plan も読み直す
  const { data, warnings, error } = useCommandData<PlanDetail>(
    "plan.show",
    { plan: id },
    store.plans,
  );
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  return <PlanDetailView detail={data} warnings={warnings} />;
}

function PlanDetailView({ detail, warnings }: { detail: PlanDetail; warnings: string[] }) {
  const host = useHost();
  const store = useStore();
  const row = useMemo(() => planRowOf(detail), [detail]);
  const byId = useMemo(
    () => new Map<string, Ticket>(detail.items.map((t) => [t.id, t])),
    [detail.items],
  );
  const state = planState(row);
  const { working, next } = planProgressLine(row, state, byId);
  // 日時は Webview では手元時刻で短く、ブラウザでは ISO のまま（チケット詳細の作成日時と同じ）
  const local = host.surface !== "browser";
  // Plan は Iteration を持たないので、チケットの Iteration を Plan の順で重ねずに並べる
  const iterations = [...new Set(detail.items.flatMap((t) => (t.iteration ? [t.iteration] : [])))];
  const details: Record<string, PlanDetail["details"][`t${number}`] | undefined> = detail.details;
  return (
    <section className="plan-page">
      {/* パネルは詳細だけを出すので、戻る先の一覧がない（一覧はサイドバー。UI-12） */}
      {host.surface === "panel" ? null : (
        <div className="toolbar">
          <a href={hrefOf({ page: "board" })}>← カンバン</a>
        </div>
      )}
      {/* タイトルの横の吹き出しで、この Plan をエージェントに頼む（承認・組み直し・閉じる。UI-15） */}
      <AskSpotBox
        as="h1"
        className={`ask-title plan-title plan-color-${planColor(detail.id)}`}
        targets={[detail.id]}
        label={`タイトル ${detail.id}`}
        section={ASK_SECTIONS.detailTitle}
        pinned
      >
        {/* 見出しの左に帯と同じ色の線を付ける */}
        <code>{detail.id}</code> 実行計画{" "}
        <span className={`badge plan-state-${state}`}>{PLAN_STATE_LABELS[state]}</span>
      </AskSpotBox>
      <dl className="iteration-summary plan-summary">
        <dt>進み</dt>
        <dd>
          <ProgressBar progress={detail.progress} />
        </dd>
        {iterations.length > 0 ? (
          <>
            <dt>Iteration</dt>
            <dd className="plan-summary-links">
              {iterations.map((it) => (
                <DetailLink key={it} route={{ page: "iterations", id: it }}>
                  <code>{it}</code>
                  {nameOf(store.iterations, it)}
                </DetailLink>
              ))}
            </dd>
          </>
        ) : null}
        <dt>承認</dt>
        <dd>
          {detail.approved_by ? (
            <>
              <span title={detail.approved_by}>{actorLabel(detail.approved_by)}</span>
              {detail.approved_at ? (
                <>
                  {" "}
                  <DateTime iso={detail.approved_at} local={local} />
                </>
              ) : null}
            </>
          ) : (
            <span className="muted">
              {detail.pending_approval ? "人の承認を待っている" : "承認の記録はない"}
            </span>
          )}
        </dd>
        {detail.closed_at ? (
          <>
            <dt>閉じた</dt>
            <dd>
              <DateTime iso={detail.closed_at} local={local} />
            </dd>
          </>
        ) : null}
        {working.length > 0 ? (
          <>
            <dt>作業中</dt>
            <dd className="plan-summary-links">
              {working.map((t) => (
                <TicketLink key={t} id={t} title={byId.get(t)?.title} />
              ))}
            </dd>
          </>
        ) : null}
        {next && next.kind !== "approval" ? (
          <>
            <dt>次</dt>
            <dd className="plan-summary-links">
              <TicketLink id={next.id} title={byId.get(next.id)?.title} />
              {next.kind === "blocked" ? (
                <span className="muted">{next.waitFor.join(", ")} 待ち</span>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      {warnings.length > 0 ? (
        <ul className="plan-warnings muted">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      <h2>依存グラフ</h2>
      <PlanGraphView plan={row} byId={byId} />
      <h2>チケット</h2>
      <ol className="plan-tickets">
        {detail.items.map((t) => {
          const d = details[t.id];
          return (
            <li key={t.id} className={`plan-ticket status-${t.status}`}>
              <div className="plan-ticket-head">
                <StatusDot status={t.status} />
                <TicketLink id={t.id} />
                <span className="plan-ticket-title">{t.title}</span>
                <span className="muted">{store.labelOf(t.status)}</span>
                {d?.tier ? <span className="badge plan-tier">{d.tier}</span> : null}
              </div>
              {d?.scope || d?.approach ? (
                <dl className="plan-ticket-details">
                  {d.scope ? (
                    <>
                      <dt>範囲</dt>
                      <dd>{d.scope}</dd>
                    </>
                  ) : null}
                  {d.approach ? (
                    <>
                      <dt>進め方</dt>
                      <dd>{d.approach}</dd>
                    </>
                  ) : null}
                </dl>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Iteration の名前（一覧にあれば「 名前」、なければ空） */
function nameOf(iterations: readonly { id: string; name: string }[], id: string): string {
  const name = iterations.find((i) => i.id === id)?.name;
  return name ? ` ${name}` : "";
}
