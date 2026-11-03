// エージェントへの依頼文（ADR-010）。対象・頼むこと・指示・形式から、エージェントに貼る文を返す。読み取りだけで、データは書き換えない。
// 候補と文の組み立ては純粋な関数（askCandidates・buildAsk）に置き、ask コマンドは store から対象を引いて渡すだけ。
// web は core を実行時に取り込めないので、画面も CLI・HTTP・Webview と同じくこのコマンドを呼ぶ

import { z } from "zod";
import { UsageError } from "../errors.js";
import { isTerminal, STATUSES, type Status } from "../model/common.js";
import { parseId, type IdKind } from "../model/id.js";
import { peekRunningRuns } from "../run/record.js";
import type { Store } from "../storage/store.js";
import { findConstraint } from "../workflow/resolve.js";
import { defineCommand, ok } from "./define.js";
import { ticketsInIteration } from "./helpers.js";

/** 頼むこと。どの対象で候補に出るかは askCandidates が決める */
export const ASK_ACTIONS = [
  "create",
  "create_iteration",
  "create_epic",
  "fix",
  "split",
  "remove",
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
      /** 入っている Iteration の status（planned・active・closed）。Iteration がなければ null */
      iteration_status: string | null;
      /** 入っている Epic。なければ null */
      epic: string | null;
      /** 依存先がすべて done か abandoned か（WF-2） */
      deps_done: boolean;
      /** このマシンで実行中の Run があるか */
      running: boolean;
      /** 今の Status からの遷移のうち、Workflow の by に agent が入っていない行き先（WF-1）。省けば制約なし */
      agent_denied?: string[];
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
  /** prompt はエージェントに貼る依頼文、command は人が打つ dg のコマンド（頼むことの操作が actor.human_only に入っているか、Workflow の by が遷移を人に限るとき） */
  kind: "prompt" | "command";
  /** 当たった actor.human_only の操作 */
  human_only: string[];
  /** 当たった Workflow の by が人に限る遷移（`t12: todo → abandoned`）。human_only とともに空なら kind は prompt */
  workflow_by: string[];
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
/** done から戻す先。abandoned はやめるので、done の取り消しの戻す先に入れない */
const UNDO_DONE_TO = ["todo", "in_progress", "review"] as const;

/**
 * 対象のチケットが入っている場所（Iteration・Epic の詳細の中の行から頼むとき）。外すの候補を足すのに使う。
 * 頭の文字で種類を決める（s3 は Iteration、e2 は Epic）
 */
export type AskWithin = string;

/** within を種類と ID にする。対象がすべてチケットで、どれもその Iteration・Epic に入っているときだけ返す */
function withinOf(s: Subjects, within: AskWithin | undefined) {
  if (!within) return undefined;
  const kind = within.startsWith("s") ? "iteration" : within.startsWith("e") ? "epic" : undefined;
  const tickets = only(s, "ticket");
  if (!kind || !tickets) return undefined;
  const inside = tickets.every((t) => (kind === "iteration" ? t.iteration : t.epic) === within);
  return inside ? { kind, id: within } : undefined;
}
type Within = NonNullable<ReturnType<typeof withinOf>>;

/** チケットを to へ動かす遷移が Workflow の by で人に限られるなら、その遷移（`t12: todo → abandoned`） */
function deniedMove(s: AskSubject, to: readonly string[]): string | undefined {
  if (s.kind !== "ticket") return undefined;
  const denied = s.agent_denied ?? [];
  // 戻す先が選べる遷移は、どれも人に限られるときだけ人に回す。行える先があればエージェントに頼む
  if (to.length === 0 || !to.every((st) => denied.includes(st))) return undefined;
  return `${s.id}: ${s.status} → ${to.join("・")}`;
}

/** 人が打つ 1 手。check のどれかが actor.human_only に入っているか、denied があれば、頼むことを人に回す */
interface HumanStep {
  check: readonly string[];
  command: string;
  /** Workflow の by が人に限る遷移（`t12: todo → abandoned`）。agent も行えるなら省く */
  denied?: string;
}

interface ActionDef {
  /** Skill の名前（dg skill install で配る dg<トピック>）。null なら 1 行目を置かない */
  skill: string | null;
  /** 1 行目に対象の ID を並べない（起票・作成。対象は「対象:」に書く） */
  bare?: boolean;
  /** w は対象のチケットが入っている場所（withinOf が認めたもの）。外すだけが使う */
  label(s: Subjects, w?: Within): string;
  text(s: Subjects, w?: Within): string;
  /** 1 行目に並べる対象。省けばすべて */
  args?(s: Subjects): Subjects;
  /** 操作が 1 つに決まる頼むことだけ持つ。Skill の手順に任せるものは、拒否されたらエージェントが人に頼む */
  human?(s: Subjects, w?: Within): HumanStep[];
}

const withDenied = (denied: string | undefined) => (denied ? { denied } : {});

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
  remove: {
    skill: "dgassign",
    label: (_s, w) => `${w?.id ?? "Iteration・Epic"} から外す`,
    text: (_s, w) => `次のチケットを ${w?.id ?? "入っている Iteration・Epic"} から外してください。`,
    human: (s, w) =>
      w
        ? [
            {
              check: [`${w.kind}.remove`],
              command: `dg ${w.kind} remove ${w.id} ${ids(s).join(" ")}`,
            },
          ]
        : [],
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
    human: (s) => s.map((t) => ({ check: ["plan.approve"], command: `dg plan approve ${t.id}` })),
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
      s.map((t) => ({
        check: ["ticket.move"],
        command: `dg ticket move ${t.id} abandoned`,
        ...withDenied(deniedMove(t, ["abandoned"])),
      })),
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
        ...withDenied(deniedMove(t, UNDO_DONE_TO)),
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

/** 頼むことを人に回すか決めるときに actor.human_only と照らす操作の名前。名前が commands にあることをテストで確かめる */
export function askHumanChecks(action: AskAction, s: Subjects, within?: AskWithin): string[] {
  return (ACTIONS[action].human?.(s, withinOf(s, within)) ?? []).flatMap((h) => h.check);
}

/**
 * 対象の種類と状態から、頼むことの候補を決める。先頭がおすすめ。
 * within（対象のチケットが入っている Iteration・Epic）を渡し、チケットがどれもそこに入っていて終わっていなければ、外すを直すの後（直すがなければ自由にの前）に足す
 */
export function askActions(s: Subjects, within?: AskWithin): AskAction[] {
  const actions = baseActions(s);
  const tickets = only(s, "ticket");
  if (!withinOf(s, within) || !tickets || tickets.some((t) => isTerminal(t.status as Status)))
    return actions;
  const at = actions.includes("fix") ? actions.indexOf("fix") + 1 : actions.indexOf("free");
  return [...actions.slice(0, at), "remove", ...actions.slice(at)];
}

function baseActions(s: Subjects): AskAction[] {
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
      // closed の Iteration に残った持ち越しは、計画より先に別の Iteration へ割り当てる
      if (tickets.some((t) => t.iteration_status === "closed"))
        return ["assign", "create_iteration", "plan", "fix", "split", "check", "abandon", "free"];
      if (tickets.length > 1) return ["plan", "assign", "check", "abandon", "free"];
      // 着手可でも、planned の Iteration（バックログ）ではまず計画を立て、active の Iteration（カンバン）なら進める
      if (tickets[0]!.deps_done)
        return tickets[0]!.iteration_status === "active"
          ? ["work", "plan", "fix", "split", "check", "abandon", "free"]
          : ["plan", "work", "fix", "split", "check", "abandon", "free"];
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

export function askCandidates(s: Subjects, within?: AskWithin): AskCandidate[] {
  const w = withinOf(s, within);
  return askActions(s, within).map((action, n) => ({
    action,
    label: ACTIONS[action].label(s, w),
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
  /** 対象のチケットが入っている Iteration・Epic（詳細の中の行から頼むとき）。外すの候補が出る */
  within?: AskWithin | undefined;
}

/** 依頼文を作る。頼むことが候補になければ UsageError */
export function buildAsk(input: BuildAskInput): AskView {
  const s = input.subjects;
  const format = input.format ?? "skill";
  const candidates = askCandidates(s, input.within);
  const w = withinOf(s, input.within);
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

  // 人に限った操作と遷移は、依頼しても TRANSITION_REJECTED になるので、人が打つコマンドを返す
  const humanOnly = new Set(input.humanOnly ?? []);
  const steps = def.human?.(s, w) ?? [];
  const hit = [...new Set(steps.flatMap((h) => h.check.filter((c) => humanOnly.has(c))))];
  const workflowBy = steps.flatMap((h) => (h.denied ? [h.denied] : []));
  if (hit.length > 0 || workflowBy.length > 0)
    return {
      ...view,
      kind: "command",
      human_only: hit,
      workflow_by: workflowBy,
      text: steps.map((h) => h.command).join("\n"),
    };

  const note = input.note?.trim();
  if (chosen === "free" && s.length === 0 && !note)
    throw new UsageError("自由に頼むときは、対象か指示（note）が要る");
  const lead: string[] = [];
  // Skill を使わない頼むことは、Skill 形式でも 1 行目の代わりに dg の呼び方を添える
  if (format === "text" || !candidate.skill) lead.push(ASK_TEXT_PREAMBLE);
  else
    lead.push(def.bare ? candidate.skill : [candidate.skill, ...ids(def.args?.(s) ?? s)].join(" "));
  const text = def.text(s, w);
  if (text) lead.push(text);
  const sections = [lead];
  if (targets.length > 0) sections.push(["対象:", ...targets.map((t) => `- ${t.line}`)]);
  if (note) sections.push(["指示:", note]);
  return {
    ...view,
    kind: "prompt",
    human_only: [],
    workflow_by: [],
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

/** 今の Status からの遷移のうち、Workflow の by に agent が入っていない行き先。Workflow が読めなければ空（move のときに拒否される） */
function agentDenied(store: Store, t: Parameters<Store["workflowFor"]>[0]): string[] {
  const wf = store.workflowFor(t);
  if (!wf) return [];
  return STATUSES.filter((to) => {
    const by = to === t.status ? undefined : findConstraint(wf.resolved, t.status, to)?.by;
    return by !== undefined && !by.includes("agent");
  });
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
        iteration_status: t.iteration
          ? (store.iterations.get(t.iteration)?.data.status ?? null)
          : null,
        epic: t.epic ?? null,
        deps_done: store.depsDone(t),
        running: running.has(t.id),
        agent_denied: agentDenied(store, t),
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
    "エージェントに貼る依頼文を作る（読み取りだけ）。対象の種類と状態から頼むことの候補とおすすめ（先頭）を返し、頼むこと・指示・形式（Skill か文章だけ）から文を組む。頼むことの操作が actor.human_only に入っているか、Workflow の by が遷移を人に限れば、人が打つ dg のコマンドを返す",
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
    within: z
      .string()
      .optional()
      .describe(
        "対象のチケットが入っている Iteration か Epic（s3・e2）。詳細の中の行から頼むときに渡し、チケットがどれもそこに入っていれば「そこから外す」を候補に足す",
      ),
  }),
  write: false,
  needs: "store",
  positionals: ["targets"],
  async run(ctx, input) {
    const refs = input.targets.map((r) => r.trim());
    const running = await runningTickets(ctx.repo, refs);
    return ok(
      buildAsk({
        subjects: subjectsOf(ctx.store, refs, running),
        action: input.action,
        note: input.note,
        format: input.format,
        humanOnly: ctx.config.actor.human_only,
        within: withinRef(ctx.store, input.within),
      }),
    );
  },
});

/** 画面の 1 か所（行・見出し）の候補。key は対象の ID を空白でつないだもの（空なら対象なし） */
export interface AskMenu {
  key: string;
  /** 対象の種類と状態から決めた候補（ask の candidates と同じ）。先頭がおすすめ。引けなければ空 */
  candidates: AskCandidate[];
  /** 対象を引けなかった理由（消えたチケットなど）。引けたら null */
  error: string | null;
}

export const askMenu = defineCommand({
  name: "ask-menu",
  group: "ask",
  summary:
    "画面の行・見出しごとの頼むことの候補（先頭がおすすめ）をまとめて返す（読み取りだけ）。組ごとに ask の candidates と同じものを返し、引けない組は error に理由を入れる。左パネルの吹き出しと右クリックのメニューが使う",
  input: z.object({
    sets: z
      .array(z.string())
      .default([])
      .describe(
        '対象の組（ID を空白で区切る。t12・"t1 t2"・s3）。空の文字列は対象なし。@ を付けた Iteration・Epic（"t12 @s3"）は、チケットが入っている場所（ask の within）',
      ),
  }),
  write: false,
  needs: "store",
  positionals: ["sets"],
  async run(ctx, input) {
    const keys = [...new Set(input.sets.map(normalizeKey))];
    const running = await runningTickets(
      ctx.repo,
      keys.flatMap((k) => parseKey(k).refs),
    );
    return ok(
      keys.map((key): AskMenu => {
        try {
          const { refs, within } = parseKey(key);
          const candidates = askCandidates(
            subjectsOf(ctx.store, refs, running),
            withinRef(ctx.store, within),
          );
          return { key, candidates, error: null };
        } catch (e) {
          return { key, candidates: [], error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
  },
});

function splitRefs(key: string): string[] {
  return key.split(/\s+/).filter(Boolean);
}

/** 組の文字列を対象と場所（@ を付けた 1 つ。重ねたら後のもの）に分ける */
function parseKey(key: string): { refs: string[]; within: string | undefined } {
  const tokens = splitRefs(key);
  const within = tokens
    .filter((t) => t.startsWith("@"))
    .at(-1)
    ?.slice(1);
  return { refs: tokens.filter((t) => !t.startsWith("@")), within };
}

/** 組の文字列を、対象の ID の後に場所を置いた形にそろえる（返す key はこの形） */
function normalizeKey(key: string): string {
  const { refs, within } = parseKey(key);
  return [...refs, ...(within ? [`@${within}`] : [])].join(" ");
}

/** within を確かめる。Iteration・Epic の ID でなければ使い方の誤り、なければ NOT_FOUND */
function withinRef(store: Store, within: string | undefined): string | undefined {
  const ref = within?.trim();
  if (!ref) return undefined;
  const kind = KIND_OF_PREFIX[ref.charAt(0)];
  if ((kind !== "iteration" && kind !== "epic") || !parseId(ref, kind))
    throw new UsageError(`${ref} は Iteration・Epic の ID ではない（s3・e2 の形で書く）`);
  return store.require(kind, ref).id;
}

/** チケットを含むときだけ、このマシンで実行中の Run があるチケットを読む */
async function runningTickets(
  repo: Parameters<typeof peekRunningRuns>[0],
  refs: readonly string[],
): Promise<ReadonlySet<string>> {
  if (!refs.some((r) => r.startsWith("t"))) return new Set();
  return new Set((await peekRunningRuns(repo)).map((r) => r.ticket));
}

/** ID から対象を引く。同じ対象を番号の書き方を変えて重ねたもの（t1 と t01 など）は 1 つにする */
function subjectsOf(
  store: Store,
  refs: readonly string[],
  running: ReadonlySet<string>,
): AskSubject[] {
  const subjects = [...new Set(refs)].map((r) => askSubjectOf(store, r, running));
  return subjects.filter((t, n) => subjects.findIndex((u) => u.id === t.id) === n);
}

export const askCommands = [ask, askMenu];
