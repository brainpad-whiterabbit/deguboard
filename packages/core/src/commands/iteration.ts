// Iteration の操作（requirements.md 5.6）。CLI では sprint がエイリアス

import { z } from "zod";
import { OperationError } from "../errors.js";
import { readHistory, type HistoryEvent } from "../git/history.js";
import { withWrite } from "../git/write.js";
import { isTerminal, slugSchema, type Status } from "../model/common.js";
import type { TicketId } from "../model/id.js";
import {
  ITERATION_STATUSES,
  otherActiveMessage,
  otherActiveOf,
  type Iteration,
} from "../model/iteration.js";
import { progressOf, type Progress, type Ticket } from "../model/ticket.js";
import type { Doc } from "../storage/documents.js";
import type { Store } from "../storage/store.js";
import { defineCommand, ok } from "./define.js";
import { plansContaining, type PlanBrief } from "./plan.js";
import type { AskAction } from "./ask.js";
import {
  iterationReadiness,
  iterationRef,
  localDate,
  nowIso,
  projectOf,
  sortedDocs,
  ticketRef,
  ticketsInIteration,
} from "./helpers.js";

const isoDate = z.iso.date();

/** active の Iteration は Project に 1 つ（IT-1）。ほかに active があれば拒否する */
function rejectIfOtherActive(store: Store, it: Doc<Iteration>, verb: string): void {
  const other = otherActiveOf(
    [...store.iterations.values()].map((i) => i.data),
    it.data,
  );
  if (other) throw new OperationError("REJECTED", otherActiveMessage(other.id, it.id, verb));
}

export const iterationCreate = defineCommand({
  name: "iteration.create",
  positionals: ["name"],
  group: "iteration",
  summary: "Iteration を作る",
  input: z.object({
    name: z.string().min(1).describe("名前"),
    project: slugSchema.optional().describe("Project。省略時は config の default_project"),
    goal: z.string().optional().describe("目標"),
    start: isoDate.optional().describe("開始日（YYYY-MM-DD）"),
    end: isoDate.optional().describe("終了日（YYYY-MM-DD）"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const project = projectOf(ctx, input.project);
        ctx.store.requireProject(project);
        const id = ctx.store.nextId("iteration");
        return ctx.store.create("iteration", {
          id,
          project,
          name: input.name,
          goal: input.goal ?? "",
          start: input.start,
          end: input.end,
          status: "planned",
        });
      },
      { message: (doc) => `${doc.id} を作成: ${doc.data.name}`, immediate: true, cas: true },
    );
    return ok(result.value.data, result.write);
  },
});

export const iterationList = defineCommand({
  name: "iteration.list",
  group: "iteration",
  summary: "Iteration を番号順に出す",
  input: z.object({
    project: z.string().optional().describe("Project で絞る。省略時はすべて"),
    status: z
      .array(z.enum(ITERATION_STATUSES))
      .optional()
      .describe("Status で絞る。省略時はすべて"),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const docs = sortedDocs(ctx.store.iterations.values()).filter(
      (d) =>
        (!input.project || d.data.project === input.project) &&
        (!input.status || input.status.includes(d.data.status)),
    );
    return ok(docs.map((d) => d.data));
  },
});

/** 持ち越したチケットと、その今の Iteration（なければ null） */
export interface CarriedTicket {
  id: string;
  /** 今の Iteration。なければ null */
  iteration: string | null;
  /** 今の Status（持ち越したあとに done・abandoned になったものを画面で区別する） */
  status: Status;
}

/**
 * Iteration の状態に応じた次の操作（UI-5）。ask はその依頼文を ask コマンドで頼む頼むこと（なければ null）。
 * 画面は種類を出し、ask の依頼文をコピーさせるだけで、判断はここに置く
 */
export type IterationNext =
  /** active で、中のチケットがすべて done か abandoned */
  | { kind: "ready"; ask: AskAction }
  /** active で、終了日を過ぎて未完了が残っている */
  | { kind: "overdue"; unfinished: number; ask: AskAction }
  /** planned。最初のチケットの claim で active になる */
  | { kind: "planned"; ask: null }
  /**
   * 閉じて持ち越しがある。moved は履歴から求めた持ち越し先で、まだコミットしていない（commit.mode が batch）
   * などで履歴に出ない分は含まない（carried より少なければ、画面は「コミットすると出る」と添える）
   */
  | { kind: "closed"; carried: number; moved: CarriedTicket[]; ask: AskAction | null };

/**
 * 履歴から、その Iteration から外れた（持ち越した）チケットの ID を番号の順に返す。今もそこに入っているものは除く。
 * web の履歴の画面（history.tsx の carriedOverFrom）は同じ求め方を写している（web は core の実行時のコードを取り込まず（ADR-033）、iteration.show に置き換えると Iteration ごとに履歴を読むため）。
 * 一致は web の history.test.tsx が確かめるので、ここを変えたら web の写しも直す
 */
export function carriedOverFrom(
  iteration: string,
  events: readonly HistoryEvent[],
  tickets: readonly Pick<Ticket, "id" | "iteration">[],
): string[] {
  const moved = new Set<string>();
  for (const e of events)
    if (
      e.kind === "ticket" &&
      e.changes.some((c) => c.field === "iteration" && c.from === iteration && c.to !== iteration)
    )
      moved.add(e.id);
  const still = new Set<string>(tickets.filter((t) => t.iteration === iteration).map((t) => t.id));
  return [...moved]
    .filter((id) => !still.has(id))
    .sort((a, b) => (Number(a.slice(1)) || 0) - (Number(b.slice(1)) || 0));
}

/** 次の操作を決める。案内が要らなければ null（active で期限内、閉じて持ち越しなし、など） */
export async function iterationNextOf(
  ctx: { store: Store; repo: { dataDir: string }; now(): Date },
  it: Iteration,
  items: readonly Ticket[],
): Promise<IterationNext | null> {
  if (it.status === "planned") return { kind: "planned", ask: null };
  if (it.status === "closed") {
    if (!it.carried_over) return null;
    // 費用：持ち越しのある closed の Iteration は、show のたびに履歴（git log -p）全体を読む。名前だけ要る呼び出しは iteration.list を使う
    let ids: string[] = [];
    try {
      ids = carriedOverFrom(
        it.id,
        (await readHistory(ctx.repo.dataDir)).events,
        [...ctx.store.tickets.values()].map((t) => t.data),
      );
    } catch {
      // 履歴が読めなければ持ち越し先は出さない（件数だけ）
    }
    const moved = ids.flatMap((id) => {
      const t = ctx.store.tickets.get(id as TicketId);
      return t ? [{ id, iteration: t.data.iteration ?? null, status: t.data.status }] : [];
    });
    return {
      kind: "closed",
      carried: it.carried_over,
      moved,
      // 割り当てを勧めるのは、今 Iteration がなく、まだ終わっていないものがあるときだけ（持ち越し後に終わったものは勧めない）
      ask: moved.some((m) => m.iteration === null && !isTerminal(m.status)) ? "assign" : null,
    };
  }
  const { complete, overdue, unfinished } = iterationReadiness(
    it,
    items.map((t) => t.status),
    localDate(ctx.now()),
  );
  if (complete) return { kind: "ready", ask: "release" };
  if (overdue) return { kind: "overdue", unfinished, ask: "carry" };
  return null;
}

/** iteration.show の出力。items は優先度と番号の順（IT-3）。progress は Epic と同じ形で、中のチケットから都度求める（EP-3）。next は次の操作の案内、plans は中のチケットを含む Plan */
export type IterationDetail = Iteration & {
  progress: Progress;
  items: Ticket[];
  next: IterationNext | null;
  /** 中のチケットを 1 件でも含む Plan（状態と進捗つき。なければ空） */
  plans: PlanBrief[];
};

export const iterationShow = defineCommand({
  name: "iteration.show",
  positionals: ["iteration"],
  group: "iteration",
  summary:
    "Iteration と進捗・次の操作（next）・中のチケットを含む Plan（plans）、入っているチケットを優先度と番号の順で出す。持ち越しのある閉じた Iteration は履歴を読むので重い",
  input: z.object({ iteration: iterationRef }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const doc = ctx.store.require("iteration", input.iteration);
    const items = ticketsInIteration(ctx.store, doc.id).map((t) => t.data);
    return ok<IterationDetail>({
      ...doc.data,
      progress: progressOf(items),
      items,
      next: await iterationNextOf(ctx, doc.data, items),
      plans: plansContaining(
        ctx.store,
        items.map((t) => t.id),
      ),
    });
  },
});

export const iterationUpdate = defineCommand({
  name: "iteration.update",
  positionals: ["iteration"],
  group: "iteration",
  summary: "Iteration の名前・目標・期間を直す。閉じた Iteration も直せる",
  input: z.object({
    iteration: iterationRef,
    name: z.string().min(1).optional().describe("名前"),
    goal: z.string().optional().describe("目標。空文字で消す"),
    start: isoDate.optional().describe("開始日（YYYY-MM-DD）"),
    end: isoDate.optional().describe("終了日（YYYY-MM-DD）"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const it = ctx.store.require("iteration", input.iteration);
        const patch: Record<string, unknown> = {};
        if (input.name !== undefined) patch["name"] = input.name;
        if (input.goal !== undefined) patch["goal"] = input.goal;
        if (input.start !== undefined) patch["start"] = input.start;
        if (input.end !== undefined) patch["end"] = input.end;
        return ctx.store.update("iteration", it.id, patch);
      },
      { message: (doc) => `${doc.id} を更新: ${doc.data.name}` },
    );
    return ok(result.value.data, result.write);
  },
});

const membership = z.object({
  iteration: iterationRef,
  tickets: z.array(ticketRef).min(1).describe("チケットの ID（t12 または 12）。複数指定できる"),
});

export const iterationAdd = defineCommand({
  name: "iteration.add",
  positionals: ["iteration", "tickets"],
  group: "iteration",
  summary: "チケットを Iteration に入れる。閉じた Iteration には入れられない",
  input: membership,
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const it = ctx.store.require("iteration", input.iteration);
        if (it.data.status === "closed")
          throw new OperationError("REJECTED", `${it.id} は閉じている`);
        const ids: string[] = [];
        for (const ref of input.tickets) {
          const t = ctx.store.require("ticket", ref);
          if (t.data.project !== it.data.project)
            throw new OperationError("REJECTED", `${t.id} は ${it.id} と別の Project`);
          await ctx.store.update("ticket", t.id, { iteration: it.id, updated_at: nowIso(ctx) });
          ids.push(t.id);
        }
        return { iteration: it.id, tickets: ids };
      },
      { message: (r) => `${r.iteration} に ${r.tickets.join(", ")} を入れる` },
    );
    return ok(result.value, result.write);
  },
});

export const iterationRemove = defineCommand({
  name: "iteration.remove",
  positionals: ["iteration", "tickets"],
  group: "iteration",
  summary: "チケットを Iteration から外す",
  input: membership,
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const it = ctx.store.require("iteration", input.iteration);
        const ids: string[] = [];
        for (const ref of input.tickets) {
          const t = ctx.store.require("ticket", ref);
          if (t.data.iteration !== it.id)
            throw new OperationError("REJECTED", `${t.id} は ${it.id} に入っていない`);
          await ctx.store.update("ticket", t.id, { iteration: undefined, updated_at: nowIso(ctx) });
          ids.push(t.id);
        }
        return { iteration: it.id, tickets: ids };
      },
      { message: (r) => `${r.iteration} から ${r.tickets.join(", ")} を外す` },
    );
    return ok(result.value, result.write);
  },
});

export const iterationStart = defineCommand({
  name: "iteration.start",
  positionals: ["iteration"],
  group: "iteration",
  summary:
    "Iteration を開始する（active にする）。開始日（start）は始めた日（手元の暦日）に書き換え、終了日は変えない。同じ Project にほかの active があれば拒否する",
  input: z.object({ iteration: iterationRef }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const it = ctx.store.require("iteration", input.iteration);
        if (it.data.status !== "planned")
          throw new OperationError("REJECTED", `${it.id} は ${it.data.status} なので開始できない`);
        rejectIfOtherActive(ctx.store, it, "開始");
        // 予定の開始日は実際とずれるので、始めた日に書き換えて実際の期間を残す（IT-1）。end は予定のまま
        return ctx.store.update("iteration", it.id, {
          status: "active",
          start: localDate(ctx.now()),
        });
      },
      // active を 1 つに保つ排他なので、claim と同じく即座に push し、拒否されたら検査からやり直す
      { message: (doc) => `${doc.id} を開始: ${doc.data.name}`, immediate: true, cas: true },
    );
    return ok(result.value.data, result.write);
  },
});

export const iterationClose = defineCommand({
  name: "iteration.close",
  positionals: ["iteration"],
  group: "iteration",
  summary:
    "Iteration を閉じ、完了と持ち越しの件数を記録する。終了日（end）は閉じた日（手元の暦日）に書き換え、開始日がそれより後なら開始日も閉じた日にする。持ち越したチケットの iteration は外す",
  input: z.object({ iteration: iterationRef }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const it = ctx.store.require("iteration", input.iteration);
        if (it.data.status === "closed")
          throw new OperationError("REJECTED", `${it.id} は既に閉じている`);
        const tickets = ticketsInIteration(ctx.store, it.id);
        const completed = tickets.filter((t) => t.data.status === "done").length;
        const carried = tickets.filter((t) => !isTerminal(t.data.status));
        for (const t of carried)
          await ctx.store.update("ticket", t.id, { iteration: undefined, updated_at: nowIso(ctx) });
        // 予定の終了日は実際とずれるので、閉じた日に書き換えて実際の期間を残す（IT-1）。
        // 開始日が閉じた日より後（始める前に閉じた）なら、期間が逆にならないよう開始日も閉じた日にする
        const today = localDate(ctx.now());
        return ctx.store.update("iteration", it.id, {
          status: "closed",
          ...(it.data.start !== undefined && it.data.start > today ? { start: today } : {}),
          end: today,
          closed_at: nowIso(ctx),
          completed,
          carried_over: carried.length,
        });
      },
      { message: (doc) => `${doc.id} を閉じる: ${doc.data.name}` },
    );
    return ok(result.value.data, result.write);
  },
});

export const iterationReopen = defineCommand({
  name: "iteration.reopen",
  positionals: ["iteration"],
  group: "iteration",
  summary:
    "閉じた Iteration を再開して active に戻す（同じ Project にほかの active があれば拒否する）。closed_at と完了・持ち越しの件数は消す。開始日は変えず、終了日は閉じた日のままなので、要れば iteration update で直す。持ち越したチケットは戻らないので iteration add で入れ直す",
  input: z.object({ iteration: iterationRef }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const warnings: string[] = [];
    const result = await withWrite(
      ctx,
      async () => {
        // cas でやり直すと mutate が再び走るので、警告は毎回作り直す
        warnings.length = 0;
        const it = ctx.store.require("iteration", input.iteration);
        if (it.data.status !== "closed")
          throw new OperationError("REJECTED", `${it.id} は閉じていない`);
        rejectIfOtherActive(ctx.store, it, "再開");
        if (it.data.carried_over)
          warnings.push(
            `閉じたときに外した ${it.data.carried_over} 件は戻らない。iteration add で入れ直す`,
          );
        return ctx.store.update("iteration", it.id, {
          status: "active",
          closed_at: undefined,
          completed: undefined,
          carried_over: undefined,
        });
      },
      { message: (doc) => `${doc.id} を再開: ${doc.data.name}`, immediate: true, cas: true },
    );
    return ok(result.value.data, result.write, warnings);
  },
});

export const iterationCommands = [
  iterationCreate,
  iterationList,
  iterationShow,
  iterationUpdate,
  iterationAdd,
  iterationRemove,
  iterationStart,
  iterationClose,
  iterationReopen,
];
