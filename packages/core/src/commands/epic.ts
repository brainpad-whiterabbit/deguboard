// Epic の操作（EP-1〜EP-5）

import { z } from "zod";
import { OperationError } from "../errors.js";
import { withWrite } from "../git/write.js";
import { isTerminal, slugSchema } from "../model/common.js";
import { EPIC_STATUSES, epicBodyTemplate, type Epic } from "../model/epic.js";
import { progressOf, type Progress, type Ticket } from "../model/ticket.js";
import { defineCommand, ok } from "./define.js";
import {
  epicRef,
  nowIso,
  projectOf,
  sortedDocs,
  ticketRef,
  ticketsInEpic,
  withBody,
} from "./helpers.js";

export const epicCreate = defineCommand({
  name: "epic.create",
  positionals: ["title"],
  group: "epic",
  summary: "Create an Epic",
  input: z.object({
    title: z.string().min(1).describe("Title"),
    project: slugSchema
      .optional()
      .describe("Project. Defaults to config's default_project when omitted"),
    labels: z.array(z.string()).optional().describe("Labels"),
    summary: z.string().optional().describe("Summary. Goes into the body template"),
    body: z.string().optional().describe("Full body. Takes precedence over summary"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const project = projectOf(ctx, input.project);
        ctx.store.requireProject(project);
        const now = nowIso(ctx);
        const id = ctx.store.nextId("epic");
        return ctx.store.create(
          "epic",
          {
            id,
            project,
            title: input.title,
            status: "open",
            labels: input.labels ?? [],
            created_at: now,
            updated_at: now,
          },
          input.body ?? epicBodyTemplate(input.summary),
        );
      },
      { message: (doc) => `Create ${doc.id}: ${doc.data.title}`, immediate: true, cas: true },
    );
    return ok(withBody(result.value), result.write);
  },
});

/** epic.list の 1 行（進捗は都度求める。EP-3） */
export type EpicRow = Epic & { progress: Progress };
/** epic.show の出力 */
export type EpicDetail = EpicRow & { body: string; tickets: Ticket[] };

export const epicList = defineCommand({
  name: "epic.list",
  group: "epic",
  summary:
    "List Epics in number order, with progress (the done count and the count excluding abandoned)",
  input: z.object({
    project: z.string().optional().describe("Filter by Project. Omit for all"),
    status: z.array(z.enum(EPIC_STATUSES)).optional().describe("Filter by Status. Omit for all"),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const docs = sortedDocs(ctx.store.epics.values()).filter(
      (d) =>
        (!input.project || d.data.project === input.project) &&
        (!input.status || input.status.includes(d.data.status)),
    );
    return ok(
      docs.map((d): EpicRow => ({
        ...d.data,
        progress: progressOf(ticketsInEpic(ctx.store, d.id).map((t) => t.data)),
      })),
    );
  },
});

export const epicShow = defineCommand({
  name: "epic.show",
  positionals: ["epic"],
  group: "epic",
  summary: "Show an Epic's body, progress, and its tickets by Status",
  input: z.object({ epic: epicRef }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const doc = ctx.store.require("epic", input.epic);
    const tickets = ticketsInEpic(ctx.store, doc.id);
    return ok<EpicDetail>({
      ...withBody(doc),
      progress: progressOf(tickets.map((t) => t.data)),
      tickets: tickets.map((t) => t.data),
    });
  },
});

export const epicUpdate = defineCommand({
  name: "epic.update",
  positionals: ["epic"],
  group: "epic",
  summary: "Edit an Epic's attributes and body",
  input: z.object({
    epic: epicRef,
    title: z.string().min(1).optional().describe("Title"),
    labels: z
      .array(z.string())
      .optional()
      .describe("Labels. Replaces the whole list (specify all of them, including existing ones)"),
    body: z.string().optional().describe("Replace the whole body"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const doc = ctx.store.require("epic", input.epic);
        const patch: Record<string, unknown> = { updated_at: nowIso(ctx) };
        if (input.title !== undefined) patch["title"] = input.title;
        if (input.labels !== undefined) patch["labels"] = input.labels;
        return ctx.store.update("epic", doc.id, patch, input.body);
      },
      { message: (doc) => `Update ${doc.id}: ${doc.data.title}` },
    );
    return ok(withBody(result.value), result.write);
  },
});

const membership = z.object({
  epic: epicRef,
  tickets: z.array(ticketRef).min(1).describe("Ticket ID (t12 or 12). Can be given more than once"),
});

export const epicAdd = defineCommand({
  name: "epic.add",
  positionals: ["epic", "tickets"],
  group: "epic",
  summary:
    "Add tickets to an Epic. Only tickets in the same Project; tickets cannot be added to a closed Epic",
  input: membership,
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const epic = ctx.store.require("epic", input.epic);
        if (epic.data.status === "closed")
          throw new OperationError("REJECTED", `${epic.id} is closed, so tickets cannot be added`);
        const ids: string[] = [];
        for (const ref of input.tickets) {
          const t = ctx.store.require("ticket", ref);
          if (t.data.project !== epic.data.project)
            throw new OperationError(
              "REJECTED",
              `${t.id} is in a different Project from ${epic.id}`,
            );
          await ctx.store.update("ticket", t.id, { epic: epic.id, updated_at: nowIso(ctx) });
          ids.push(t.id);
        }
        return { epic: epic.id, tickets: ids };
      },
      { message: (r) => `Add ${r.tickets.join(", ")} to ${r.epic}` },
    );
    return ok(result.value, result.write);
  },
});

export const epicRemove = defineCommand({
  name: "epic.remove",
  positionals: ["epic", "tickets"],
  group: "epic",
  summary: "Remove tickets from an Epic",
  input: membership,
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const epic = ctx.store.require("epic", input.epic);
        const ids: string[] = [];
        for (const ref of input.tickets) {
          const t = ctx.store.require("ticket", ref);
          if (t.data.epic !== epic.id)
            throw new OperationError("REJECTED", `${t.id} is not in ${epic.id}`);
          await ctx.store.update("ticket", t.id, { epic: undefined, updated_at: nowIso(ctx) });
          ids.push(t.id);
        }
        return { epic: epic.id, tickets: ids };
      },
      { message: (r) => `Remove ${r.tickets.join(", ")} from ${r.epic}` },
    );
    return ok(result.value, result.write);
  },
});

export const epicClose = defineCommand({
  name: "epic.close",
  positionals: ["epic"],
  group: "epic",
  summary:
    "Close an Epic. Rejected if tickets other than done or abandoned remain; use force to close it anyway",
  input: z.object({
    epic: epicRef,
    force: z.boolean().optional().describe("Close even if tickets remain"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const warnings: string[] = [];
    const result = await withWrite(
      ctx,
      async () => {
        const epic = ctx.store.require("epic", input.epic);
        if (epic.data.status === "closed")
          throw new OperationError("REJECTED", `${epic.id} is already closed`);
        const open = ticketsInEpic(ctx.store, epic.id).filter((t) => !isTerminal(t.data.status));
        if (open.length > 0) {
          const ids = open.map((t) => t.id).join(", ");
          if (!input.force)
            throw new OperationError(
              "REJECTED",
              `${ids} not finished. To close it anyway, add force`,
            );
          warnings.push(`Closed with ${ids} left unfinished`);
        }
        const now = nowIso(ctx);
        return ctx.store.update("epic", epic.id, {
          status: "closed",
          updated_at: now,
          closed_at: now,
        });
      },
      { message: (doc) => `Close ${doc.id}: ${doc.data.title}` },
    );
    return ok(withBody(result.value), result.write, warnings);
  },
});

export const epicReopen = defineCommand({
  name: "epic.reopen",
  positionals: ["epic"],
  group: "epic",
  summary: "Reopen a closed Epic",
  input: z.object({ epic: epicRef }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const epic = ctx.store.require("epic", input.epic);
        if (epic.data.status !== "closed")
          throw new OperationError("REJECTED", `${epic.id} is not closed`);
        return ctx.store.update("epic", epic.id, {
          status: "open",
          updated_at: nowIso(ctx),
          closed_at: undefined,
        });
      },
      { message: (doc) => `Reopen ${doc.id}: ${doc.data.title}` },
    );
    return ok(withBody(result.value), result.write);
  },
});

export const epicCommands = [
  epicCreate,
  epicList,
  epicShow,
  epicUpdate,
  epicAdd,
  epicRemove,
  epicClose,
  epicReopen,
];
