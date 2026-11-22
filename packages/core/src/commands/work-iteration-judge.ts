// 作業中（in_progress・review）のチケットの Iteration は active でなければならない、という Core の固定の規則の決定（IT-4、ADR-009）。
// チケットを作業中にする 3 つの経路（claim・ticket move の todo からの前進・done / abandoned からの戻し）が、Iteration の今の状態と
// ほかの active を受け取って決めるだけで、git・ファイルを読まない（import は型だけ）。Workflow の requires ではないので、
// --override では越えられない。事実を集めて決定を行う（開始を書く・拒否を投げる）のは claim-setup.ts の startIterationForWork。
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
  /** 拒否する。message は出口（チケットを active に移す・今の active を閉じる）を案内する */
  | { kind: "reject"; message: string };

const WORK_STATUSES: readonly Status[] = ["in_progress", "review"];

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

const RULE =
  "a ticket in progress or in review must be in the active Iteration, and --override does not pass this";

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
