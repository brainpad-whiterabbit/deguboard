// ticket claim の拒否ともう一度の claim かどうかの決定の組み合わせ（status・担当・PR・仮番号・--retry-reason・--branch）を、
// git なしで確かめる。取り込んだ後の値で決める経路（古い索引・push に負けた後のやり直し）と、Run を開いて前の手直しを閉じる経路は
// commands-flow-reclaim.test.ts の代表の件が見る。境目の方針と担当の付け替えの許可は commands-flow-ticket.test.ts。
// claim したセッションの記録が効くか・別のセッションの操作を拒むかの組み合わせもここで確かめ、記録を読み書きする経路は claim-sessions.test.ts。
// claim の前の予約（Plan とチケット）も同じ関数が決めるので、その組み合わせもここで確かめる（読み書きする経路は reservations.test.ts）。
// claim が push の前に予約を書くか・取れなかった claim の予約をどう戻すかの組み合わせも、ここで確かめる
import { describe, expect, it } from "vitest";
import { OperationError, UsageError } from "../errors.js";
import { STATUSES } from "../model/common.js";
import {
  claimRejectionError,
  decideClaim,
  decideClaimReservation,
  decideReclaim,
  decideReservationRollback,
  decideSessionClaim,
  holdingReservation,
  sessionClaimHolds,
  workBranchName,
  type ClaimFacts,
  type ClaimRejection,
  type ClaimReservationFacts,
  type ReclaimFacts,
  type ReservationCandidate,
  type SessionClaim,
  type SessionClaimFacts,
  type SessionSigns,
} from "./claim-judge.js";

/** 既定：担当のない todo のチケットを、eiki の AI が claim する */
const claim = (ticket: Partial<ClaimFacts["ticket"]> = {}, over: Partial<ClaimFacts> = {}) =>
  decideClaim({
    ticket: { id: "t1", status: "todo", ...ticket },
    actor: "eiki/agent",
    retryReasons: false,
    ...over,
  });

const NO_PR =
  "t1 is claimed by you (eiki/agent) and has no PR yet. To keep implementing, use run start. To stop, use ticket unclaim";
const NO_PR_WITH_HOOKS =
  "t1 is claimed by you (eiki/agent) and has no PR yet. To keep implementing, ask a sub-agent with the brief from dg next (it has the mark, and the hook opens and closes the Run), not run start. To stop, use ticket unclaim";

describe("claim の拒否と、もう一度の claim かどうか（ST-3・ST-9）", () => {
  it("担当のない todo と、自分（同じユーザの人と AI）に割り当てた todo は、新しい claim に進む", () => {
    expect(claim()).toEqual({ kind: "claim" });
    expect(claim({ assignee: "eiki" })).toEqual({ kind: "claim" });
    expect(claim({ assignee: "eiki/agent" })).toEqual({ kind: "claim" });
    // todo に残った前の作業の PR の記録は、手直しにしない
    expect(claim({ assignee: "eiki", pr: 41 })).toEqual({ kind: "claim" });
  });

  it("ほかのユーザに割り当てた todo は、前の担当を付けて新しい claim に進む（担当の付け替え）", () => {
    expect(claim({ assignee: "taro" })).toEqual({ kind: "claim", reassignedFrom: "taro" });
    expect(claim({ assignee: "taro/agent" })).toEqual({
      kind: "claim",
      reassignedFrom: "taro/agent",
    });
  });

  it("自分が claim 済みで PR のある in_progress・review は、人でも AI でも、もう一度の claim になる", () => {
    for (const status of ["in_progress", "review"] as const)
      for (const assignee of ["eiki", "eiki/agent"])
        for (const actor of ["eiki", "eiki/agent"])
          expect(
            claim({ status, assignee, pr: 41, branch: "t1" }, { actor }),
            `${status} ${assignee} ${actor}`,
          ).toEqual({ kind: "reclaim" });
    // --retry-reason はもう一度の claim で使える（拒まない）
    expect(
      claim({ status: "review", assignee: "eiki/agent", pr: 41 }, { retryReasons: true }),
    ).toEqual({ kind: "reclaim" });
  });

  it("ほかのユーザが claim したチケットは、PR があっても、どの status でも CLAIM_LOST", () => {
    for (const status of STATUSES.filter((s) => s !== "todo"))
      expect(claim({ status, assignee: "taro/agent", pr: 41 }), status).toEqual({
        kind: "reject",
        code: "CLAIM_LOST",
        message: "t1 is already claimed by taro/agent",
      });
  });

  it("自分の claim でも PR のない in_progress・review は手直しにならず、続け方を案内して CLAIM_LOST。作業ブランチがあるときだけ、フックが届くセッションの案内を持つ", () => {
    for (const status of ["in_progress", "review"] as const) {
      expect(claim({ status, assignee: "eiki/agent", branch: "t1" }), status).toEqual({
        kind: "reject",
        code: "CLAIM_LOST",
        message: NO_PR,
        messageWithHooks: NO_PR_WITH_HOOKS,
      });
      // PR の要らない作業（branch なし）は親が自分で進めるので、run start の案内だけ
      expect(claim({ status, assignee: "eiki/agent" }), status).toEqual({
        kind: "reject",
        code: "CLAIM_LOST",
        message: NO_PR,
      });
    }
  });

  it("終わったチケットと、担当のない todo でないチケットは TRANSITION_REJECTED。自分が担当の終わったチケットも同じ", () => {
    const rejected = (status: string) => ({
      kind: "reject",
      code: "TRANSITION_REJECTED",
      message: `t1 is ${status}, so it cannot be claimed`,
    });
    for (const status of STATUSES.filter((s) => s !== "todo"))
      expect(claim({ status }), status).toEqual(rejected(status));
    for (const status of ["done", "abandoned"] as const) {
      expect(claim({ status, assignee: "eiki/agent" }), status).toEqual(rejected(status));
      expect(claim({ status, assignee: "eiki/agent", pr: 41 }), status).toEqual(rejected(status));
    }
  });

  it("仮番号のチケットは、todo でもほかのユーザの claim でも、番号を確定させるよう知らせて拒む。もう一度の claim はその前に決まる", () => {
    const provisional = {
      kind: "reject",
      code: "REJECTED",
      message: expect.stringContaining("t1 has a provisional number that is not pushed yet"),
    };
    expect(claim({ provisional: true })).toEqual(provisional);
    expect(claim({ provisional: true, status: "in_progress", assignee: "taro" })).toEqual(
      provisional,
    );
    expect(claim({ provisional: true, status: "review", assignee: "eiki", pr: 41 })).toEqual({
      kind: "reclaim",
    });
  });

  it("todo の claim に --retry-reason は渡せない（使い方の誤り）。todo でない拒否は --retry-reason より先に決まる", () => {
    expect(claim({}, { retryReasons: true })).toEqual({
      kind: "reject",
      code: "INVALID_INPUT",
      message:
        "retry_reason can be used only when claiming again a ticket that you have claimed and that has a PR (t1 is todo)",
    });
    expect(
      claim({ status: "in_progress", assignee: "taro" }, { retryReasons: true }),
    ).toMatchObject({ code: "CLAIM_LOST" });
    expect(
      claim({ status: "in_progress", assignee: "eiki/agent" }, { retryReasons: true }),
    ).toMatchObject({ code: "CLAIM_LOST", message: NO_PR });
  });

  it("拒否は code のとおりの dg のエラーになり、フックが届くセッションでは、その案内があるときだけ文を差し替える", () => {
    const lost: ClaimRejection = { kind: "reject", code: "CLAIM_LOST", message: "plain" };
    const error = claimRejectionError(lost, true);
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ code: "CLAIM_LOST", message: "plain", exitCode: 1 });
    const withHooks = { ...lost, messageWithHooks: "with hooks" };
    expect(claimRejectionError(withHooks, true).message).toBe("with hooks");
    expect(claimRejectionError(withHooks, false).message).toBe("plain");
    const usage = claimRejectionError(
      { kind: "reject", code: "INVALID_INPUT", message: "m" },
      false,
    );
    expect(usage).toBeInstanceOf(UsageError);
    expect(usage).toMatchObject({ code: "INVALID_INPUT", message: "m", exitCode: 2 });
  });
});

/** 既定：ブランチ t1-fix-login と PR #41 を記録した自分のチケットを、eiki の AI がもう一度 claim する */
const reclaim = (over: Partial<ReclaimFacts> = {}) =>
  decideReclaim({
    ticket: { id: "t1", branch: "t1-fix-login", pr: 41, assignee: "eiki/agent" },
    branch: undefined,
    withoutBranch: false,
    actorKind: "agent",
    noRun: false,
    ...over,
  });

const NOTICE =
  "t1 is already claimed by you (eiki/agent) and has PR #41, so this is treated as the start of a fix and the ticket is not changed";

describe("もう一度の claim（ST-9・RN-5）", () => {
  it("手直しの始まりとして知らせ、AI の claim は手直しの Run を開く。人の claim と --no-run は開かない", () => {
    expect(reclaim()).toEqual({ kind: "fix", notice: NOTICE, opensRun: true });
    expect(reclaim({ actorKind: "human" })).toEqual({
      kind: "fix",
      notice: NOTICE,
      opensRun: false,
    });
    expect(reclaim({ noRun: true })).toEqual({ kind: "fix", notice: NOTICE, opensRun: false });
  });

  it("--branch は、最初の claim と同じ値（<id>- を付ける前の値）でも、記録済みの名前でも通る（ST-3）", () => {
    for (const branch of ["fix-login", "t1-fix-login"])
      expect(reclaim({ branch }), branch).toMatchObject({ kind: "fix" });
    // <id>- を付ける前の版が記録した名前は、組み立ての規則に合わなくても、記録済みの名前そのものなら通る
    expect(
      decideReclaim({
        ticket: { id: "t1", branch: "feature/x", pr: 41, assignee: "eiki" },
        branch: "feature/x",
        withoutBranch: false,
        actorKind: "human",
        noRun: false,
      }),
    ).toMatchObject({ kind: "fix" });
  });

  it("別の名前になる --branch と --without-branch は、ブランチは変えられないと拒む（使い方の誤り）", () => {
    const rejected = {
      kind: "reject",
      code: "INVALID_INPUT",
      message:
        "t1 is already claimed (branch t1-fix-login, PR #41). Claiming again cannot change the branch",
    };
    expect(reclaim({ branch: "login" })).toEqual(rejected);
    expect(reclaim({ withoutBranch: true })).toEqual(rejected);
    // 同じ名前の --branch を付けても、--without-branch は拒む
    expect(reclaim({ branch: "fix-login", withoutBranch: true })).toEqual(rejected);
    // 作業ブランチのないチケット（PR の要らない作業に PR を記録した）は none と書く
    expect(
      decideReclaim({
        ticket: { id: "t1", pr: 41, assignee: "eiki" },
        branch: "x",
        withoutBranch: false,
        actorKind: "human",
        noRun: false,
      }),
    ).toMatchObject({
      message:
        "t1 is already claimed (branch none, PR #41). Claiming again cannot change the branch",
    });
  });

  it("名前に使えない --branch の値は、組み立ての規則の誤りとして拒む", () => {
    expect(() => reclaim({ branch: "Fix Login" })).toThrow(UsageError);
    expect(() => reclaim({ branch: "t2-fix-login" })).toThrow(
      "starts with another ticket's ID (t2)",
    );
  });
});

describe("作業ブランチの名前の組み立て（ST-3）", () => {
  it("値の前に <id>- を付け、自分の ID で始まる値と ID だけの値はそのまま使う", () => {
    expect(workBranchName("t12", "fix-login")).toBe("t12-fix-login");
    expect(workBranchName("t12", "t12-fix-login")).toBe("t12-fix-login");
    expect(workBranchName("t12", "t12")).toBe("t12");
    // 別のチケットの ID に見えても、ID の後が - か終わりでなければ値の一部
    expect(workBranchName("t12", "t1x")).toBe("t12-t1x");
  });

  it("別のチケットの ID で始まる値・使えない文字を含む値・長すぎる値は使い方の誤り", () => {
    expect(() => workBranchName("t12", "t1-fix")).toThrow("starts with another ticket's ID (t1)");
    expect(() => workBranchName("t12", "t1")).toThrow("starts with another ticket's ID (t1)");
    expect(() => workBranchName("t12", "feat/x")).toThrow("has characters that cannot be used");
    expect(() => workBranchName("t12", "-x")).toThrow(UsageError);
    expect(() => workBranchName("t12", "a".repeat(200))).toThrow("characters long");
  });
});

const IDLE_MS = 30 * 60_000;
const CLAIMED_AT = "2026-11-06T00:00:00Z";
const RECORD: SessionClaim = { session: "sess-a", claimed_at: CLAIMED_AT };
/** CLAIMED_AT から分だけ後の時刻 */
const after = (minutes: number) => new Date(Date.parse(CLAIMED_AT) + minutes * 60_000);
const iso = (minutes: number) => after(minutes).toISOString();

/** 既定：sess-a が記録して 10 分後で、フックは届いていない */
const holds = (over: Partial<SessionSigns> = {}, record: SessionClaim = RECORD) =>
  sessionClaimHolds(record, {
    lastHookAt: undefined,
    endedAt: undefined,
    now: after(10),
    idleMs: IDLE_MS,
    ...over,
  });

/** 既定：sess-a が記録して 10 分後（5 分後にフックが届いた）に、別のセッション sess-b の AI がもう一度 claim する */
const sessionClaim = (over: Partial<SessionClaimFacts> = {}) =>
  decideSessionClaim({
    ticket: "t1",
    operation: "claim",
    record: RECORD,
    lastHookAt: iso(5),
    endedAt: undefined,
    now: after(10),
    idleMs: IDLE_MS,
    actorKind: "agent",
    session: "sess-b",
    takeOver: false,
    ...over,
  });

const HOLDER = `session sess-a (it claimed t1 at ${CLAIMED_AT}; its last dg hook arrived at ${iso(5)})`;

describe("claim したセッションの記録が効くか（SY-5）", () => {
  it("最後の知らせ（記録した時刻と最後に届いたフックの新しいほう）から 30 分より前は効き、30 分ちょうどから無視する", () => {
    expect(holds()).toBe(true);
    expect(holds({ now: after(29) })).toBe(true);
    expect(holds({ now: after(30) })).toBe(false);
    // フックが届いていれば、そこから数える
    expect(holds({ now: after(50), lastHookAt: iso(25) })).toBe(true);
    expect(holds({ now: after(55), lastHookAt: iso(25) })).toBe(false);
    // 記録より前に届いたフックは、記録した時刻より古いので使わない
    expect(holds({ now: after(29), lastHookAt: iso(-60) })).toBe(true);
    expect(holds({ now: after(30), lastHookAt: iso(-60) })).toBe(false);
    // 時計が戻って今が記録より前でも効く
    expect(holds({ now: after(-5) })).toBe(true);
  });

  it("最後の知らせの後（同じ時刻を含む）に SessionEnd が届いた記録は無視し、終わりの後にフックが届いていれば（同じ ID の再開）効く", () => {
    expect(holds({ endedAt: iso(5) })).toBe(false);
    expect(holds({ lastHookAt: iso(5), endedAt: iso(5) })).toBe(false);
    expect(holds({ lastHookAt: iso(3), endedAt: iso(5) })).toBe(false);
    expect(holds({ lastHookAt: iso(8), endedAt: iso(5) })).toBe(true);
    // 記録より前の終わり（終わったセッションを再開してから claim した）は、記録の時刻が新しいので効く
    expect(holds({ endedAt: iso(-5) })).toBe(true);
    // 記録と同じ時刻の終わりは無視する
    expect(holds({ endedAt: iso(0) })).toBe(false);
  });

  it("読めない時刻は、記録なら無視し、フックと終わりならないものとして扱う", () => {
    expect(holds({}, { session: "sess-a", claimed_at: "いつか" })).toBe(false);
    expect(holds({ lastHookAt: "x", endedAt: "y" })).toBe(true);
    expect(holds({ now: after(30), lastHookAt: "x" })).toBe(false);
  });
});

describe("別のセッションが claim したチケットへの、もう一度の claim・unclaim（SY-5）", () => {
  it("生きている別のセッションの記録があると、AI のもう一度の claim と unclaim を拒み、記録したセッションと越え方を示す", () => {
    expect(sessionClaim()).toEqual({
      kind: "reject",
      code: "REJECTED",
      message: `t1 is being worked on by another session of yours: ${HOLDER}. This session (sess-b) cannot claim it again while that session is alive. Leave the ticket to that session. If that session has stopped, or a person told you to take the work over, add --take-over (the record moves to this session). The record is ignored once SessionEnd reaches that session or no dg hook has reached it for 30 minutes`,
    });
    expect(sessionClaim({ operation: "unclaim" })).toEqual({
      kind: "reject",
      code: "REJECTED",
      message: `t1 is being worked on by another session of yours: ${HOLDER}. This session (sess-b) cannot unclaim it while that session is alive. Leave the ticket to that session. If that session has stopped, or a person told you to take the work over, add --take-over. The record is ignored once SessionEnd reaches that session or no dg hook has reached it for 30 minutes`,
    });
    // フックが届いていないセッションの記録も、記録から 30 分の間は拒む
    expect(sessionClaim({ lastHookAt: undefined })).toMatchObject({
      kind: "reject",
      message: expect.stringContaining(
        `session sess-a (it claimed t1 at ${CLAIMED_AT}; no dg hook has reached it)`,
      ),
    });
  });

  it("記録がない・記録したセッション自身・無視する記録（SessionEnd・30 分）は、操作・主体・--take-over がどれでも黙って通す", () => {
    const passing: Partial<SessionClaimFacts>[] = [
      { record: undefined },
      { session: "sess-a" },
      { endedAt: iso(5) },
      { now: after(35) },
    ];
    for (const pass of passing)
      for (const operation of ["claim", "unclaim"] as const)
        for (const actorKind of ["agent", "human"] as const)
          for (const takeOver of [false, true])
            for (const session of pass.session ? ["sess-a"] : ["sess-b", undefined])
              expect(
                sessionClaim({ ...pass, operation, actorKind, takeOver, session }),
                JSON.stringify({ pass, operation, actorKind, takeOver, session }),
              ).toEqual({ kind: "pass" });
  });

  it("人の操作は、生きている別のセッションの記録があっても拒まずに知らせる（セッションと --take-over によらない）", () => {
    for (const session of ["sess-b", undefined])
      for (const takeOver of [false, true]) {
        expect(sessionClaim({ actorKind: "human", session, takeOver })).toEqual({
          kind: "pass",
          warning: `t1 is being worked on by an agent in ${HOLDER}. A person's claim is not stopped, so it was done as asked; tell that session if it should stop`,
        });
        expect(
          sessionClaim({ actorKind: "human", session, takeOver, operation: "unclaim" }),
        ).toEqual({
          kind: "pass",
          warning: `t1 is being worked on by an agent in ${HOLDER}. A person's unclaim is not stopped, so it was done as asked; tell that session if it should stop`,
        });
      }
  });

  it("セッションがわからない AI の呼び出しは、--take-over がなくても拒まずに知らせる", () => {
    for (const takeOver of [false, true]) {
      expect(sessionClaim({ session: undefined, takeOver })).toEqual({
        kind: "pass",
        warning: `t1 is being worked on by ${HOLDER}. The session calling dg is unknown (the agent sets no session ID), so this claim could not be checked against it and was done as asked`,
      });
      expect(sessionClaim({ session: undefined, takeOver, operation: "unclaim" })).toEqual({
        kind: "pass",
        warning: `t1 is being worked on by ${HOLDER}. The session calling dg is unknown (the agent sets no session ID), so this unclaim could not be checked against it and was done as asked`,
      });
    }
  });

  it("--take-over は、別のセッションの AI のもう一度の claim と unclaim を通し、引き継いだことを知らせる", () => {
    for (const operation of ["claim", "unclaim"] as const)
      expect(sessionClaim({ takeOver: true, operation })).toEqual({
        kind: "pass",
        warning: `Took t1 over from ${HOLDER} with --take-over`,
        takenOver: true,
      });
  });
});

/** sess-a が Plan p1 を予約した記録の文（予約の対象を名指しする） */
const RESERVER = `session sess-a (it reserved p1 at ${CLAIMED_AT}; its last dg hook arrived at ${iso(5)})`;
/** 予約が止める操作 */
const RESERVED_OPERATIONS = ["start", "claim", "reserve", "next"] as const;
/** 既定：sess-a が p1 を予約して 10 分後に、別のセッション sess-b の AI が p1 のチケット t1 を claim する */
const reserved = (over: Partial<SessionClaimFacts> = {}) =>
  sessionClaim({ operation: "start", reserved: "p1", ...over });

describe("別のセッションが予約したチケットと Plan への操作（SY-5。claim の記録と同じ関数で決める）", () => {
  it("生きている別のセッションの予約があると、AI の claim・予約・dg next を拒み、予約したセッションと対象、操作ごとの越え方を示す", () => {
    const rejected = (cannot: string, how: string) => ({
      kind: "reject",
      code: "REJECTED",
      message: `t1 is being worked on by another session of yours: ${RESERVER}. This session (sess-b) cannot ${cannot} while that session is alive. Leave the ticket to that session. If that session has stopped, or a person told you to take the work over, add --take-over${how}. The record is ignored once SessionEnd reaches that session or no dg hook has reached it for 30 minutes`,
    });
    const moves = " (the reservation moves to this session)";
    expect(reserved()).toEqual(rejected("claim it", moves));
    expect(reserved({ operation: "reserve" })).toEqual(rejected("reserve it", moves));
    expect(reserved({ operation: "next" })).toEqual(
      rejected("advance it", ` to the call, together with --reserve${moves}`),
    );
    // もう一度の claim は、claim の記録と同じ言い回しで、予約の対象を名指しする
    expect(reserved({ operation: "claim" })).toEqual(
      rejected("claim it again", " (the record moves to this session)"),
    );
  });

  it("予約がない・予約したセッション自身・無視する予約（SessionEnd・30 分）は、操作・主体・--take-over がどれでも黙って通す", () => {
    const passing: Partial<SessionClaimFacts>[] = [
      { record: undefined },
      { session: "sess-a" },
      { endedAt: iso(5) },
      { now: after(35) },
    ];
    for (const pass of passing)
      for (const operation of RESERVED_OPERATIONS)
        for (const actorKind of ["agent", "human"] as const)
          for (const takeOver of [false, true])
            for (const session of pass.session ? ["sess-a"] : ["sess-b", undefined])
              expect(
                reserved({ ...pass, operation, actorKind, takeOver, session }),
                JSON.stringify({ pass, operation, actorKind, takeOver, session }),
              ).toEqual({ kind: "pass" });
  });

  it("人の操作とセッションがわからない AI の呼び出しは拒まずに知らせ、--take-over は越えて引き継いだことを返す", () => {
    for (const operation of RESERVED_OPERATIONS) {
      const did = operation === "start" || operation === "claim" ? "claim" : "call";
      for (const takeOver of [false, true]) {
        for (const session of ["sess-b", undefined])
          expect(reserved({ operation, actorKind: "human", session, takeOver })).toEqual({
            kind: "pass",
            warning: `t1 is being worked on by an agent in ${RESERVER}. A person's ${did} is not stopped, so it was done as asked; tell that session if it should stop`,
          });
        expect(reserved({ operation, session: undefined, takeOver })).toEqual({
          kind: "pass",
          warning: `t1 is being worked on by ${RESERVER}. The session calling dg is unknown (the agent sets no session ID), so this ${did} could not be checked against it and was done as asked`,
        });
      }
      expect(reserved({ operation, takeOver: true })).toEqual({
        kind: "pass",
        warning: `Took t1 over from ${RESERVER} with --take-over`,
        takenOver: true,
      });
    }
  });
});

describe("チケットに効いている予約（チケット自身、それを含む Plan の順）", () => {
  const CLOCK = { now: after(10), idleMs: IDLE_MS };
  const candidate = (
    target: string,
    session: string,
    over: Partial<ReservationCandidate> = {},
  ): ReservationCandidate => ({
    target,
    record: { session, claimed_at: CLAIMED_AT },
    lastHookAt: undefined,
    endedAt: undefined,
    ...over,
  });

  it("候補がなければなく、効く最初の候補を返す（チケットの予約が Plan の予約より先）", () => {
    expect(holdingReservation([], CLOCK)).toBeUndefined();
    const ticket = candidate("t1", "sess-b");
    const plan = candidate("p1", "sess-a");
    expect(holdingReservation([plan], CLOCK)).toBe(plan);
    expect(holdingReservation([ticket, plan], CLOCK)).toBe(ticket);
  });

  it("効かない予約（SessionEnd・30 分・読めない時刻）は飛ばし、次の候補を見る。どれも効かなければない", () => {
    const plan = candidate("p1", "sess-a");
    const dead: ReservationCandidate[] = [
      candidate("t1", "sess-b", { endedAt: iso(5) }),
      candidate("t1", "sess-b", { record: { session: "sess-b", claimed_at: iso(-30) } }),
      candidate("t1", "sess-b", { record: { session: "sess-b", claimed_at: "いつか" } }),
    ];
    for (const ticket of dead) {
      expect(holdingReservation([ticket, plan], CLOCK), JSON.stringify(ticket)).toBe(plan);
      expect(holdingReservation([ticket], CLOCK), JSON.stringify(ticket)).toBeUndefined();
    }
    // フックが届いていれば、記録から 30 分を過ぎても効く（候補ごとのフックの時刻で見る）
    const alive = candidate("t1", "sess-b", {
      record: { session: "sess-b", claimed_at: iso(-30) },
      lastHookAt: iso(5),
    });
    expect(holdingReservation([alive, plan], CLOCK)).toBe(alive);
  });

  it("チケットの claim の記録が呼んだセッションのものなら、別のセッションの予約（チケット・Plan）があっても効く予約はない。記録がない・別のセッションの記録・セッションがわからない呼び出しでは予約が効く", () => {
    const ticket = candidate("t1", "sess-b");
    const plan = candidate("p1", "sess-b");
    const claimBy = (session: string): SessionClaim => ({ session, claimed_at: CLAIMED_AT });
    for (const candidates of [[ticket], [plan], [ticket, plan]]) {
      const first = candidates[0];
      // claim の記録は呼んだセッション自身のもの：記録の古さによらず（呼んでいるので生きている）予約より優先する
      for (const claim of [claimBy("sess-a"), { session: "sess-a", claimed_at: iso(-600) }])
        expect(holdingReservation(candidates, CLOCK, { claim, session: "sess-a" })).toBeUndefined();
      const others: { claim: SessionClaim | undefined; session: string | undefined }[] = [
        { claim: undefined, session: "sess-a" },
        { claim: claimBy("sess-c"), session: "sess-a" },
        { claim: claimBy("sess-a"), session: undefined },
        { claim: undefined, session: undefined },
      ];
      for (const own of others)
        expect(holdingReservation(candidates, CLOCK, own), JSON.stringify(own)).toBe(first);
    }
  });

  it("todo のチケット（新しい claim）では、呼んだセッションの claim の記録が残っていても前の作業の周期のものとして数えず、別のセッションの予約が効いて claim を拒む", () => {
    const own = { claim: { session: "sess-b", claimed_at: CLAIMED_AT }, session: "sess-b" };
    for (const held of [candidate("t1", "sess-a"), candidate("p1", "sess-a")]) {
      expect(holdingReservation([held], CLOCK, { ...own, fresh: true })).toBe(held);
      // todo でなければ（もう一度の claim など）、同じ記録が予約より優先される
      expect(holdingReservation([held], CLOCK, { ...own, fresh: false })).toBeUndefined();
      const decision = reserved({
        record: held.record,
        reserved: held.target,
        lastHookAt: held.lastHookAt,
      });
      expect(decision.kind).toBe("reject");
    }
  });
});

describe("claim が push の前に書くチケットの予約（PL-7。t1158）", () => {
  /** 既定：sess-a が p1 を予約して 10 分後に、別のセッション sess-b の AI（予約を書ける）が p1 のチケット t1 を新しく claim する */
  const claimReservation = (over: Partial<ClaimReservationFacts> = {}) =>
    decideClaimReservation({
      ticket: "t1",
      operation: "start",
      record: { session: "sess-a", claimed_at: CLAIMED_AT },
      reserved: "p1",
      lastHookAt: iso(5),
      endedAt: undefined,
      now: after(10),
      idleMs: IDLE_MS,
      actorKind: "agent",
      session: "sess-b",
      takeOver: false,
      recordable: true,
      ...over,
    });
  const OPERATIONS = ["start", "claim"] as const;
  /** 効いている予約がない：予約がない・SessionEnd が届いた・30 分が過ぎた */
  const NOT_HELD: Partial<ClaimReservationFacts>[] = [
    { record: undefined },
    { endedAt: iso(5) },
    { now: after(35) },
  ];

  it("生きている別のセッションの予約があると、decideSessionClaim と同じ拒否を返し、予約は書かない", () => {
    for (const operation of OPERATIONS)
      for (const recordable of [true, false])
        expect(claimReservation({ operation, recordable })).toEqual(reserved({ operation }));
  });

  it("効いている予約がない新しい claim は、予約を書ける呼び出しなら予約を書く。もう一度の claim は書かない", () => {
    for (const none of NOT_HELD) {
      const label = JSON.stringify(none);
      for (const takeOver of [false, true]) {
        expect(claimReservation({ ...none, takeOver }), label).toEqual({
          kind: "pass",
          write: true,
        });
        expect(claimReservation({ ...none, takeOver, operation: "claim" }), label).toEqual({
          kind: "pass",
          write: false,
        });
      }
    }
  });

  it("呼んだセッションの予約がすでに効いている claim は、書かない（--take-over を付けても）", () => {
    for (const operation of OPERATIONS)
      for (const takeOver of [false, true])
        expect(claimReservation({ operation, session: "sess-a", takeOver })).toEqual({
          kind: "pass",
          write: false,
        });
  });

  it("--take-over で越えた claim は、新しい claim でももう一度の claim でも、引き継いだことを知らせて予約を書く", () => {
    for (const operation of OPERATIONS)
      expect(claimReservation({ operation, takeOver: true })).toEqual({
        kind: "pass",
        warning: `Took t1 over from ${RESERVER} with --take-over`,
        write: true,
      });
  });

  it("予約を書けない呼び出し（人・セッションのわからない AI・記録に使えないセッションの ID）は、予約があってもなくても書かず、知らせは decideSessionClaim のまま返す", () => {
    const callers: Partial<ClaimReservationFacts>[] = [
      { actorKind: "human" },
      { actorKind: "human", session: undefined },
      { session: undefined },
      // 記録に使えない形の ID のセッション（別のセッションとは言えるので、--take-over で越える）
      { takeOver: true },
    ];
    for (const caller of callers)
      for (const operation of OPERATIONS) {
        const facts = { ...caller, operation, recordable: false };
        const told = reserved({ ...caller, operation });
        expect(told).toMatchObject({ kind: "pass", warning: expect.any(String) });
        expect(claimReservation(facts), JSON.stringify(facts)).toEqual({
          kind: "pass",
          warning: (told as { warning: string }).warning,
          write: false,
        });
        for (const none of NOT_HELD)
          expect(claimReservation({ ...facts, ...none }), JSON.stringify(facts)).toEqual({
            kind: "pass",
            write: false,
          });
      }
  });
});

describe("claim が取れなかったときの、push の前に書いた予約の戻し方（t1158）", () => {
  const written: SessionClaim = { session: "sess-b", claimed_at: iso(10) };
  const previous: SessionClaim = { session: "sess-a", claimed_at: CLAIMED_AT };

  it("今の予約が書いたもののままなら、書く前の予約に戻し、なかったなら消す", () => {
    expect(decideReservationRollback({ written, previous, current: { ...written } })).toEqual({
      kind: "restore",
      record: previous,
    });
    expect(
      decideReservationRollback({ written, previous: undefined, current: { ...written } }),
    ).toEqual({ kind: "remove" });
  });

  it("今の予約が書いたものと違う（消えた・別のセッションが引き継いだ・同じセッションが書き直した）なら、触らない", () => {
    const changed: (SessionClaim | undefined)[] = [
      undefined,
      { session: "sess-c", claimed_at: written.claimed_at },
      { session: written.session, claimed_at: iso(12) },
    ];
    for (const current of changed)
      for (const before of [previous, undefined])
        expect(
          decideReservationRollback({ written, previous: before, current }),
          JSON.stringify({ current, before }),
        ).toEqual({ kind: "keep" });
  });
});
