// Iteration の流れの段階と次の手（EX-3・EX-8、ADR-030）。流れの 8 つの規則（ここが正本。guide-all は書かない）と止まる判定を、
// チケット・Plan の事実と resume から都度求め、保存しない（dg next と同じ考え）。段階を返すだけで、エージェントを起動も監視もしない（EX-1）。
// 会話の中にしかない事実（この実行で割り当て・点検・見直しを終えた）は resume に入れて返す。エージェントは次の呼び出しに --resume で写して渡す

import { createHash } from "node:crypto";
import { z } from "zod";
import { UsageError } from "../errors.js";
import { composeGuide } from "../guide/guide.js";
import { isTerminal } from "../model/common.js";
import { FLOW_SKIPS } from "../model/config.js";
import { compareIds, parseId, type IterationId } from "../model/id.js";
import type { Ticket } from "../model/ticket.js";
import type { Store } from "../storage/store.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { agentDg as dg, sortedDocs, ticketsInIteration } from "./helpers.js";

/** 流れの段階。飛ばせる段階（config の flow.skip）に、規則 8（どれにも当たらない）と同じ段階が事実も変わらずに続いたときの stop を足す */
export const FLOW_STAGES = [...FLOW_SKIPS, "stop"] as const;
export type FlowStageName = (typeof FLOW_STAGES)[number];

/** この実行で終えたこと（会話の中にしかない事実）。resume が運ぶ */
export interface FlowMemory {
  assigned: boolean;
  checked: boolean;
  audited: boolean;
}

const NO_MEMORY: FlowMemory = { assigned: false, checked: false, audited: false };

/** 終えたことを resume で覚える段階。前の呼び出しがこの段階を返したなら、エージェントはそれを行い終えたとみなす */
const REMEMBERED: Partial<Record<FlowStageName, keyof FlowMemory>> = {
  assign: "assigned",
  check: "checked",
  audit: "audited",
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
   * チケットの指定では対象とその Iteration のチケット（guide-all の「対象を決める」）。<S> がなければ空
   */
  releaseScope: readonly FlowTicket[];
  /** 割り当ての候補（Iteration に入っていない todo。ラベル audit-<S> を除く） */
  candidates: readonly string[];
  /** ラベル audit-<S> のチケットがある（状態と所属は問わない） */
  auditLabeled: boolean;
  /** 対象のチケットを含む承認待ちの Plan（番号順） */
  pendingPlans: readonly { id: string; tickets: readonly string[] }[];
  /** 対象のチケットを含む承認済みの開いた Plan と、その終わっていないチケット（番号順） */
  approvedPlans: readonly { id: string; unfinished: readonly string[] }[];
  /** 対象のうち、開いた Plan に入っていない todo */
  unplanned: readonly string[];
  /** --no-assign */
  noAssign: boolean;
}

export interface FlowStage {
  name: FlowStageName;
  /** 当たった規則の番号（flowStageOf の 1〜8）。同じ段階が続いて止まったときは null */
  rule: number | null;
  /** 段階を決めた事実（1 文） */
  reason: string;
  /** 段階の Plan（規則 3・4）。なければ null */
  plan: string | null;
  /** 段階の相手のチケット（割り当ての候補・承認待ちの Plan のチケット・終わっていないチケット・Plan に入っていない todo） */
  tickets: string[];
}

/** 見直し済み：ラベル audit-<S> のチケットがあるか、この実行で見直しを終えた */
export function isAudited(facts: Pick<FlowFacts, "auditLabeled">, memory: FlowMemory): boolean {
  return facts.auditLabeled || memory.audited;
}

const allFinished = (tickets: readonly FlowTicket[]) =>
  tickets.length > 0 && tickets.every((t) => isTerminal(t.status));

/**
 * 事実とこの実行で終えたことから、8 つの規則（--help に並べた順）で最初に当たる段階を求める（純粋関数）。
 * skip（config の flow.skip）の段階は規則を読まず、次の規則に進む。見直しを飛ばすと、すべて終わったときはすぐリリースに進める
 */
export function flowStageOf(
  facts: FlowFacts,
  memory: FlowMemory,
  skip: readonly FlowStageName[] = [],
): FlowStage {
  const audited = isAudited(facts, memory);
  const s = facts.iteration;
  const skipped = (name: FlowStageName) => skip.includes(name);
  const at = (
    name: FlowStageName,
    rule: number,
    reason: string,
    tickets: readonly string[] = [],
    plan: string | null = null,
  ): FlowStage => ({ name, rule, reason, plan, tickets: [...tickets] });
  if (
    !skipped("assign") &&
    !memory.assigned &&
    !audited &&
    facts.candidates.length > 0 &&
    !facts.noAssign
  )
    return at(
      "assign",
      1,
      `Iteration に入っていない todo が ${facts.candidates.length} 件ある`,
      facts.candidates,
    );
  if (!skipped("check") && !memory.checked) return at("check", 2, "この実行でまだ点検していない");
  const pending = skipped("plan") ? undefined : facts.pendingPlans[0];
  if (pending) return at("plan", 3, `Plan ${pending.id} が承認待ち`, pending.tickets, pending.id);
  const working = skipped("work")
    ? undefined
    : facts.approvedPlans.find((p) => p.unfinished.length > 0);
  if (working)
    return at(
      "work",
      4,
      `承認済みの Plan ${working.id} に終わっていないチケットが ${working.unfinished.length} 件ある`,
      working.unfinished,
      working.id,
    );
  if (!skipped("plan") && facts.unplanned.length > 0)
    return at(
      "plan",
      5,
      `開いた Plan に入っていない todo が ${facts.unplanned.length} 件ある`,
      facts.unplanned,
    );
  // 閉じた Iteration は流れを終えている。見直しとリリースを返すと、閉じた後の呼び出しでリリースを繰り返す
  const open = facts.targets.filter((t) => !isTerminal(t.status)).map((t) => t.id);
  if (s !== null && facts.iterationClosed)
    return at("stop", 8, `${s} は閉じていて、流れを終えた`, open);
  if (s !== null && allFinished(facts.releaseScope)) {
    if (!audited && !skipped("audit"))
      return at("audit", 6, `${s} のチケットがすべて done か abandoned で、まだ見直していない`);
    if (skipped("release"))
      return at("stop", 8, `${s} のチケットがすべて終わったが、リリースは流れから外している`, open);
    return at(
      "release",
      7,
      audited
        ? `${s} のチケットがすべて done か abandoned で、見直し済み`
        : `${s} のチケットがすべて done か abandoned で、見直しは流れから外している`,
    );
  }
  return at(
    "stop",
    8,
    s === null && allFinished(facts.targets)
      ? "対象のチケットはすべて終わったが、Iteration が 1 つに決まらないので見直しとリリースはしない"
      : open.length > 0
        ? `進められる手がない（${open.join("・")} は PR のない in_progress か、マージ待ちの review など）`
        : "対象にチケットがない",
    open,
  );
}

/** resume の中身。不透明な値として返し、エージェントは組み立てない（EX-8） */
interface ResumeState {
  v: 1;
  /** 対象（解決した ID。チケットは並べ替えた並び）。違う対象の resume は使わない */
  target: string;
  /** 前の呼び出しが求めた段階（同じ段階が続いて止まったときは、続いた段階） */
  stage: FlowStageName;
  /** 前の呼び出しの事実のハッシュ */
  facts: string;
  /** 前の呼び出しまでに終えたこと（前の段階の分は含まない） */
  memory: FlowMemory;
}

export function encodeResume(state: Omit<ResumeState, "v">): string {
  return Buffer.from(JSON.stringify({ v: 1, ...state }), "utf8").toString("base64url");
}

/** 読めない・形が違う resume は undefined（呼び手は割り当てと点検からやり直す） */
export function decodeResume(value: string): ResumeState | undefined {
  try {
    const raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const r = raw as Partial<ResumeState>;
    if (
      r?.v !== 1 ||
      typeof r.target !== "string" ||
      typeof r.facts !== "string" ||
      !(FLOW_STAGES as readonly string[]).includes(r.stage ?? "") ||
      typeof r.memory !== "object" ||
      r.memory === null
    )
      return undefined;
    const m = r.memory;
    return {
      v: 1,
      target: r.target,
      stage: r.stage!,
      facts: r.facts,
      memory: {
        assigned: m.assigned === true,
        checked: m.checked === true,
        audited: m.audited === true,
      },
    };
  } catch {
    return undefined;
  }
}

/** 前の呼び出しの段階を終えたとみなして、終えたことに足す */
export function memoryAfter(prev: ResumeState | undefined): FlowMemory {
  if (!prev) return { ...NO_MEMORY };
  const key = REMEMBERED[prev.stage];
  return key ? { ...prev.memory, [key]: true } : { ...prev.memory };
}

/**
 * 同じ段階が続き、事実が変わらないか。割り当て・点検・見直しは resume で終えたことになり続かないので、
 * 続くのは計画（承認が得られない）・作業（マージを待っている）・止まる、のとき
 */
export function isRepeated(prev: ResumeState | undefined, stage: FlowStageName, facts: string) {
  return prev !== undefined && prev.stage === stage && prev.facts === facts && stage !== "stop";
}

/**
 * 段階の手のやり方の節（段階ごとに読む guide の節。先頭が手順の節）。本文は composeGuide が Core から読み、並べた順につなぐ。
 * 返す本文だけで段階を進められるよう、手順の節が同じトピックの中で「」で指す節はすべて入れる（flow.test.ts が閉じ方を確かめる）。
 * ほかのトピックの節（`dg guide <topic>` の「…」）は案内されたトピックとして読む
 */
export const FLOW_GUIDE: Record<FlowStageName, { topic: string; sections: readonly string[] }> = {
  assign: { topic: "assign", sections: ["When proposing an assignment", "Iteration"] },
  check: { topic: "check", sections: ["Check steps"] },
  plan: { topic: "plan", sections: ["Flow", "Creating a Plan", "About approval"] },
  work: {
    topic: "work",
    sections: [
      "Flow",
      "Before and after claim",
      "Implement",
      "Receive the implementation result",
      "Following the Plan",
    ],
  },
  audit: {
    topic: "audit",
    sections: [
      "見直しの手順",
      "観点",
      "サブエージェントに任せる",
      "同じ指摘を繰り返さない",
      "重大度と置き場",
      "起票するチケット",
    ],
  },
  release: { topic: "release", sections: ["リリースの手順", "リリースの手順がないとき"] },
  stop: { topic: "all", sections: ["次の手順を選ぶ"] },
};

/** guide.command：返した本文を読み直す dg guide の呼び出し。空白を含む節の名前は引用する */
function guideCommandOf(topic: string, sections: readonly string[]): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  return [`dg guide ${topic}`, ...sections.map((s) => `--section ${quote(s)}`)].join(" ");
}

export interface FlowApproval {
  /** この段階で人の承認を得てから進める操作があるか（--auto で聞かずに選べるものだけなら false） */
  required: boolean;
  /** 承認を求める場所（guide-all の表）。required が false なら null */
  what: string | null;
  /** --auto のとき聞かずに勧める選択肢で進めるもの。--auto でない・config の判断に入らない・人が決める判断なら null */
  auto: string | null;
  /** --auto が聞かずに選ぶものが、この段階にあるか（auto と同じ。点検は直す行だけ、人が決める削除・閉じるは含まない） */
  auto_ok: boolean;
}

/**
 * 段階の承認の要否（guide-all の表と「--auto で自動で選ぶ」）。--auto が聞かずに選ぶのは config の auto.decisions に入る判断と、
 * auto.merge のときの PR のマージだけ。人が決める判断（削除・abandoned・閉じる・リリース）は config によらず聞く（EX-7）
 */
export function approvalOf(
  stage: FlowStageName,
  opts: { auto: boolean; autoMerge: boolean; decisions: readonly string[] },
): FlowApproval {
  const chosen = (decision: string) => opts.auto && opts.decisions.includes(decision);
  const ask = (what: string): FlowApproval => ({
    required: true,
    what,
    auto: null,
    auto_ok: false,
  });
  const choose = (decision: string, what: string, auto: string): FlowApproval =>
    chosen(decision) ? { required: false, what: null, auto, auto_ok: true } : ask(what);
  switch (stage) {
    case "assign":
      return choose("assign", "入れる行", "入れる行");
    case "check":
      return chosen("check")
        ? {
            required: true,
            what: "削除・abandoned・閉じる",
            auto: "直し方が 1 つに決まる直す行",
            auto_ok: true,
          }
        : ask("直す行、削除・abandoned・閉じる");
    case "plan":
      return choose("plan", "Plan", "Plan の承認（plan approve）");
    case "work":
      return opts.auto && opts.autoMerge
        ? {
            required: false,
            what: null,
            auto: "品質ゲート（dg gate --for merge）を満たす PR のマージ（dg pr merge）",
            auto_ok: true,
          }
        : ask("PR ごとのマージ（dg guide done）");
    case "audit":
      return choose("audit", "指摘の表", "指摘の表（「直さない」以外を反映する）");
    case "release":
      return ask("リリースの PR のマージ・公開・閉じる");
    case "stop":
      return { required: false, what: null, auto: null, auto_ok: false };
  }
}

/** 段階で親が呼ぶ dg のコマンド（順に）。手のやり方は guide の節。Plan の承認は --auto が聞かずに選ぶときだけ呼ぶ */
function commandsOf(stage: FlowStage, s: string | null, autoOk: boolean): string[] {
  switch (stage.name) {
    case "assign":
      return [dg(`iteration add ${s ?? "<S>"} <入れるチケット…>`)];
    case "check":
      return [dg("sync"), dg("validate"), dg("lint")];
    case "plan":
      return stage.plan
        ? [dg(`plan show ${stage.plan}`), ...(autoOk ? [dg(`plan approve ${stage.plan}`)] : [])]
        : [dg(`plan create ${stage.tickets.join(" ")}`)];
    case "work":
      return [dg(`plan show ${stage.plan}`), ...stage.tickets.map((t) => dg(`next ${t}`))];
    case "audit":
      return [dg(`ticket list --label audit-${s}`)];
    case "release":
      return [dg(`iteration show ${s}`)];
    case "stop":
      return [];
  }
}

/** 対象の解決。Iteration 1 つ、Plan 1 つ、チケット 1 つ以上のどれか */
function resolveTargets(
  store: Store,
  refs: readonly string[],
): {
  kind: "iteration" | "plan" | "tickets";
  /** resume の対象と比べる鍵。解決した ID で、チケットは並べ替える（t1 t2 と t2 t1 を同じ対象にする） */
  key: string;
  iteration: string | null;
  tickets: Ticket[];
} {
  const kinds = refs.map((r) =>
    parseId(r, "iteration") ? "iteration" : parseId(r, "plan") ? "plan" : "ticket",
  );
  if (kinds.some((k) => k !== "ticket")) {
    if (refs.length !== 1)
      throw new UsageError("Iteration か Plan は 1 つだけ指定する（チケットと混ぜない）");
    if (kinds[0] === "iteration") {
      const it = store.require("iteration", refs[0]!);
      return {
        kind: "iteration",
        key: it.id,
        iteration: it.id,
        tickets: ticketsInIteration(store, it.id).map((d) => d.data),
      };
    }
    const plan = store.require("plan", refs[0]!);
    const tickets = plan.data.tickets.flatMap((id) => store.tickets.get(id)?.data ?? []);
    return { kind: "plan", key: plan.id, iteration: commonIteration(tickets), tickets };
  }
  const tickets = [...new Set(refs.map((r) => store.require("ticket", r).data))];
  const key = tickets
    .map((t) => t.id)
    .sort(compareIds)
    .join(" ");
  return { kind: "tickets", key, iteration: commonIteration(tickets), tickets };
}

/** チケットの Iteration が 1 つに決まればそれ（Iteration のないチケットは数えない）。決まらなければ null */
function commonIteration(tickets: readonly Ticket[]): string | null {
  const ids = [...new Set(tickets.flatMap((t) => (t.iteration ? [t.iteration] : [])))];
  return ids.length === 1 ? ids[0]! : null;
}

/** 流れの事実と、同じ段階が続いたかを見るためのハッシュの材料を集める */
export function flowFactsOf(
  ctx: CommandContext,
  refs: readonly string[],
  noAssign: boolean,
): { facts: FlowFacts; fingerprint: string; key: string } {
  const store = ctx.store;
  const target = resolveTargets(store, refs);
  const s = target.iteration;
  const auditLabel = s ? `audit-${s}` : undefined;
  const all = sortedDocs(store.tickets.values()).map((d) => d.data);
  const ids = new Set(target.tickets.map((t) => t.id));
  const iteration = s ? store.iterations.get(s as IterationId)?.data : undefined;
  const project = iteration?.project;
  // 閉じた Iteration には入れられないので、割り当ての候補はない
  const candidates =
    iteration?.status === "closed"
      ? []
      : target.kind === "iteration"
        ? all.filter(
            (t) =>
              t.status === "todo" &&
              t.iteration === undefined &&
              t.project === project &&
              !(auditLabel && t.labels.includes(auditLabel)),
          )
        : target.tickets.filter((t) => t.status === "todo" && t.iteration === undefined);
  const releaseScope =
    s === null
      ? []
      : target.kind === "iteration"
        ? target.tickets
        : [...target.tickets, ...all.filter((t) => t.iteration === s && !ids.has(t.id))];
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
    candidates: candidates.map((t) => t.id),
    auditLabeled: auditLabel !== undefined && all.some((t) => t.labels.includes(auditLabel)),
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
      })),
    unplanned: target.tickets
      .filter((t) => t.status === "todo" && !inOpenPlan.has(t.id))
      .map((t) => t.id),
    noAssign,
  };
  // 同じ段階が続いたかは、段階を決める事実に加えて、対象のチケットの更新と Run の出入りで見る
  // （作業の段階で見直しや手直しが進めば、チケットの状態が同じでも事実は変わった）
  const watched = new Set([...ids, ...releaseScope.map((t) => t.id)]);
  const runs = [...store.runs.values()]
    .map((d) => d.data)
    .filter((r) => watched.has(r.ticket))
    .map((r) => `${r.id}:${r.finished_at ?? ""}`)
    .sort();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        facts,
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
  repeated: FlowStageName | null;
  /**
   * この段階の手のやり方（guide の節）。sections は読む節（先頭が手順の節）、text はその本文を順につないだもの（config を埋めたもの）。
   * 手順の節が同じトピックの中で指す節はすべて text に入る。command で同じ本文を読める
   */
  guide: { topic: string; sections: string[]; text: string; command: string };
  /** この段階で親が呼ぶ dg のコマンド（順に） */
  commands: string[];
  approval: FlowApproval;
  /** 止まったとき人に伝えること。なければ null */
  ask_human: string | null;
  /** この実行で終えたこと（resume を受けて求めた。今の段階の分はまだ含まない） */
  memory: FlowMemory;
  /** 次の呼び出しで --resume にそのまま写して渡す値。保存しない */
  resume: string;
}

export const flowNext = defineCommand({
  name: "flow.next",
  positionals: ["targets"],
  group: "flow",
  summary:
    "Iteration の流れ（割り当て → 点検 → 計画 → 作業 → 見直し → リリース）の今の段階と次の手を返す。" +
    "対象は Iteration 1 つ・Plan 1 つ・チケット 1 つ以上のどれか。段階は次の 8 つの規則の順で最初に当たるもの" +
    "（1 割り当て：この実行で割り当てを終えておらず、見直し済みでなく、Iteration に入っていない todo があり、--no-assign がない／" +
    "2 点検：この実行でまだ点検していない／3 計画：対象を含む承認待ちの Plan がある／4 作業：対象を含む承認済みの Plan に終わっていないチケットがある／" +
    "5 計画：開いた Plan に入っていない todo がある／6 見直し：<S> のチケットがすべて done か abandoned で見直し済みでない／7 リリース：同じで見直し済み／8 止まる。<S> が閉じていれば割り当てず、6・7 の前に流れを終えたとして止まる）。" +
    "見直し済みは、ラベル audit-<S> のチケットがあるか、この実行で見直しを終えた。チケットか Plan の指定では、<S> はチケットの Iteration（1 つに決まるときだけ）で、見直しとリリースはその Iteration のチケットがすべて終わったときだけ。" +
    "返す resume を次の呼び出しの --resume に写して渡すと、前に返した割り当て・点検・見直しを終えたものとして飛ばす。resume がない・読めない・別の対象のものなら割り当てと点検からやり直す。" +
    "段階を終えずに止めたとき（見直しの指摘の表で止めたなど）は、その resume を渡さない（渡すとその段階を飛ばす）。" +
    "config の flow.skip の段階は規則を読まずに飛ばす。前に返した段階と同じ段階で事実（チケット・Plan・Run）が変わらなければ stop を返す。段階の節（guide）・呼ぶコマンド（commands）・承認の要否（approval。auto_ok は --auto が聞かずに選ぶかで、config の auto.decisions と auto.merge に従い、人が決める判断は含まない）を返す。何も書かない",
  input: z.object({
    targets: z
      .array(z.string().min(1))
      .min(1)
      .describe("対象。Iteration（s3）1 つ、Plan（p7）1 つ、チケット（t12）1 つ以上のどれか"),
    auto: z.boolean().optional().describe("勧める選択肢がある戻せる判断を自動で選ぶ（EX-7）"),
    no_assign: z.boolean().optional().describe("割り当ての段階を飛ばす"),
    resume: z
      .string()
      .optional()
      .describe("前の dg flow next が返した resume。そのまま写して渡し、組み立てない"),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const auto = input.auto ?? false;
    const warnings: string[] = [];
    const {
      facts,
      fingerprint,
      key: target,
    } = flowFactsOf(ctx, input.targets, input.no_assign ?? false);
    let prev = input.resume === undefined ? undefined : decodeResume(input.resume);
    if (input.resume !== undefined && !prev)
      warnings.push("resume を読めないので、割り当てと点検からやり直す");
    if (prev && prev.target !== target) {
      warnings.push(`resume は別の対象（${prev.target}）のものなので、割り当てと点検からやり直す`);
      prev = undefined;
    }
    const memory = memoryAfter(prev);
    const found = flowStageOf(facts, memory, ctx.config.flow.skip);
    const repeated = isRepeated(prev, found.name, fingerprint) ? found.name : null;
    const stage: FlowStage = repeated
      ? {
          name: "stop",
          rule: null,
          reason: `段階 ${repeated} が続き、事実が変わらない（${found.reason}）`,
          plan: found.plan,
          tickets: found.tickets,
        }
      : found;
    const guide = FLOW_GUIDE[stage.name];
    const guideText = await composeGuide(
      guide.topic,
      ctx.config,
      ctx.repo.topLevel,
      guide.sections,
    );
    warnings.push(...guideText.warnings);
    const approval = approvalOf(stage.name, {
      auto,
      autoMerge: ctx.config.auto.merge,
      decisions: ctx.config.auto.decisions,
    });
    const result: FlowNext = {
      target: { iteration: facts.iteration, tickets: facts.targets.map((t) => t.id) },
      stage,
      repeated,
      guide: {
        topic: guide.topic,
        sections: [...guide.sections],
        text: guideText.text,
        command: guideCommandOf(guide.topic, guide.sections),
      },
      approval,
      commands: commandsOf(stage, facts.iteration, approval.auto_ok),
      ask_human:
        stage.name === "stop"
          ? `${stage.reason}。状態を示して止まる。同じ対象で起動し直せば状態から求め直す`
          : null,
      memory,
      // 止まったときも求めた段階を覚える。同じ事実で呼び直しても、続いた段階として止まり続ける
      resume: encodeResume({ target, stage: found.name, facts: fingerprint, memory }),
    };
    return ok(result, undefined, warnings);
  },
});

export const flowCommands = [flowNext];
