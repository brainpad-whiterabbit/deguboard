// Plan の操作（requirements.md 5.7、ADR-028）。Plan を書くのは作成・承認・終了のときだけで、進捗は都度求める

import { z } from "zod";
import { OperationError } from "../errors.js";
import { withWrite } from "../git/write.js";
import type { TicketId } from "../model/id.js";
import { isTerminal, slugSchema } from "../model/common.js";
import { PLAN_TIERS, type Plan, type PlanTier } from "../model/plan.js";
import { pendingDeps, progressOf, type Progress, type Ticket } from "../model/ticket.js";
import type { Doc } from "../storage/documents.js";
import type { Store } from "../storage/store.js";
import { cyclePath, findCrossingCycle, findCycle, type WaitEdge } from "../storage/wait-cycle.js";
import { defineCommand, ok } from "./define.js";
import { nowIso, openPlanOf, planRef, projectOf, sortedDocs, ticketRef } from "./helpers.js";

/** 1 つの値（CLI の `--after t3=t1,t2`）でも配列（HTTP）でも受ける */
const refList = z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]);
const freeText = z.union([z.string(), z.number(), z.boolean()]);

function splitRefs(value: z.output<typeof refList>): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

export const planCreate = defineCommand({
  name: "plan.create",
  positionals: ["tickets"],
  group: "plan",
  summary:
    "Create a Plan awaiting approval. Tickets that do not exist, are finished, or are in another open Plan cannot be added",
  input: z.object({
    tickets: z
      .array(ticketRef)
      .min(1)
      .describe("Tickets to advance (the order listed is a guide to the run order)"),
    project: slugSchema
      .optional()
      .describe("Project. Defaults to config's default_project when omitted"),
    after: z
      .record(z.string(), refList)
      .optional()
      .describe(
        "Waits within the Plan only (t3=t1,t2 advances t3 after t1 and t2). Cycles are rejected and the path is shown (remove after or reverse its direction)",
      ),
    scope: z.record(z.string(), freeText).optional().describe("Scope for each ticket (t3=text)"),
    approach: z
      .record(z.string(), freeText)
      .optional()
      .describe("Approach for each ticket (t3=text)"),
    tier: z
      .record(z.string(), z.enum(PLAN_TIERS))
      .optional()
      .describe(
        "Tier for each ticket (t3=light; light / standard / heavy). Maps to models in config's models.*",
      ),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const project = projectOf(ctx, input.project);
        ctx.store.requireProject(project);
        const tickets: TicketId[] = [];
        for (const ref of input.tickets) {
          const t = ctx.store.require("ticket", ref);
          if (tickets.includes(t.data.id)) continue;
          if (t.data.project !== project)
            throw new OperationError("REJECTED", `${t.id} is not a ticket of Project ${project}`);
          if (isTerminal(t.data.status))
            throw new OperationError(
              "REJECTED",
              `${t.id} is ${t.data.status}, so it cannot be put in a Plan`,
            );
          const other = openPlanOf(ctx.store, t.data.id);
          if (other)
            throw new OperationError(
              "REJECTED",
              `${t.id} is in the open Plan ${other.id}. Close ${other.id} first`,
            );
          tickets.push(t.data.id);
        }
        // 計画内の参照は Plan に入れたチケットだけ
        const member = (ref: string, what: string): TicketId => {
          const t = ctx.store.require("ticket", ref);
          if (!tickets.includes(t.data.id))
            throw new OperationError("REJECTED", `The ${what} ticket ${t.id} is not in the Plan`);
          return t.data.id;
        };
        const after: Record<string, TicketId[]> = {};
        for (const [key, value] of Object.entries(input.after ?? {})) {
          const id = member(key, "after");
          const waits = splitRefs(value).map((r) => member(r, "after"));
          if (waits.includes(id))
            throw new OperationError("REJECTED", `${id} cannot wait for itself`);
          after[id] = [...new Set([...(after[id] ?? []), ...waits])];
        }
        const afterEdges = (id: string): WaitEdge[] =>
          (after[id] ?? []).map((to) => ({ to, via: "after" }));
        const cycle = findCycle(Object.keys(after), afterEdges);
        if (cycle)
          throw new OperationError(
            "REJECTED",
            `after forms a cycle: ${cyclePath(cycle, false)}. Remove that after or change its direction`,
          );
        // after と depends_on を合わせても循環しない（互いを待って着手できなくなる）
        const crossing = findCrossingCycle(ctx.store, tickets, after);
        if (crossing)
          throw new OperationError(
            "REJECTED",
            `after and depends_on form a cycle: ${cyclePath(crossing, true)}. Remove that after or change its direction`,
          );
        const details: Record<string, { scope?: string; approach?: string; tier?: PlanTier }> = {};
        for (const [field, map] of [
          ["scope", input.scope],
          ["approach", input.approach],
          ["tier", input.tier],
        ] as const) {
          for (const [key, value] of Object.entries(map ?? {})) {
            const id = member(key, field);
            details[id] = { ...details[id], [field]: String(value) };
          }
        }
        const id = ctx.store.nextId("plan");
        return ctx.store.create("plan", {
          id,
          project,
          tickets,
          after,
          pending_approval: true,
          details,
        });
      },
      {
        message: (doc) => `Create ${doc.id}: ${doc.data.tickets.join(", ")}`,
        immediate: true,
        cas: true,
      },
    );
    return ok(result.value.data, result.write);
  },
});

/** Plan の状態。Plan には書かず、pending_approval と closed_at から求める */
export type PlanStatus = "pending" | "approved" | "closed";

/** 次に着手するチケット（PL-6）。waiting が空なら着手できる。空でなければ、着手できるものがなく、Plan の順で先頭の todo が待っている相手 */
export interface PlanNext {
  id: TicketId;
  waiting: TicketId[];
}

/**
 * Plan のチケットが着手できるか（PL-6）。都度求め、Plan には書かない。
 * waiting はチケットごとの残りの待ちの相手（after の終わっていない待ち先が先、depends_on の終わっていない依存先が後）。
 * ready は todo で waiting が空のチケット（Plan の順）、next は次に着手するもの
 */
export interface PlanReadiness {
  waiting: Record<TicketId, TicketId[]>;
  ready: TicketId[];
  next: PlanNext | null;
}

/** plan.list の 1 行（状態・進捗・着手できるかは都度求める。PL-1・PL-6） */
export type PlanRow = Plan & { status: PlanStatus; progress: Progress } & PlanReadiness;

const PLAN_FILTERS = ["open", "pending", "approved", "closed"] as const;

function planStatus(plan: Plan): PlanStatus {
  if (plan.closed_at !== undefined) return "closed";
  return plan.pending_approval ? "pending" : "approved";
}

/** iteration.show に出す Plan の 1 行（UI-5）。状態と進捗は plan.list と同じ求め方 */
export type PlanBrief = { id: Plan["id"]; status: PlanStatus; progress: Progress };

/** 中のチケットを 1 件でも含む Plan を、番号順に状態と進捗つきで出す。閉じた Plan も含める */
export function plansContaining(store: Store, ticketIds: readonly string[]): PlanBrief[] {
  const ids = new Set(ticketIds);
  return sortedDocs(store.plans.values())
    .filter((d) => d.data.tickets.some((t) => ids.has(t)))
    .map((d) => ({
      id: d.data.id,
      status: planStatus(d.data),
      progress: progressOf(ticketsOf(store, d.data).map((t) => t.data)),
    }));
}

function ticketsOf(store: Store, plan: Plan): Doc<Ticket>[] {
  return plan.tickets.flatMap((id) => store.tickets.get(id) ?? []);
}

/** 着手できるかを求めるのに要るチケットの属性 */
export type ReadinessTicket = Pick<Ticket, "id" | "status" | "depends_on">;

/**
 * 着手できるかを求める（PL-6）。ticketOf はチケットを引く（見つからなければ undefined）。
 * 消したチケットは Plan の中にないものとして扱い、after がそれ（か Plan の外）を指しても待たない（画面の依存グラフの辺と同じ）。
 * depends_on の待ちは deps_done（WF-2）と同じ pendingDeps で求める（見つからない依存先も相手に出す）。
 * 次は、Plan の順（tickets）で先の着手できる todo。なければ先頭の todo とその待ちの相手。todo がなければ null
 */
export function planReadiness(
  plan: Pick<Plan, "tickets" | "after" | "closed_at">,
  ticketOf: (id: string) => ReadinessTicket | undefined,
): PlanReadiness {
  const finished = (id: string) => {
    const status = ticketOf(id)?.status;
    return status !== undefined && isTerminal(status);
  };
  const waiting: Record<string, TicketId[]> = {};
  const todo: TicketId[] = [];
  for (const id of plan.tickets) {
    const t = ticketOf(id);
    if (!t) continue;
    const afterWaits = (plan.after[id] ?? []).filter(
      (dep) =>
        dep !== id && plan.tickets.includes(dep) && ticketOf(dep) !== undefined && !finished(dep),
    );
    const depWaits = pendingDeps(t, (dep) => ticketOf(dep)?.status).filter(
      (dep) => !afterWaits.includes(dep),
    );
    waiting[id] = [...afterWaits, ...depWaits];
    if (t.status === "todo") todo.push(id);
  }
  // 閉じた Plan は進めないので、着手できるものも次も出さない（待ちの相手はグラフのために出す）
  if (plan.closed_at !== undefined) return { waiting, ready: [], next: null };
  const ready = todo.filter((id) => waiting[id]!.length === 0);
  const first = ready[0] ?? todo[0];
  const next = first === undefined ? null : { id: first, waiting: waiting[first]! };
  return { waiting, ready, next };
}

const readinessIn = (store: Store, plan: Plan): PlanReadiness =>
  planReadiness(plan, (id) => store.tickets.get(id as TicketId)?.data);

export const planList = defineCommand({
  name: "plan.list",
  group: "plan",
  summary:
    "List Plans in number order, with status (pending, approved, closed), progress, each ticket's waiting-on (waiting), tickets that can be started (ready), and next. --status open limits the list to open Plans (awaiting approval and approved)",
  input: z.object({
    project: slugSchema.optional().describe("Filter by Project"),
    status: z
      .enum(PLAN_FILTERS)
      .optional()
      .describe(
        "open (not closed), pending (awaiting approval), approved (approved and open), or closed",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const match = (status: PlanStatus): boolean =>
      !input.status || (input.status === "open" ? status !== "closed" : input.status === status);
    const rows = sortedDocs(ctx.store.plans.values())
      .filter((d) => !input.project || d.data.project === input.project)
      .map((d) => ({ doc: d, status: planStatus(d.data) }))
      .filter((r) => match(r.status))
      .map(({ doc, status }): PlanRow => ({
        ...doc.data,
        status,
        progress: progressOf(ticketsOf(ctx.store, doc.data).map((t) => t.data)),
        ...readinessIn(ctx.store, doc.data),
      }));
    return ok(rows);
  },
});

export const planShow = defineCommand({
  name: "plan.show",
  positionals: ["plan"],
  group: "plan",
  summary:
    "Show a Plan and its tickets in Plan order. Status (status: pending, approved, closed), progress, what each ticket waits on (items[].waiting), whether it can be started (items[].ready), and next are not written in the Plan; they are derived from ticket states",
  input: z.object({ plan: planRef }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const doc = ctx.store.require("plan", input.plan);
    const warnings: string[] = [];
    const found: Doc<Ticket>[] = [];
    for (const id of doc.data.tickets) {
      const t = ctx.store.tickets.get(id);
      if (t) found.push(t);
      else warnings.push(`${id} not found (deleted)`);
    }
    // チケットごとの待ちの相手は items[].waiting に出すので、上の階層には ready と next だけを置く
    const { waiting, ready, next } = readinessIn(ctx.store, doc.data);
    const items = found.map((t) => ({
      ...t.data,
      waiting: waiting[t.data.id] ?? [],
      ready: ready.includes(t.data.id),
    }));
    return ok(
      {
        ...doc.data,
        status: planStatus(doc.data),
        progress: progressOf(found.map((t) => t.data)),
        ready,
        next,
        items,
      },
      undefined,
      warnings,
    );
  },
});

export const planApprove = defineCommand({
  name: "plan.approve",
  positionals: ["plan"],
  group: "plan",
  summary: "Approve a Plan awaiting approval. Records the approver and the time",
  input: z.object({ plan: planRef }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const plan = ctx.store.require("plan", input.plan);
        if (plan.data.closed_at !== undefined)
          throw new OperationError("REJECTED", `${plan.id} is closed`);
        if (!plan.data.pending_approval)
          throw new OperationError(
            "REJECTED",
            `${plan.id} is already approved (${plan.data.approved_by ?? "unknown"})`,
          );
        return ctx.store.update("plan", plan.id, {
          pending_approval: false,
          approved_by: ctx.actor.id,
          approved_at: nowIso(ctx),
        });
      },
      { message: (doc) => `Approve ${doc.id}` },
    );
    return ok(result.value.data, result.write);
  },
});

export const planClose = defineCommand({
  name: "plan.close",
  positionals: ["plan"],
  group: "plan",
  summary:
    "Close a Plan. Its tickets can then be added to another Plan. Unfinished tickets produce a warning",
  input: z.object({ plan: planRef }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const warnings: string[] = [];
    const result = await withWrite(
      ctx,
      async () => {
        const plan = ctx.store.require("plan", input.plan);
        if (plan.data.closed_at !== undefined)
          throw new OperationError("REJECTED", `${plan.id} is already closed`);
        const open = plan.data.tickets.filter((id) => {
          const status = ctx.store.tickets.get(id)?.data.status;
          return status !== undefined && !isTerminal(status);
        });
        if (open.length > 0) warnings.push(`Closed with ${open.join(", ")} left open`);
        return ctx.store.update("plan", plan.id, { closed_at: nowIso(ctx) });
      },
      { message: (doc) => `Close ${doc.id}` },
    );
    return ok(result.value.data, result.write, warnings);
  },
});

export const planCommands = [planCreate, planList, planShow, planApprove, planClose];
