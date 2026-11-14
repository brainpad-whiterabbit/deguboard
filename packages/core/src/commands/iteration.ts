// Iteration の操作（requirements.md 5.6）。CLI では sprint がエイリアス

import { z } from "zod";
import { OperationError } from "../errors.js";
import { readHistory, type HistoryEvent, type HistoryReader } from "../git/history.js";
import { withWrite } from "../git/write.js";
import { isFinishedSet, isTerminal, type Status } from "../model/common.js";
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
import { iterationRef, nowIso, sortedDocs, ticketRef, ticketsInIteration } from "./helpers.js";

/** active の Iteration はカンバンに 1 つ（IT-1）。ほかに active があれば拒否する */
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
  summary: "Create an Iteration",
  input: z.object({
    name: z.string().min(1).describe("Name"),
    goal: z.string().optional().describe("Goal"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const id = ctx.store.nextId("iteration");
        return ctx.store.create("iteration", {
          id,
          name: input.name,
          goal: input.goal ?? "",
          status: "planned",
        });
      },
      { message: (doc) => `Create ${doc.id}: ${doc.data.name}`, immediate: true, cas: true },
    );
    return ok(result.value.data, result.write);
  },
});

export const iterationList = defineCommand({
  name: "iteration.list",
  group: "iteration",
  summary: "List Iterations in number order",
  input: z.object({
    status: z
      .array(z.enum(ITERATION_STATUSES))
      .optional()
      .describe("Filter by Status. Omit for all"),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const docs = sortedDocs(ctx.store.iterations.values()).filter(
      (d) => !input.status || input.status.includes(d.data.status),
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
  /** planned。最初のチケットの claim で active になる */
  | { kind: "planned"; ask: null }
  /**
   * 閉じて持ち越しがある。moved は履歴から求めた持ち越し先で、まだコミットしていない（commit.mode が batch）
   * などで履歴に出ない分は含まない（carried より少なければ、画面は「コミットすると出る」と添える）
   */
  | { kind: "closed"; carried: number; moved: CarriedTicket[]; ask: AskAction | null };

/**
 * 履歴から、その Iteration から外れた（持ち越した）チケットの ID を番号の順に返す。今もそこに入っているものは除く。
 * web の履歴の画面（history.tsx の carriedOverFrom）は同じ求め方を写している（web は core の実行時のコードを取り込まず、iteration.show に置き換えると Iteration ごとに履歴を読むため）。
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

/** 次の操作を決める。案内が要らなければ null（active で未完了が残る、閉じて持ち越しなし、など） */
export async function iterationNextOf(
  ctx: {
    store: Store;
    repo: { dataDir: string };
    readHistory?: HistoryReader | undefined;
  },
  it: Iteration,
  items: readonly Ticket[],
): Promise<IterationNext | null> {
  if (it.status === "planned") return { kind: "planned", ask: null };
  if (it.status === "closed") {
    if (!it.carried_over) return null;
    // 費用：持ち越しのある closed の Iteration は、show のたびに履歴（git log -p）全体を読む（プロセス内の CommandClient では HEAD が同じあいだ使い回す）。名前だけ要る呼び出しは iteration.list を使う
    let ids: string[] = [];
    try {
      ids = carriedOverFrom(
        it.id,
        (await (ctx.readHistory ?? readHistory)(ctx.repo.dataDir)).events,
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
  return isFinishedSet(items.map((t) => t.status)) ? { kind: "ready", ask: "release" } : null;
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
    "Show an Iteration with its progress, the next step (next), the Plans that include its tickets (plans), and the tickets in it in priority and number order. A closed Iteration with carried-over tickets reads the history, so it is slow",
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
  summary: "Edit an Iteration's name and goal. A closed Iteration can also be edited",
  input: z.object({
    iteration: iterationRef,
    name: z.string().min(1).optional().describe("Name"),
    goal: z.string().optional().describe("Goal. An empty string clears it"),
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
        return ctx.store.update("iteration", it.id, patch);
      },
      { message: (doc) => `Update ${doc.id}: ${doc.data.name}` },
    );
    return ok(result.value.data, result.write);
  },
});

const membership = z.object({
  iteration: iterationRef,
  tickets: z.array(ticketRef).min(1).describe("Ticket ID (t12 or 12). Can be given more than once"),
});

export const iterationAdd = defineCommand({
  name: "iteration.add",
  positionals: ["iteration", "tickets"],
  group: "iteration",
  summary: "Add tickets to an Iteration. Tickets cannot be added to a closed Iteration",
  input: membership,
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const it = ctx.store.require("iteration", input.iteration);
        if (it.data.status === "closed") throw new OperationError("REJECTED", `${it.id} is closed`);
        const ids: string[] = [];
        for (const ref of input.tickets) {
          const t = ctx.store.require("ticket", ref);
          await ctx.store.update("ticket", t.id, { iteration: it.id, updated_at: nowIso(ctx) });
          ids.push(t.id);
        }
        return { iteration: it.id, tickets: ids };
      },
      { message: (r) => `Add ${r.tickets.join(", ")} to ${r.iteration}` },
    );
    return ok(result.value, result.write);
  },
});

export const iterationRemove = defineCommand({
  name: "iteration.remove",
  positionals: ["iteration", "tickets"],
  group: "iteration",
  summary: "Remove tickets from an Iteration",
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
            throw new OperationError("REJECTED", `${t.id} is not in ${it.id}`);
          await ctx.store.update("ticket", t.id, { iteration: undefined, updated_at: nowIso(ctx) });
          ids.push(t.id);
        }
        return { iteration: it.id, tickets: ids };
      },
      { message: (r) => `Remove ${r.tickets.join(", ")} from ${r.iteration}` },
    );
    return ok(result.value, result.write);
  },
});

export const iterationStart = defineCommand({
  name: "iteration.start",
  positionals: ["iteration"],
  group: "iteration",
  summary:
    "Start an Iteration (make it active). Records the time it started (started_at). Rejected if another Iteration is active",
  input: z.object({ iteration: iterationRef }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const it = ctx.store.require("iteration", input.iteration);
        if (it.data.status !== "planned")
          throw new OperationError(
            "REJECTED",
            `${it.id} is ${it.data.status}, so it cannot be started`,
          );
        rejectIfOtherActive(ctx.store, it, "started");
        // 実績の期間の始まりとして started_at を書く（IT-1）
        return ctx.store.update("iteration", it.id, {
          status: "active",
          started_at: nowIso(ctx),
        });
      },
      // active を 1 つに保つ排他なので、claim と同じく即座に push し、拒否されたら検査からやり直す
      { message: (doc) => `Start ${doc.id}: ${doc.data.name}`, immediate: true, cas: true },
    );
    return ok(result.value.data, result.write);
  },
});

export const iterationClose = defineCommand({
  name: "iteration.close",
  positionals: ["iteration"],
  group: "iteration",
  summary:
    "Close an Iteration and record the time it closed (closed_at) and the counts of completed and carried-over tickets. Carried-over tickets lose their iteration",
  input: z.object({ iteration: iterationRef }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const it = ctx.store.require("iteration", input.iteration);
        if (it.data.status === "closed")
          throw new OperationError("REJECTED", `${it.id} is already closed`);
        const tickets = ticketsInIteration(ctx.store, it.id);
        const completed = tickets.filter((t) => t.data.status === "done").length;
        const carried = tickets.filter((t) => !isTerminal(t.data.status));
        for (const t of carried)
          await ctx.store.update("ticket", t.id, { iteration: undefined, updated_at: nowIso(ctx) });
        return ctx.store.update("iteration", it.id, {
          status: "closed",
          closed_at: nowIso(ctx),
          completed,
          carried_over: carried.length,
        });
      },
      { message: (doc) => `Close ${doc.id}: ${doc.data.name}` },
    );
    return ok(result.value.data, result.write);
  },
});

export const iterationReopen = defineCommand({
  name: "iteration.reopen",
  positionals: ["iteration"],
  group: "iteration",
  summary:
    "Reopen a closed Iteration and make it active again (rejected if another Iteration is active). Clears closed_at and the completed and carried-over counts. The start time (started_at) is not changed. Carried-over tickets do not come back, so add them again with iteration add",
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
          throw new OperationError("REJECTED", `${it.id} is not closed`);
        rejectIfOtherActive(ctx.store, it, "resumed");
        if (it.data.carried_over)
          warnings.push(
            `The ${it.data.carried_over} tickets removed when it was closed do not come back. Add them again with iteration add`,
          );
        return ctx.store.update("iteration", it.id, {
          status: "active",
          closed_at: undefined,
          completed: undefined,
          carried_over: undefined,
        });
      },
      { message: (doc) => `Reopen ${doc.id}: ${doc.data.name}`, immediate: true, cas: true },
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
