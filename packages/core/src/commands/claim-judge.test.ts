// ticket claim の拒否ともう一度の claim かどうかの決定の組み合わせ（status・担当・PR・仮番号・--retry-reason・--branch）を、
// git なしで確かめる。取り込んだ後の値で決める経路（古い索引・push に負けた後のやり直し）と、Run を開いて前の手直しを閉じる経路は
// commands-flow-reclaim.test.ts の代表の件が見る。境目の方針と担当の付け替えの許可は commands-flow-ticket.test.ts
import { describe, expect, it } from "vitest";
import { OperationError, UsageError } from "../errors.js";
import { STATUSES } from "../model/common.js";
import {
  claimRejectionError,
  decideClaim,
  decideReclaim,
  workBranchName,
  type ClaimFacts,
  type ClaimRejection,
  type ReclaimFacts,
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
