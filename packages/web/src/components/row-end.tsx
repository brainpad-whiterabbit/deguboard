// 左パネルのカンバン（board.tsx）とバックログ（backlog.tsx）の行の右端の部品と、その判定。
// 開いた Plan に入っているチケットの Plan の番号と待ち（kanbanPlanMarks）、todo の行の着手可・待ち・承認待ち（kanbanReadiness）を、
// カンバンの行（KanbanRowEnd）とバックログの行（BacklogRowEnd）で同じ判定と同じ部品で出す。
// カンバンの行は、下の段にチケットの Run を 1 回 1 つの丸で並べる（RunPips。run.recent の要約を読むだけで、dg は呼ばない）

import { useEffect, useState, type ReactNode } from "react";
import { AssigneeMark } from "./assignee-mark.js";
import { RowPriority } from "./parts.js";
import { openPlanByTicket, planColor, waitsOf } from "./plan-graph.js";
import { formatDuration, RESULT_LABELS, runResultKey, type RunResultKey } from "./run-parts.js";
import { formatTime } from "./timeline.js";
import {
  isOwnAssignee,
  type PlanRow,
  type RunSummary,
  type Ticket,
  type TicketRow,
  type TicketRunsView,
  type WhoamiView,
  type WorkflowDefinition,
  isFinished,
} from "../types.js";
import { msg, tr } from "../l10n.js";

/** 左パネルのカンバンとバックログの行に出す、チケットが入っている開いた Plan と、残っている待ちの相手 */
export interface PlanMark {
  plan: string;
  /** Plan が承認待ち（plan.status が pending）。todo の行は待ちの相手によらず「承認待ち」と出す */
  pending: boolean;
  /** 残っている待ちの相手（core の plan.list の waiting。Plan の after の待ちが先、depends_on が後）。空なら着手できる */
  waitingOn: string[];
}

/** 開いた Plan に入っているチケットごとの PlanMark。待ちの相手は core が求めた値を読むだけ（PL-6） */
export function kanbanPlanMarks(
  plans: readonly PlanRow[],
  planOf: ReadonlyMap<string, string> = openPlanByTicket(plans),
): Map<string, PlanMark> {
  const marks = new Map<string, PlanMark>();
  for (const plan of plans) {
    if (plan.status === "closed") continue;
    for (const id of Object.keys(plan.waiting)) {
      if (planOf.get(id) !== plan.id) continue;
      marks.set(id, {
        plan: plan.id,
        pending: plan.status === "pending",
        waitingOn: waitsOf(plan, id),
      });
    }
  }
  return marks;
}

/** 待ちの相手の短い書き方：1 件なら「t137 待ち」、2 件以上なら先頭と残りの件数で「t137+1 待ち」、なければ空文字 */
export function waitLabel(waitingOn: readonly string[]): string {
  const [first, ...rest] = waitingOn;
  if (first === undefined) return "";
  return tr("{0}{1} 待ち", first, rest.length > 0 ? `+${rest.length}` : "");
}

/** 左パネルのカンバンとバックログの todo の行が着手できるか：承認待ち（Plan が承認待ち）・待ち（待ちの相手が残る）・着手可。開いた Plan に入っていない行と todo でない行は null */
export type KanbanReadiness = "pending" | "waiting" | "ready";

/** 行の右端の着手可・待ち・承認待ちと、タイトルを薄くするか（isWaitingReadiness）を同じ判定で決める */
export function kanbanReadiness(
  ticket: Pick<Ticket, "status">,
  mark: PlanMark | undefined,
): KanbanReadiness | null {
  if (!mark || ticket.status !== "todo") return null;
  if (mark.pending) return "pending";
  return mark.waitingOn.length === 0 ? "ready" : "waiting";
}

/** 承認待ちか待ちの行は、すぐには手を付けられないのでタイトルを説明文の色で薄く出す（UI-2。実行中の Run の例外は呼び出し側） */
export function isWaitingReadiness(readiness: KanbanReadiness | null): boolean {
  return readiness === "pending" || readiness === "waiting";
}

/** 開いた Plan に入っていない、終わっていない（todo・in_progress・review）行か。カンバンの行に破線の空き枠を出す判定（UI-2） */
export function needsPlanSlot(ticket: Pick<Ticket, "status">, mark: PlanMark | undefined): boolean {
  return !mark && !isFinished(ticket.status);
}

/**
 * 左パネルのカンバンの行の右端（開いた Plan に入っているか、開いた Plan に入っていない未完了の行か、Run の並びを出すか、担当のあるチケット）。縦に 2 段で、
 * 上の段の左端に優先度の印（high・low。medium は出さない）を置き、続けて担当の印と Plan の番号を Plan の色で出す（開いた Plan に入っていない終わっていない行は番号の代わりに破線の空き枠「—」）。
 * 下の段は Run の並び（runs。出すかは呼び出し側が showRunPips で決める）があればそれを、なければ todo なら承認待ち（Plan が承認待ち）・
 * 待ちの相手（after と depends_on の終わっていないもの）・着手可を出す（着手可・待ちだけ）。どれもなければ下の段は出さない
 */
export function KanbanRowEnd({
  ticket,
  mark,
  runs,
  stepLabel,
}: {
  ticket: TicketRow;
  mark: PlanMark | undefined;
  /** 下の段に並べる Run の要約。渡さなければ着手可・待ちを出す */
  runs?: TicketRunsView | undefined;
  /** Run の step の表示名（stepLabelOf） */
  stepLabel: (step: string) => string;
}) {
  // 実行中の Run があれば、todo でも着手可・待ちより Run の並びを出す（手が動いていることの方が大事なので）
  const sub = runs ? <RunPips runs={runs} stepLabel={stepLabel} /> : readinessBadge(ticket, mark);
  return (
    <span className="row-end">
      <span className="row-end-top">
        <RowPriority priority={ticket.priority} />
        <AssigneeMark assignee={ticket.assignee} runAgent={ticket.run_agent} />
        {mark ? <RowPlan plan={mark.plan} /> : needsPlanSlot(ticket, mark) ? <RowPlanSlot /> : null}
      </span>
      {sub ? <span className="row-end-sub">{sub}</span> : null}
    </span>
  );
}

/** Run の step の表示名：Workflow の steps の label、なければ（steps に書いていない step も）id のまま */
export function stepLabelOf(
  definition: Pick<WorkflowDefinition, "steps"> | undefined,
  step: string,
): string {
  return definition?.steps?.find((s) => s.id === step)?.label ?? step;
}

/** カンバンの行に Run の並びを出すか：In Progress と Review の行で Run があるとき。ほかの状態の行も実行中の Run があれば出す（UI-2） */
export function showRunPips(
  ticket: Pick<Ticket, "status">,
  runs: TicketRunsView | undefined,
): runs is TicketRunsView {
  if (!runs || runs.runs.length === 0) return false;
  if (ticket.status === "in_progress" || ticket.status === "review") return true;
  // 新しい 3 件の外にある実行中の Run も見る（core の TicketRunsView.running）
  return runs.running;
}

/**
 * 行の丸の結果の種類。run-parts.tsx の結果の種類に、重い指摘のあった見直し（heavy。成功で閉じても）と、
 * 止まって返事を待っている実行中の Run（waiting。waiting_since がある）を足す。書き終わりを待つ（settling_since）は実行中のまま
 */
export type RunPipKey = RunResultKey | "heavy" | "waiting";

export function runPipKey(run: RunSummary): RunPipKey {
  if (run.running && run.waiting_since) return "waiting";
  if (!run.running && run.result === "success" && run.review && !run.review.passed) return "heavy";
  return runResultKey(run);
}

const PIP_LABELS: Record<RunPipKey, string> = {
  ...RESULT_LABELS,
  heavy: msg("重い指摘"),
  waiting: msg("返事待ち"),
};

/**
 * 行の地の色を変える Run の結果：最後の Run が返事待ち（waiting）か、失敗・中断で終わった（failed）。ほかは null。
 * 並びを出さない行（showRunPips が偽）には呼び出し側で使わない
 */
export function runTone(runs: TicketRunsView): "waiting" | "failed" | null {
  const last = runs.runs[0];
  if (!last) return null;
  const key = runPipKey(last);
  if (key === "waiting") return "waiting";
  return key === "failure" || key === "interrupted" ? "failed" : null;
}

/** 経過の短い書き方：1 時間未満は分、1 日未満は時間、それより長ければ日（切り捨て） */
export function shortSpan(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return tr("{0}分", minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? tr("{0}時間", hours) : tr("{0}日", Math.floor(hours / 24));
}

const msOf = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : Number.NaN);

/**
 * 最後の丸の横の文字：実行中は「手 · 経過」、返事待ちは「返事待ち · 待った時間」、
 * 終わった Run は成功なら「手 · n分前」、ほか（重い指摘・失敗・中断・未完了）は「結果 · n分前」
 */
export function runPipCaption(
  run: RunSummary,
  stepLabel: (step: string) => string,
  now: number,
): string {
  const key = runPipKey(run);
  if (key === "waiting")
    return `${tr(PIP_LABELS.waiting)} · ${shortSpan(now - msOf(run.waiting_since))}`;
  if (key === "running") return `${stepLabel(run.step)} · ${shortSpan(now - msOf(run.started_at))}`;
  const head = key === "success" ? stepLabel(run.step) : tr(PIP_LABELS[key]);
  return `${head} · ${tr("{0}前", shortSpan(now - msOf(run.finished_at ?? run.started_at)))}`;
}

/**
 * 丸に重ねたとき・Tab で移ったときに出す行：手と結果、開始の時刻とかかった時間（実行中は今までの時間）、
 * 直した指摘の数（retries が 1 以上）、見直しの指摘の数（review があれば）、失敗・中断の理由（error）
 */
export function runPipDetails(
  run: RunSummary,
  stepLabel: (step: string) => string,
  now: number,
): string[] {
  const seconds = ((run.running ? now : msOf(run.finished_at)) - msOf(run.started_at)) / 1000;
  const lines = [
    `${stepLabel(run.step)} · ${tr(PIP_LABELS[runPipKey(run)])}`,
    `${formatTime(run.started_at)} · ${formatDuration(Number.isFinite(seconds) ? Math.max(0, seconds) : null)}`,
  ];
  if (run.retries > 0) lines.push(tr("直した指摘 {0}", run.retries));
  if (run.review) lines.push(tr("指摘 重い {0} / 軽い {1}", run.review.heavy, run.review.light));
  if (run.error) lines.push(run.error);
  return lines;
}

/** 経過の文字を 1 分ごとに描き直すための今の時刻（dg は呼ばず、描き直すだけ） */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * カンバンの行の Run の並び（UI-2）：古い順に 3 個までの丸（それより古い分は「+n」）と、最後の丸の横の文字（runPipCaption）。
 * 最後の丸は少し大きい。丸の色と形（塗り・中抜き・半分塗り。styles.css の .run-pip）が結果を表し、実行中と返事待ちの最後の丸は明滅する
 * （動きを減らす設定では明滅しない）。丸ごとに Tab で止まり、重ねるか移ると runPipDetails を出す。並び全体に読み上げ用の名前を付ける
 */
export function RunPips({
  runs,
  stepLabel,
}: {
  runs: TicketRunsView;
  stepLabel: (step: string) => string;
}) {
  const now = useMinuteNow();
  // run.recent は新しい順なので、古い順に並べ直す
  const shown = [...runs.runs].reverse();
  const last = shown.at(-1);
  if (!last) return null;
  const older = runs.total - shown.length;
  const caption = runPipCaption(last, stepLabel, now);
  return (
    <span
      className="run-pips"
      role="group"
      aria-label={tr("Run {0} 回。最後は {1}", runs.total, caption)}
    >
      {older > 0 ? <span className="run-pips-more">+{older}</span> : null}
      {shown.map((run) => {
        const details = runPipDetails(run, stepLabel, now);
        return (
          <span key={run.id} className="run-pip-wrap">
            <span
              className={`run-pip run-${runPipKey(run)}${run === last ? " is-last" : ""}`}
              role="img"
              tabIndex={0}
              aria-label={details.join(tr("、"))}
            />
            <span className="run-pip-tip" aria-hidden="true">
              {details.map((line, n) => (
                <span key={n}>{line}</span>
              ))}
            </span>
          </span>
        );
      })}
      <span className="run-pips-caption">{caption}</span>
    </span>
  );
}

/** 左パネルの行の Plan の番号（Plan の色） */
function RowPlan({ plan }: { plan: string }) {
  return (
    <span className={`row-plan plan-color-${planColor(plan)}`} title={`Plan ${plan}`}>
      {plan}
    </span>
  );
}

/** 開いた Plan に入っていない行の、Plan の番号の位置に出す破線の空き枠（警告に見せない専用の色。バックログの行には出さない） */
function RowPlanSlot() {
  return (
    <span className="row-plan-slot" title={tr("開いた Plan に入っていない")}>
      —
    </span>
  );
}

/** 左パネルの行の着手可・待ちの相手・承認待ち（kanbanReadiness で 1 回だけ判定する）。開いた Plan に入っていない行と todo でない行は null */
function readinessBadge(ticket: Pick<Ticket, "status">, mark: PlanMark | undefined): ReactNode {
  const state = kanbanReadiness(ticket, mark);
  if (!mark || state === null) return null;
  if (state === "pending") {
    return (
      <span className="row-wait" title={tr("{0} は人の承認を待っている", mark.plan)}>
        {tr("承認待ち")}
      </span>
    );
  }
  if (state === "ready") return <span className="row-ready">{tr("着手可")}</span>;
  return (
    <span className="row-wait" title={tr("{0} を待っている", mark.waitingOn.join(tr("・")))}>
      {waitLabel(mark.waitingOn)}
    </span>
  );
}

/**
 * 左パネルのバックログの行の右端（UI-3）：縦に 2 段で、上の段の左端に優先度の印（high・low。medium は出さない）を置き、
 * 続けて担当の印と Plan の番号を出す。開いた Plan に入っていれば下の段に todo の着手可・待ちの相手・承認待ちを出す（判定は kanbanPlanMarks と kanbanReadiness）。
 * 担当者が別の人なら、カンバンと同じ担当の印（頭文字の丸。agent なら汎用のアイコンを添える。全名はツールチップ）を優先度の印と Plan の番号の間に出す。
 * 自分か自分の agent（isOwnAssignee。core の whoami の own_ids）なら出さない
 */
export function BacklogRowEnd({
  ticket,
  mark,
  me,
}: {
  /** 一覧の行（TicketRow）なら Run の agent（run_agent）をホバーの文に出す（アイコンは agent によらず 1 種） */
  ticket: Pick<Ticket, "status" | "assignee" | "priority"> & Partial<Pick<TicketRow, "run_agent">>;
  mark: PlanMark | undefined;
  /** 操作している人（store.me）。分からなければ担当者をすべて別の人として出す */
  me: Pick<WhoamiView, "own_ids"> | null;
}) {
  const who =
    ticket.assignee && !isOwnAssignee(me, ticket.assignee) ? (
      <AssigneeMark assignee={ticket.assignee} runAgent={ticket.run_agent} />
    ) : null;
  const priority = <RowPriority priority={ticket.priority} />;
  const readiness = mark ? readinessBadge(ticket, mark) : null;
  // Plan の外の行も .row-end で包み、印の高さをほかの行と揃える
  return (
    <span className="row-end">
      <span className="row-end-top">
        {priority}
        {who}
        {mark ? <RowPlan plan={mark.plan} /> : null}
      </span>
      {readiness ? <span className="row-end-sub">{readiness}</span> : null}
    </span>
  );
}
