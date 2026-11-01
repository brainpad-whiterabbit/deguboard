// Plan の操作（requirements.md 5.7、ADR-004）。Plan を書くのは作成・承認・終了のときだけで、進捗は都度求める

import { z } from "zod";
import { OperationError } from "../errors.js";
import { withWrite } from "../git/write.js";
import type { TicketId } from "../model/id.js";
import { slugSchema } from "../model/common.js";
import type { Plan } from "../model/plan.js";
import type { Ticket } from "../model/ticket.js";
import type { Doc } from "../storage/documents.js";
import type { Store } from "../storage/store.js";
import { defineCommand, ok } from "./define.js";
import { nowIso, planRef, progressOf, projectOf, ticketRef } from "./helpers.js";

/** 終わったチケット。Plan に入れられない（PL-3） */
const FINISHED: readonly Ticket["status"][] = ["done", "abandoned"];

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

/** 開いた（closed_at のない）Plan のうち、チケットを含むもの */
function openPlanOf(store: Store, ticket: TicketId): Doc<Plan> | undefined {
  for (const plan of store.plans.values()) {
    if (plan.data.closed_at === undefined && plan.data.tickets.includes(ticket)) return plan;
  }
  return undefined;
}

/** 計画内の待ちが循環していれば、その一例を返す */
function afterCycle(after: Record<string, string[]>): string[] | undefined {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const next of after[id] ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of Object.keys(after)) {
    const found = visit(id);
    if (found) return found;
  }
  return undefined;
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
          if (FINISHED.includes(t.data.status))
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
        const cycle = afterCycle(after);
        if (cycle)
          throw new OperationError("REJECTED", `after が循環している: ${cycle.join(" → ")}`);
        const details: Record<string, { scope?: string; approach?: string }> = {};
        for (const [field, map] of [
          ["scope", input.scope],
          ["approach", input.approach],
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

export const planShow = defineCommand({
  name: "plan.show",
  positionals: ["plan"],
  group: "plan",
  summary:
    "Plan と、入っているチケットを Plan の順で出す。進捗は Plan に書かず、チケットの状態から求める",
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
    const finished = (id: TicketId) => {
      const status = ctx.store.tickets.get(id)?.data.status;
      return status !== undefined && FINISHED.includes(status);
    };
    const items = found.map((t) => {
      const waiting = (doc.data.after[t.data.id] ?? []).filter((id) => !finished(id));
      return { ...t.data, waiting };
    });
    return ok({ ...doc.data, progress: progressOf(found), items }, undefined, warnings);
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
          return status !== undefined && !FINISHED.includes(status);
        });
        if (open.length > 0) warnings.push(`${open.join(", ")} を残したまま閉じた`);
        return ctx.store.update("plan", plan.id, { closed_at: nowIso(ctx) });
      },
      { message: (doc) => `${doc.id} を閉じる` },
    );
    return ok(result.value.data, result.write, warnings);
  },
});

export const planCommands = [planCreate, planApprove, planShow, planClose];
