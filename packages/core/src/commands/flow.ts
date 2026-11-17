// Iteration の流れの段階と次の手（EX-3・EX-8、ADR-030）。流れの 8 つの規則（ここが正本。guide-all は書かない）を、
// チケット・Plan の事実と関所の記録（Iteration の checkpoints。dg checkpoint が足す）から都度求め、段階は保存しない（dg next と同じ考え）。
// 段階を返すだけで、エージェントを起動も監視もしない（EX-1）。割り当て・点検・見直しを終えたかは、記録とその根拠（flow-records.ts）で決めるので、
// 会話・人・マシンをまたいで続きから進む。止まる判定（同じ段階が事実も変わらずに続いた）だけは、前に返した段階を deguboard-local に覚えて行う

import { createHash } from "node:crypto";
import { z } from "zod";
import { composeGuide, readStageGuide } from "../guide/guide.js";
import { isFinishedSet, isTerminal } from "../model/common.js";
import { compareIds, type IterationId } from "../model/id.js";
import type { Checkpoint, CheckpointStage } from "../model/iteration.js";
import {
  GATE_LEVELS,
  gateLevelOf,
  lowersGate,
  type GateLevel,
  type Ticket,
} from "../model/ticket.js";
import type { Decision, FlowDecidedStage } from "../model/workflow.js";
import { autoApplies, judgeDecisions, type Permission } from "../workflow/conditions.js";
import { DEFAULT_WORKFLOW, type CustomStage } from "../workflow/resolve.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import {
  askedCandidates,
  auditDoneOf,
  auditedWith,
  checkFactsOf,
  checkedWith,
  flowCandidates,
  iterationCheckpoints,
  passed,
  passedStages,
  readFlowLocal,
  releaseScopeOf,
  resolveFlowTarget,
  writeFlowLocal,
} from "./flow-records.js";
import { agentDg as dg, sortedDocs } from "./helpers.js";
import { wipCheckOf } from "./next.js";

/**
 * 流れの段階。飛ばせる段階（workflow.yaml の flow の skip に書ける、dg flow next が返す段階）に、終わった Plan を閉じる close
 * （規則 4 の一部で、飛ばせない）と、規則 8（どれにも当たらない）と同じ段階が事実も変わらずに続いたときの stop を足す
 */
export const FLOW_STAGES = [
  "assign",
  "check",
  "plan",
  "work",
  "audit",
  "release",
  "close",
  "stop",
] as const;
export type FlowStageName = (typeof FLOW_STAGES)[number];

/** 関所を持つ流れの段階（dg flow next が返す段階のうち。retro は流れの外で、手順が関所を呼ぶ） */
const CHECKPOINT_OF: Partial<Record<FlowStageName, CheckpointStage>> = {
  assign: "assign",
  check: "check",
  audit: "audit",
  release: "release",
};

type FlowTicket = Pick<Ticket, "id" | "status">;

/** 段階を求める材料（事実）。テストは事実を直に渡して規則ごとに確かめる */
export interface FlowFacts {
  /** 対象の Iteration（<S>）。チケットか Plan の指定で、Iteration が 1 つに決まらなければ null */
  iteration: string | null;
  /** <S> が閉じている（リリースして閉じた後）。<S> がなければ false */
  iterationClosed: boolean;
  /** 対象のチケット */
  targets: readonly FlowTicket[];
  /**
   * 見直しとリリースの判定で「すべて done か abandoned」を見るチケット。Iteration の指定では対象と同じ、
   * チケットの指定では対象とその Iteration のチケット（guide-all の「Deciding the target」）。<S> がなければ空。
   * ラベル release-<S> のチケット（リリースの段で起票する 2 つ）は除く。リリースの段の途中で残っていても、リリースを返し続けるため
   */
  releaseScope: readonly FlowTicket[];
  /** 割り当ての候補（flow-records.ts の flowCandidates） */
  candidates: readonly string[];
  /** 割り当ての関所の記録が見た候補。ここにない候補（記録のあとに増えた分）だけを聞き直す */
  asked: readonly string[];
  /** 今のチケットの事実で通った点検の関所の記録がある（チケットが変わると偽に戻る） */
  checked: boolean;
  /** 今 done のチケットをすべて見た見直しの関所の記録がある（そのあとにマージされたチケットがあると偽に戻る） */
  audited: boolean;
  /** リリースの関所の記録がある（iteration reopen のあとは偽に戻る） */
  releasePassed: boolean;
  /**
   * 数える関所の記録のある段階の名前。根拠を持たない段階（振り返りと独自の段階）を終えたかを、名前があるかで決める
   * （iteration reopen のあとは空に戻る）
   */
  passedStages: readonly string[];
  /** 対象のチケットを含む承認待ちの Plan（番号順） */
  pendingPlans: readonly { id: string; tickets: readonly string[] }[];
  /**
   * 対象のチケットを含む承認済みの開いた Plan（番号順）。unfinished は終わっていないチケット、
   * finished は Plan のチケットが「終わった」（isFinishedSet）こと。終わったものは規則 4 で閉じる
   */
  approvedPlans: readonly { id: string; unfinished: readonly string[]; finished: boolean }[];
  /** 対象のうち、開いた Plan に入っていない todo（ラベル release-<S> を除く。リリースの手順で進めるので計画しない） */
  unplanned: readonly string[];
  /** --no-assign */
  noAssign: boolean;
}

/** 独自の段階のうち、段階を求めるのに要るもの（名前と位置） */
type CustomStagePlace = Pick<CustomStage, "id" | "after">;

export interface FlowStage {
  /** 段階の名前。同梱の段階（FlowStageName）か、独自の段階の名前（workflow.yaml の flow の鍵） */
  name: string;
  /** 当たった規則の番号（flowStageOf の 1〜8）。同じ段階が続いて止まったときと、独自の段階は null */
  rule: number | null;
  /** 独自の段階が続く同梱の段階（workflow.yaml の after）。同梱の段階は null */
  after: string | null;
  /** 段階を決めた事実（1 文） */
  reason: string;
  /** 段階の Plan（規則 3・4）。なければ null */
  plan: string | null;
  /** 段階の相手のチケット（割り当ての候補・承認待ちの Plan のチケット・終わっていないチケット・Plan に入っていない todo） */
  tickets: string[];
}

const allFinished = (tickets: readonly FlowTicket[]) => isFinishedSet(tickets.map((t) => t.status));

/**
 * 事実（関所の記録を数えた結果を含む）から、8 つの規則（--help に並べた順）で最初に当たる段階を求める（純粋関数）。
 * skip（workflow.yaml の flow の skip）の段階は規則を読まず、次の規則に進む。見直しを飛ばすと、すべて終わったときはすぐリリースに進める。
 * skip には振り返り（retro。dg flow next は返さない）と独自の段階も書けるので、名前は文字列で受ける。
 * 関所の記録は Iteration に書くので、Iteration が 1 つに決まらない流れは割り当て（Iteration を決める）だけを返し、決まらなければ止まる。
 *
 * 独自の段階（custom。workflow.yaml の flow の decide・after・guide）は、after の同梱の段階を終えた（か飛ばした）ところで、
 * 次の同梱の段階の前に返す。同じ after のものは書いた順に 1 つずつ。関所の記録があれば終えたものとし、skip に書けば返さない。
 * after ごとの「終えた」は次のとおり（閉じた Iteration では、流れを終えた後の release・retro のあとの段階だけを返す）：
 * - assign：割り当ての規則 1 に当たらない（Iteration が決まっている）
 * - check：点検の規則 2 に当たらない
 * - plan：承認待ちの Plan も、Plan に入っていない todo もない（計画が残るうちは返さない）
 * - work：すべて done か abandoned（見直しの前）
 * - audit：見直しを終えた（リリースの前）
 * - release：Iteration が閉じた（release を飛ばす流れでは、すべて終えて見直しも終えた）
 * - retro：release のあとで、振り返りの関所の記録がある（振り返りは流れの外なので、flow next は振り返りを返さずに待つ）
 */
export function flowStageOf(
  facts: FlowFacts,
  skip: readonly string[] = [],
  custom: readonly CustomStagePlace[] = [],
): FlowStage {
  const audited = facts.audited;
  const s = facts.iteration;
  // 記録のあとに増えた候補だけを聞き直す（人が「入れない」と決めた候補は聞き直さない）
  const fresh = facts.candidates.filter((id) => !facts.asked.includes(id));
  const skipped = (name: FlowStageName | "retro") => skip.includes(name);
  const at = (
    name: FlowStageName,
    rule: number,
    reason: string,
    tickets: readonly string[] = [],
    plan: string | null = null,
  ): FlowStage => ({ name, rule, after: null, reason, plan, tickets: [...tickets] });
  /** after のあとに置いた独自の段階のうち、まだ関所を通っていない最初のもの（書いた順） */
  const own = (after: CustomStagePlace["after"]): FlowStage | undefined => {
    const next = custom.find(
      (c) => c.after === after && !skip.includes(c.id) && !facts.passedStages.includes(c.id),
    );
    return (
      next && {
        name: next.id,
        rule: null,
        after,
        reason: `The stage ${next.id} of this board comes after ${after}, and its checkpoint is not passed`,
        plan: null,
        tickets: [],
      }
    );
  };
  /** 流れを終えた後（release と retro のあと）の独自の段階 */
  const ownAfterFlow = () =>
    own("release") ??
    (skipped("retro") || facts.passedStages.includes("retro") ? own("retro") : undefined);
  const closed = facts.iterationClosed;
  /** 流れの途中（release より前）の独自の段階。閉じた Iteration では返さない（閉じた後に足した段階で、終えた流れを戻さない） */
  const ownBefore = (after: CustomStagePlace["after"]) => (closed ? undefined : own(after));
  if (!skipped("assign") && !audited && fresh.length > 0 && !facts.noAssign)
    return at(
      "assign",
      1,
      s === null
        ? `${fresh.length} target tickets are not in an Iteration, and the flow needs one Iteration (its checkpoints are recorded there), so decide it`
        : `${fresh.length} tickets are not in an Iteration, and no assign checkpoint has seen them`,
      fresh,
    );
  if (s === null) {
    const open = facts.targets.filter((t) => !isTerminal(t.status)).map((t) => t.id);
    return at(
      "stop",
      8,
      allFinished(facts.targets) && facts.targets.length > 0
        ? "Every target ticket is finished, but no single Iteration is determined, so there is no audit or release"
        : facts.targets.length === 0
          ? "There are no target tickets"
          : "No single Iteration is determined for the target tickets, and the checkpoints of the flow are recorded on an Iteration. Put them into one Iteration (dg iteration add), or give the tickets of one Iteration",
      open,
    );
  }
  const afterAssign = ownBefore("assign");
  if (afterAssign) return afterAssign;
  if (!skipped("check") && !facts.checked)
    return at(
      "check",
      2,
      `No check checkpoint of ${s} matches the current tickets (not checked yet, or the tickets changed after the check)`,
    );
  const afterCheck = ownBefore("check");
  if (afterCheck) return afterCheck;
  const pending = skipped("plan") ? undefined : facts.pendingPlans[0];
  if (pending)
    return at("plan", 3, `Plan ${pending.id} is awaiting approval`, pending.tickets, pending.id);
  // 計画のあとの段階は、作業の前に返す。Plan に入っていない todo が残るうちは、計画（規則 5）が残っているので返さない
  const afterPlan = skipped("plan") || facts.unplanned.length === 0 ? ownBefore("plan") : undefined;
  if (afterPlan) return afterPlan;
  const working = skipped("work")
    ? undefined
    : facts.approvedPlans.find((p) => p.unfinished.length > 0);
  if (working)
    return at(
      "work",
      4,
      `The approved Plan ${working.id} has ${working.unfinished.length} unfinished tickets`,
      working.unfinished,
      working.id,
    );
  // 終わった承認済みの Plan は閉じる（規則 4 の一部）。閉じると規則 5 の計画に進める
  const finishedPlan = skipped("work") ? undefined : facts.approvedPlans.find((p) => p.finished);
  if (finishedPlan)
    return at(
      "close",
      4,
      `The approved Plan ${finishedPlan.id} is finished (every ticket is done or abandoned), so it is closed`,
      [],
      finishedPlan.id,
    );
  if (!skipped("plan") && facts.unplanned.length > 0)
    return at(
      "plan",
      5,
      `${facts.unplanned.length} todo tickets are not in an open Plan`,
      facts.unplanned,
    );
  // 閉じた Iteration は流れを終えている。見直しとリリースを返すと、閉じた後の呼び出しでリリースを繰り返す
  const open = facts.targets.filter((t) => !isTerminal(t.status)).map((t) => t.id);
  if (closed)
    return ownAfterFlow() ?? at("stop", 8, `${s} is closed, and the flow is finished`, open);
  if (allFinished(facts.releaseScope)) {
    const afterWork = own("work");
    if (afterWork) return afterWork;
    if (!audited && !skipped("audit"))
      return at(
        "audit",
        6,
        `Every ticket in ${s} is done or abandoned, and no audit checkpoint has seen all the done tickets (not audited yet, or tickets were merged after the audit)`,
      );
    const afterAudit = own("audit");
    if (afterAudit) return afterAudit;
    if (skipped("release"))
      return (
        ownAfterFlow() ??
        at("stop", 8, `Every ticket in ${s} is finished, and release is skipped in the flow`, open)
      );
    return at(
      "release",
      7,
      `Every ticket in ${s} is done or abandoned, and ${
        audited ? "it is audited" : "the audit is skipped in the flow"
      } (${
        facts.releasePassed
          ? "the release checkpoint is passed, so go on with the release steps until the Iteration is closed"
          : "the release checkpoint is not passed yet"
      })`,
    );
  }
  return at(
    "stop",
    8,
    open.length > 0
      ? `No step can move forward (${open.join(", ")} are in_progress without a PR, review waiting for merge, or similar)`
      : "There are no target tickets",
    open,
  );
}

/**
 * 同じ段階が続き、事実が変わらないか（止まる判定）。prev は前の呼び出しが返した段階と事実のハッシュ（deguboard-local に覚える）。
 * 続くのは、関所を呼び忘れた割り当て・点検・見直し・リリース・独自の段階（記録が足されないので同じ段階のまま）、承認が得られない計画、マージを待つ作業のとき
 */
export function isRepeated(
  prev: { stage: string; facts: string } | undefined,
  stage: string,
  facts: string,
) {
  return prev !== undefined && prev.stage === stage && prev.facts === facts && stage !== "stop";
}

/** 段階の手のやり方を読む節の組。also があれば、そのトピックの節を sections のあとにつなぐ（work は並列の手順） */
interface FlowGuideRef {
  topic: string;
  sections: readonly string[];
  also?: { topic: string; sections: readonly string[] };
}

/**
 * 段階の手のやり方の節（段階ごとに読む guide の節。先頭が手順の節）。本文は composeGuide が Core から読み、並べた順につなぐ。
 * 返す本文だけで段階を進められるよう、手順の節が同じトピックの中で「」で指す節はすべて入れる（flow.test.ts が閉じ方を確かめる）。
 * ほかのトピックの節（`dg guide <topic>` の「…」）は案内されたトピックとして読む。読むものを返す本文に入れる節は also で足す
 */
export const FLOW_GUIDE: Record<FlowStageName, FlowGuideRef> = {
  assign: { topic: "assign", sections: ["When proposing an assignment", "Iteration"] },
  check: { topic: "check", sections: ["Check steps"] },
  plan: { topic: "plan", sections: ["Flow", "Creating a Plan", "About approval"] },
  work: {
    topic: "work",
    sections: [
      "Flow",
      "Gate level",
      "Before and after claim",
      "Implement",
      "Receive the implementation result",
      "Following the Plan",
      "Merging after approval",
    ],
    also: { topic: "parallel", sections: ["Advancing in parallel"] },
  },
  audit: {
    topic: "audit",
    sections: [
      "Audit steps",
      "Viewpoints",
      "Delegating to subagents",
      "Not repeating the same findings",
      "Severity and where to put it",
      "Filing tickets",
    ],
  },
  close: { topic: "done", sections: ["Closing a Plan"] },
  release: { topic: "release", sections: ["Release steps", "When there are no release steps"] },
  stop: { topic: "all", sections: ["Choosing the next step"] },
};

/** guide.command：返した本文を読み直す dg guide の呼び出し。空白を含む節の名前は引用する */
function guideCommandOf(topic: string, sections: readonly string[]): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  return [`dg guide ${topic}`, ...sections.map((s) => `--section ${quote(s)}`)].join(" ");
}

/**
 * 段階の手のやり方（FlowNext の guide）と、読めなかった文書の警告。同梱の段階は guide の節を composeGuide で組み、
 * 独自の段階は手順の文書（workflow.yaml の guide のパス）を読む
 */
async function guideOf(
  ctx: CommandContext,
  stage: FlowStageName | CustomStage,
): Promise<{ guide: FlowNext["guide"]; warnings: string[] }> {
  if (typeof stage !== "string") {
    const doc = await readStageGuide(stage, ctx.repo.topLevel);
    return {
      guide: { topic: stage.id, sections: [], text: doc.text, command: null, path: stage.guide },
      warnings: doc.warnings,
    };
  }
  const ref = FLOW_GUIDE[stage];
  const parts = [ref, ...(ref.also ? [ref.also] : [])];
  const texts = await Promise.all(
    parts.map((p) => composeGuide(p.topic, ctx.config, ctx.repo.topLevel, p.sections)),
  );
  return {
    guide: {
      topic: ref.topic,
      sections: [...ref.sections],
      text: texts.map((g) => g.text).join("\n\n"),
      command: parts.map((p) => guideCommandOf(p.topic, p.sections)).join(" && "),
      path: null,
    },
    warnings: texts.flatMap((g) => g.warnings),
  };
}

export interface FlowApproval {
  /** この段階で人の承認を得てから進める操作があるか（聞かずに進められるものだけなら false） */
  required: boolean;
  /** 承認を求める場所（guide-all の表）。required が false なら null */
  what: string | null;
  /** --auto のとき聞かずに勧める選択肢で進めるもの。--auto でない・値が ask_unless_auto でないなら null */
  auto: string | null;
  /** --auto が聞かずに進めるものが、この段階にあるか（auto と同じ。点検は直す行だけで、削除・abandoned・閉じるは含まない） */
  auto_ok: boolean;
  /** 承認の要否を決めた Workflow の値（例：`flow.plan: ask_unless_auto`）。値で決まらない段階（close・stop）は null */
  value: string | null;
  /** その値をこの呼び出しのエージェントに当てた結果（allow は聞かずにできる、approval は人の承認が要る、reject は人だけができる） */
  agent: Permission;
}

/** approvalOf が読む Workflow の値 */
export interface FlowDecisions {
  /** 流れの段階の値（workflow.yaml の flow） */
  flow: Record<FlowDecidedStage, Decision>;
  /** PR のマージを判定する値（review → done の境目の decide） */
  merge: Decision;
}

/**
 * 権限の値 1 つをエージェントに当てた承認の要否。name は値の場所（例：flow.plan）、what は承認を求めるもの、free は --auto が聞かずに進めるもの。
 * rejected は、値が人だけ（reject）のときに what に代える文。段階の一部だけを dg が拒否する段階（release）が渡す
 */
function judgedApproval(
  auto: boolean,
  name: string,
  decision: Decision,
  what: string,
  free: string,
  rejected?: string,
): FlowApproval {
  const value = `${name}: ${decision}`;
  const agent = judgeDecisions([decision], "agent", auto);
  const viaAuto = auto && autoApplies([decision]);
  if (agent === "allow")
    return {
      required: false,
      what: null,
      auto: viaAuto ? free : null,
      auto_ok: viaAuto,
      value,
      agent,
    };
  return {
    required: true,
    what:
      agent === "reject"
        ? (rejected ??
          `${what} (only a person does it: an agent's call is rejected, so ask a person to run the commands)`)
        : what,
    auto: null,
    auto_ok: false,
    value,
    agent,
  };
}

/**
 * 独自の段階の承認の要否。段階の decide をエージェントに当てる（同梱の段階と同じ判定）。
 * 何を聞くかは手順の文書が持つので、what は段階の判断とだけ書く
 */
export function customApprovalOf(
  stage: Pick<CustomStage, "id" | "decide">,
  auto: boolean,
): FlowApproval {
  const what = `The decision of the ${stage.id} stage (its steps say what to ask)`;
  return judgedApproval(auto, `flow.${stage.id}.decide`, stage.decide, what, what);
}

/**
 * 段階の承認の要否。Workflow の値（flow と、作業の段階は review → done の境目の decide）をエージェントに当てて決める（EX-7）。
 * --auto が聞かずに進めるのは値が ask_unless_auto の場面だけで、always_ask は --auto でも聞き、human_only は人が行う。
 * 点検の値が決めるのは直す行だけで、削除・abandoned・閉じるは governance と exceptions の値が決めるので、いつも聞く場所に残す
 */
export function approvalOf(
  stage: FlowStageName,
  opts: { auto: boolean } & FlowDecisions,
): FlowApproval {
  const judged = (
    name: string,
    decision: Decision,
    what: string,
    free: string,
    rejected?: string,
  ) => judgedApproval(opts.auto, name, decision, what, free, rejected);
  switch (stage) {
    case "assign":
      return judged("flow.assign", opts.flow.assign, "Rows to add", "Rows to add");
    case "check": {
      const fix = judged(
        "flow.check",
        opts.flow.check,
        "Rows to fix, and deletions, abandoned, and closing",
        "Fix rows that have exactly one way to fix",
      );
      return fix.required
        ? fix
        : { ...fix, required: true, what: "Deletions, abandoned, and closing" };
    }
    case "plan":
      return judged(
        "flow.plan",
        opts.flow.plan,
        "Plan",
        "Approving the Plan (plan approve --auto)",
      );
    case "work":
      return judged(
        "boundaries review → done",
        opts.merge,
        "Merging each PR (when approved, dg pr merge <id> --approved-by human)",
        "Merging PRs that meet the quality gate (dg gate --for merge) with dg pr merge <id> --auto",
      );
    case "audit":
      return judged(
        "flow.audit",
        opts.flow.audit,
        "Findings table",
        'Findings table (apply all except "won\'t fix")',
      );
    case "release":
      return judged(
        "flow.release",
        opts.flow.release,
        "Merging the release PR, publishing, and closing",
        "Merging the release PR, publishing, and closing",
        // flow.release で dg が拒否するのは、リリースの関所（dg checkpoint release）と Iteration を閉じる・再開する。リリースの PR のマージと公開は
        // コマンドで止められないので、人だけの値でも、人が関所を通した後に、人に聞いてからエージェントが行う（guide release の手順 3）
        "Passing the release checkpoint and closing the Iteration (only a person does them: an agent's calls of dg checkpoint release and dg iteration close are rejected, so ask a person to run them), and merging the release PR and publishing (ask a person before each one; when approved, the agent runs them)",
      );
    // 終わった Plan を閉じるのは人の判断に入れない（終わった状態を記録するだけで、チケットは変わらない）
    case "close":
    case "stop":
      return {
        required: false,
        what: null,
        auto: null,
        auto_ok: false,
        value: null,
        agent: "allow",
      };
  }
}

/**
 * 段階の関所を通すコマンド（dg checkpoint）。関所を持たない段階（plan・work・close・stop）と、リリースの関所を通った後は null。
 * 独自の段階はいつも関所を持ち、名前は段階の名前。
 * 段階の値に合う付け方を足す（人だけなら人に頼む文）。対象は flow next と同じもの（根拠を同じ対象から求めるため）
 */
function checkpointOf(
  stage: FlowStage,
  target: string,
  approval: FlowApproval,
  releasePassed: boolean,
): string | null {
  const name = stage.after === null ? CHECKPOINT_OF[stage.name as FlowStageName] : stage.name;
  if (!name || (name === "release" && releasePassed)) return null;
  return judgedCommand(`checkpoint ${name} ${target}`, approval);
}

/**
 * 流れの段階の値が判定するコマンド（iteration add・plan approve・checkpoint）に、値に合う付け方を足す。
 * --auto で聞かずに進めるなら --auto、人の承認が要るなら --approved-by human（承認を得た後にだけ呼ぶ）、
 * 人だけができるなら人に頼む文にする
 */
function judgedCommand(command: string, approval: FlowApproval): string {
  if (approval.agent === "reject")
    return `Ask a person to run dg ${command} (only a person can do it; an agent's call is rejected)`;
  if (approval.agent === "approval") return dg(`${command} --approved-by human`);
  return dg(approval.auto_ok ? `${command} --auto` : command);
}

/**
 * 段階で親が呼ぶ dg のコマンド（順に）。手のやり方は guide の節。Plan の承認は聞かずに進められるときだけ呼ぶ
 * （承認を求めるときは guide の手順が承認の後に呼ぶ）。
 * gate（--gate の段）があれば、作業の段階で段の違うチケットにだけ next の前に段を付ける（TK-9。下げるときは人に頼む文を返す）。
 * 同じ段のチケットに入れないのは、呼ぶたびに更新が出て止まる判定（fingerprint の updated_at）を揺らさないため
 */
function commandsOf(
  stage: FlowStage,
  s: string | null,
  approval: FlowApproval,
  gate?: { level: GateLevel; of: (id: string) => GateLevel },
): string[] {
  // 独自の段階の手は手順の文書が持つ（dg が呼ぶと決まったコマンドはない）
  if (stage.after !== null) return [];
  switch (stage.name as FlowStageName) {
    case "assign":
      return [judgedCommand(`iteration add ${s ?? "<S>"} <tickets to add…>`, approval)];
    case "check":
      return [dg("sync"), dg("validate"), dg("lint")];
    case "plan":
      return stage.plan
        ? [
            dg(`plan show ${stage.plan}`),
            ...(approval.required ? [] : [judgedCommand(`plan approve ${stage.plan}`, approval)]),
          ]
        : [dg(`plan create ${stage.tickets.join(" ")}`)];
    case "work":
      return [
        dg(`plan show ${stage.plan}`),
        ...stage.tickets.flatMap((t) => [
          ...(gate && gate.of(t) !== gate.level
            ? [
                // 段を下げるのは Core の固定で人に限る（エージェントの呼び出しは拒否される）ので、人が打つ手として返す
                lowersGate(gate.of(t), gate.level)
                  ? `Ask a person to run dg ticket update ${t} --gate ${gate.level} before the next of ${t}, and wait for it (only a person can lower the quality gate level; an agent's call is rejected)`
                  : dg(`ticket update ${t} --gate ${gate.level}`),
              ]
            : []),
          dg(`next ${t}`),
        ]),
      ];
    case "audit":
      return [dg(`ticket list --label audit-${s}`)];
    case "release":
      return [dg(`iteration show ${s}`)];
    case "close":
      return stage.plan ? [dg(`plan close ${stage.plan}`)] : [];
    case "stop":
      return [];
  }
}

/**
 * 流れの事実と、同じ段階が続いたかを見るためのハッシュの材料を集める。
 * localAssign は、Iteration の決まらない流れの割り当ての記録（deguboard-local）。Iteration の記録と合わせて数える
 */
export function flowFactsOf(
  ctx: CommandContext,
  refs: readonly string[],
  noAssign: boolean,
  localAssign: readonly Checkpoint[] = [],
): { facts: FlowFacts; fingerprint: string; key: string } {
  const store = ctx.store;
  const target = resolveFlowTarget(store, refs);
  const s = target.iteration;
  // リリースの手順で起票したチケット。リリースの段で進めるので、計画しない
  const isRelease = (t: Ticket) => s !== null && t.labels.includes(`release-${s}`);
  const all = sortedDocs(store.tickets.values()).map((d) => d.data);
  const ids = new Set(target.tickets.map((t) => t.id));
  const iteration = s ? store.iterations.get(s as IterationId)?.data : undefined;
  const releaseScope = releaseScopeOf(store, target);
  // 数える関所の記録（iteration reopen より前は数えない）。根拠が今の事実に合うかは段階ごとに見る
  const records = iterationCheckpoints(store, s);
  const plans = sortedDocs(store.plans.values()).filter(
    (p) => p.data.closed_at === undefined && p.data.tickets.some((t) => ids.has(t)),
  );
  const statusOf = (id: string) => store.tickets.get(id as Ticket["id"])?.data.status;
  const inOpenPlan = new Set(
    [...store.plans.values()]
      .filter((p) => p.data.closed_at === undefined)
      .flatMap((p) => p.data.tickets),
  );
  const facts: FlowFacts = {
    iteration: s,
    iterationClosed: iteration?.status === "closed",
    targets: target.tickets,
    releaseScope,
    candidates: flowCandidates(store, target),
    asked: [...askedCandidates([...records, ...localAssign])].sort(),
    checked: s !== null && checkedWith(records, checkFactsOf(store, target)),
    audited: s !== null && auditedWith(records, auditDoneOf(store, target)),
    releasePassed: passed(records, "release"),
    passedStages: passedStages(records),
    pendingPlans: plans
      .filter((p) => p.data.pending_approval)
      .map((p) => ({ id: p.id, tickets: p.data.tickets })),
    approvedPlans: plans
      .filter((p) => !p.data.pending_approval)
      .map((p) => ({
        id: p.id,
        // 消したチケットは Plan の中にないものとして扱う（planReadiness と同じ）。abandoned も終わったものとする
        unfinished: p.data.tickets.filter((id) => {
          const st = statusOf(id);
          return st !== undefined && !isTerminal(st);
        }),
        finished: isFinishedSet(p.data.tickets.map(statusOf)),
      })),
    unplanned: target.tickets
      .filter((t) => t.status === "todo" && !inOpenPlan.has(t.id) && !isRelease(t))
      .map((t) => t.id),
    noAssign,
  };
  // 同じ段階が続いたかは、段階を決める事実（関所の記録を数えた結果を含む）に加えて、対象のチケットの更新と Run の出入りで見る
  // （作業の段階で見直しや手直しが進めば、チケットの状態が同じでも事実は変わった）。
  // release-<S> のチケットも見る（リリースの PR が進めば、リリースの段が続いても止めない）
  const watched = new Set([
    ...ids,
    ...releaseScope.map((t) => t.id),
    ...all.filter((t) => t.iteration === s && isRelease(t)).map((t) => t.id),
  ]);
  const runs = [...store.runs.values()]
    .map((d) => d.data)
    .filter((r) => watched.has(r.ticket))
    .map((r) => `${r.id}:${r.finished_at ?? ""}`)
    .sort();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        // 対象の並びが違っても同じ対象（t1 t2 と t2 t1）
        facts: {
          ...facts,
          targets: [...facts.targets].sort((a, b) => compareIds(a.id, b.id)),
          releaseScope: [...facts.releaseScope].sort((a, b) => compareIds(a.id, b.id)),
          unplanned: [...facts.unplanned].sort(compareIds),
        },
        // 関所を通ったことも進み（リリースの関所のように、通っても段階が変わらないものがある）
        checkpoints: records.length,
        tickets: [...watched].sort().map((id) => {
          const t = store.tickets.get(id as Ticket["id"])?.data;
          return t ? [t.id, t.status, t.pr ?? null, t.updated_at] : [id];
        }),
        plans: plans.map((p) => [p.id, p.data.pending_approval, p.data.tickets]),
        runs,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return { facts, fingerprint, key: target.key };
}

export interface FlowNext {
  /** 対象：Iteration（<S>）と、扱うチケット */
  target: { iteration: string | null; tickets: string[] };
  stage: FlowStage;
  /** 同じ段階が事実も変わらずに続いて止まったとき、続いた段階。ほかは null */
  repeated: string | null;
  /**
   * この段階の手のやり方（guide の節）。sections は読む節（先頭が手順の節）、text はその本文を順につないだもの（config を埋めたもの）。
   * 手順の節が同じトピックの中で指す節はすべて text に入る。also の節（work の並列の手順）も text に続く。command で同じ本文を読める（also のあるときは command が 2 つの dg guide を && でつなぐので、両方を順に読む）。
   * 独自の段階は、topic が段階の名前、sections が空、text が手順の文書の本文（書いたまま。読めなければ空で、警告が出る）、
   * path が文書のパス（リポジトリの最上位から。読み直すときはこのファイルを読む）で、command は null。同梱の段階の path は null
   */
  guide: {
    topic: string;
    sections: string[];
    text: string;
    command: string | null;
    path: string | null;
  };
  /** この段階で親が呼ぶ dg のコマンド（順に） */
  commands: string[];
  /**
   * この段階の関所を通すコマンド（dg checkpoint。段階の値に合う付け方を足したもの。人だけなら人に頼む文）。段階の手順が決めた場所で呼ぶ。
   * 通ると Iteration に記録が足され、次の呼び出しが段階を終えたものとして進む。呼ばなければ同じ段階を返し続ける。
   * 関所を持たない段階（plan・work・close・stop）と、リリースの関所を通った後は null。独自の段階はいつも持つ
   */
  checkpoint: string | null;
  approval: FlowApproval;
  /** 止まったとき人に伝えること。なければ null */
  ask_human: string | null;
}

export const flowNext = defineCommand({
  name: "flow.next",
  positionals: ["targets"],
  group: "flow",
  summary:
    "Return the current stage of the Iteration flow (assign → check → plan → work → audit → release, with close inside the work rule) and the next step. " +
    "The target is one Iteration, one Plan, or one or more tickets. The stage is the first of these eight rules that applies, in order " +
    "(1 assign: some candidate has not been seen by an assign checkpoint, <S> is not audited, and --no-assign is not given / " +
    "2 check: no check checkpoint matches the current tickets / 3 plan: an approval-waiting Plan includes the target / 4 work: an approved Plan that includes the target has unfinished tickets, and if none, an approved open Plan that includes the target is finished (close: plan close) / " +
    "5 plan: an open Plan does not include some todo / 6 audit: all tickets of <S> are done or abandoned but not yet audited / 7 release: the same, and audited. Tickets labeled release-<S> (the two release tickets that the release steps file) are not counted in 6 and 7 nor planned in 5, so release keeps returning until <S> is closed / 8 stop. If <S> is closed, nothing is assigned, and the flow stops as finished before 6 and 7). " +
    "Whether assign, check, and audit are finished is read from the checkpoint records of <S> (checkpoints of the Iteration, added by dg checkpoint), so a flow goes on from where it was across conversations, people, and machines. A record counts only while its basis holds, and records from before dg iteration reopen are not counted. " +
    "Assign: the candidates are the unfinished target tickets that are not in an Iteration, for a ticket or Plan target only. An Iteration target has no candidates, so it never returns assign (putting other todos into the Iteration is left to the assignment steps, dg guide assign, when a person asks for it), and --no-assign has a meaning only for a ticket or Plan target. A record holds the candidates it saw, and only candidates that no record has seen are asked about. " +
    "Check: a record holds a hash of the tickets (which tickets there are, and each one's title, body without the acceptance marks, priority, labels, dependencies, Epic, and Iteration; not its Status, assignee, branch, PR, or gate level), and it stops counting when they change. " +
    "Audit (audited): a record holds the done tickets, and it stops counting when a ticket that it did not see is done (tickets labeled audit-<S> or release-<S> are not looked at, so merging the audit's own fixes does not ask for another audit). " +
    "The stage's steps pass the checkpoint with the command in checkpoint (null when the stage has none, and for release once it is passed). If it is not passed, the same stage is returned again. " +
    "For a ticket or Plan target, <S> is the ticket's Iteration (only when it is a single one), and audit and release apply only when all tickets in that Iteration are finished. The records are kept on an Iteration, so when no single Iteration is determined, only rule 1 applies (the assign stage decides the Iteration, and its checkpoint is recorded on this machine only), and otherwise the flow stops. " +
    "Stages in skip under flow of workflow.yaml are skipped without reading their rules. " +
    "A stage of your own (a stage in flow of workflow.yaml with decide, after, and guide) is returned once the bundled stage in its after is finished or skipped, before the next bundled stage, until its checkpoint is passed (dg checkpoint <its name>; the record has no basis, so it counts until dg iteration reopen); stages with the same after come one at a time in the order written. " +
    "The bundled stage counts as finished like this: assign and check when their rules 1 and 2 do not apply; plan when no Plan waits for approval and every todo is in an open Plan (so before the work); work when all tickets of <S> are done or abandoned (before the audit); audit when it is audited (before the release); release when <S> is closed; retro when <S> is closed and the retro checkpoint is passed (flow next does not return the retrospective itself). On a closed <S>, only the stages after release and retro are returned. " +
    "For such a stage, stage.name is its name, stage.after its after, and stage.rule null; guide.text is the document in its guide as written (config values are not filled in), guide.path its path from the top of the repository (read that file to read it again; guide.command is null), commands is empty, checkpoint is its checkpoint command, and approval comes from its decide (approval.value is flow.<name>.decide: <value>). If the document is missing or cannot be read (outside the repository, not a regular file, or over 64 KiB), the stage is still returned with an empty guide.text and a warning. " +
    "If the facts (tickets, Plans, Runs, checkpoint records) have not changed for the same stage as the previous return, it returns stop (repeated is the stage). The previous return is remembered for each target on this machine (deguboard-local/flow/, not shared), and it is forgotten when stop is returned, so the call after a stop works the stage out again. Returns the stage's section (guide), the commands to call (commands; with --gate, the work stage sets the level on tickets whose level differs before next; when that lowers the level, the entry is a sentence to ask a person to run the command, because only a person can lower it), and whether approval is needed (approval). " +
    "The Workflow's values decide approval (dg workflow show): flow.assign, flow.check, flow.plan, flow.audit, and flow.release for their stages, and the decide of the review → done boundary for the merges of the work stage. approval.value is that value, and approval.agent is what it means for an agent in this call: allow (go ahead without asking), approval (ask a person first; required is true), or reject (only a person does it; required is true). --auto goes ahead without asking only where the value is ask_unless_auto: auto_ok is then true, and the judged commands carry --auto (iteration add, plan approve, and the checkpoint), which records the agent as the approver. A value of always_ask is asked with --auto too. A judged command (in commands or checkpoint) that carries --approved-by human is run only after a person approves approval.what. In the check stage the value decides only the rows to fix; deletions, abandoned, and closing are always asked. " +
    "When a column is over its WIP limit (wip in workflow.yaml), it warns the same way as dg next, and the work stage puts first in commands a step to advance tickets in the columns further along (starting is not refused). Writes no data (only the memory of the previous return, under deguboard-local)",
  input: z.object({
    targets: z
      .array(z.string().min(1))
      .min(1)
      .describe("Target: one Iteration (s3), one Plan (p7), or one or more tickets (t12)"),
    // 要件 EX-7
    auto: z
      .boolean()
      .optional()
      .describe(
        "Go ahead without asking where the Workflow's value is ask_unless_auto (the person started the flow with --auto). The judged commands returned then carry --auto",
      ),
    no_assign: z
      .boolean()
      .optional()
      .describe(
        "Skip the assign stage (meaningful only for a ticket or Plan target; an Iteration target never returns assign)",
      ),
    // 要件 TK-9
    gate: z
      .enum(GATE_LEVELS)
      .optional()
      .describe(
        "Quality gate level the person gave (/dgall --gate-<level>). In the work stage, puts dg ticket update <id> --gate <level> before next only for tickets whose level differs (a ticket with no gate is high). When the level is lower than the ticket's, the entry asks a person to run it instead",
      ),
  }),
  // データには書かない。止まる判定のために、前に返した段階だけを deguboard-local に覚える
  write: false,
  needs: "store",
  async run(ctx, input) {
    const auto = input.auto ?? false;
    const warnings: string[] = [];
    const local = await readFlowLocal(
      ctx.repo.localDir,
      resolveFlowTarget(ctx.store, input.targets).key,
    );
    const {
      facts,
      fingerprint: factsHash,
      key: target,
    } = flowFactsOf(ctx, input.targets, input.no_assign ?? false, local.assign);
    // 止まる判定は、引数（--auto・--gate）も同じ呼び出しどうしで比べる。人が引数を変えて始め直したら、同じ段階でも返す手が変わる
    const fingerprint = `${factsHash}${auto ? " auto" : ""}${input.gate ? ` gate=${input.gate}` : ""}`;
    // 読むだけなので、workflow.yaml に誤りがあって読めなければ Core の既定の値で求める（誤りは dg validate が知らせる）
    const workflow = ctx.store.workflow?.resolved ?? DEFAULT_WORKFLOW;
    const found = flowStageOf(facts, workflow.flow.skip, workflow.flow.custom);
    const repeated = isRepeated(local.last, found.name, fingerprint) ? found.name : null;
    // 止まると返したら、覚えた段階を忘れる。新しい会話が同じ対象で始め直したとき（会話は見分けられない）に、
    // 止まったままにせず、次の呼び出しで段階を求め直す。回し続けるエージェントは、1 回おきに止まる手を受け取る
    const { last: _last, ...kept } = local;
    try {
      await writeFlowLocal(ctx.repo.localDir, target, {
        ...kept,
        ...(repeated ? {} : { last: { stage: found.name, facts: fingerprint } }),
      });
    } catch (error) {
      // 覚えられなくても段階は返す（止まる判定が次の呼び出しで効かないだけ）
      warnings.push(
        `Cannot remember the returned stage under deguboard-local/flow (${error instanceof Error ? error.message : String(error)}), so the next call cannot tell whether the same stage repeats`,
      );
    }
    const stage: FlowStage = repeated
      ? {
          name: "stop",
          rule: null,
          after: null,
          reason: `The stage ${repeated} repeats with no change in the facts (${found.reason})`,
          plan: found.plan,
          tickets: found.tickets,
        }
      : found;
    // 独自の段階（after を持つ）は、手順の文書と decide を workflow.yaml の定義から引く
    const custom =
      stage.after === null ? undefined : workflow.flow.custom.find((c) => c.id === stage.name);
    // custom がなければ同梱の段階（flowStageOf は同じ定義から独自の段階を返すので、after を持つ段階はいつも見つかる）
    const bundled = stage.name as FlowStageName;
    const guide = await guideOf(ctx, custom ?? bundled);
    warnings.push(...guide.warnings);
    // 着手の手を返すのは、作業の段階に todo のチケットがあるときだけ（どれも着手済みなら上限ちょうどは超えない）
    const starting =
      stage.name === "work" &&
      stage.tickets.some((id) => ctx.store.tickets.get(id as Ticket["id"])?.data.status === "todo");
    const wip = wipCheckOf(ctx, starting);
    warnings.push(...wip.warnings);
    const approval = custom
      ? customApprovalOf(custom, auto)
      : approvalOf(bundled, {
          auto,
          flow: workflow.flow.stages,
          merge: workflow.boundaries.find((b) => b.from === "review" && b.to === "done")!.decide,
        });
    // 続いた段階の関所の名前（関所を持つ同梱の段階か、独自の段階）
    const repeatedCheckpoint =
      repeated === null
        ? undefined
        : found.after === null
          ? CHECKPOINT_OF[repeated as FlowStageName]
          : repeated;
    const result: FlowNext = {
      target: { iteration: facts.iteration, tickets: facts.targets.map((t) => t.id) },
      stage,
      repeated,
      guide: guide.guide,
      approval,
      commands: [
        // WIP の上限を超えた列があれば、作業の段階で着手する前に先の列を進める手を置く（要件 WF-8。拒否はしない。dg next と同じ判定）
        ...(stage.name === "work" && wip.step !== null ? [wip.step] : []),
        ...commandsOf(
          stage,
          facts.iteration,
          approval,
          input.gate === undefined
            ? undefined
            : {
                level: input.gate,
                of: (id) => gateLevelOf(ctx.store.tickets.get(id as Ticket["id"])?.data),
              },
        ),
      ],
      checkpoint: checkpointOf(stage, target, approval, facts.releasePassed),
      ask_human:
        stage.name === "stop"
          ? `${stage.reason}. ${
              // 関所を持つ段階が続いたのは、関所を通していないから（手順を終えて呼び忘れたか、承認が得られていない）
              repeatedCheckpoint
                ? `The ${repeated} checkpoint is not passed (dg checkpoint ${repeatedCheckpoint} ${target}): the stage ends only when its steps pass it. `
                : ""
            }Show the state and stop. Starting again with the same target works it out again from the state`
          : null,
    };
    return ok(result, undefined, warnings);
  },
});

export const flowCommands = [flowNext];
