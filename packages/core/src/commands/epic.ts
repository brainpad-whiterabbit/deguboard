// Epic の操作（EP-1〜EP-5）

import { z } from "zod";
import { OperationError } from "../errors.js";
import { withWrite } from "../git/write.js";
import { slugSchema } from "../model/common.js";
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
  summary: "Epic を作る",
  input: z.object({
    title: z.string().min(1).describe("タイトル"),
    project: slugSchema.optional().describe("Project。省略時は config の default_project"),
    labels: z.array(z.string()).optional().describe("ラベル"),
    summary: z.string().optional().describe("概要。本文の雛形に入れる"),
    body: z.string().optional().describe("本文全体。summary より優先"),
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
      { message: (doc) => `${doc.id} を作成: ${doc.data.title}`, immediate: true, cas: true },
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
  summary: "Epic を番号順に、進捗（done の件数と abandoned を除く件数）つきで出す",
  input: z.object({
    project: z.string().optional().describe("Project で絞る。省略時はすべて"),
    status: z.array(z.enum(EPIC_STATUSES)).optional().describe("Status で絞る。省略時はすべて"),
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
  summary: "Epic の本文と進捗、所属するチケットを Status ごとに出す",
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
  summary: "Epic の属性と本文を直す",
  input: z.object({
    epic: epicRef,
    title: z.string().min(1).optional().describe("タイトル"),
    labels: z
      .array(z.string())
      .optional()
      .describe("ラベル。一覧を置き換える（既存も含めて全部指定する）"),
    body: z.string().optional().describe("本文全体を置き換える"),
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
      { message: (doc) => `${doc.id} を更新: ${doc.data.title}` },
    );
    return ok(withBody(result.value), result.write);
  },
});

const membership = z.object({
  epic: epicRef,
  tickets: z.array(ticketRef).min(1).describe("チケットの ID（t12 または 12）。複数指定できる"),
});

export const epicAdd = defineCommand({
  name: "epic.add",
  positionals: ["epic", "tickets"],
  group: "epic",
  summary: "チケットを Epic に入れる。同じ Project のチケットだけで、閉じた Epic には入れられない",
  input: membership,
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const epic = ctx.store.require("epic", input.epic);
        if (epic.data.status === "closed")
          throw new OperationError("REJECTED", `${epic.id} は閉じているのでチケットを足せない`);
        const ids: string[] = [];
        for (const ref of input.tickets) {
          const t = ctx.store.require("ticket", ref);
          if (t.data.project !== epic.data.project)
            throw new OperationError("REJECTED", `${t.id} は ${epic.id} と別の Project`);
          await ctx.store.update("ticket", t.id, { epic: epic.id, updated_at: nowIso(ctx) });
          ids.push(t.id);
        }
        return { epic: epic.id, tickets: ids };
      },
      { message: (r) => `${r.epic} に ${r.tickets.join(", ")} を入れる` },
    );
    return ok(result.value, result.write);
  },
});

export const epicRemove = defineCommand({
  name: "epic.remove",
  positionals: ["epic", "tickets"],
  group: "epic",
  summary: "チケットを Epic から外す",
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
            throw new OperationError("REJECTED", `${t.id} は ${epic.id} に入っていない`);
          await ctx.store.update("ticket", t.id, { epic: undefined, updated_at: nowIso(ctx) });
          ids.push(t.id);
        }
        return { epic: epic.id, tickets: ids };
      },
      { message: (r) => `${r.epic} から ${r.tickets.join(", ")} を外す` },
    );
    return ok(result.value, result.write);
  },
});

export const epicClose = defineCommand({
  name: "epic.close",
  positionals: ["epic"],
  group: "epic",
  summary: "Epic を閉じる。done・abandoned 以外のチケットが残っていれば拒否し、force で閉じる",
  input: z.object({
    epic: epicRef,
    force: z.boolean().optional().describe("残ったチケットがあっても閉じる"),
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
          throw new OperationError("REJECTED", `${epic.id} は既に閉じている`);
        const open = ticketsInEpic(ctx.store, epic.id).filter(
          (t) => t.data.status !== "done" && t.data.status !== "abandoned",
        );
        if (open.length > 0) {
          const ids = open.map((t) => t.id).join(", ");
          if (!input.force)
            throw new OperationError(
              "REJECTED",
              `${ids} が終わっていない。閉じるなら force を付ける`,
            );
          warnings.push(`${ids} を残したまま閉じた`);
        }
        const now = nowIso(ctx);
        return ctx.store.update("epic", epic.id, {
          status: "closed",
          updated_at: now,
          closed_at: now,
        });
      },
      { message: (doc) => `${doc.id} を閉じる: ${doc.data.title}` },
    );
    return ok(withBody(result.value), result.write, warnings);
  },
});

export const epicReopen = defineCommand({
  name: "epic.reopen",
  positionals: ["epic"],
  group: "epic",
  summary: "閉じた Epic を再開する",
  input: z.object({ epic: epicRef }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const epic = ctx.store.require("epic", input.epic);
        if (epic.data.status !== "closed")
          throw new OperationError("REJECTED", `${epic.id} は閉じていない`);
        return ctx.store.update("epic", epic.id, {
          status: "open",
          updated_at: nowIso(ctx),
          closed_at: undefined,
        });
      },
      { message: (doc) => `${doc.id} を再開: ${doc.data.title}` },
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
