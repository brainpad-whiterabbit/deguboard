// Plan の操作（requirements.md 5.7、ADR-004）。Plan を書くのは作成・承認・終了のときだけで、進捗は都度求める

import { z } from "zod";
import { OperationError } from "../errors.js";
import { withWrite } from "../git/write.js";
import type { TicketId } from "../model/id.js";
import { isTerminal, slugSchema } from "../model/common.js";
import { PLAN_TIERS, type Plan, type PlanTier } from "../model/plan.js";
import { pendingDeps, progressOf, type Progress, type Ticket } from "../model/ticket.js";
import type { Doc } from "../storage/documents.js";
import type { Store } from "../storage/store.js";
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

/** 待ちの辺（from が to を待つ）。via は辺の出どころ */
interface WaitEdge {
  to: string;
  via: "after" | "depends_on";
}

/** 待ちが循環していれば、その一例（始まりのチケットと、たどった辺）を返す */
function findCycle(
  ids: readonly string[],
  edgesOf: (id: string) => readonly WaitEdge[],
): { start: string; edges: WaitEdge[] } | undefined {
  const state = new Map<string, "visiting" | "done">();
  // たどっている途中のチケットと、そこから出た辺（path[i] は onPath[i] から出た辺）
  const onPath: string[] = [];
  const path: WaitEdge[] = [];
  const visit = (id: string): { start: string; edges: WaitEdge[] } | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "visiting") return { start: id, edges: path.slice(onPath.indexOf(id)) };
    state.set(id, "visiting");
    onPath.push(id);
    for (const next of edgesOf(id)) {
      path.push(next);
      const found = visit(next.to);
      if (found) return found;
      path.pop();
    }
    onPath.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of ids) {
    const found = visit(id);
    if (found) return found;
  }
  return undefined;
}

/** after の循環は ID だけを並べ、after と depends_on をまたぐ循環は辺ごとに出どころを添える */
function cyclePath(cycle: { start: string; edges: WaitEdge[] }, labeled: boolean): string {
  return [
    cycle.start,
    ...cycle.edges.map((e) => (labeled ? `→(${e.via}) ${e.to}` : `→ ${e.to}`)),
  ].join(" ");
}

export const planCreate = defineCommand({
  name: "plan.create",
  positionals: ["tickets"],
  group: "plan",
  summary:
    "Plan を承認待ちで作る。存在しない・終わった・別の開いた Plan に入っているチケットは入れられない",
  input: z.object({
    tickets: z.array(ticketRef).min(1).describe("進めるチケット（並べた順が実行順の目安）"),
    project: slugSchema.optional().describe("Project。省略時は config の default_project"),
    after: z
      .record(z.string(), refList)
      .optional()
      .describe("計画内だけの待ち（t3=t1,t2 で t3 を t1・t2 の後に進める）"),
    scope: z.record(z.string(), freeText).optional().describe("チケットごとの範囲（t3=文）"),
    approach: z.record(z.string(), freeText).optional().describe("チケットごとの方針（t3=文）"),
    tier: z
      .record(z.string(), z.enum(PLAN_TIERS))
      .optional()
      .describe(
        "チケットごとの段階（t3=light。light / standard / heavy）。config の models.* でモデルに対応させる",
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
            throw new OperationError("REJECTED", `${t.id} は Project ${project} のチケットでない`);
          if (isTerminal(t.data.status))
            throw new OperationError(
              "REJECTED",
              `${t.id} は ${t.data.status} なので Plan に入れられない`,
            );
          const other = openPlanOf(ctx.store, t.data.id);
          if (other)
            throw new OperationError(
              "REJECTED",
              `${t.id} は開いた Plan ${other.id} に入っている。先に ${other.id} を閉じる`,
            );
          tickets.push(t.data.id);
        }
        // 計画内の参照は Plan に入れたチケットだけ
        const member = (ref: string, what: string): TicketId => {
          const t = ctx.store.require("ticket", ref);
          if (!tickets.includes(t.data.id))
            throw new OperationError("REJECTED", `${what}の ${t.id} は Plan に入っていない`);
          return t.data.id;
        };
        const after: Record<string, TicketId[]> = {};
        for (const [key, value] of Object.entries(input.after ?? {})) {
          const id = member(key, "after");
          const waits = splitRefs(value).map((r) => member(r, "after"));
          if (waits.includes(id))
            throw new OperationError("REJECTED", `${id} は自分自身を待てない`);
          after[id] = [...new Set([...(after[id] ?? []), ...waits])];
        }
        const afterEdges = (id: string): WaitEdge[] =>
          (after[id] ?? []).map((to) => ({ to, via: "after" }));
        const cycle = findCycle(Object.keys(after), afterEdges);
        if (cycle)
          throw new OperationError("REJECTED", `after が循環している: ${cyclePath(cycle, false)}`);
        // after と depends_on を合わせても循環しない（互いを待って着手できなくなる）。
        // depends_on は Plan の外の終わっていないチケットもたどる（外を回って戻る待ちも止まる）。
        // after の辺を含まない循環（depends_on だけ。壊れたデータ）は TK-2 と validate に任せる
        const crossing =
          Object.keys(after).length === 0
            ? undefined
            : findCycle(tickets, (id) => {
                const t = ctx.store.resolve("ticket", id)?.data;
                const deps = t
                  ? pendingDeps(t, (dep) => ctx.store.resolve("ticket", dep)?.data.status)
                  : [];
                return [
                  ...afterEdges(id),
                  ...deps
                    .filter((to) => to !== id && ctx.store.resolve("ticket", to) !== undefined)
                    .map((to): WaitEdge => ({ to, via: "depends_on" })),
                ];
              });
        if (crossing?.edges.some((e) => e.via === "after"))
          throw new OperationError(
            "REJECTED",
            `after と depends_on が循環している: ${cyclePath(crossing, true)}`,
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
        message: (doc) => `${doc.id} を作成: ${doc.data.tickets.join(", ")}`,
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
    "Plan を番号順に、状態（pending・approved・closed）と進捗、チケットの待ちの相手（waiting）・着手できるもの（ready）・次（next）つきで出す。--status open で開いたもの（承認待ちと承認済み）に絞る",
  input: z.object({
    project: slugSchema.optional().describe("Project で絞る"),
    status: z
      .enum(PLAN_FILTERS)
      .optional()
      .describe("open（閉じていない）・pending（承認待ち）・approved（承認済みで開いた）・closed"),
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
    "Plan と、入っているチケットを Plan の順で出す。進捗・待ちの相手（items[].waiting）・着手できるか（items[].ready）・次（next）は Plan に書かず、チケットの状態から求める",
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
      else warnings.push(`${id} が見つからない（削除された）`);
    }
    // チケットごとの待ちの相手は items[].waiting に出すので、上の階層には ready と next だけを置く
    const { waiting, ready, next } = readinessIn(ctx.store, doc.data);
    const items = found.map((t) => ({
      ...t.data,
      waiting: waiting[t.data.id] ?? [],
      ready: ready.includes(t.data.id),
    }));
    return ok(
      { ...doc.data, progress: progressOf(found.map((t) => t.data)), ready, next, items },
      undefined,
      warnings,
    );
  },
});

export const planApprove = defineCommand({
  name: "plan.approve",
  positionals: ["plan"],
  group: "plan",
  summary: "承認待ちの Plan を承認する。承認者と日時を書く",
  input: z.object({ plan: planRef }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const plan = ctx.store.require("plan", input.plan);
        if (plan.data.closed_at !== undefined)
          throw new OperationError("REJECTED", `${plan.id} は閉じている`);
        if (!plan.data.pending_approval)
          throw new OperationError(
            "REJECTED",
            `${plan.id} は既に承認されている（${plan.data.approved_by ?? "不明"}）`,
          );
        return ctx.store.update("plan", plan.id, {
          pending_approval: false,
          approved_by: ctx.actor.id,
          approved_at: nowIso(ctx),
        });
      },
      { message: (doc) => `${doc.id} を承認` },
    );
    return ok(result.value.data, result.write);
  },
});

export const planClose = defineCommand({
  name: "plan.close",
  positionals: ["plan"],
  group: "plan",
  summary:
    "Plan を閉じる。入っていたチケットは別の Plan に入れられるようになる。終わっていないチケットは警告する",
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
          throw new OperationError("REJECTED", `${plan.id} は既に閉じている`);
        const open = plan.data.tickets.filter((id) => {
          const status = ctx.store.tickets.get(id)?.data.status;
          return status !== undefined && !isTerminal(status);
        });
        if (open.length > 0) warnings.push(`${open.join(", ")} を残したまま閉じた`);
        return ctx.store.update("plan", plan.id, { closed_at: nowIso(ctx) });
      },
      { message: (doc) => `${doc.id} を閉じる` },
    );
    return ok(result.value.data, result.write, warnings);
  },
});

export const planCommands = [planCreate, planList, planShow, planApprove, planClose];
