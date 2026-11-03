// エージェントへの依頼文（ADR-010）。対象・頼むこと・指示・形式から、エージェントに貼る文を返す。読み取りだけで、データは書き換えない。
// 候補と文の組み立ては純粋な関数（askCandidates・buildAsk）に置き、ask コマンドは store から対象を引いて渡すだけ。
// web は core を実行時に取り込めないので、画面も CLI・HTTP・Webview と同じくこのコマンドを呼ぶ

import { z } from "zod";
import { UsageError } from "../errors.js";
import { isTerminal, type Status } from "../model/common.js";
import { parseId, type IdKind } from "../model/id.js";
import { peekRunningRuns } from "../run/record.js";
import type { Store } from "../storage/store.js";
import { defineCommand, ok } from "./define.js";
import { ticketsInIteration } from "./helpers.js";

/** 頼むこと。どの対象で候補に出るかは askCandidates が決める */
export const ASK_ACTIONS = [
  "create",
  "create_iteration",
  "create_epic",
  "fix",
  "split",
  "edit",
  "assign",
  "plan",
  "approve",
  "work",
  "resume",
  "all",
  "done",
  "check",
  "release",
  "close",
  "reopen",
  "abandon",
  "undo_done",
  "status",
  "retro",
  "free",
] as const;
export type AskAction = (typeof ASK_ACTIONS)[number];

export const ASK_FORMATS = ["skill", "text"] as const;
export type AskFormat = (typeof ASK_FORMATS)[number];

export type PlanState = "pending_approval" | "approved" | "closed";

/** 依頼文の対象。本文は持たない（エージェントが dg で読む） */
export type AskSubject =
  | {
      kind: "ticket";
      id: string;
      title: string;
      status: string;
      iteration: string | null;
      /** 依存先がすべて done か abandoned か（WF-2） */
      deps_done: boolean;
      /** このマシンで実行中の Run があるか */
      running: boolean;
    }
  | {
      kind: "iteration";
      id: string;
      title: string;
      status: string;
      /** 中のチケットが 1 件以上あり、すべて done か abandoned か */
      complete: boolean;
    }
  | { kind: "epic"; id: string; title: string; status: string }
  | {
      kind: "plan";
      id: string;
      status: PlanState;
      tickets: string[];
      /** チケットが 1 件以上あり、すべて done か abandoned か */
      complete: boolean;
    };

export type AskTarget = AskSubject & {
  /** 依頼文の「対象:」に並べる 1 行 */
  line: string;
};

export interface AskCandidate {
  action: AskAction;
  label: string;
  /** 1 行目の Skill（`/dgdone`）。Skill を使わない頼むことは null */
  skill: string | null;
  /** 先頭の候補だけ true */
  recommended: boolean;
}

export interface AskView {
  targets: AskTarget[];
  /** 対象の種類と状態から決めた候補。先頭がおすすめ */
  candidates: AskCandidate[];
  action: AskAction;
  label: string;
  skill: string | null;
  format: AskFormat;
  /** prompt はエージェントに貼る依頼文、command は人が打つ dg のコマンド（頼むことの操作が actor.human_only に入っているとき） */
  kind: "prompt" | "command";
  /** 当たった actor.human_only の操作。空なら kind は prompt */
  human_only: string[];
  /** 依頼文か、人が打つコマンド（1 行に 1 つ） */
  text: string;
}

/** 文章だけの形式で、1 行目の Skill の代わりに添える dg の呼び方（AG-1） */
export const ASK_TEXT_PREAMBLE =
  "deguboard（dg）のデータについての依頼です。dg は `dg … --json --actor agent` で呼び、.git/deguboard/ のファイルは直接編集しないでください。";

const CREATED_BY_HUMAN = "人の指示による起票なので --created-by human を付けてください。";
const CREATED_BY_HUMAN_LATER =
  "人の指示なので、チケットを起票するときは --created-by human を付けてください。";

type Subjects = readonly AskSubject[];
type TicketSubject = Extract<AskSubject, { kind: "ticket" }>;

const only = <K extends AskSubject["kind"]>(s: Subjects, kind: K) =>
  s.length > 0 && s.every((t) => t.kind === kind)
    ? (s as readonly Extract<AskSubject, { kind: K }>[])
    : undefined;
const single = <K extends AskSubject["kind"]>(s: Subjects, kind: K) =>
  s.length === 1 ? only(s, kind)?.[0] : undefined;
const ids = (s: Subjects) => s.map((t) => t.id);
const isStalled = (t: TicketSubject) => t.status === "in_progress" && !t.running;
const isWaiting = (t: TicketSubject) => t.status === "todo" && !t.deps_done;
const kindName = (t: AskSubject) => (t.kind === "iteration" ? "Iteration" : "Epic");

/** 人が打つ 1 手。check のどれかが actor.human_only に入っていれば、頼むことを人に回す */
interface HumanStep {
  check: readonly string[];
  command: string;
}

interface ActionDef {
  /** Skill の名前（dg skill install で配る dg<トピック>）。null なら 1 行目を置かない */
  skill: string | null;
  /** 1 行目に対象の ID を並べない（起票・作成。対象は「対象:」に書く） */
  bare?: boolean;
  label(s: Subjects): string;
  text(s: Subjects): string;
  /** 1 行目に並べる対象。省けばすべて */
  args?(s: Subjects): Subjects;
  /** 操作が 1 つに決まる頼むことだけ持つ。Skill の手順に任せるものは、拒否されたらエージェントが人に頼む */
  human?(s: Subjects): HumanStep[];
}

const ACTIONS: Record<AskAction, ActionDef> = {
  create: {
    skill: "dgimport",
    bare: true,
    label(s) {
      const it = single(s, "iteration");
      if (it) return `起票して ${it.id} に入れる`;
      const ep = single(s, "epic");
      if (ep) return ep.status === "closed" ? "続きを起票する" : `起票して ${ep.id} に足す`;
      if (only(s, "ticket")?.every((t) => t.status === "done")) return "不具合・続きを起票する";
      if (only(s, "ticket")?.every((t) => t.status === "abandoned")) return "起票し直す";
      return "起票する";
    },
    text(s) {
      const it = single(s, "iteration");
      const ep = single(s, "epic");
      const tickets = only(s, "ticket");
      const lead = it
        ? `次の内容をチケットにして ${it.id} に入れてください。`
        : ep?.status === "closed"
          ? "この Epic の続きの作業をチケットにしてください。新しい Epic にまとめるかは案を示してください。"
          : ep
            ? `次の内容をチケットにして ${ep.id} に足してください。`
            : tickets?.every((t) => t.status === "done")
              ? "次のチケットの後に見つかった不具合や続きの作業をチケットにしてください。"
              : tickets?.every((t) => t.status === "abandoned")
                ? "次のチケットの代わりを起票し直してください。"
                : s.length > 0
                  ? "次の対象に関わる内容をチケットにしてください。"
                  : "次の内容をチケットにしてください。";
      return `${lead}${CREATED_BY_HUMAN}`;
    },
    human(s) {
      const steps: HumanStep[] = [
        { check: ["ticket.create", "ticket.import"], command: 'dg ticket create "<タイトル>"' },
      ];
      const it = single(s, "iteration");
      if (it) steps.push({ check: ["iteration.add"], command: `dg iteration add ${it.id} "<ID>"` });
      const ep = single(s, "epic");
      if (ep?.status === "open")
        steps.push({ check: ["epic.add"], command: `dg epic add ${ep.id} "<ID>"` });
      return steps;
    },
  },
  create_iteration: {
    skill: "dgassign",
    bare: true,
    label: () => "Iteration を作る",
    text: (s) =>
      (s.length > 0
        ? "次のチケットを入れる Iteration を作ってください。名前・目標・期間は指示のとおりにし、なければ案を示してください。"
        : "Iteration を作ってください。名前・目標・期間は指示のとおりにし、入れるチケットがあれば案を示してください。") +
      CREATED_BY_HUMAN_LATER,
    human: () => [{ check: ["iteration.create"], command: 'dg iteration create "<名前>"' }],
  },
  create_epic: {
    skill: "dgassign",
    bare: true,
    label: () => "Epic を作る",
    text: (s) =>
      (s.length > 0
        ? "次のチケットを束ねる Epic を作ってください。題と概要は指示のとおりにし、なければ案を示してください。"
        : "Epic を作ってください。題と概要は指示のとおりにし、束ねるチケットがあれば案を示してください。") +
      CREATED_BY_HUMAN_LATER,
    human: () => [{ check: ["epic.create"], command: 'dg epic create "<題>"' }],
  },
  fix: {
    skill: "dgimport",
    label: () => "直す",
    text: () => "次のチケットを指示のとおりに直してください。",
  },
  split: {
    skill: "dgimport",
    label: () => "分ける",
    text: () =>
      "次のチケットを分けてください。元のチケットの扱い（残す・abandoned にする）は案を示してください。",
  },
  edit: {
    skill: null,
    label: (s) => (single(s, "iteration") ? "名前・目標・期間を直す" : "題・概要を直す"),
    text: (s) =>
      single(s, "iteration")
        ? "この Iteration の名前・目標・期間を、指示のとおりに直してください。"
        : "この Epic の題と概要を、指示のとおりに直してください。",
    human: (s) =>
      s.map((t) =>
        t.kind === "iteration"
          ? { check: ["iteration.update"], command: `dg iteration update ${t.id} --name "<名前>"` }
          : { check: ["epic.update"], command: `dg epic update ${t.id} --title "<題>"` },
      ),
  },
  assign: {
    skill: "dgassign",
    label: (s) =>
      single(s, "iteration")?.status === "closed"
        ? "持ち越しを割り当てる"
        : single(s, "epic") || single(s, "iteration")
          ? "チケットを足す・外す"
          : "割り当てる",
    text(s) {
      const it = single(s, "iteration");
      if (it?.status === "closed")
        return "この Iteration の持ち越しのチケットを、今の Iteration か新しい Iteration に割り当ててください。";
      if (it)
        return `未割り当ての todo から ${it.id} に入れるものを選んでください。足す・外すチケットが指示にあればそのとおりに。`;
      if (single(s, "epic"))
        return "この Epic に入れるチケットを選んでください。足す・外すチケットが指示にあればそのとおりに。";
      return "次のチケットを合う Iteration・Epic に割り当ててください。移す先が指示にあればそのとおりに。";
    },
  },
  plan: {
    skill: "dgplan",
    label: (s) => (single(s, "plan") ? "組み直す" : "計画を立てる"),
    text: (s) =>
      single(s, "plan")
        ? "この Plan を組み直し、承認を待ってください。"
        : "次の対象を進める Plan を立て、承認を待ってください。",
  },
  approve: {
    skill: "dgplan",
    label: () => "承認する",
    text: () => "承認待ちのこの Plan の内容を示し、承認を求めてください。",
  },
  work: {
    skill: "dgwork",
    label: (s) => (single(s, "plan") ? "Plan を進める" : "進める"),
    text: (s) =>
      single(s, "plan")
        ? "この Plan を着手できるものから進めてください。"
        : "次のチケットを進めてください。",
  },
  resume: {
    skill: "dgwork",
    label: () => "再開する",
    // 実行中の Run と同じ Skill を重ねて呼ばないよう、1 行目には止まったものだけを並べる
    args: (s) => (only(s, "ticket") ?? []).filter(isStalled),
    text(s) {
      const running = (only(s, "ticket") ?? []).filter((t) => t.running).map((t) => t.id);
      return (
        "止まっている次のチケットの作業を再開してください。" +
        (running.length > 0
          ? `${running.join("・")} は Run が実行中なので触らないでください。`
          : "")
      );
    },
  },
  all: {
    skill: "dgall",
    label: () => "最後まで進める",
    text: () => "この Iteration を最後まで進めてください。承認の場所は Skill の手順どおりに。",
  },
  done: {
    skill: "dgdone",
    label: () => "確かめて片付ける",
    text: (s) =>
      single(s, "plan")
        ? "この Plan のマージ済みのチケットを照合して片付け、終わっていれば Plan を閉じてください。"
        : "PR のマージを照合し、残った受け入れ条件を確かめて片付けてください。",
  },
  check: {
    skill: "dgcheck",
    label: (s) => (only(s, "ticket")?.every(isWaiting) ? "待ちを確かめる" : "点検する"),
    text: (s) =>
      s.length === 0
        ? "全体を点検し、直す案を表で示してください。"
        : only(s, "ticket")?.every(isWaiting)
          ? "依存先の進みと、次のチケットを進める順を確かめてください。直す案があれば表で示してください。"
          : "次の対象を点検し、直す案を表で示してください。",
  },
  release: {
    skill: "dgrelease",
    label: () => "リリースする",
    text: () =>
      "この Iteration をリリースしてください。リリースの PR のマージと公開の前に承認を求めてください。",
  },
  close: {
    skill: null,
    label: () => "閉じる",
    text: (s) =>
      `この ${kindName(s[0]!)} を閉じてください（人の指示）。終わっていないチケットがあれば、閉じる前に知らせてください。`,
    human: (s) =>
      s.map((t) => ({
        check: [`${t.kind}.close`],
        command: `dg ${t.kind} close ${t.id}`,
      })),
  },
  reopen: {
    skill: null,
    label: () => "再開する",
    text: (s) =>
      s[0]?.kind === "iteration"
        ? "この Iteration を再開してください（人の指示）。ほかに active があれば、再開の前に知らせてください。"
        : "この Epic を再開してください（人の指示）。",
    human: (s) =>
      s.map((t) => ({
        check: [`${t.kind}.reopen`],
        command: `dg ${t.kind} reopen ${t.id}`,
      })),
  },
  abandon: {
    skill: null,
    label: () => "やめる",
    text: () =>
      "次のチケットをやめて abandoned にしてください（人の指示）。理由は指示のとおりに本文へ書いてください。",
    human: (s) =>
      s.map((t) => ({ check: ["ticket.move"], command: `dg ticket move ${t.id} abandoned` })),
  },
  undo_done: {
    skill: null,
    label: () => "done を取り消す",
    text: () =>
      "次のチケットの done を取り消してください（人の指示）。戻す Status と理由は指示のとおりに。",
    human: (s) =>
      s.map((t) => ({
        check: ["ticket.move"],
        command: `dg ticket move ${t.id} "<戻す Status>"`,
      })),
  },
  status: {
    skill: null,
    label: () => "様子を聞く",
    text: () => "次のチケットの作業の様子を教えてください。データは書き換えないでください。",
  },
  retro: {
    skill: null,
    label: () => "振り返る",
    text: (s) =>
      s[0]?.kind === "iteration"
        ? "この Iteration の振り返りをまとめてください。終わったチケット・Run の集計・持ち越しから、うまくいったことと次に直すことを挙げてください。データは書き換えないでください。"
        : "この Epic の振り返りをまとめてください。データは書き換えないでください。",
  },
  free: { skill: null, label: () => "自由に", text: () => "" },
};

/** 依頼文に使う Skill の名前（dg<トピック>）。dg skill install で配る名前と一致することを cli のテストで確かめる */
export const ASK_SKILLS: readonly string[] = [
  ...new Set(Object.values(ACTIONS).flatMap((a) => (a.skill ? [a.skill] : []))),
];

/** 対象の種類と状態から、頼むことの候補を決める。先頭がおすすめ */
export function askActions(s: Subjects): AskAction[] {
  if (s.length === 0) return ["create", "create_iteration", "create_epic", "check", "free"];

  const tickets = only(s, "ticket");
  if (tickets) {
    const all = (status: string) => tickets.every((t) => t.status === status);
    if (all("review")) return ["done", "fix", "check", "free"];
    if (all("done")) return ["create", "undo_done", "free"];
    if (all("abandoned")) return ["create", "free"];
    if (all("in_progress"))
      return tickets.some(isStalled)
        ? ["resume", "status", "fix", "free"]
        : ["status", "fix", "free"];
    if (all("todo")) {
      // Iteration に入れてから進める（todo・abandoned のほかは Iteration が要る）
      if (tickets.some((t) => t.iteration === null))
        return ["assign", "create_iteration", "fix", "split", "check", "abandon", "free"];
      if (tickets.length > 1) return ["plan", "assign", "check", "abandon", "free"];
      if (tickets[0]!.deps_done)
        return ["work", "plan", "fix", "split", "check", "abandon", "free"];
      return ["check", "fix", "split", "plan", "abandon", "free"];
    }
    return ["check", "assign", "free"];
  }

  const it = single(s, "iteration");
  if (it) {
    if (it.status === "closed") return ["retro", "assign", "reopen", "free"];
    const rest: AskAction[] = ["create", "assign", "edit", "close", "check", "free"];
    if (it.status === "active" && it.complete) return ["release", "plan", "all", ...rest];
    return it.status === "active" ? ["plan", "all", "release", ...rest] : ["plan", "all", ...rest];
  }

  const ep = single(s, "epic");
  if (ep)
    return ep.status === "closed"
      ? ["create", "retro", "reopen", "free"]
      : ["create", "assign", "plan", "edit", "close", "check", "free"];

  const plan = single(s, "plan");
  if (plan) {
    if (plan.status === "closed") return ["check", "free"];
    if (plan.status === "pending_approval") return ["approve", "plan", "free"];
    return plan.complete ? ["done", "free"] : ["work", "plan", "done", "free"];
  }

  // 種類の混ざった対象や、複数の Iteration・Epic・Plan
  return ["check", "plan", "free"];
}

export function askCandidates(s: Subjects): AskCandidate[] {
  return askActions(s).map((action, n) => ({
    action,
    label: ACTIONS[action].label(s),
    skill: ACTIONS[action].skill && `/${ACTIONS[action].skill}`,
    recommended: n === 0,
  }));
}

const PLAN_STATE_LABEL: Record<PlanState, string> = {
  pending_approval: "承認待ち",
  approved: "承認済み",
  closed: "閉じた",
};

/** 「対象:」の 1 行。ID とタイトル（と Status・Iteration）だけで、本文は入れない */
export function targetLine(t: AskSubject): string {
  switch (t.kind) {
    case "ticket":
      return `${t.id}「${t.title}」（${t.status}, ${t.iteration ?? "Iteration なし"}）`;
    case "iteration":
      return `Iteration ${t.id}「${t.title}」（${t.status}）`;
    case "epic":
      return `Epic ${t.id}「${t.title}」（${t.status}）`;
    case "plan":
      return `Plan ${t.id}（${[PLAN_STATE_LABEL[t.status], t.tickets.join(" ")].filter(Boolean).join("、")}）`;
  }
}

export interface BuildAskInput {
  subjects: Subjects;
  /** 省けばおすすめ */
  action?: AskAction | undefined;
  note?: string | undefined;
  format?: AskFormat | undefined;
  /** config の actor.human_only */
  humanOnly?: readonly string[] | undefined;
}

/** 依頼文を作る。頼むことが候補になければ UsageError */
export function buildAsk(input: BuildAskInput): AskView {
  const s = input.subjects;
  const format = input.format ?? "skill";
  const candidates = askCandidates(s);
  const chosen = input.action ?? candidates[0]!.action;
  const candidate = candidates.find((c) => c.action === chosen);
  if (!candidate)
    throw new UsageError(
      `${chosen} はこの対象の頼むことの候補にない`,
      `候補：${candidates.map((c) => `${c.action}（${c.label}）`).join("、")}`,
    );
  const def = ACTIONS[chosen];
  const targets = s.map((t) => ({ ...t, line: targetLine(t) }));
  const view = {
    targets,
    candidates,
    action: chosen,
    label: candidate.label,
    skill: candidate.skill,
    format,
  };

  // 人に限った操作は、依頼しても TRANSITION_REJECTED になるので、人が打つコマンドを返す
  const humanOnly = new Set(input.humanOnly ?? []);
  const steps = def.human?.(s) ?? [];
  const hit = [...new Set(steps.flatMap((h) => h.check.filter((c) => humanOnly.has(c))))];
  if (hit.length > 0)
    return {
      ...view,
      kind: "command",
      human_only: hit,
      text: steps.map((h) => h.command).join("\n"),
    };

  const lead: string[] = [];
  if (format === "text") lead.push(ASK_TEXT_PREAMBLE);
  else if (candidate.skill)
    lead.push(def.bare ? candidate.skill : [candidate.skill, ...ids(def.args?.(s) ?? s)].join(" "));
  const text = def.text(s);
  if (text) lead.push(text);
  const sections = [lead];
  if (targets.length > 0) sections.push(["対象:", ...targets.map((t) => `- ${t.line}`)]);
  const note = input.note?.trim();
  if (note) sections.push(["指示:", note]);
  return {
    ...view,
    kind: "prompt",
    human_only: [],
    text: sections
      .filter((lines) => lines.length > 0)
      .map((lines) => lines.join("\n"))
      .join("\n\n"),
  };
}

const KIND_OF_PREFIX: Record<string, IdKind> = {
  t: "ticket",
  s: "iteration",
  e: "epic",
  p: "plan",
};

function isComplete(statuses: readonly (Status | undefined)[]): boolean {
  return statuses.length > 0 && statuses.every((st) => st !== undefined && isTerminal(st));
}

/** ID から対象を引く。種類は頭の文字で決めるので、番号だけは受けない */
export function askSubjectOf(store: Store, ref: string, running: ReadonlySet<string>): AskSubject {
  const kind = KIND_OF_PREFIX[ref.trim().charAt(0)];
  if (!kind || !parseId(ref, kind))
    throw new UsageError(`${ref} は対象の ID ではない（t12・s3・e2・p7 の形で書く）`);
  switch (kind) {
    case "ticket": {
      const t = store.require("ticket", ref).data;
      return {
        kind,
        id: t.id,
        title: t.title,
        status: t.status,
        iteration: t.iteration ?? null,
        deps_done: store.depsDone(t),
        running: running.has(t.id),
      };
    }
    case "iteration": {
      const it = store.require("iteration", ref).data;
      const statuses = ticketsInIteration(store, it.id).map((t) => t.data.status);
      return {
        kind,
        id: it.id,
        title: it.name,
        status: it.status,
        complete: isComplete(statuses),
      };
    }
    case "epic": {
      const ep = store.require("epic", ref).data;
      return { kind, id: ep.id, title: ep.title, status: ep.status };
    }
    case "plan": {
      const p = store.require("plan", ref).data;
      return {
        kind,
        id: p.id,
        status:
          p.closed_at !== undefined
            ? "closed"
            : p.pending_approval
              ? "pending_approval"
              : "approved",
        tickets: p.tickets,
        complete: isComplete(p.tickets.map((id) => store.tickets.get(id)?.data.status)),
      };
    }
  }
}

export const ask = defineCommand({
  name: "ask",
  group: "ask",
  summary:
    "エージェントに貼る依頼文を作る（読み取りだけ）。対象の種類と状態から頼むことの候補とおすすめ（先頭）を返し、頼むこと・指示・形式（Skill か文章だけ）から文を組む。頼むことの操作が actor.human_only に入っていれば、人が打つ dg のコマンドを返す",
  input: z.object({
    targets: z
      .array(z.string().min(1))
      .default([])
      .describe("対象の ID（t12・s3・e2・p7。複数可）。省けば対象なし（起票・作成・全体の点検）"),
    action: z
      .enum(ASK_ACTIONS)
      .optional()
      .describe("頼むこと。省けばおすすめ（candidates の先頭）。候補にないものは使い方の誤り"),
    note: z.string().optional().describe("依頼文に添える指示"),
    format: z
      .enum(ASK_FORMATS)
      .default("skill")
      .describe("skill は 1 行目が Skill の呼び出し、text は Skill の代わりに dg の呼び方を添える"),
  }),
  write: false,
  needs: "store",
  positionals: ["targets"],
  async run(ctx, input) {
    const refs = [...new Set(input.targets.map((r) => r.trim()))];
    const hasTicket = refs.some((r) => r.startsWith("t"));
    const running = new Set(
      hasTicket ? (await peekRunningRuns(ctx.repo)).map((r) => r.ticket) : [],
    );
    const subjects = refs.map((r) => askSubjectOf(ctx.store, r, running));
    // 同じ対象を番号の書き方を変えて重ねたもの（t1 と t01 など）を除く
    const unique = subjects.filter((t, n) => subjects.findIndex((u) => u.id === t.id) === n);
    return ok(
      buildAsk({
        subjects: unique,
        action: input.action,
        note: input.note,
        format: input.format,
        humanOnly: ctx.config.actor.human_only,
      }),
    );
  },
});

export const askCommands = [ask];
