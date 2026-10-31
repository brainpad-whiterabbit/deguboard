// Iteration の操作（requirements.md 5.6）。CLI では sprint がエイリアス

import { z } from "zod";
import { OperationError } from "../errors.js";
import { withWrite } from "../git/write.js";
import { slugSchema } from "../model/common.js";
import { ITERATION_STATUSES } from "../model/iteration.js";
import { defineCommand, ok } from "./define.js";
import {
  iterationRef,
  nowIso,
  projectOf,
  sortedDocs,
  ticketRef,
  ticketsInIteration,
} from "./helpers.js";

const isoDate = z.iso.date();

export const iterationCreate = defineCommand({
  name: "iteration.create",
  positionals: ["name"],
  group: "iteration",
  summary: "Iteration を作る",
  input: z.object({
    name: z.string().min(1),
    project: slugSchema.optional().describe("Project。省略時は config の default_project"),
    goal: z.string().optional(),
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
    project: z.string().optional(),
    status: z.array(z.enum(ITERATION_STATUSES)).optional(),
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

export const iterationShow = defineCommand({
  name: "iteration.show",
  positionals: ["iteration"],
  group: "iteration",
  summary: "Iteration と、入っているチケットを優先度と番号の順で出す",
  input: z.object({ iteration: iterationRef }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const doc = ctx.store.require("iteration", input.iteration);
    const items = ticketsInIteration(ctx.store, doc.id).map((t) => t.data);
    return ok({ ...doc.data, items });
  },
});

const membership = z.object({ iteration: iterationRef, tickets: z.array(ticketRef).min(1) });

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
  summary: "Iteration を開始する（active にする）",
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
        return ctx.store.update("iteration", it.id, { status: "active" });
      },
      { message: (doc) => `${doc.id} を開始: ${doc.data.name}` },
    );
    return ok(result.value.data, result.write);
  },
});

export const iterationClose = defineCommand({
  name: "iteration.close",
  positionals: ["iteration"],
  group: "iteration",
  summary:
    "Iteration を閉じ、完了と持ち越しの件数を記録する。持ち越したチケットの iteration は外す",
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
        const carried = tickets.filter(
          (t) => t.data.status !== "done" && t.data.status !== "abandoned",
        );
        for (const t of carried)
          await ctx.store.update("ticket", t.id, { iteration: undefined, updated_at: nowIso(ctx) });
        return ctx.store.update("iteration", it.id, {
          status: "closed",
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

export const iterationCommands = [
  iterationCreate,
  iterationList,
  iterationShow,
  iterationAdd,
  iterationRemove,
  iterationStart,
  iterationClose,
];
