// 品質ゲートの判定（EX-3・TK-9、ADR-011）。事実（GateFacts）と判定の結果（GateView）を受け取って決めるだけで、
// git・gh・ファイルを読まない（import は型と定数と純粋な関数だけ）。事実を集めて検査を回すのは gate.ts、gh を呼ぶのは pr.ts。
// 判定の組み合わせ（段 × for × 事実）は gate-judge.test.ts が git なしで確かめ、git を通すテストは経路の代表だけを見る
//
// 検査（actions.test）は遅いので、決める処理は 2 段に分ける：
//   1. judgeBeforeCheck：検査のほかの条件を決め、検査を回すか（check）を返す
//   2. concludeGate：回した検査の結果を入れて、結論（GateView）を出す
// dg pr ready・dg pr merge は、その結論から越えた条件と止める条件を gatePassage で出す

import type { BranchTip, PrGateFacts } from "../git/facts.js";
import { REVIEW_STEP, type Run } from "../model/run.js";
import { gateScopeOf, type GateLevel } from "../model/ticket.js";
import type { CheckOutcome } from "./gate-check.js";
import { APPROVAL_OVERRIDES, NEVER_OVERRIDDEN } from "./pr-approval.js";

/** 重い指摘を直す回数の上限（見直しは最初を含めて 3 回まで。the "Limit" section of `dg guide review`） */
export const FIX_ROUNDS_LIMIT = 2;

export const GATE_STAGES = ["ready", "merge"] as const;
export type GateStage = (typeof GATE_STAGES)[number];

const GATE_CONDITIONS = [
  "pr",
  "acceptance",
  "review",
  "fix_rounds",
  "mergeable",
  "head",
  "check",
] as const;
export type GateConditionId = (typeof GATE_CONDITIONS)[number];

interface GateCondition {
  id: GateConditionId;
  ok: boolean;
  /** 判定の材料か、満たさない理由（1 文） */
  detail: string;
  /** ほかの条件が満たされず検査を回さなかった印。理由の文を判定に使わない */
  not_run?: true;
}

export interface GateView {
  ticket: string;
  /** ready は PR を出す前（gh pr ready）、merge はマージの前（gh pr merge） */
  for: GateStage;
  /** 判定した段（チケットの gate。ないときは high。TK-9） */
  gate: GateLevel;
  pr: number | null;
  /** 判定した PR の先端のコミット（gh の headRefOid）。PR を読めなければ null。dg pr merge はこの SHA を --match-head-commit で渡す（t750） */
  sha: string | null;
  passed: boolean;
  conditions: GateCondition[];
}

/**
 * PR の事実（gh pr view の結果）。読めなかったときも値で持つ：
 * no_selector はチケットに PR の番号も作業ブランチもない（gh を呼んでいない）、missing は PR がない、
 * unreadable は gh がない・読めない（reason は理由の文）
 */
export type PrFact =
  | { kind: "no_selector" }
  | { kind: "missing"; selector: string }
  | { kind: "unreadable"; reason: string }
  | { kind: "read"; pr: PrGateFacts };

/** 見直しの判定に使う Run の項目（閉じた Run・実行中の Run・持ち主のない保留を同じ形で受ける） */
export type ReviewRun = Pick<
  Run,
  "id" | "step" | "head" | "started_at" | "finished_at" | "result" | "review"
>;

/** 見直しの事実。tip は作業ブランチのリモートの先端（読めなければ null）、runs はチケットの見直しの Run を開始の順に */
export interface ReviewFacts {
  tip: BranchTip | null;
  runs: readonly ReviewRun[];
}

/**
 * 品質ゲートの判定に使う事実。段と for が判定しない条件の事実は読まず（gateReads）、空の値（acceptance は []、
 * review は tip: null と runs: []、latest は null）で渡す。判定はその事実を見ない
 */
export interface GateFacts {
  ticket: string;
  /** チケットの段（gate。ないときは high） */
  level: GateLevel;
  for: GateStage;
  /** チケットに記録した PR の番号（gh で読めなかったときに、結果の pr に出す） */
  recordedPr: number | null;
  /** 作業ブランチを切った時刻（修正ループの回数を数え始める時刻） */
  branchAt: string | undefined;
  pr: PrFact;
  /** 受け入れ条件の項目（チケットの本文から） */
  acceptance: ReadonlyArray<{ index: number; checked: boolean }>;
  review: ReviewFacts;
  /** 作業ブランチの最新のコミット（リモートがあればリモートの先端）。読めなければ null */
  latest: string | null;
  /** actions.test が空でないか。空なら検査は回さずに通すので、ほかの条件によらず判定する */
  checkConfigured: boolean;
}

/** 検査のほかの条件を決めた結果（1 段目） */
interface GateDraft {
  ticket: string;
  for: GateStage;
  gate: GateLevel;
  pr: number | null;
  sha: string | null;
  /** 検査のほかの条件（判定する順） */
  conditions: GateCondition[];
  /**
   * 検査の扱い。out_of_scope は段が判定しない（free）、judge は判定する（回すか、覚えた結果を使う）、
   * not_run はほかの条件を満たさないので回さない
   */
  check: "out_of_scope" | "judge" | "not_run";
}

const short = (sha: string) => sha.slice(0, 8);

/**
 * 段と for が判定に使う事実（どれを読むか）。集める側（gate.ts）と決める側が同じ表を使う。
 * 受け入れ条件は、PR を出す前は付けられない項目の理由を PR の本文に書けばよいので見ない。
 * 最新のコミット（latest）は head の条件に使い、見直しも検査も判定しない free では比べない
 */
export function gateReads(
  level: GateLevel,
  stage: GateStage,
): { acceptance: boolean; review: boolean; latest: boolean } {
  const scope = gateScopeOf(level);
  return {
    acceptance: stage === "merge" && scope.acceptance,
    review: scope.review,
    latest: stage === "merge" && (scope.review || scope.check),
  };
}

/**
 * 見直しが作業ブランチのリモートの先端（tip）を見直したか（t763）。見直した SHA（Run の head）があれば先端の SHA と同じか、
 * なければ（この項目より前の Run・読めなかった Run）見直しの開始が先端のコミットの時刻より後か（push した時刻は Git に残らないので近似）。
 * SHA で比べるのは、見直しの前に作って後で push したコミット・時計のずれ・古いコミットへの force-push を時刻では見分けられないため。
 * dg gate の review と dg next の段階が同じ関数で判定する
 */
export function reviewedTip(run: Pick<Run, "head" | "started_at">, tip: BranchTip): boolean {
  return run.head !== undefined ? run.head === tip.sha : run.started_at >= tip.at;
}

/**
 * 修正ループの回数：このブランチ（branch_at より後）の見直しのうち、結果に重い指摘が出た回の数。
 * 実行中でも結果を記録した見直しは数える（dg gate の fix_rounds と dg next の段階が同じ数を使う）
 */
export function heavyReviewRounds(
  runs: ReadonlyArray<Pick<Run, "step" | "started_at" | "review">>,
  branchAt: string | undefined,
): number {
  const since = branchAt ?? "";
  return runs.filter(
    (r) =>
      r.step === REVIEW_STEP && r.started_at >= since && r.review !== null && r.review.heavy > 0,
  ).length;
}

/** PR の条件（pr）。マージの前は draft も満たさない */
function prCondition(pr: PrFact, stage: GateStage): GateCondition {
  const unmet = (detail: string): GateCondition => ({ id: "pr", ok: false, detail });
  if (pr.kind === "no_selector") return unmet("The ticket has neither a PR nor a work branch");
  if (pr.kind === "unreadable") return unmet(`Cannot check the PR: ${pr.reason}`);
  if (pr.kind === "missing") return unmet(`No PR (${pr.selector})`);
  const { number, state, isDraft } = pr.pr;
  if (state !== "OPEN") return unmet(`PR #${number} is not open (${state})`);
  if (stage === "merge" && isDraft) return unmet(`PR #${number} is still a draft`);
  return { id: "pr", ok: true, detail: `PR #${number} is open${isDraft ? " (draft)" : ""}` };
}

function acceptanceCondition(items: GateFacts["acceptance"]): GateCondition {
  const unchecked = items.filter((i) => !i.checked).map((i) => i.index);
  return {
    id: "acceptance",
    ok: unchecked.length === 0,
    detail:
      unchecked.length === 0
        ? `All ${items.length} acceptance criteria are marked`
        : `Acceptance criteria ${unchecked.join(", ")} are not marked`,
  };
}

/** 見直しの条件（review）：リモートの先端を見直した最後の見直しが、閉じていて通っている */
function reviewCondition({ tip, runs }: ReviewFacts): GateCondition {
  const unmet = (detail: string): GateCondition => ({ id: "review", ok: false, detail });
  if (tip === null) return unmet("Cannot read the remote tip of the work branch (the last push)");
  // リモートの先端と比べる（見直した SHA があれば SHA、なければ先端のコミットの時刻。reviewedTip）
  const latest = runs.filter((r) => reviewedTip(r, tip)).at(-1);
  if (!latest)
    return unmet(
      `No review of the last push (remote tip ${short(tip.sha)}, committed at ${tip.at})`,
    );
  if (latest.finished_at === null)
    return unmet(`Review ${latest.id} of the last push has not finished`);
  if (latest.result !== "success")
    return unmet(`Review ${latest.id} of the last push closed as ${latest.result}`);
  if (latest.review === null)
    return unmet(`The result of review ${latest.id} is not recorded (dg run review-result)`);
  if (!latest.review.passed)
    return unmet(`Review ${latest.id} did not pass (${latest.review.heavy} heavy findings)`);
  return { id: "review", ok: true, detail: `Review ${latest.id} of the last push passed` };
}

function fixRoundsCondition(runs: readonly ReviewRun[], branchAt: string | undefined) {
  const rounds = heavyReviewRounds(runs, branchAt);
  const ok = rounds <= FIX_ROUNDS_LIMIT;
  const condition: GateCondition = {
    id: "fix_rounds",
    ok,
    detail: ok
      ? `${rounds} review rounds found heavy findings (limit ${FIX_ROUNDS_LIMIT})`
      : `${rounds} review rounds found heavy findings, which exceeds the limit of ${FIX_ROUNDS_LIMIT}. Ask the human whether to continue`,
  };
  return condition;
}

/** base と衝突しない（mergeable）。PR を読めなければ満たさない */
function mergeableCondition(pr: PrFact): GateCondition {
  if (pr.kind !== "read")
    return {
      id: "mergeable",
      ok: false,
      detail: "Cannot read the PR, so conflicts cannot be checked",
    };
  const { mergeable } = pr.pr;
  return {
    id: "mergeable",
    ok: mergeable === "MERGEABLE",
    detail:
      mergeable === "MERGEABLE"
        ? "No conflict with base"
        : `mergeable is ${mergeable} (there is a conflict, or it is still being computed. Wait a moment and check again)`,
  };
}

/**
 * PR の先端は、見直しと検査が判定したブランチの最新のコミット（リモートの先端）と同じでなければならない（t750）。
 * 違えば判定していないコミットをマージすることになるので通さない
 */
function headCondition(pr: PrGateFacts, latest: string): GateCondition {
  const same = pr.head === latest;
  return {
    id: "head",
    ok: same,
    detail: same
      ? `PR #${pr.number}'s head ${short(latest)} is the latest commit of the work branch`
      : pr.head === undefined
        ? `Cannot read the head commit of PR #${pr.number} from gh, so it cannot be compared with the work branch`
        : `PR #${pr.number}'s head ${short(pr.head)} is not the latest commit of the work branch (${short(latest)}). Push or fetch so they match, then judge again`,
  };
}

/**
 * 検査のほかの条件を決め、検査を回すかを返す（1 段目）。gh・Git が読めなかった事実の条件は満たさないとする（判定できないものを通さない）。
 * 判定する条件はチケットの段（TK-9）で決まる。high はすべて、low は見直し（review・fix_rounds）を除き、
 * free は pr と（マージの前の）mergeable だけ。判定しない条件は conditions に出さない。
 * waived は、人の承認で越える条件（dg pr merge --approved-by だけが渡す。t884）。判定は変えず（満たさない条件は ok: false のまま返す）、
 * 検査を回すかだけに使う：ほかの満たさない条件がすべて越えられるなら、検査を「回さなかった」で落とさずに回す
 * （検査が一覧になければ、検査は実際に通らなければならないため。一覧にあっても、通ったかどうかを PR に残す記録を事実にするため）
 */
export function judgeBeforeCheck(
  facts: GateFacts,
  waived: ReadonlySet<GateConditionId> = new Set(),
): GateDraft {
  const stage = facts.for;
  const reads = gateReads(facts.level, stage);
  const conditions: GateCondition[] = [prCondition(facts.pr, stage)];
  if (reads.acceptance) conditions.push(acceptanceCondition(facts.acceptance));
  // 見直しは段が判定するときだけ（high）
  if (reads.review)
    conditions.push(
      reviewCondition(facts.review),
      fixRoundsCondition(facts.review.runs, facts.branchAt),
    );
  if (stage === "merge") {
    conditions.push(mergeableCondition(facts.pr));
    // 最新のコミットを読めないときは、見直し（review）と検査（check）が別の条件で落ちるので比べない。
    // free は見直しも検査も判定しないので比べず、マージは判定した PR の先端（sha）に固定する
    if (reads.latest && facts.pr.kind === "read" && facts.latest !== null)
      conditions.push(headCondition(facts.pr.pr, facts.latest));
  }
  // 検査（actions.test）。free は回さない。時間がかかるので、ほかの条件をすべて満たしたときだけ回す（空なら回さずに通すので、いつでも判定する）
  const check = !gateScopeOf(facts.level).check
    ? "out_of_scope"
    : !facts.checkConfigured || conditions.every((c) => c.ok || waived.has(c.id))
      ? "judge"
      : "not_run";
  const read = facts.pr.kind === "read" ? facts.pr.pr : undefined;
  return {
    ticket: facts.ticket,
    for: stage,
    gate: facts.level,
    pr: read?.number ?? facts.recordedPr,
    sha: read?.head ?? null,
    conditions,
    check,
  };
}

/**
 * 1 段目の結果に検査の結果を入れて結論を出す（2 段目）。check は、1 段目が judge を返したときに回した検査の結果
 * （ほかのときは渡さない）
 */
export function concludeGate(draft: GateDraft, check?: CheckOutcome): GateView {
  const conditions = [...draft.conditions];
  if (draft.check === "judge") {
    if (!check) throw new Error("The check was to be judged, but no result was given");
    conditions.push({ id: "check", ok: check.ok, detail: check.detail });
  } else if (draft.check === "not_run")
    conditions.push({
      id: "check",
      ok: false,
      detail: "The other conditions are not met, so the check (actions.test) was not run",
      not_run: true,
    });
  return {
    ticket: draft.ticket,
    for: draft.for,
    gate: draft.gate,
    pr: draft.pr,
    sha: draft.sha,
    passed: conditions.every((c) => c.ok),
    conditions,
  };
}

/**
 * 人の承認で越える条件。承認（approved。dg pr merge --approved-by の人）があるマージだけが APPROVAL_OVERRIDES の条件を越え、
 * 承認がなければ何も越えない（--auto でも越えない）。ready は越えない（満たさないまま出すのは人が gh を打つ）
 */
export function waivedBy(stage: GateStage, approved: boolean): ReadonlySet<GateConditionId> {
  return new Set<GateConditionId>(stage === "merge" && approved ? APPROVAL_OVERRIDES : []);
}

/**
 * dg pr ready・dg pr merge がゲートの結果から進むか止めるか。進むときは越えた条件（overridden）、
 * 止めるときは満たさない条件と理由の行（failed）と、承認があっても越えられない条件（blocking）
 */
type GatePassage =
  | {
      proceed: true;
      pr: number;
      /** 判定した PR の先端。merge で進むときは null にならない */
      sha: string | null;
      overridden: GateConditionId[];
    }
  | { proceed: false; failed: string[]; blocking: string[] };

/**
 * ゲートの結果から、越えた条件と止める条件を出す。waived（waivedBy）の条件は満たさなくても越え、ほかの満たさない条件が
 * 1 つでもあれば止める。PR（pr）・衝突（mergeable）・先端（head と sha）は、承認があっても越えない（t884）。
 * マージは判定した先端に固定するので、先端が読めなければ止める（ready は固定しないので先端は要らない。t750）
 */
export function gatePassage(gate: GateView, waived: ReadonlySet<GateConditionId>): GatePassage {
  const unmet = gate.conditions.filter((c) => !c.ok);
  const overridden = unmet.filter((c) => waived.has(c.id)).map((c) => c.id);
  const unpinned = gate.for === "merge" && gate.sha === null;
  if (overridden.length === unmet.length && gate.pr !== null && !unpinned)
    return { proceed: true, pr: gate.pr, sha: gate.sha, overridden };
  const failed = unmet.map((c) => `${c.id}: ${c.detail}`);
  // 承認があっても越えられない条件（承認がないときは、承認を得ても残る条件を案内に出す）
  const overridable = new Set<GateConditionId>(APPROVAL_OVERRIDES);
  const blocking: string[] = unmet.filter((c) => !overridable.has(c.id)).map((c) => c.id);
  // free は head の条件を判定しないので、先端が読めなかったときは理由を足す（落とした理由が空にならないように）
  if (unpinned && !gate.conditions.some((c) => c.id === "head")) {
    failed.push(
      "head: cannot read the PR head commit from gh, so the merge cannot be pinned to the judged commit",
    );
    blocking.push("head");
  }
  return { proceed: false, failed, blocking };
}

/**
 * GATE_FAILED の detail の、満たさないまま進める道の案内。ready は人が gh を打つ。merge は人に聞き、承認されたら agent が
 * --approved-by でマージする（越えられるのは APPROVAL_OVERRIDES の条件。t884）。
 * blocking は、承認があっても越えられない満たさない条件
 */
function proceedHint(ticketId: string, stage: GateStage, blocking: readonly string[]): string {
  if (stage === "ready")
    return "Proceeding without meeting it (the review cannot be started, the fix loop went past its limit, or a human set the count) is a human decision, so ask a human to run gh pr ready (dg guide review)";
  if (blocking.length > 0)
    return `A person's approval does not override ${blocking.join(", ")} (${NEVER_OVERRIDDEN}), so resolve them first. Do not ask a person to run gh pr merge`;
  return `Merging without meeting it is a human decision, and it always needs a person's approval (fixed in Core; neither the config nor workflow.yaml changes it, and a flow that goes ahead without asking does not skip it): show a person these unmet conditions and ask whether to merge anyway. Only when the person approves, run dg pr merge ${ticketId} --approved-by human (the approval overrides ${APPROVAL_OVERRIDES.join(", ")}). Do not ask a person to run gh pr merge, and never pass --approved-by without a person's approval`;
}

/** 止めるとき（gatePassage の proceed: false）の GATE_FAILED の文（message）と、満たさない条件と進め方の案内（detail） */
export function gateFailure(
  gate: Pick<GateView, "ticket" | "for">,
  stopped: { failed: readonly string[]; blocking: readonly string[] },
): { message: string; detail: string } {
  const { ticket, for: stage } = gate;
  return {
    message: `${ticket} does not meet the quality gate (dg gate ${ticket} --for ${stage}), so gh pr ${stage} is not called`,
    detail: `${stopped.failed.join("\n")}\n${proceedHint(ticket, stage, stopped.blocking)}. If the level of the ticket does not fit the change, a person changes it with dg ticket update ${ticket} --gate <level> (only a person can lower it; an agent's call is rejected), then run dg pr ${stage} again`,
  };
}
