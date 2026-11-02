// 左パネルのカンバン（board.tsx）とバックログ（backlog.tsx）の行の右端の部品と、その判定。
// 開いた Plan に入っているチケットの Plan の番号と待ち（kanbanPlanMarks）、todo の行の着手可・待ち・承認待ち（kanbanReadiness）を、
// カンバンの行（KanbanRowEnd）とバックログの行（BacklogRowEnd）で同じ判定と同じ部品で出す

import type { ReactNode } from "react";
import { AssigneeMark } from "./assignee-mark.js";
import { PriorityBadge, RowPriority } from "./parts.js";
import { openPlanByTicket, planColor, planGraph, remainingWaits } from "./plan-graph.js";
import {
  isOwnAssignee,
  type PlanRow,
  type Ticket,
  type TicketRow,
  type WhoamiView,
} from "../types.js";

/** 左パネルのカンバンとバックログの行に出す、チケットが入っている開いた Plan と、残っている待ちの相手 */
export interface PlanMark {
  plan: string;
  /** Plan が承認待ち（plan.status が pending）。todo の行は待ちの相手によらず「承認待ち」と出す */
  pending: boolean;
  /** 残っている待ちの相手（remainingWaits。Plan の after の待ちが先、depends_on が後）。空なら着手できる */
  waitingOn: string[];
}

/** 開いた Plan に入っているチケットごとの PlanMark。after の待ちは Plan ごとに planGraph で求め、depends_on の待ちは deps_done で決める（remainingWaits） */
export function kanbanPlanMarks(
  plans: readonly PlanRow[],
  tickets: readonly TicketRow[],
  planOf: ReadonlyMap<string, string> = openPlanByTicket(plans),
): Map<string, PlanMark> {
  // キーをチケットの ID の型（t の番号）のままにすると depends_on・after の文字列で引けないので、文字列に広げる
  const byId = new Map<string, TicketRow>(tickets.map((t) => [t.id, t]));
  const marks = new Map<string, PlanMark>();
  for (const plan of plans) {
    if (plan.status === "closed") continue;
    for (const node of planGraph(plan, byId).nodes) {
      if (planOf.get(node.id) !== plan.id) continue;
      marks.set(node.id, {
        plan: plan.id,
        pending: plan.status === "pending",
        waitingOn: remainingWaits(byId.get(node.id)!, node.waitingOn, byId),
      });
    }
  }
  return marks;
}

/** 待ちの相手の短い書き方：1 件なら「t137 待ち」、2 件以上なら先頭と残りの件数で「t137+1 待ち」、なければ空文字 */
export function waitLabel(waitingOn: readonly string[]): string {
  const [first, ...rest] = waitingOn;
  if (first === undefined) return "";
  return `${first}${rest.length > 0 ? `+${rest.length}` : ""} 待ち`;
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

/**
 * 左パネルのカンバンの行の右端（開いた Plan に入っているか、実行中の Run があるか、担当のあるチケット）。縦に 2 段で、上に担当の印と Plan の番号を Plan の色で、
 * 下に実行中の Run があれば「実行中」（Plan の外の行でも）、なければ todo なら承認待ち（Plan が承認待ち）・
 * 待ちの相手（after と depends_on の終わっていないもの）・着手可、どれでもなければ優先度の印を出す。
 * 下の段に優先度の印でないものを出すときに優先度の印（high・low）もあれば、優先度の印を上の段の Plan の番号の左に寄せる
 */
export function KanbanRowEnd({
  ticket,
  mark,
  running,
}: {
  ticket: TicketRow;
  mark: PlanMark | undefined;
  running: boolean;
}) {
  const readiness = planReadiness(ticket, mark);
  // 実行中の Run があれば、todo でも着手可・待ちより「実行中」を出す（手が動いていることの方が大事なので）
  const sub = running ? (
    <span className="row-running" title="このマシンで Run が実行中">
      実行中
    </span>
  ) : (
    readiness
  );
  const priority = <RowPriority priority={ticket.priority} variant="kanban" />;
  return (
    <span className="row-end">
      <span className="row-end-top">
        {sub ? priority : null}
        <AssigneeMark assignee={ticket.assignee} runAgent={ticket.run_agent} />
        {mark ? <RowPlan plan={mark.plan} /> : null}
      </span>
      <span className="row-end-sub">{sub ?? priority}</span>
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

/** 左パネルの行の着手可・待ちの相手・承認待ち（kanbanReadiness で 1 回だけ判定する）。開いた Plan に入っていない行と todo でない行は null */
function planReadiness(ticket: Pick<Ticket, "status">, mark: PlanMark | undefined): ReactNode {
  const state = kanbanReadiness(ticket, mark);
  if (!mark || state === null) return null;
  if (state === "pending") {
    return (
      <span className="row-wait" title={`${mark.plan} は人の承認を待っている`}>
        承認待ち
      </span>
    );
  }
  if (state === "ready") return <span className="row-ready">着手可</span>;
  return (
    <span className="row-wait" title={`${mark.waitingOn.join("・")} を待っている`}>
      {waitLabel(mark.waitingOn)}
    </span>
  );
}

/**
 * 左パネルのバックログの行の右端（UI-3）：開いた Plan に入っていれば、カンバンの行と同じ部品で縦に 2 段、上に Plan の番号、
 * 下に todo なら着手可・待ちの相手・承認待ち（判定は kanbanPlanMarks と kanbanReadiness）。入っていなければ上の段に優先度の札（と担当の印）だけを出す。
 * 担当者が別の人なら、カンバンと同じ担当の印（頭文字の丸。agent なら汎用のアイコンを添える。全名はツールチップ）を上の段の Plan の番号の左に出す。
 * 自分か自分の agent（isOwnAssignee。core の whoami の own_ids）なら出さない。
 * 優先度はどの行にもカンバンのカードと同じ low・medium・high の札（PriorityBadge）で出す。
 * 下の段に着手可・待ちを出すときは、優先度の札を上の段の Plan の番号の左に寄せる
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
  const priority = <PriorityBadge priority={ticket.priority} />;
  // Plan の外の行も .row-end で包み、札の高さ（.row-end .badge）をほかの行と揃える
  if (!mark) {
    return (
      <span className="row-end">
        <span className="row-end-top">
          {priority}
          {who}
        </span>
      </span>
    );
  }
  const readiness = planReadiness(ticket, mark);
  return (
    <span className="row-end">
      <span className="row-end-top">
        {readiness ? priority : null}
        {who}
        <RowPlan plan={mark.plan} />
      </span>
      <span className="row-end-sub">{readiness ?? priority}</span>
    </span>
  );
}
