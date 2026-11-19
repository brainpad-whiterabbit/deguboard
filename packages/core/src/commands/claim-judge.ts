// ticket claim の拒否と、もう一度の claim（reclaim）かどうかの決定（ST-3・ST-9・RN-5、ADR-031）。チケットの今の値と主体を
// 受け取って決めるだけで、git・ファイルを読まない（import は型と定数と純粋な関数だけ）。決めるのは 2 つ：
//   - decideClaim：新しい claim に進むか・もう一度の claim か・拒否か。ticket.ts の ticketClaim が、書き込みの中（取り込みと索引の
//     読み直しの後）で呼ぶ。push が拒否されて最新の状態からやり直す（git/write.ts の cas）たびに、やり直した後の値で決め直される
//   - decideReclaim：もう一度の claim を拒むか（ブランチは変えられない）、手直しの始まりとして Run を開くか
// 境目の方針（requires・decide）と担当の付け替えの許可、ブランチ名が使えるかは、事実を読むので ticket.ts に残す。
// 前の手直しの Run の閉じ方は run-close-judge.ts の decidePreviousFixRunClose。組み合わせは claim-judge.test.ts が git なしで確かめ、
// git を通すテスト（commands-flow-reclaim.test.ts）は経路の代表だけを見る

import { OperationError, UsageError, type DeguboardError } from "../errors.js";
import { sameUser, type ActorKind } from "../model/actor.js";
import { BRANCH_VALUE_MAX, type Ticket } from "../model/ticket.js";

/**
 * 作業ブランチの名前を `<id>-<値>` に組み立てる（ST-3）。ブランチからチケットを ID で探せるように、dg が ID を付ける。
 * 自分の ID と `-` で始まる値（と ID だけの値）はそのまま使い、別のチケットの ID で始まる値は取り違えるので拒む。
 * 値は英小文字・数字・ハイフンだけ（`/` を含む `feat/x` のような名前も拒む）。使えない値は UsageError を投げる
 */
export function workBranchName(ticketId: string, value: string): string {
  if (value.length > BRANCH_VALUE_MAX) {
    throw new UsageError(
      `The branch value is ${value.length} characters long. Give short English words, up to ${BRANCH_VALUE_MAX} characters`,
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new UsageError(
      `The branch value "${value}" has characters that cannot be used. Give short English words in lowercase letters, digits, and hyphens (dg records the branch as ${ticketId}-<value>)`,
    );
  }
  if (value === ticketId || value.startsWith(`${ticketId}-`)) return value;
  const otherId = /^t\d+(?=-|$)/.exec(value)?.[0];
  if (otherId) {
    throw new UsageError(
      `The branch value "${value}" starts with another ticket's ID (${otherId}). Leave the ID out: dg puts ${ticketId}- in front of the value`,
    );
  }
  return `${ticketId}-${value}`;
}

/** claim を拒む、という決定。code は dg のエラーの code（INVALID_INPUT は使い方の誤り） */
export interface ClaimRejection {
  kind: "reject";
  code: "REJECTED" | "CLAIM_LOST" | "TRANSITION_REJECTED" | "INVALID_INPUT";
  message: string;
  /**
   * このセッションに dg のフックが届いているときに、message の代わりに出す文（続け方の案内が変わる。t717）。
   * あるときだけ、行う側がフックが届いているかを読む
   */
  messageWithHooks?: string;
}

/** ticket claim を呼んだときに行うこと */
type ClaimDecision =
  /** 新しい claim に進む。reassignedFrom は、ほかのユーザに割り当てた todo を取るときの前の担当（担当の付け替え。governance.reassign） */
  | { kind: "claim"; reassignedFrom?: string }
  /** もう一度の claim（手直しの始まり）。チケットは変えない */
  | { kind: "reclaim" }
  | ClaimRejection;

/** decideClaim に要る事実 */
export interface ClaimFacts {
  /** 取り込みと索引の読み直しの後の、チケットの今の値 */
  ticket: Pick<Ticket, "id" | "status" | "assignee" | "pr" | "branch" | "provisional">;
  /** claim を呼んだ主体の ID（`eiki` か `eiki/agent`） */
  actor: string;
  /** --retry-reason を渡したか（もう一度の claim でだけ使える） */
  retryReasons: boolean;
}

/** もう一度の claim になる条件：自分（同じユーザの人と AI）が claim 済みで PR のある in_progress・review のチケット（ST-9） */
function isReclaim({ ticket, actor }: ClaimFacts): boolean {
  return (
    (ticket.status === "in_progress" || ticket.status === "review") &&
    ticket.assignee !== undefined &&
    sameUser(ticket.assignee, actor) &&
    ticket.pr !== undefined
  );
}

/**
 * ticket claim が新しい claim に進むか・もう一度の claim か・拒否かを決める（ST-3・ST-9）。上から順に：
 *   - 自分が claim 済みで PR のある in_progress・review はもう一度の claim
 *   - 仮番号のチケットは拒む（dg sync で振り直されることがあり、claim するとブランチ名に仮番号が残る。DT-5）
 *   - todo でないチケット：ほかのユーザの claim は CLAIM_LOST。自分の claim でも PR のない in_progress・review は手直しにならない
 *     （実装の途中。続け方を案内して CLAIM_LOST）。ほか（担当のない in_progress・done・abandoned など）は TRANSITION_REJECTED
 *   - todo に --retry-reason は渡せない（使い方の誤り）
 */
export function decideClaim(f: ClaimFacts): ClaimDecision {
  const { ticket, actor } = f;
  if (isReclaim(f)) return { kind: "reclaim" };
  if (ticket.provisional)
    return {
      kind: "reject",
      code: "REJECTED",
      message: `${ticket.id} has a provisional number that is not pushed yet, and the number may change. Run dg sync when the remote is reachable to fix the number, then claim the ticket by its fixed ID`,
    };
  const owner = ticket.assignee;
  const own = owner !== undefined && sameUser(owner, actor);
  if (ticket.status !== "todo") {
    if (owner && !own)
      return {
        kind: "reject",
        code: "CLAIM_LOST",
        message: `${ticket.id} is already claimed by ${owner}`,
      };
    if (own && (ticket.status === "in_progress" || ticket.status === "review"))
      return {
        kind: "reject",
        code: "CLAIM_LOST",
        message: `${ticket.id} is claimed by you (${owner}) and has no PR yet. To keep implementing, use run start. To stop, use ticket unclaim`,
        // フックが届くセッションでは、親が run start で続けず、印の brief をサブエージェントに渡して続けさせる（t717）。
        // PR の要らない作業（branch なし）は親が自分で進めるので、フックが届いても run start の案内のままにする
        ...(ticket.branch
          ? {
              messageWithHooks: `${ticket.id} is claimed by you (${owner}) and has no PR yet. To keep implementing, ask a sub-agent with the brief from dg next (it has the mark, and the hook opens and closes the Run), not run start. To stop, use ticket unclaim`,
            }
          : {}),
      };
    return {
      kind: "reject",
      code: "TRANSITION_REJECTED",
      message: `${ticket.id} is ${ticket.status}, so it cannot be claimed`,
    };
  }
  if (f.retryReasons)
    return {
      kind: "reject",
      code: "INVALID_INPUT",
      message: `retry_reason can be used only when claiming again a ticket that you have claimed and that has a PR (${ticket.id} is todo)`,
    };
  return { kind: "claim", ...(owner && !own ? { reassignedFrom: owner } : {}) };
}

/** 拒否の決定を、dg のエラーにする。hooksReach は、このセッションに dg のフックが届いているか（messageWithHooks があるときだけ読む） */
export function claimRejectionError(
  rejection: ClaimRejection,
  hooksReach: boolean,
): DeguboardError {
  const message =
    hooksReach && rejection.messageWithHooks !== undefined
      ? rejection.messageWithHooks
      : rejection.message;
  return rejection.code === "INVALID_INPUT"
    ? new UsageError(message)
    : new OperationError(rejection.code, message);
}

/** decideReclaim に要る事実 */
export interface ReclaimFacts {
  /** もう一度の claim と決まったチケット（自分が claim 済みで PR がある） */
  ticket: Pick<Ticket, "id" | "branch" | "pr" | "assignee">;
  /** --branch の値（省いたら undefined）と --without-branch */
  branch: string | undefined;
  withoutBranch: boolean;
  /** 呼んだ主体が人か AI か。手直しの Run を開くのは AI だけ（RN-5） */
  actorKind: ActorKind;
  /** --no-run（Run はフックに任せる） */
  noRun: boolean;
}

/** もう一度の claim で行うこと */
type ReclaimDecision =
  | ClaimRejection
  /** 手直しの始まりとみなす。notice は warnings に入れる文、opensRun は手直しの Run（fix）を開くか */
  | { kind: "fix"; notice: string; opensRun: boolean };

/**
 * もう一度の claim を拒むか、手直しの始まりとして進めるかを決める（ST-9・RN-5）。チケットは変えないので、ブランチを変える指定
 * （--without-branch と、別の名前になる --branch）は拒む。--branch は最初の claim と同じ値（`fix-login`）でも通るように、
 * 組み立てた後の名前で比べる（ST-3）。記録済みの名前そのもの（`<id>-` を付ける前の版が記録した `feature/x` など）は、組み立てずに通す。
 * 名前に使えない値は、組み立ての規則の誤りとして workBranchName が UsageError を投げる
 */
export function decideReclaim(f: ReclaimFacts): ReclaimDecision {
  const { ticket } = f;
  const sameBranch =
    f.branch === undefined ||
    f.branch === ticket.branch ||
    workBranchName(ticket.id, f.branch) === ticket.branch;
  if (f.withoutBranch || !sameBranch)
    return {
      kind: "reject",
      code: "INVALID_INPUT",
      message: `${ticket.id} is already claimed (branch ${ticket.branch ?? "none"}, PR #${ticket.pr}). Claiming again cannot change the branch`,
    };
  return {
    kind: "fix",
    notice: `${ticket.id} is already claimed by you (${ticket.assignee}) and has PR #${ticket.pr}, so this is treated as the start of a fix and the ticket is not changed`,
    opensRun: f.actorKind === "agent" && !f.noRun,
  };
}
