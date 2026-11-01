// Ticket の操作（CL-2、ST-1〜ST-3、ST-7〜ST-8）

import { z } from "zod";
import { OperationError, UsageError } from "../errors.js";
import { collectBranchFacts } from "../git/facts.js";
import { withWrite } from "../git/write.js";
import { resolveActorRef, sameUser } from "../model/actor.js";
import { STATUSES, slugSchema, statusSchema, type Status } from "../model/common.js";
import { parseId, type TicketId } from "../model/id.js";
import {
  PRIORITIES,
  parseAcceptance,
  replaceAcceptance,
  setAcceptance,
  ticketBodyTemplate,
  type Ticket,
} from "../model/ticket.js";
import type { FactName } from "../model/workflow.js";
import type { Doc } from "../storage/documents.js";
import { wouldCreateCycle } from "../storage/integrity.js";
import type { Store, WorkflowEntry } from "../storage/store.js";
import type { Facts } from "../workflow/conditions.js";
import { canTransition, describeRejection, findConstraint } from "../workflow/resolve.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { matchesFilter, ticketFilterSchema } from "./filters.js";
import {
  dependents,
  nowIso,
  openPlanOf,
  projectOf,
  sortedDocs,
  ticketRef,
  withBody,
} from "./helpers.js";

/** 主体の参照。`human` / `agent` は自分（のユーザ）に解く（model/actor.ts） */
const actorRef = z.string().min(1);

const ticketAttributes = {
  priority: z.enum(PRIORITIES).optional().describe("優先度"),
  labels: z.array(z.string()).optional().describe("ラベル"),
  iteration: z.string().optional().describe("Iteration の ID"),
  epic: z.string().optional().describe("Epic の ID。閉じた Epic には付けられない"),
  depends_on: z.array(z.string()).optional().describe("依存先のチケットの ID"),
  workflow: slugSchema.optional().describe("Workflow。省略時は Project の既定"),
  assignee: actorRef
    .optional()
    .describe("担当者。human で自分、agent で自分の AI、ほかは ID のまま"),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Workflow の fields で定義した任意フィールド"),
};

/** 受け入れ条件の項目。1 項目 1 行の自由文（CLI はカンマで割らない） */
const acceptanceItems = z
  .array(
    z
      .string()
      .min(1)
      .regex(/^[^\r\n]+$/, "1 項目は 1 行で書く"),
  )
  .meta({ freeText: true });

const createInput = z.object({
  title: z.string().min(1).describe("タイトル"),
  project: slugSchema.optional().describe("Project。省略時は config の default_project"),
  summary: z.string().optional().describe("概要。本文の雛形に入れる"),
  acceptance: acceptanceItems
    .optional()
    .describe(
      "受け入れ条件。1 項目ずつ、本文の雛形のチェックリストに入れる。body があるときは使わない",
    ),
  body: z.string().optional().describe("本文全体（Markdown）。summary と acceptance より優先"),
  created_by: actorRef
    .optional()
    .describe(
      "起票者。省略時は操作した主体。エージェントが人の指示・承認で起票するときは human（ユーザ本人）",
    ),
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
    created_by: resolveActorRef(ctx.actor, input.created_by ?? ctx.actor.id),
    ...(input.assignee ? { assignee: resolveActorRef(ctx.actor, input.assignee) } : {}),
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
  positionals: ["title"],
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
        const body = input.body ?? ticketBodyTemplate(input.summary, input.acceptance);
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
  positionals: ["file"],
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
              b.draft.body ?? ticketBodyTemplate(b.draft.summary, b.draft.acceptance),
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
    const filter = {
      ...input,
      ...(input.assignee ? { assignee: resolveActorRef(ctx.actor, input.assignee) } : {}),
      ...(input.created_by ? { created_by: resolveActorRef(ctx.actor, input.created_by) } : {}),
    };
    const docs = sortedDocs(ctx.store.tickets.values()).filter((d) =>
      matchesFilter(ctx.store, d.data, filter),
    );
    return ok(docs.map((d) => d.data));
  },
});

export const ticketShow = defineCommand({
  name: "ticket.show",
  positionals: ["ticket"],
  group: "ticket",
  summary:
    "チケットの属性と本文、受け入れ条件の項目（acceptance）、依存元（dependents）、依存先が終わったか（deps_done）、入っている開いた Plan（plan）を出す",
  input: z.object({ ticket: ticketRef }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const doc = ctx.store.require("ticket", input.ticket);
    return ok({
      ...withBody(doc),
      acceptance: parseAcceptance(doc.body) ?? [],
      dependents: dependents(ctx.store, doc.data.id),
      deps_done: ctx.store.depsDone(doc.data),
      plan: openPlanOf(ctx.store, doc.data.id)?.id ?? null,
    });
  },
});

export const ticketUpdate = defineCommand({
  name: "ticket.update",
  positionals: ["ticket"],
  group: "ticket",
  summary: "チケットの属性と本文を直す。status は ticket.move で変える",
  input: z.object({
    ticket: ticketRef,
    title: z.string().min(1).optional(),
    body: z.string().optional().describe("本文全体を置き換える"),
    acceptance: acceptanceItems
      .optional()
      .describe(
        "受け入れ条件の項目。## 受け入れ条件 の節だけを置き換え、同じ文の済みの印は保つ。節がなければ末尾に足す。body とは同時に指定できない",
      ),
    ...ticketAttributes,
    labels: z
      .array(z.string())
      .optional()
      .describe("ラベル。一覧を置き換える（既存も含めて全部指定する）"),
    depends_on: z
      .array(z.string())
      .optional()
      .describe("依存先のチケットの ID。一覧を置き換える（既存も含めて全部指定する）"),
    iteration: z.string().nullable().optional().describe("Iteration の ID"),
    epic: z.string().nullable().optional().describe("Epic の ID"),
    workflow: slugSchema.nullable().optional().describe("Workflow。外すと Project の既定に戻る"),
    pr: z.number().int().positive().nullable().optional().describe("PR 番号"),
    branch: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe("作業ブランチ名。外すと PR の要らない作業になり、照合の対象から外れる"),
    assignee: actorRef
      .nullable()
      .optional()
      .describe("担当者。human で自分、agent で自分の AI。起票者は変えない"),
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
        if (input.body !== undefined && input.acceptance !== undefined) {
          throw new UsageError("body と acceptance は同時に指定できない");
        }
        const body =
          input.acceptance === undefined
            ? input.body
            : replaceAcceptance(doc.body, input.acceptance);
        const patch: Record<string, unknown> = { updated_at: nowIso(ctx) };
        if (input.title !== undefined) patch["title"] = input.title;
        if (input.priority !== undefined) patch["priority"] = input.priority;
        if (input.labels !== undefined) patch["labels"] = input.labels;
        if (input.pr !== undefined) patch["pr"] = input.pr ?? undefined;
        if (input.branch !== undefined) patch["branch"] = input.branch ?? undefined;
        if (input.assignee !== undefined) {
          patch["assignee"] =
            input.assignee === null ? undefined : resolveActorRef(ctx.actor, input.assignee);
          patch["claimed_by"] = undefined;
        }
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
        return store.update("ticket", t.id, patch, body);
      },
      { message: (doc) => `${doc.id} を更新: ${doc.data.title}` },
    );
    return ok(withBody(result.value), result.write);
  },
});

export const ticketCheck = defineCommand({
  name: "ticket.check",
  positionals: ["ticket", "items"],
  group: "ticket",
  summary:
    "受け入れ条件の項目に済みの印を付ける。項目は番号で指定し、全部なら all、印を外すなら undo のオプションを使う。番号は ticket show の acceptance の index",
  input: z.object({
    ticket: ticketRef,
    items: z
      .array(z.number().int().positive())
      .optional()
      .describe("項目の番号（1 始まり）。ticket show の acceptance の index"),
    all: z.boolean().optional().describe("すべての項目を対象にする"),
    undo: z.boolean().optional().describe("印を外して未済に戻す"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    // CLI は可変長の位置引数を省くと [] を渡すので、番号の有無はここで見る
    const numbers = [...new Set(input.items ?? [])].sort((a, b) => a - b);
    if (input.all && numbers.length > 0) throw new UsageError("all と番号は同時に指定できない");
    if (!input.all && numbers.length === 0) throw new UsageError("項目の番号か all を指定する");
    const checked = !input.undo;
    const result = await withWrite(
      ctx,
      async () => {
        const doc = ctx.store.require("ticket", input.ticket);
        const items = parseAcceptance(doc.body);
        if (items === undefined)
          throw new OperationError("NOT_FOUND", `${doc.id} の本文に ## 受け入れ条件 がない`);
        if (items.length === 0)
          throw new OperationError("NOT_FOUND", `${doc.id} の受け入れ条件に項目がない`);
        const missing = numbers.filter((n) => n > items.length);
        if (missing.length > 0) {
          throw new OperationError(
            "NOT_FOUND",
            `${doc.id} の受け入れ条件に番号 ${missing.join(", ")} の項目はない（1〜${items.length}）`,
          );
        }
        const targets = input.all ? items.map((i) => i.index) : numbers;
        return ctx.store.update(
          "ticket",
          doc.id,
          { updated_at: nowIso(ctx) },
          setAcceptance(doc.body, targets, checked),
        );
      },
      {
        message: (doc) =>
          `${doc.id} の受け入れ条件${input.all ? "をすべて" : ` ${numbers.join(", ")} を`}${checked ? "済みにする" : "未済に戻す"}`,
      },
    );
    const doc = result.value;
    return ok({ ...withBody(doc), acceptance: parseAcceptance(doc.body) ?? [] }, result.write);
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
  const constraint = findConstraint(wf.resolved, from, to);
  const gitFacts = (constraint?.requires ?? [])
    .map((c) => c.replace(/^!/, "") as FactName)
    .filter((f) => f !== "deps_done");
  if (gitFacts.length > 0 && doc.data.branch) {
    const needPr = gitFacts.some((f) => f.startsWith("pr_"));
    const collected = await collectBranchFacts(ctx.repo, doc.data.branch, {
      pr: doc.data.pr,
      needPr,
      status: doc.data.status,
    });
    Object.assign(facts, collected.facts);
  }
  return facts;
}

/** 遷移に伴う担当者とブランチの扱い（ST-8）。旧名の claimed_by も消す */
function transitionSideEffects(to: Status): Record<string, unknown> {
  if (to === "abandoned" || to === "todo")
    return { assignee: undefined, claimed_by: undefined, branch: undefined };
  return {};
}

export const ticketMove = defineCommand({
  name: "ticket.move",
  positionals: ["ticket", "status"],
  group: "ticket",
  summary:
    "Status を変える。Workflow の transitions の制約（by・requires）に反する遷移と、同じ Status への move は拒否する",
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
  positionals: ["ticket"],
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
  positionals: ["ticket"],
  group: "ticket",
  summary:
    "チケットに着手する。担当者（assignee）を自分にしてブランチを記録し、in_progress にする。push の成功で排他を得る。todo → in_progress の制約（requires: [deps_done] など）があれば従う",
  input: z.object({
    ticket: ticketRef,
    branch: z.string().min(1).optional().describe("作業ブランチ名。省略時は feature/<id>-<slug>"),
    without_branch: z
      .boolean()
      .optional()
      .describe("PR も作業ブランチも要らない作業。branch を記録せず、照合の対象にしない"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const warnings: string[] = [];
    if (input.without_branch && input.branch !== undefined) {
      throw new UsageError("branch と without_branch は同時に指定できない");
    }
    const result = await withWrite(
      ctx,
      async () => {
        const doc = ctx.store.require("ticket", input.ticket);
        if (doc.data.status !== "todo") {
          if (doc.data.assignee) {
            throw new OperationError(
              "CLAIM_LOST",
              `${doc.id} は ${doc.data.assignee} が claim 済み`,
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
        const previous = doc.data.assignee;
        if (previous && !sameUser(previous, ctx.actor.id))
          warnings.push(`担当者を ${previous} から ${ctx.actor.id} に変えた`);
        return ctx.store.update("ticket", doc.id, {
          status: "in_progress",
          assignee: ctx.actor.id,
          claimed_by: undefined,
          branch: input.without_branch ? undefined : (input.branch ?? defaultBranchName(doc.data)),
          updated_at: nowIso(ctx),
        });
      },
      {
        message: (doc) => `${doc.id} を claim: ${doc.data.assignee}`,
        immediate: true,
        cas: true,
      },
    );
    return ok(withBody(result.value), result.write, warnings);
  },
});

export const ticketUnclaim = defineCommand({
  name: "ticket.unclaim",
  positionals: ["ticket"],
  group: "ticket",
  summary:
    "claim を外して todo に戻す。自分（同じユーザの人と AI）の claim か記録のない claim だけ。他人のものは force",
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
        const owner = doc.data.assignee;
        if (owner && !sameUser(owner, ctx.actor.id) && !input.force) {
          throw new OperationError(
            "REJECTED",
            `${doc.id} は ${owner} の claim。外すなら force を付ける`,
          );
        }
        return ctx.store.update("ticket", doc.id, {
          status: "todo",
          assignee: undefined,
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
  ticketCheck,
  ticketMove,
  ticketDelete,
  ticketImport,
  ticketClaim,
  ticketUnclaim,
];
