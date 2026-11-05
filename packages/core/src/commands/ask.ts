// エージェントへの依頼文（ADR-010）。対象・頼むこと・指示・形式から、エージェントに貼る文を返す。読み取りだけで、データは書き換えない。
// 候補と文の組み立ては純粋な関数（askCandidates・buildAsk）に置き、ask コマンドは store から対象を引いて渡すだけ。
// web は core を実行時に取り込めないので、画面も CLI・HTTP・Webview と同じくこのコマンドを呼ぶ

import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentSkillDirs } from "../agents/index.js";
import { UsageError } from "../errors.js";
import { isTerminal, STATUSES, type Status } from "../model/common.js";
import { idKindOf, parseId } from "../model/id.js";
import { peekRunningRuns } from "../run/record.js";
import type { Store } from "../storage/store.js";
import { findConstraint } from "../workflow/resolve.js";
import { defineCommand, ok } from "./define.js";
import { iterationReadiness, localDate, ticketsInIteration } from "./helpers.js";

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
  "carry",
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
      /** active で終了日を過ぎ、未完了のチケットがあるか（持ち越しの相談。省けば false） */
      overdue?: boolean;
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
  /** 対象の ID とタイトル（と Status・Iteration）の 1 行。画面の札のツールチップに出す。依頼文には入れない */
  line: string;
  /** 画面の札の小さな添え字。チケット・Iteration・Epic は Status、Plan は承認の状態の表示名（承認待ち・承認済み・閉じた） */
  sub: string;
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
  /** prompt はエージェントに貼る依頼文、command は人が打つ dg のコマンド（操作が 1 つに決まる頼むことで、その操作が actor.human_only に入っているか、Workflow の by が遷移を人に限るとき） */
  kind: "prompt" | "command";
  /** 当たった actor.human_only の操作 */
  human_only: string[];
  /** 当たった Workflow の by が人に限る遷移（`t12: todo → abandoned`）。human_only とともに空なら kind は prompt */
  workflow_by: string[];
  /** 依頼文か、人が打つコマンド（1 行に 1 つ） */
  text: string;
}

/** PATH に dg がないときの置き換えの案内。Skill（cli の skill.md の {{dgPathNote}}）と文章だけの形式が同じ文を写す正本（AG-2・AG-8） */
export const DG_PATH_NOTE =
  "PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。";

/** DG_PATH_NOTE の英語。英語の依頼文（language が en）の文章だけの形式に使う */
export const DG_PATH_NOTE_EN =
  "If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.";

/** 文章だけの形式で、頼む 1 文の次に添える dg の呼び方（AG-1） */
export const ASK_DG_USAGE = `dg は \`dg … --json --actor agent\` で呼び、.git/deguboard/ のファイルは直接編集しないでください。${DG_PATH_NOTE}`;

/** ASK_DG_USAGE の英語 */
export const ASK_DG_USAGE_EN = `Call dg as \`dg … --json --actor agent\`, and do not edit the files under .git/deguboard/ directly. ${DG_PATH_NOTE_EN}`;

/** 依頼文の定型の文の言語（UI-11）。指示（note）とチケットの中身は書いた言葉のまま入れ、言語では変えない */
export const ASK_LANGUAGES = ["ja", "en"] as const;
export type AskLanguage = (typeof ASK_LANGUAGES)[number];

/** 言語に合わせて、日本語と英語の定型の文のどちらかを選ぶ */
const say = (lang: AskLanguage, ja: string, en: string) => (lang === "en" ? en : ja);
/** 頼む 1 文の終わり */
const end = (lang: AskLanguage) => say(lang, "。", ".");

const createdByHuman = (lang: AskLanguage) =>
  say(
    lang,
    "（人の指示なので --created-by human を付ける）",
    " (pass --created-by human, since this is a human's instruction)",
  );
const createdByHumanLater = (lang: AskLanguage) =>
  say(
    lang,
    "（チケットを起票するなら、人の指示なので --created-by human を付ける）",
    ". If you create tickets, pass --created-by human, since this is a human's instruction",
  );

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
/** done から戻す先。abandoned はやめるので、done の取り消しの戻す先に入れない */
const UNDO_DONE_TO = ["todo", "in_progress", "review"] as const;

/**
 * within（対象のチケットが入っている Iteration・Epic。詳細の中の行から頼むとき）を種類と ID にする。外すの候補を足すのに使う。
 * 種類は頭の文字で決め（s3 は Iteration、e2 は Epic）、対象がすべてチケットで、どれもそこに入っているときだけ返す
 */
function withinOf(s: Subjects, within: string | undefined) {
  if (!within) return undefined;
  const kind = idKindOf(within);
  const tickets = only(s, "ticket");
  if ((kind !== "iteration" && kind !== "epic") || !tickets) return undefined;
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
  /** Skill の名前（dg skill install で配る dg<トピック>）。null なら Skill の形でも文章だけの形で返す（ADR-010） */
  skill: string | null;
  /** 1 行目に対象の ID を並べない（起票・作成） */
  bare?: boolean;
  /** w は対象のチケットが入っている場所（withinOf が認めたもの）。外すだけが使う */
  label(s: Subjects, w?: Within): string;
  /** 文章だけの形の頼む 1 文。対象の ID を含める。lang は定型の文の言語 */
  text(s: Subjects, w: Within | undefined, lang: AskLanguage): string;
  /** Skill の呼び出しだけでは頼むことが決まらないとき（起票・作成・外す・分ける・組み直す・持ち越し）、指示の行と同じ位置に置く短い頼みごとの 1 行 */
  intent?(s: Subjects, w: Within | undefined, lang: AskLanguage): string;
  /** 1 行目に並べる対象。省けばすべて */
  args?(s: Subjects): Subjects;
  /** 操作が 1 つに決まる頼むことだけ持つ。Skill の手順に任せるものは、拒否されたらエージェントが人に頼む */
  human?(s: Subjects, w?: Within): HumanStep[];
}

const withDenied = (denied: string | undefined) => (denied ? { denied } : {});
/** 頼む 1 文に入れる対象の ID */
const idList = (s: Subjects, lang: AskLanguage) => ids(s).join(say(lang, "・", ", "));

/** 起票の行き先。頼む 1 文と、Skill の呼び出しの次の行の頼みごとの両方に使う */
function createTarget(s: Subjects, lang: AskLanguage): { text: string; intent?: string } {
  const it = single(s, "iteration");
  const ep = single(s, "epic");
  const tickets = only(s, "ticket");
  const L = idList(s, lang);
  if (it)
    return {
      text: say(
        lang,
        `指示の内容をチケットにして ${it.id} に入れてください`,
        `Turn the instructions into tickets and add them to ${it.id}`,
      ),
      intent: say(lang, `起票して ${it.id} に入れて`, `Create tickets and add them to ${it.id}`),
    };
  if (ep?.status === "closed")
    return {
      text: say(
        lang,
        `${ep.id} の続きの作業をチケットにし、新しい Epic にまとめるかは案を示してください`,
        `Turn the follow-up work of ${ep.id} into tickets, and propose whether to group them into a new Epic`,
      ),
      intent: say(
        lang,
        `${ep.id} の続きを起票して`,
        `Create tickets for the follow-up of ${ep.id}`,
      ),
    };
  if (ep)
    return {
      text: say(
        lang,
        `指示の内容をチケットにして ${ep.id} に足してください`,
        `Turn the instructions into tickets and add them to ${ep.id}`,
      ),
      intent: say(lang, `起票して ${ep.id} に足して`, `Create tickets and add them to ${ep.id}`),
    };
  if (tickets?.every((t) => t.status === "done"))
    return {
      text: say(
        lang,
        `${L} の後に見つかった不具合や続きの作業をチケットにしてください`,
        `Turn the bugs and follow-up work found after ${L} into tickets`,
      ),
      intent: say(
        lang,
        `${L} の不具合・続きを起票して`,
        `Create tickets for the bugs and follow-ups of ${L}`,
      ),
    };
  if (tickets?.every((t) => t.status === "abandoned"))
    return {
      text: say(lang, `${L} の代わりを起票し直してください`, `Create a replacement for ${L}`),
      intent: say(lang, `${L} を起票し直して`, `Create a replacement for ${L}`),
    };
  if (s.length > 0)
    return {
      text: say(
        lang,
        `${L} に関わる内容をチケットにしてください`,
        `Turn the work related to ${L} into tickets`,
      ),
      intent: say(
        lang,
        `${L} に関わる内容を起票して`,
        `Create tickets for the work related to ${L}`,
      ),
    };
  return {
    text: say(lang, "指示の内容をチケットにしてください", "Turn the instructions into tickets"),
  };
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
    text: (s, _w, lang) => `${createTarget(s, lang).text}${createdByHuman(lang)}${end(lang)}`,
    intent: (s, _w, lang) => createTarget(s, lang).intent ?? "",
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
    text: (s, _w, lang) =>
      say(
        lang,
        `${s.length > 0 ? `${idList(s, lang)} を入れる ` : ""}Iteration を、名前・目標・期間は指示のとおり（なければ案を示して）作ってください`,
        `Create an Iteration${s.length > 0 ? ` to hold ${idList(s, lang)}` : ""}, with the name, goal, and dates as instructed (propose them if not given)`,
      ) +
      createdByHumanLater(lang) +
      end(lang),
    intent: (s, _w, lang) =>
      say(
        lang,
        `${s.length > 0 ? `${idList(s, lang)} を入れる ` : ""}Iteration を作って`,
        `Create an Iteration${s.length > 0 ? ` to hold ${idList(s, lang)}` : ""}`,
      ),
    human: () => [{ check: ["iteration.create"], command: 'dg iteration create "<名前>"' }],
  },
  create_epic: {
    skill: "dgassign",
    bare: true,
    label: () => "Epic を作る",
    text: (s, _w, lang) =>
      say(
        lang,
        `${s.length > 0 ? `${idList(s, lang)} を束ねる ` : ""}Epic を、題と概要は指示のとおり（なければ案を示して）作ってください`,
        `Create an Epic${s.length > 0 ? ` to group ${idList(s, lang)}` : ""}, with the title and summary as instructed (propose them if not given)`,
      ) +
      createdByHumanLater(lang) +
      end(lang),
    intent: (s, _w, lang) =>
      say(
        lang,
        `${s.length > 0 ? `${idList(s, lang)} を束ねる ` : ""}Epic を作って`,
        `Create an Epic${s.length > 0 ? ` to group ${idList(s, lang)}` : ""}`,
      ),
    human: () => [{ check: ["epic.create"], command: 'dg epic create "<題>"' }],
  },
  fix: {
    skill: "dgimport",
    label: () => "直す",
    text: (s, _w, lang) =>
      say(
        lang,
        `${idList(s, lang)} を指示のとおりに直してください。`,
        `Fix ${idList(s, lang)} as instructed.`,
      ),
  },
  split: {
    skill: "dgimport",
    label: () => "分ける",
    text: (s, _w, lang) =>
      say(
        lang,
        `${idList(s, lang)} を分け、元のチケットの扱い（残す・abandoned にする）は案を示してください`,
        `Split ${idList(s, lang)}, and propose what to do with the original tickets (keep them or make them abandoned)`,
      ) +
      createdByHumanLater(lang) +
      end(lang),
    // 直すと同じ呼び出しになるので、分けることを添える
    intent: (s, _w, lang) => say(lang, `${idList(s, lang)} を分けて`, `Split ${idList(s, lang)}`),
  },
  remove: {
    skill: "dgassign",
    label: (_s, w) => `${w?.id ?? "Iteration・Epic"} から外す`,
    text: (s, w, lang) =>
      say(
        lang,
        `${idList(s, lang)} を ${w?.id ?? "入っている Iteration・Epic"} から外してください。`,
        `Remove ${idList(s, lang)} from ${w?.id ?? "the Iteration or Epic they belong to"}.`,
      ),
    intent: (_s, w, lang) =>
      say(
        lang,
        `${w?.id ?? "入っている Iteration・Epic"} から外して`,
        `Remove them from ${w?.id ?? "the Iteration or Epic they belong to"}`,
      ),
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
    text: (s, _w, lang) =>
      single(s, "iteration")
        ? say(
            lang,
            `${idList(s, lang)} の名前・目標・期間を、指示のとおりに直してください。`,
            `Update the name, goal, and dates of ${idList(s, lang)} as instructed.`,
          )
        : say(
            lang,
            `${idList(s, lang)} の題と概要を、指示のとおりに直してください。`,
            `Update the title and summary of ${idList(s, lang)} as instructed.`,
          ),
    human: (s) =>
      s.map((t) =>
        t.kind === "iteration"
          ? {
              check: ["iteration.update"],
              command: `dg iteration update ${t.id} --name "<名前>" --goal "<目標>" --start "<開始日>" --end "<終了日>"`,
            }
          : {
              check: ["epic.update"],
              command: `dg epic update ${t.id} --title "<題>" --body "<概要>"`,
            },
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
    text(s, _w, lang) {
      const it = single(s, "iteration");
      if (it?.status === "closed")
        return say(
          lang,
          `${it.id} の持ち越しのチケットを、今の Iteration か新しい Iteration に割り当ててください。`,
          `Assign the carried-over tickets of ${it.id} to the current Iteration or a new Iteration.`,
        );
      if (it)
        return say(
          lang,
          `未割り当ての todo から ${it.id} に入れるものを選んでください（足す・外すチケットが指示にあればそのとおりに）。`,
          `Choose which unassigned todo tickets to add to ${it.id} (if the instructions name tickets to add or remove, follow them).`,
        );
      const ep = single(s, "epic");
      if (ep)
        return say(
          lang,
          `${ep.id} に入れるチケットを選んでください（足す・外すチケットが指示にあればそのとおりに）。`,
          `Choose the tickets to add to ${ep.id} (if the instructions name tickets to add or remove, follow them).`,
        );
      return say(
        lang,
        `${idList(s, lang)} を合う Iteration・Epic に割り当ててください（移す先が指示にあればそのとおりに）。`,
        `Assign ${idList(s, lang)} to a fitting Iteration or Epic (if the instructions name where to move them, follow them).`,
      );
    },
    // 閉じた Iteration はふつうの割り当てと同じ呼び出しになるので、持ち越しであることを添える
    intent(s, _w, lang) {
      const it = single(s, "iteration");
      return it?.status === "closed"
        ? say(
            lang,
            `${it.id} の持ち越しを割り当てて`,
            `Assign the carried-over tickets of ${it.id}`,
          )
        : "";
    },
  },
  plan: {
    skill: "dgplan",
    label: (s) => (single(s, "plan") ? "組み直す" : "計画を立てる"),
    text: (s, _w, lang) =>
      single(s, "plan")
        ? say(
            lang,
            `${idList(s, lang)} を組み直し、承認を待ってください。`,
            `Rework ${idList(s, lang)} and wait for approval.`,
          )
        : say(
            lang,
            `${idList(s, lang)} を進める Plan を立て、承認を待ってください。`,
            `Make a Plan to proceed with ${idList(s, lang)}, then wait for approval.`,
          ),
    // 承認待ちの Plan では承認すると同じ呼び出しになるので、組み直すことを添える
    intent: (s, _w, lang) =>
      single(s, "plan")
        ? say(lang, `${idList(s, lang)} を組み直して`, `Rework ${idList(s, lang)}`)
        : "",
  },
  approve: {
    skill: "dgplan",
    label: () => "承認する",
    text: (s, _w, lang) =>
      say(
        lang,
        `承認待ちの ${idList(s, lang)} の内容を示し、承認を求めてください。`,
        `Show the content of ${idList(s, lang)}, which is awaiting approval, and ask for approval.`,
      ),
    human: (s) => s.map((t) => ({ check: ["plan.approve"], command: `dg plan approve ${t.id}` })),
  },
  work: {
    skill: "dgwork",
    label: (s) => (single(s, "plan") ? "Plan を進める" : "進める"),
    text: (s, _w, lang) =>
      single(s, "plan")
        ? say(
            lang,
            `${idList(s, lang)} を着手できるものから進めてください。`,
            `Proceed with ${idList(s, lang)}, starting with the tickets that can be started.`,
          )
        : say(lang, `${idList(s, lang)} を進めてください。`, `Proceed with ${idList(s, lang)}.`),
  },
  resume: {
    skill: "dgwork",
    label: () => "再開する",
    // 実行中の Run と同じ Skill を重ねて呼ばないよう、1 行目には止まったものだけを並べる
    args: (s) => (only(s, "ticket") ?? []).filter(isStalled),
    text(s, _w, lang) {
      const tickets = only(s, "ticket") ?? [];
      const stalled = idList(tickets.filter(isStalled), lang);
      const running = tickets.filter((t) => t.running);
      const others = idList(running, lang);
      return say(
        lang,
        `止まっている ${stalled} の作業を再開してください` +
          (running.length > 0 ? `（${others} は Run が実行中なので触らない）` : "") +
          "。",
        `Resume the stalled work on ${stalled}` +
          (running.length > 0 ? ` (leave ${others} alone, since a Run is running on them)` : "") +
          ".",
      );
    },
  },
  all: {
    skill: "dgall",
    label: () => "最後まで進める",
    text: (s, _w, lang) =>
      say(
        lang,
        `${idList(s, lang)} を最後まで進めてください（承認の場所は手順どおりに）。`,
        `Take ${idList(s, lang)} all the way through, pausing for approval where the steps say to.`,
      ),
  },
  done: {
    skill: "dgdone",
    label: () => "確かめて片付ける",
    text: (s, _w, lang) =>
      single(s, "plan")
        ? say(
            lang,
            `${idList(s, lang)} のマージ済みのチケットを照合して片付け、終わっていれば Plan を閉じてください。`,
            `Reconcile and clean up the merged tickets of ${idList(s, lang)}, and close the Plan if it is finished.`,
          )
        : say(
            lang,
            `${idList(s, lang)} の PR のマージを照合し、残った受け入れ条件を確かめて片付けてください。`,
            `Reconcile the PR merges of ${idList(s, lang)}, verify the remaining acceptance criteria, and clean up.`,
          ),
  },
  check: {
    skill: "dgcheck",
    label: (s) => (only(s, "ticket")?.every(isWaiting) ? "待ちを確かめる" : "点検する"),
    text: (s, _w, lang) =>
      s.length === 0
        ? say(
            lang,
            "全体を点検し、直す案を表で示してください。",
            "Check everything and show the proposed fixes in a table.",
          )
        : only(s, "ticket")?.every(isWaiting)
          ? say(
              lang,
              `${idList(s, lang)} の依存先の進みと進める順を確かめ、直す案があれば表で示してください。`,
              `Check the progress of the dependencies of ${idList(s, lang)} and the order to proceed, and show any proposed fixes in a table.`,
            )
          : say(
              lang,
              `${idList(s, lang)} を点検し、直す案を表で示してください。`,
              `Check ${idList(s, lang)} and show the proposed fixes in a table.`,
            ),
  },
  release: {
    skill: "dgrelease",
    label: () => "リリースする",
    text: (s, _w, lang) =>
      say(
        lang,
        `${idList(s, lang)} をリリースし、リリースの PR のマージと公開の前に承認を求めてください。`,
        `Release ${idList(s, lang)}, and ask for approval before merging the release PR and publishing.`,
      ),
  },
  // 閉じる（close）とは別：データを書き換えず、未完了を持ち越すか続けるかの相談だけを頼む（閉じるのは人の指示で、人に回す対象にしない）
  carry: {
    skill: null,
    label: () => "持ち越しを相談する",
    text: (s, _w, lang) =>
      say(
        lang,
        `${idList(s, lang)} は終了日を過ぎて未完了のチケットがあります。持ち越すか続けるかを、未完了の一覧を示して相談してください（相談だけで、Iteration・チケットのデータは書き換えない）。`,
        `${idList(s, lang)} is past its end date with unfinished tickets. List the unfinished tickets and consult me on whether to carry them over or continue (consult only; do not change the Iteration or ticket data).`,
      ),
  },
  close: {
    skill: null,
    label: () => "閉じる",
    text: (s, _w, lang) =>
      say(
        lang,
        `${idList(s, lang)} を閉じてください（人の指示。終わっていないチケットがあれば閉じる前に知らせる）。`,
        `Close ${idList(s, lang)} (a human's instruction; if any tickets are unfinished, tell me before closing).`,
      ),
    human: (s) =>
      s.map((t) => ({
        check: [`${t.kind}.close`],
        command: `dg ${t.kind} close ${t.id}`,
      })),
  },
  reopen: {
    skill: null,
    label: () => "再開する",
    text: (s, _w, lang) =>
      s[0]?.kind === "iteration"
        ? say(
            lang,
            `${idList(s, lang)} を再開してください（人の指示。ほかに active があれば再開の前に知らせる）。`,
            `Reopen ${idList(s, lang)} (a human's instruction; if another Iteration is active, tell me before reopening).`,
          )
        : say(
            lang,
            `${idList(s, lang)} を再開してください（人の指示）。`,
            `Reopen ${idList(s, lang)} (a human's instruction).`,
          ),
    human: (s) =>
      s.map((t) => ({
        check: [`${t.kind}.reopen`],
        command: `dg ${t.kind} reopen ${t.id}`,
      })),
  },
  abandon: {
    skill: null,
    label: () => "やめる",
    text: (s, _w, lang) =>
      say(
        lang,
        `${idList(s, lang)} をやめて abandoned にしてください（人の指示。理由は指示のとおりに本文へ書く）。`,
        `Abandon ${idList(s, lang)} by moving ${s.length > 1 ? "them" : "it"} to abandoned (a human's instruction; write the reason in the body as instructed).`,
      ),
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
    text: (s, _w, lang) =>
      say(
        lang,
        `${idList(s, lang)} の done を取り消してください（人の指示。戻す Status と理由は指示のとおりに）。`,
        `Undo done for ${idList(s, lang)} (a human's instruction; the Status to return to and the reason are as instructed).`,
      ),
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
    text: (s, _w, lang) =>
      say(
        lang,
        `${idList(s, lang)} の作業の様子を教えてください（データは書き換えない）。`,
        `Tell me how the work on ${idList(s, lang)} is going (do not change any data).`,
      ),
  },
  retro: {
    skill: null,
    label: () => "振り返る",
    text: (s, _w, lang) =>
      s[0]?.kind === "iteration"
        ? say(
            lang,
            `${idList(s, lang)} の振り返りを、終わったチケット・Run の集計・持ち越しから、うまくいったことと次に直すことを挙げてまとめてください（データは書き換えない）。`,
            `Write a retrospective of ${idList(s, lang)} from the finished tickets, the Run totals, and the carry-overs, listing what went well and what to improve next (do not change any data).`,
          )
        : say(
            lang,
            `${idList(s, lang)} の振り返りをまとめてください（データは書き換えない）。`,
            `Write a retrospective of ${idList(s, lang)} (do not change any data).`,
          ),
  },
  free: {
    skill: null,
    label: () => "自由に",
    text: (s, _w, lang) =>
      s.length > 0
        ? say(
            lang,
            `${idList(s, lang)} について、指示のとおりにしてください。`,
            `Regarding ${idList(s, lang)}, do as instructed.`,
          )
        : "",
  },
};

/** 依頼文に使う Skill の名前（dg<トピック>）。dg skill install で配る名前と一致することを cli のテストで確かめる */
export const ASK_SKILLS: readonly string[] = [
  ...new Set(Object.values(ACTIONS).flatMap((a) => (a.skill ? [a.skill] : []))),
];

/**
 * dg の Skill（ASK_SKILLS のどれかの <名前>/SKILL.md）が、Skill のディレクトリ（Adapter の skillDirs）のどれかにあるか。
 * 中身の印は見ない（手を加えた Skill も呼べば動く）
 */
export async function askSkillInstalled(dirs: readonly string[]): Promise<boolean> {
  const paths = dirs.flatMap((dir) => ASK_SKILLS.map((name) => join(dir, name, "SKILL.md")));
  const found = await Promise.all(
    paths.map((path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    ),
  );
  return found.includes(true);
}

/** 頼むことで人が打つ手。buildAsk が人に回すかを決めるのと askHumanChecks は、ここから同じ手を得る */
function humanSteps(action: AskAction, s: Subjects, w: Within | undefined): HumanStep[] {
  return ACTIONS[action].human?.(s, w) ?? [];
}

/** 頼むことを人に回すか決めるときに actor.human_only と照らす操作の名前。名前が commands にあることをテストで確かめる */
export function askHumanChecks(action: AskAction, s: Subjects, within?: string): string[] {
  return humanSteps(action, s, withinOf(s, within)).flatMap((h) => h.check);
}

/**
 * 対象の種類と状態から、頼むことの候補を決める。先頭がおすすめ。
 * within（対象のチケットが入っている Iteration・Epic）を渡し、チケットがどれもそこに入っていて終わっていなければ、外すを直すの後（直すがなければ自由にの前）に足す
 */
function askActions(s: Subjects, within?: string): AskAction[] {
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
    if (it.status === "active" && it.overdue) return ["carry", "plan", "all", "release", ...rest];
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

export function askCandidates(s: Subjects, within?: string): AskCandidate[] {
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

/** 画面の札の添え字（AskTarget の sub） */
function targetSub(t: AskSubject): string {
  return t.kind === "plan" ? PLAN_STATE_LABEL[t.status] : t.status;
}

/** Skill を持つ頼むことの文章だけの形に添える、その段階の手順を読む 1 文。トピックは Skill の呼び出し（`/dgplan`）から `/dg` を除いたもの */
export const askGuideLine = (skill: string, lang: AskLanguage = "ja") => {
  const command = `\`dg guide ${skill.replace(/^\/dg/, "")}\``;
  return say(
    lang,
    `手順は ${command} を読み、そのとおりに進めてください。`,
    `Read ${command} for the steps and follow them.`,
  );
};

/** AskTarget の line。ID とタイトル（と Status・Iteration）だけで、本文は入れない */
function targetLine(t: AskSubject): string {
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
  /** 省けば skill。ask コマンドは省かれたら Skill の有無（askSkillInstalled）から決めて渡す */
  format?: AskFormat | undefined;
  /** config の actor.human_only */
  humanOnly?: readonly string[] | undefined;
  /** 対象のチケットが入っている Iteration・Epic（詳細の中の行から頼むとき）。外すの候補が出る */
  within?: string | undefined;
  /** 定型の文の言語。省けば日本語。指示とチケットの中身は変えない */
  language?: AskLanguage | undefined;
}

/** 依頼文を作る。頼むことが候補になければ UsageError */
export function buildAsk(input: BuildAskInput): AskView {
  const s = input.subjects;
  const format = input.format ?? "skill";
  const lang = input.language ?? "ja";
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
  const targets = s.map((t) => ({ ...t, line: targetLine(t), sub: targetSub(t) }));
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
  const steps = humanSteps(chosen, s, w);
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
  // 題・本文・Status はエージェントが dg で読むので、依頼文には ID だけを入れる（ADR-010）
  const lines: string[] = [];
  if (format === "skill" && candidate.skill) {
    // Skill の形は呼び出しと指示だけ。呼び出しで頼むことが決まらないもの（起票・作成・外す・分ける・組み直す・持ち越し）だけ短い頼みごとを挟む
    lines.push(
      def.bare ? candidate.skill : [candidate.skill, ...ids(def.args?.(s) ?? s)].join(" "),
    );
    const intent = def.intent?.(s, w, lang);
    if (intent) lines.push(intent);
  } else {
    // 文章だけの形と Skill を使わない頼むことは、頼む 1 文と dg の呼び方を添える。Skill を持つ頼むことには、その段階の guide を読む 1 文も添える
    const text = def.text(s, w, lang);
    if (text) lines.push(text);
    lines.push(say(lang, ASK_DG_USAGE, ASK_DG_USAGE_EN));
    // Skill を持つ頼むことは、Skill と同じ手順（承認や品質ゲート）で進むよう、その段階の guide を読ませる
    if (candidate.skill) lines.push(askGuideLine(candidate.skill, lang));
  }
  if (note) lines.push(note);
  return { ...view, kind: "prompt", human_only: [], workflow_by: [], text: lines.join("\n") };
}

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
function askSubjectOf(
  store: Store,
  ref: string,
  running: ReadonlySet<string>,
  today: string,
): AskSubject {
  const kind = idKindOf(ref);
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
      const { complete, overdue } = iterationReadiness(
        it,
        ticketsInIteration(store, it.id).map((t) => t.data.status),
        today,
      );
      return {
        kind,
        id: it.id,
        title: it.name,
        status: it.status,
        complete,
        overdue,
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
    "エージェントに貼る依頼文を作る（読み取りだけ）。対象の種類と状態から頼むことの候補とおすすめ（先頭）を返し、頼むこと・指示・形式（Skill か文章だけ）・言語（定型の文を日本語か英語で）から文を組む。操作が 1 つに決まる頼むことは、その操作が actor.human_only に入っているか、Workflow の by が遷移を人に限れば、人が打つ dg のコマンドを返す",
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
      .optional()
      .describe(
        "skill は Skill の呼び出しと指示だけ、text は頼む 1 文と dg の呼び方と（Skill を持つ頼むことは）読む guide の 1 文と指示。Skill のない頼むことは skill でも text の形。省けば、dg skill install の置き場所（リポジトリかホームディレクトリの下）に dg の Skill があれば skill、なければ text",
      ),
    within: z
      .string()
      .optional()
      .describe(
        "対象のチケットが入っている Iteration か Epic（s3・e2）。詳細の中の行から頼むときに渡し、チケットがどれもそこに入っていれば「そこから外す」を候補に足す",
      ),
    language: z
      .enum(ASK_LANGUAGES)
      .optional()
      .describe(
        "依頼文の定型の文（頼む 1 文・dg の呼び方・guide を読む 1 文・Skill の次の行の頼みごと）の言語。省けば ja。指示とチケットの中身は書いた言葉のまま",
      ),
  }),
  write: false,
  needs: "store",
  positionals: ["targets"],
  async run(ctx, input) {
    const refs = input.targets.map((r) => r.trim());
    const running = await runningTickets(ctx.repo, refs);
    // 形式を省けば、Skill を入れていない人には貼っても動く文章の形にする（人が選んだ形式はそのまま）
    const dirs = agentSkillDirs({ env: ctx.env ?? process.env, topLevel: ctx.repo.topLevel });
    const format = input.format ?? ((await askSkillInstalled(dirs)) ? "skill" : "text");
    return ok(
      buildAsk({
        subjects: subjectsOf(ctx.store, refs, running, localDate(ctx.now())),
        action: input.action,
        note: input.note,
        format,
        humanOnly: ctx.config.actor.human_only,
        within: withinRef(ctx.store, input.within),
        language: input.language,
      }),
    );
  },
});

/** 画面の 1 か所（行・見出し）の候補。key は askMenuKey の形（対象の ID を空白でつなぎ、場所を @ を付けて後ろに置く。空なら対象なし） */
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
    "画面の行・見出しごとの頼むことの候補（先頭がおすすめ）をまとめて返す（読み取りだけ）。組ごとに ask の candidates と同じものを返し、引けない組は error に理由を入れる。画面（VS Code の左パネル・エディタのパネルの詳細・ブラウザ）の吹き出しが使う",
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
      keys.flatMap((k) => parseAskMenuKey(k).refs),
    );
    return ok(
      keys.map((key): AskMenu => {
        try {
          const { refs, within } = parseAskMenuKey(key);
          const candidates = askCandidates(
            subjectsOf(ctx.store, refs, running, localDate(ctx.now())),
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

/**
 * ask-menu の組の鍵。対象の ID を空白でつなぎ、場所（within）があれば @ を付けて後ろに置く（返す key はこの形）。
 * web は core を実行時に取り込めないので同じ書式を写し（ask-key.ts）、一致を web のテストで確かめる
 */
export function askMenuKey(refs: readonly string[], within?: string): string {
  return [...refs, ...(within ? [`@${within}`] : [])].join(" ");
}

/** 組の文字列を対象と場所（@ を付けた 1 つ。重ねたら後のもの）に分ける */
export function parseAskMenuKey(key: string): { refs: string[]; within: string | undefined } {
  const tokens = key.split(/\s+/).filter(Boolean);
  const within = tokens
    .filter((t) => t.startsWith("@"))
    .at(-1)
    ?.slice(1);
  return { refs: tokens.filter((t) => !t.startsWith("@")), within };
}

/** 組の文字列を、対象の ID の後に場所を置いた形にそろえる（返す key はこの形） */
function normalizeKey(key: string): string {
  const { refs, within } = parseAskMenuKey(key);
  return askMenuKey(refs, within);
}

/** within を確かめる。Iteration・Epic の ID でなければ使い方の誤り、なければ NOT_FOUND */
function withinRef(store: Store, within: string | undefined): string | undefined {
  const ref = within?.trim();
  if (!ref) return undefined;
  const kind = idKindOf(ref);
  if ((kind !== "iteration" && kind !== "epic") || !parseId(ref, kind))
    throw new UsageError(`${ref} は Iteration・Epic の ID ではない（s3・e2 の形で書く）`);
  return store.require(kind, ref).id;
}

/** チケットを含むときだけ、このマシンで実行中の Run があるチケットを読む */
async function runningTickets(
  repo: Parameters<typeof peekRunningRuns>[0],
  refs: readonly string[],
): Promise<ReadonlySet<string>> {
  if (!refs.some((r) => idKindOf(r) === "ticket")) return new Set();
  return new Set((await peekRunningRuns(repo)).map((r) => r.ticket));
}

/** ID から対象を引く。同じ対象を番号の書き方を変えて重ねたもの（t1 と t01 など）は 1 つにする */
function subjectsOf(
  store: Store,
  refs: readonly string[],
  running: ReadonlySet<string>,
  today: string,
): AskSubject[] {
  const subjects = [...new Set(refs)].map((r) => askSubjectOf(store, r, running, today));
  return subjects.filter((t, n) => subjects.findIndex((u) => u.id === t.id) === n);
}

export const askCommands = [ask, askMenu];
