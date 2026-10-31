// Ticket の操作（CL-2、ST-1〜ST-3、ST-7〜ST-8）

import { z } from "zod";
import { OperationError } from "../errors.js";
import { collectBranchFacts } from "../git/facts.js";
import { withWrite } from "../git/write.js";
import { STATUSES, slugSchema, statusSchema, type Status } from "../model/common.js";
import { parseId, type TicketId } from "../model/id.js";
import { PRIORITIES, ticketBodyTemplate, type Ticket } from "../model/ticket.js";
import type { FactName } from "../model/workflow.js";
import type { Doc } from "../storage/documents.js";
import { wouldCreateCycle } from "../storage/integrity.js";
import type { Store, WorkflowEntry } from "../storage/store.js";
import type { Facts } from "../workflow/conditions.js";
import { canTransition, describeRejection } from "../workflow/resolve.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { matchesFilter, ticketFilterSchema } from "./filters.js";
import { dependents, nowIso, projectOf, sortedDocs, ticketRef, toId, withBody } from "./helpers.js";

const ticketAttributes = {
  priority: z.enum(PRIORITIES).optional().describe("優先度"),
  labels: z.array(z.string()).optional().describe("ラベル"),
  iteration: z.string().optional().describe("Iteration の ID"),
  epic: z.string().optional().describe("Epic の ID。閉じた Epic には付けられない"),
  depends_on: z.array(z.string()).optional().describe("依存先のチケットの ID"),
  workflow: slugSchema.optional().describe("Workflow。省略時は Project の既定"),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Workflow の fields で定義した任意フィールド"),
};

const createInput = z.object({
  title: z.string().min(1).describe("タイトル"),
  project: slugSchema.optional().describe("Project。省略時は config の default_project"),
  summary: z.string().optional().describe("概要。本文の雛形に入れる"),
  body: z.string().optional().describe("本文全体（Markdown）。summary より優先"),
  ...ticketAttributes,
});
type CreateInput = z.output<typeof createInput>;

/** 作成・取り込みで共通の検証。参照先の存在と整合を確かめ、frontmatter の形にする */
function buildTicket(
  ctx: CommandContext,
  input: CreateInput,
  resolveDep: (ref: string) => TicketId,
): Record<string, unknown> {
  const store = ctx.store;
  const project = projectOf(ctx, input.project);
  const projectDoc = store.requireProject(project);
  if (projectDoc.data.status !== "active")
    throw new OperationError("REJECTED", `Project ${project} はアーカイブ済み`);
  const workflowId = input.workflow ?? projectDoc.data.workflow;
  const workflow = store.workflows.get(workflowId);
  if (!workflow)
    throw new OperationError("NOT_FOUND", `Workflow ${workflowId} が見つからないか読めない`);
  const epic = input.epic === undefined ? undefined : requireOpenEpic(store, input.epic, project);
  const iteration =
    input.iteration === undefined ? undefined : requireIteration(store, input.iteration, project);
  const depends_on = (input.depends_on ?? []).map(resolveDep);
  const fields = validateFields(workflow, input.fields);
  const now = nowIso(ctx);
  return {
    project,
    title: input.title,
    status: "todo",
    priority: input.priority ?? "medium",
    labels: input.labels ?? [],
    ...(iteration ? { iteration } : {}),
    ...(epic ? { epic } : {}),
    depends_on,
    ...(input.workflow ? { workflow: input.workflow } : {}),
    ...fields,
    created_at: now,
    updated_at: now,
  };
}

function requireOpenEpic(store: Store, ref: string, project: string) {
  const epic = store.require("epic", ref);
  if (epic.data.project !== project)
    throw new OperationError("REJECTED", `Epic ${epic.id} は Project ${project} のものではない`);
  if (epic.data.status === "closed")
    throw new OperationError("REJECTED", `Epic ${epic.id} は閉じているのでチケットを足せない`);
  return epic.id;
}

function requireIteration(store: Store, ref: string, project: string) {
  const it = store.require("iteration", ref);
  if (it.data.project !== project)
    throw new OperationError("REJECTED", `Iteration ${it.id} は Project ${project} のものではない`);
  if (it.data.status === "closed")
    throw new OperationError("REJECTED", `Iteration ${it.id} は閉じている`);
  return it.id;
}

/** Workflow の fields に定義されたものだけを通し、型を確かめる */
function validateFields(
  workflow: WorkflowEntry,
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const def = workflow.resolved.fields.find((f) => f.id === key);
    if (!def)
      throw new OperationError(
        "VALIDATION_FAILED",
        `フィールド ${key} は Workflow ${workflow.resolved.id} に定義されていない`,
      );
    if (value === null || value === undefined) {
      out[key] = undefined;
      continue;
    }
    const okType =
      def.type === "number"
        ? typeof value === "number"
        : def.type === "boolean"
          ? typeof value === "boolean"
          : def.type === "enum"
            ? typeof value === "string" && (def.options ?? []).includes(value)
            : def.type === "date"
              ? typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
              : typeof value === "string";
    if (!okType)
      throw new OperationError(
        "VALIDATION_FAILED",
        `フィールド ${key} の値が型 ${def.type} に合わない`,
      );
    out[key] = value;
  }
  return out;
}

function resolveExistingDep(store: Store) {
  return (ref: string): TicketId => store.require("ticket", ref).data.id;
}

function provisionalMarker(ctx: CommandContext) {
  return async (docs: Doc<Ticket> | Doc<Ticket>[]) => {
    for (const doc of Array.isArray(docs) ? docs : [docs])
      await ctx.store.update("ticket", doc.id, { provisional: true });
  };
}

export const ticketCreate = defineCommand({
  name: "ticket.create",
  group: "ticket",
  summary: "チケットを起票する。commit.mode によらず即座にコミットして push する",
  input: createInput,
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const data = buildTicket(ctx, input, resolveExistingDep(ctx.store));
        const id = ctx.store.nextId("ticket");
        const body = input.body ?? ticketBodyTemplate(input.summary);
        return ctx.store.create("ticket", { id, ...data }, body);
      },
      {
        message: (doc) => `${doc.id} を起票: ${doc.data.title}`,
        immediate: true,
        cas: true,
        markProvisional: provisionalMarker(ctx),
      },
    );
    return ok(withBody(result.value), result.write);
  },
});

export const ticketImport = defineCommand({
  name: "ticket.import",
  group: "ticket",
  summary: "下書きの配列を 1 コミットで取り込む。下書きの key を depends_on から参照できる",
  input: z.object({
    drafts: z
      .array(
        createInput.extend({ key: z.string().optional().describe("下書きの中だけで使う仮キー") }),
      )
      .min(1)
      .describe("チケットの下書きの配列"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const keys = new Set<string>();
    for (const d of input.drafts) {
      if (d.key && keys.has(d.key))
        throw new OperationError("VALIDATION_FAILED", `仮キー ${d.key} が重複している`);
      if (d.key) keys.add(d.key);
    }
    const result = await withWrite(
      ctx,
      async () => {
        const store = ctx.store;
        const first = Number(store.nextId("ticket").slice(1));
        const idByKey = new Map<string, TicketId>();
        input.drafts.forEach((d, i) => {
          if (d.key) idByKey.set(d.key, `t${first + i}`);
        });
        const resolveDep = (ref: string): TicketId => {
          const fromKey = idByKey.get(ref);
          if (fromKey) return fromKey;
          if (parseId(ref, "ticket")) return store.require("ticket", ref).data.id;
          throw new OperationError(
            "NOT_FOUND",
            `依存先 ${ref} はチケットの ID でも下書きの key でもない`,
          );
        };
        const built = input.drafts.map((d) => ({
          draft: d,
          data: buildTicket(ctx, d, resolveDep),
        }));
        // 下書きの中の循環は入れる前に確かめる
        const deps = new Map<string, string[]>();
        built.forEach((b, i) => deps.set(`t${first + i}`, b.data["depends_on"] as string[]));
        for (const [id, ds] of deps) {
          const seen = new Set<string>();
          const queue = [...ds];
          while (queue.length) {
            const cur = queue.shift()!;
            if (cur === id)
              throw new OperationError("VALIDATION_FAILED", `依存が循環している: ${id}`);
            if (seen.has(cur)) continue;
            seen.add(cur);
            queue.push(
              ...(deps.get(cur) ?? store.tickets.get(cur as TicketId)?.data.depends_on ?? []),
            );
          }
        }
        const docs: Doc<Ticket>[] = [];
        for (const [i, b] of built.entries()) {
          const id: TicketId = `t${first + i}`;
          docs.push(
            await store.create(
              "ticket",
              { id, ...b.data },
              b.draft.body ?? ticketBodyTemplate(b.draft.summary),
            ),
          );
        }
        return docs;
      },
      {
        message: (docs) =>
          `${docs.length} 件のチケットを取り込み: ${docs.map((d) => d.id).join(", ")}`,
        immediate: true,
        cas: true,
        markProvisional: provisionalMarker(ctx),
      },
    );
    return ok(
      result.value.map((d) => d.data),
      result.write,
    );
  },
});

export const ticketList = defineCommand({
  name: "ticket.list",
  group: "ticket",
  summary: "チケットを番号順に出す。abandoned は include_abandoned か status の指定で出す",
  input: ticketFilterSchema,
  write: false,
  needs: "store",
  async run(ctx, input) {
    const docs = sortedDocs(ctx.store.tickets.values()).filter((d) =>
      matchesFilter(ctx.store, d.data, input),
    );
    return ok(docs.map((d) => d.data));
  },
});

export const ticketShow = defineCommand({
  name: "ticket.show",
  group: "ticket",
  summary: "チケットの属性と本文、依存元を出す",
  input: z.object({ ticket: ticketRef }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const doc = ctx.store.require("ticket", input.ticket);
    return ok({
      ...withBody(doc),
      dependents: dependents(ctx.store, doc.data.id),
      ready: ctx.store.depsDone(doc.data),
    });
  },
});

export const ticketUpdate = defineCommand({
  name: "ticket.update",
  group: "ticket",
  summary: "チケットの属性と本文を直す。status は ticket.move で変える",
  input: z.object({
    ticket: ticketRef,
    title: z.string().min(1).optional(),
    body: z.string().optional().describe("本文全体を置き換える"),
    ...ticketAttributes,
    iteration: z.string().nullable().optional().describe("Iteration の ID。null で外す"),
    epic: z.string().nullable().optional().describe("Epic の ID。null で外す"),
    workflow: slugSchema.nullable().optional().describe("Workflow。null で Project の既定に戻す"),
    pr: z.number().int().positive().nullable().optional().describe("PR 番号。null で外す"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const store = ctx.store;
        const doc = store.require("ticket", input.ticket);
        const t = doc.data;
        const patch: Record<string, unknown> = { updated_at: nowIso(ctx) };
        if (input.title !== undefined) patch["title"] = input.title;
        if (input.priority !== undefined) patch["priority"] = input.priority;
        if (input.labels !== undefined) patch["labels"] = input.labels;
        if (input.pr !== undefined) patch["pr"] = input.pr ?? undefined;
        if (input.epic !== undefined)
          patch["epic"] =
            input.epic === null ? undefined : requireOpenEpic(store, input.epic, t.project);
        if (input.iteration !== undefined) {
          patch["iteration"] =
            input.iteration === null
              ? undefined
              : requireIteration(store, input.iteration, t.project);
        }
        if (input.workflow !== undefined) {
          if (input.workflow !== null && !store.workflows.has(input.workflow)) {
            throw new OperationError("NOT_FOUND", `Workflow ${input.workflow} が見つからない`);
          }
          patch["workflow"] = input.workflow ?? undefined;
        }
        if (input.depends_on !== undefined) {
          const ids = input.depends_on.map((ref) => store.require("ticket", ref).data.id);
          if (ids.includes(t.id) || wouldCreateCycle(store, t.id, ids)) {
            throw new OperationError("REJECTED", "依存が循環する");
          }
          patch["depends_on"] = ids;
        }
        if (input.fields) {
          const wfId =
            (input.workflow === undefined ? t.workflow : (input.workflow ?? undefined)) ??
            store.requireProject(t.project).data.workflow;
          const wf = store.workflows.get(wfId);
          if (!wf) throw new OperationError("NOT_FOUND", `Workflow ${wfId} が見つからない`);
          Object.assign(patch, validateFields(wf, input.fields));
        }
        return store.update("ticket", t.id, patch, input.body);
      },
      { message: (doc) => `${doc.id} を更新: ${doc.data.title}` },
    );
    return ok(withBody(result.value), result.write);
  },
});

/** 遷移の検査に要る事実を集める。Git の事実は requires に出てくるときだけ取る */
async function factsFor(
  ctx: CommandContext,
  doc: Doc<Ticket>,
  wf: WorkflowEntry,
  from: Status,
  to: Status,
): Promise<Facts> {
  const facts: Facts = { deps_done: ctx.store.depsDone(doc.data) };
  const transition = wf.resolved.transitions.find((t) => t.from === from && t.to === to);
  const gitFacts = (transition?.requires ?? [])
    .map((c) => c.replace(/^!/, "") as FactName)
    .filter((f) => f !== "deps_done");
  if (gitFacts.length > 0 && doc.data.branch) {
    const needPr = gitFacts.some((f) => f.startsWith("pr_"));
    Object.assign(
      facts,
      await collectBranchFacts(ctx.repo, doc.data.branch, { pr: doc.data.pr, needPr }),
    );
  }
  return facts;
}

/** 遷移に伴う claim とブランチの扱い（ST-8） */
function transitionSideEffects(to: Status): Record<string, unknown> {
  if (to === "abandoned" || to === "todo") return { claimed_by: undefined, branch: undefined };
  return {};
}

export const ticketMove = defineCommand({
  name: "ticket.move",
  group: "ticket",
  summary: "Status を変える。遷移表と Workflow の requires を通らない遷移は拒否する",
  input: z.object({
    ticket: ticketRef,
    status: statusSchema.describe(`次の Status（${STATUSES.join(" / ")}）`),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const doc = ctx.store.require("ticket", input.ticket);
        const from = doc.data.status;
        if (from === input.status) throw new OperationError("REJECTED", `${doc.id} は既に ${from}`);
        const wf = ctx.store.requireWorkflowFor(doc.data);
        const facts = await factsFor(ctx, doc, wf, from, input.status);
        const check = canTransition(wf.resolved, from, input.status, ctx.actor.kind, facts);
        if (!check.ok)
          throw new OperationError(
            "TRANSITION_REJECTED",
            describeRejection(check, from, input.status),
          );
        const updated = await ctx.store.update("ticket", doc.id, {
          status: input.status,
          ...transitionSideEffects(input.status),
          updated_at: nowIso(ctx),
        });
        return { doc: updated, from };
      },
      { message: ({ doc, from }) => `${doc.id} を ${from} から ${doc.data.status} へ` },
    );
    return ok({ ...withBody(result.value.doc), from: result.value.from }, result.write);
  },
});

export const ticketDelete = defineCommand({
  name: "ticket.delete",
  group: "ticket",
  summary: "チケットを墓標（tickets/deleted/）へ移す。番号は再利用しない",
  input: z.object({ ticket: ticketRef }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const warnings: string[] = [];
    const result = await withWrite(
      ctx,
      async () => {
        const store = ctx.store;
        const doc = store.require("ticket", input.ticket);
        const deps = dependents(store, doc.data.id);
        if (deps.length > 0)
          warnings.push(`${deps.join(", ")} が ${doc.id} に依存している。depends_on を直す`);
        for (const it of store.iterations.values()) {
          if (it.data.tickets.includes(doc.data.id)) {
            await store.update("iteration", it.id, {
              tickets: it.data.tickets.filter((x) => x !== doc.data.id),
            });
          }
        }
        await store.deleteTicket(doc.data.id);
        return doc;
      },
      { message: (doc) => `${doc.id} を削除: ${doc.data.title}` },
    );
    return ok({ id: result.value.id, title: result.value.data.title }, result.write, warnings);
  },
});

/** 作業ブランチの既定の名前。title の ASCII 部分を slug にする */
export function defaultBranchName(ticket: Ticket): string {
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `feature/${ticket.id}-${slug}` : `feature/${ticket.id}`;
}

export const ticketClaim = defineCommand({
  name: "ticket.claim",
  group: "ticket",
  summary:
    "チケットに着手する。claimed_by とブランチを記録して in_progress にし、push の成功で排他を得る",
  input: z.object({
    ticket: ticketRef,
    branch: z.string().min(1).optional().describe("作業ブランチ名。省略時は feature/<id>-<slug>"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const doc = ctx.store.require("ticket", input.ticket);
        if (doc.data.status !== "todo") {
          if (doc.data.claimed_by) {
            throw new OperationError(
              "CLAIM_LOST",
              `${doc.id} は ${doc.data.claimed_by} が claim 済み`,
            );
          }
          throw new OperationError(
            "TRANSITION_REJECTED",
            `${doc.id} は ${doc.data.status} なので claim できない`,
          );
        }
        const wf = ctx.store.requireWorkflowFor(doc.data);
        const facts = await factsFor(ctx, doc, wf, "todo", "in_progress");
        const check = canTransition(wf.resolved, "todo", "in_progress", ctx.actor.kind, facts);
        if (!check.ok)
          throw new OperationError(
            "TRANSITION_REJECTED",
            describeRejection(check, "todo", "in_progress"),
          );
        return ctx.store.update("ticket", doc.id, {
          status: "in_progress",
          claimed_by: ctx.actor.id,
          branch: input.branch ?? defaultBranchName(doc.data),
          updated_at: nowIso(ctx),
        });
      },
      {
        message: (doc) => `${doc.id} を claim: ${doc.data.claimed_by}`,
        immediate: true,
        cas: true,
      },
    );
    return ok(withBody(result.value), result.write);
  },
});

export const ticketUnclaim = defineCommand({
  name: "ticket.unclaim",
  group: "ticket",
  summary: "claim を外して todo に戻す。自分の claim か記録のない claim だけ。他人のものは force",
  input: z.object({
    ticket: ticketRef,
    force: z.boolean().optional().describe("他人の claim も外す"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const doc = ctx.store.require("ticket", input.ticket);
        if (doc.data.status !== "in_progress") {
          throw new OperationError(
            "TRANSITION_REJECTED",
            `${doc.id} は ${doc.data.status} なので unclaim できない`,
          );
        }
        const owner = doc.data.claimed_by;
        if (owner && owner !== ctx.actor.id && !input.force) {
          throw new OperationError(
            "REJECTED",
            `${doc.id} は ${owner} の claim。外すなら force を付ける`,
          );
        }
        return ctx.store.update("ticket", doc.id, {
          status: "todo",
          claimed_by: undefined,
          branch: undefined,
          updated_at: nowIso(ctx),
        });
      },
      { message: (doc) => `${doc.id} の claim を外す` },
    );
    return ok(withBody(result.value), result.write);
  },
});

export const ticketCommands = [
  ticketCreate,
  ticketList,
  ticketShow,
  ticketUpdate,
  ticketMove,
  ticketDelete,
  ticketImport,
  ticketClaim,
  ticketUnclaim,
];
