// 作業中（in_progress・review）のチケットの Iteration は active でなければならない、という Core の固定の規則の決定（IT-4、ADR-009）。
// チケットを作業中にする 3 つの経路（claim・ticket move の todo からの前進・done / abandoned からの戻し）が、Iteration の今の状態と
// ほかの active を受け取って決めるだけで、git・ファイルを読まない（import は型だけ）。Workflow の requires ではないので、
// --override では越えられない。事実を集めて決定を行う（開始を書く・拒否を投げる）のは claim-setup.ts の startIterationForWork。
// 作業中のチケットを Iteration に入れる操作（iteration add・ticket update --iteration）は decideWorkAssignment で、照合（dg sync）が
// todo を作業中へ進めるのは reconcile-judge.ts が decideWorkIteration で同じ規則を守る。dg next（next.ts）は claim が拒否する todo に
// 着手の手でなく人に聞く手を返し、lint（setup.ts）は規則から外れた作業中のチケットを戻しの出口とともに指摘する。
// todo に戻す経路（ticket move・ticket unclaim）で、閉じた Iteration のチケットを Iteration から外すのは leftClosedIteration（IT-2）。
// 組み合わせは work-iteration-judge.test.ts が確かめ、git を通すテストは経路の代表だけを見る

import type { Iteration } from "../model/iteration.js";
import type { Status } from "../model/common.js";

/**
 * チケットを作業中にする経路。claim と move（todo からの前進）は着手で、planned の Iteration を開始できる。
 * return（done・abandoned からの戻し）は終えた作業の続きで、Iteration は開始しない
 */
export type WorkRoute = "claim" | "move" | "return";

/** decideWorkIteration に要る事実 */
export interface WorkIterationFacts {
  route: WorkRoute;
  ticket: string;
  /** チケットの Iteration の今の値。Iteration のないチケット（とファイルのない Iteration を指すチケット）は undefined */
  iteration: Pick<Iteration, "id" | "status"> | undefined;
  /** ほかに active の Iteration の ID（model/iteration.ts の otherActiveOf）。なければ undefined */
  otherActive: string | undefined;
}

export type WorkIterationDecision =
  /** そのまま進める（Iteration が active か、Iteration のないチケット） */
  | { kind: "go" }
  /** planned の Iteration を開始してから進める */
  | { kind: "start"; iteration: string }
  /**
   * 拒否する。message は出口（チケットを active に移す・今の active を閉じる）を案内する。
   * state は Iteration の状態の言い方、ways は人が選ぶ出口で、照合の知らせ（reconcile-judge.ts）が同じ出口を案内するのに使う
   */
  | { kind: "reject"; message: string; state: string; ways: string };

/** 作業中の Status（この規則が見るもの） */
export const WORK_STATUSES: readonly Status[] = ["in_progress", "review"];

/**
 * ticket move が作業中へ入る経路。todo から作業中へは着手（move）、done・abandoned から作業中へは戻し（return）。
 * 作業中どうしの移動と、作業中へ入らない移動は規則の外なので undefined
 */
export function workRouteOfMove(from: Status, to: Status): "move" | "return" | undefined {
  if (!WORK_STATUSES.includes(to)) return undefined;
  if (from === "todo") return "move";
  if (from === "done" || from === "abandoned") return "return";
  return undefined;
}

/** 規則の文。拒否の文と、照合が前進を止めた知らせ（reconcile-judge.ts）が添える */
export const WORK_ITERATION_RULE =
  "a ticket in progress or in review must be in the active Iteration, and --override does not pass this";
const RULE = WORK_ITERATION_RULE;

/** Iteration にチケットを入れるコマンド */
const addTo = (iteration: string, ticket: string) => `dg iteration add ${iteration} ${ticket}`;

/**
 * チケットを作業中にしてよいかを、その Iteration の状態で決める。
 *   - Iteration がない：進める（対象外。lint_iteration_missing が見る）
 *   - active：進める
 *   - planned でほかに active がない：着手（claim・move）は開始して進める。戻しは開始せず拒否する
 *   - planned でほかに active がある・closed：拒否する
 */
export function decideWorkIteration(facts: WorkIterationFacts): WorkIterationDecision {
  const { route, ticket, iteration: it, otherActive: other } = facts;
  if (!it || it.status === "active") return { kind: "go" };
  const what = route === "return" ? "it cannot go back to work" : "work on it cannot start";
  const reject = (state: string, ways: string): WorkIterationDecision => ({
    kind: "reject",
    message: `${ticket} is in ${it.id} (${state}), so ${what} (${RULE}). Ask a person which to do: ${ways}, and then try again`,
    state,
    ways,
  });
  if (it.status === "planned") {
    if (other) {
      const after = route === "return" ? ` and start ${it.id} (dg iteration start ${it.id})` : "";
      return reject(
        `planned, and ${other} is active`,
        `move ${ticket} into ${other} (${addTo(other, ticket)}), or close ${other} (dg iteration close ${other})${after}`,
      );
    }
    if (route !== "return") return { kind: "start", iteration: it.id };
    return reject(
      "planned",
      `start ${it.id} (dg iteration start ${it.id}), or move ${ticket} into the Iteration to work in (${addTo("<iteration>", ticket)})`,
    );
  }
  // closed
  if (other) {
    return reject(
      `closed, and ${other} is active`,
      `move ${ticket} into ${other} (${addTo(other, ticket)}), or close ${other} (dg iteration close ${other}) and reopen ${it.id} (dg iteration reopen ${it.id})`,
    );
  }
  return reject(
    "closed",
    `move ${ticket} into the Iteration to work in (${addTo("<iteration>", ticket)}), or reopen ${it.id} (dg iteration reopen ${it.id})`,
  );
}

/**
 * ticket move・ticket unclaim で todo に戻すチケットが、閉じた Iteration から外れるか。外れるならその Iteration の ID を返す。
 * 閉じた Iteration には終わっていないチケットを残さない（IT-2。iteration close が done・abandoned 以外の iteration を外すのと揃える）。
 * done・abandoned から作業中への戻しは decideWorkIteration が拒否するので、閉じた Iteration から終わっていない状態へ出られるのは todo だけ。
 * unclaim は in_progress のチケットだけを戻す。閉じた Iteration に作業中のチケットが残るのは規則より前のデータなど（lint が指摘する）で、
 * unclaim はそこから出る出口の 1 つになる
 */
export function leftClosedIteration(
  to: Status,
  iteration: Pick<Iteration, "id" | "status"> | undefined,
): string | undefined {
  return to === "todo" && iteration?.status === "closed" ? iteration.id : undefined;
}

/** ticket move・ticket unclaim が閉じた Iteration から外したことの知らせ。人が別の Iteration に入れられるように、入れ方を添える */
export function leftClosedIterationWarning(ticket: string, iteration: string): string {
  return `${ticket} left ${iteration}, because ${iteration} is closed and a closed Iteration keeps only done and abandoned tickets. To plan it again, add it to another Iteration (${addTo("<iteration>", ticket)})`;
}

/** decideWorkAssignment に要る事実 */
export interface WorkAssignmentFacts {
  ticket: string;
  /** チケットの今の Status */
  status: Status;
  /** 入れ先の Iteration（閉じた Iteration は呼ぶ側が先に拒否する） */
  target: Pick<Iteration, "id" | "status">;
  /** 入れ先のほかに active の Iteration の ID（model/iteration.ts の otherActiveOf）。なければ undefined */
  otherActive: string | undefined;
}

/**
 * 作業中のチケットを Iteration に入れてよいかを決める（iteration add・ticket update --iteration）。
 * 入れると作業中のチケットが active でない Iteration に入るなら、拒否の文を返す。入れてよければ undefined。
 * todo・done・abandoned のチケットと、active の Iteration への出し入れは規則の外。Iteration から外す（なしにする）のも規則の外
 * （Iteration のないチケットは decideWorkIteration と同じく対象にしない）。着手と違い、入れる操作は Iteration を開始しない
 */
export function decideWorkAssignment(facts: WorkAssignmentFacts): string | undefined {
  const { ticket, status, target, otherActive: other } = facts;
  if (!WORK_STATUSES.includes(status) || target.status === "active") return undefined;
  const ways = other
    ? `add it to ${other}, the active Iteration (${addTo(other, ticket)}), or close ${other} (dg iteration close ${other}) and start ${target.id} (dg iteration start ${target.id})`
    : `start ${target.id} first (dg iteration start ${target.id})`;
  return `${ticket} is ${status} and ${target.id} is ${target.status}, so ${ticket} cannot be added to ${target.id} (${RULE}). Ask a person which to do: ${ways}, and then try again`;
}
