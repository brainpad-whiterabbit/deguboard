// Ticket の操作（CL-2、ST-1〜ST-3、ST-7〜ST-9、RN-5）

import { prettifyError, z } from "zod";
import { OperationError, UsageError } from "../errors.js";
import { collectBranchFacts, fetchPrCreatedAt, findMergedLeftover } from "../git/facts.js";
import { findBranchWorktree } from "../git/worktree.js";
import { AbortWrite, withWrite } from "../git/write.js";
import { resolveActorRef, sameUser } from "../model/actor.js";
import { STATUSES, isTerminal, slugSchema, statusSchema, type Status } from "../model/common.js";
import { parseId, type TicketId } from "../model/id.js";
import type { RunId } from "../model/run.js";
import {
  PRIORITIES,
  parseAcceptance,
  replaceAcceptance,
  setAcceptance,
  ticketBodyTemplate,
  type AcceptanceItem,
  type Ticket,
} from "../model/ticket.js";
import type { FactName, StepOpener } from "../model/workflow.js";
import { dropRunning, peekRunningRuns, readRunningRuns, runAgentByTicket } from "../run/record.js";
import type { Doc } from "../storage/documents.js";
import { wouldCreateCycle } from "../storage/integrity.js";
import type { Store, WorkflowEntry } from "../storage/store.js";
import type { Facts } from "../workflow/conditions.js";
import { canTransition, describeRejection, findConstraint } from "../workflow/resolve.js";
import {
  prepareIterationForClaim,
  prepareWorktreeForClaim,
  runSetupInWorktree,
} from "./claim-setup.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { parseDraftSource } from "./draft-source.js";
import { matchesFilter, ticketFilterSchema } from "./filters.js";
import { stageFactsOf, stageOf, type Stage } from "./next.js";
import {
  dependents,
  nowIso,
  openPlanOf,
  projectOf,
  sortedDocs,
  ticketRef,
  withBody,
} from "./helpers.js";
import {
  agentFromEnv,
  closeOpenedRunUnlessClosed,
  describeClosedRuns,
  findOpenedRun,
  openedStepOf,
  openRun,
  runsClosedByMove,
  token,
  transcriptFields,
  type ClosedOpenedRun,
  type TranscriptInput,
} from "./run.js";

/**
 * チケットの操作に付随して、操作が開いた Run（claim は実装、reclaim は手直し）を閉じる（RN-6）。書き込みの中で呼び、
 * 実行中の Run があるものだけ閉じる。別の文脈が先に閉じていた Run は閉じずに警告し、操作は止めない。
 * 閉じたことと取り込みの警告は warnings に入れる。実行中の記録はコミットの後に dropClosed で消す
 */
async function closeRunsWith(
  ctx: CommandContext,
  ticket: Ticket,
  openers: readonly StepOpener[],
  input: { result: "success" | "failure"; error?: string | undefined },
  warnings: string[],
): Promise<ClosedRun[]> {
  const closed: ClosedRun[] = [];
  const running = (await readRunningRuns(ctx.repo)).runs;
  for (const opener of openers) {
    const run = await findOpenedRun(ctx, ticket, opener, running);
    if (!run) continue;
    const result = await closeOpenedRunUnlessClosed(
      ctx,
      run,
      { opener, ...input },
      "this operation",
      warnings,
    );
    if (!result) continue;
    warnings.push(...result.warnings);
    closed.push({ ...result, opener });
  }
  return closed;
}

/** ticket update --pr が実装の Run を閉じるときの PR の作成時刻（RN-6）。チケットに実行中の実装の Run がなければ取らない */
async function prCreatedAtForRun(
  ctx: CommandContext,
  ref: string,
  pr: number,
): Promise<Awaited<ReturnType<typeof fetchPrCreatedAt>> | undefined> {
  const doc = ctx.store.resolve("ticket", ref);
  if (!doc || !(await findOpenedRun(ctx, doc.data, "claim"))) return undefined;
  return fetchPrCreatedAt(ctx.repo, pr);
}

/** 操作に付随して閉じた Run と、それを開いた操作（コミットメッセージの呼び名に使う） */
type ClosedRun = ClosedOpenedRun & { opener: StepOpener };

async function dropClosed(ctx: CommandContext, closed: readonly ClosedRun[]): Promise<void> {
  for (const c of closed) await dropRunning(ctx.repo, c.run.id);
}

/** 書き込みのコミットメッセージに、付随して閉じた Run を足す（照合のメッセージと同じ形） */
const withClosedRun = (message: string, closed: readonly ClosedRun[]) =>
  [message, ...describeClosedRuns(closed)].join(". ");

/** 主体の参照。`human` / `agent` は自分（のユーザ）に解く（model/actor.ts） */
const actorRef = z.string().min(1);

const ticketAttributes = {
  priority: z.enum(PRIORITIES).optional().describe("Priority"),
  labels: z.array(z.string()).optional().describe("Labels"),
  iteration: z.string().optional().describe("Iteration ID"),
  epic: z.string().optional().describe("Epic ID. Cannot be set on a closed Epic"),
  depends_on: z.array(z.string()).optional().describe("IDs of tickets this one depends on"),
  workflow: slugSchema
    .optional()
    .describe("Workflow. Defaults to the Project's default when omitted"),
  assignee: actorRef
    .optional()
    .describe("Assignee. human for yourself, agent for your own AI, otherwise the ID as-is"),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional fields defined in the Workflow's fields"),
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
  title: z.string().min(1).describe("Title"),
  project: slugSchema
    .optional()
    .describe("Project. Defaults to config's default_project when omitted"),
  summary: z.string().optional().describe("Summary. Goes into the body template"),
  acceptance: acceptanceItems
    .optional()
    .describe(
      "Acceptance criteria. Each item goes into the body template's checklist, one per line. Not used when body is given",
    ),
  body: z
    .string()
    .optional()
    .describe("Full body (Markdown). Takes precedence over summary and acceptance"),
  created_by: actorRef
    .optional()
    .describe(
      "Creator. Defaults to the acting actor. When an agent creates tickets on a person's instruction or approval, use human (the user themselves)",
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
    throw new OperationError("REJECTED", `Project ${project} is archived`);
  const workflowId = input.workflow ?? projectDoc.data.workflow;
  const workflow = store.workflows.get(workflowId);
  if (!workflow)
    throw new OperationError("NOT_FOUND", `Workflow ${workflowId} not found or cannot be read`);
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
    throw new OperationError("REJECTED", `Epic ${epic.id} does not belong to Project ${project}`);
  if (epic.data.status === "closed")
    throw new OperationError("REJECTED", `Epic ${epic.id} is closed, so tickets cannot be added`);
  return epic.id;
}

function requireIteration(store: Store, ref: string, project: string) {
  const it = store.require("iteration", ref);
  if (it.data.project !== project)
    throw new OperationError(
      "REJECTED",
      `Iteration ${it.id} does not belong to Project ${project}`,
    );
  if (it.data.status === "closed")
    throw new OperationError("REJECTED", `Iteration ${it.id} is closed`);
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
        `Field ${key} is not defined in Workflow ${workflow.resolved.id}`,
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
        `The value of field ${key} does not match type ${def.type}`,
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
  summary: "Create a ticket. Commits and pushes immediately, regardless of commit.mode",
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
        message: (doc) => `File ${doc.id}: ${doc.data.title}`,
        immediate: true,
        cas: true,
        markProvisional: provisionalMarker(ctx),
      },
    );
    return ok(withBody(result.value), result.write);
  },
});

const draftsSchema = z
  .array(
    createInput.extend({
      key: z.string().optional().describe("Temporary key, used only within the drafts"),
    }),
  )
  .min(1);

/** source（YAML か JSON の本文）から下書きを読み、形を検査する。行末コメントの判定は draft-source.ts */
function draftsFromSource(source: string) {
  const parsed = draftsSchema.safeParse(parseDraftSource(source));
  if (!parsed.success)
    throw new UsageError("The draft has the wrong shape", prettifyError(parsed.error));
  return parsed.data;
}

export const ticketImport = defineCommand({
  name: "ticket.import",
  positionals: ["file"],
  group: "ticket",
  summary:
    "Import an array of drafts in one commit. A draft's key can be referenced from depends_on",
  input: z.object({
    drafts: draftsSchema
      .optional()
      .describe("Array of ticket drafts (cannot be given together with source)"),
    source: z
      .string()
      .meta({ cliSource: true })
      .optional()
      .describe("Draft body (YAML or JSON; use instead of drafts)"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    if (input.drafts && input.source !== undefined)
      throw new UsageError("drafts and source cannot be passed together");
    const drafts = input.source !== undefined ? draftsFromSource(input.source) : input.drafts;
    if (!drafts) throw new UsageError("Pass the drafts with either drafts or source");
    const keys = new Set<string>();
    for (const d of drafts) {
      if (d.key && keys.has(d.key))
        throw new OperationError("VALIDATION_FAILED", `Provisional key ${d.key} is duplicated`);
      if (d.key) keys.add(d.key);
    }
    const result = await withWrite(
      ctx,
      async () => {
        const store = ctx.store;
        const first = Number(store.nextId("ticket").slice(1));
        const idByKey = new Map<string, TicketId>();
        drafts.forEach((d, i) => {
          if (d.key) idByKey.set(d.key, `t${first + i}`);
        });
        const resolveDep = (ref: string): TicketId => {
          const fromKey = idByKey.get(ref);
          if (fromKey) return fromKey;
          if (parseId(ref, "ticket")) return store.require("ticket", ref).data.id;
          throw new OperationError(
            "NOT_FOUND",
            `Dependency ${ref} is neither a ticket ID nor a draft key`,
          );
        };
        const built = drafts.map((d) => ({
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
              throw new OperationError("VALIDATION_FAILED", `Dependencies form a cycle: ${id}`);
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

/**
 * ticket.list の 1 行。deps_done は依存先がすべて done か abandoned か（WF-2。別の Project の依存先も見る）。
 * run_agent はチケットの Run の agent（実行中の Run があればその agent、なければ最後の Run の agent。Run がなければ null。RN-1）
 */
export type TicketRow = Ticket & { deps_done: boolean; run_agent: string | null };

/** ticket.show の出力 */
export type TicketDetail = Ticket & {
  body: string;
  acceptance: AcceptanceItem[];
  dependents: TicketId[];
  deps_done: boolean;
  /** 終わっていない依存先（WF-2。deps_done と同じ判定で、別の Project も見る）。見つからない依存先の status は null */
  pending_deps: { id: TicketId; status: Status | null }[];
  /** 入っている開いた Plan の ID */
  plan: string | null;
  /** 作業ブランチを checkout している worktree の絶対パス。ブランチがない・worktree がないときは null（UI-4） */
  worktree: string | null;
  /** 作業の段階（EX-3。dg next と同じ求め方。作業ブランチは取り込まずに読む） */
  stage: Stage;
};

export const ticketList = defineCommand({
  name: "ticket.list",
  group: "ticket",
  summary:
    "List tickets in number order. Each row adds whether its dependencies are finished (deps_done, same as ticket show) and the agent of its Run (run_agent: the agent of the running Run, or else of the last Run). abandoned tickets are listed with include_abandoned or a status filter",
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
    // run_agent は実行中の Run（このマシンの deguboard-local/runs/）と runs/ の集計から 1 回で引く
    const running = docs.length > 0 ? await peekRunningRuns(ctx.repo) : [];
    const agents = runAgentByTicket(
      running,
      [...ctx.store.runs.values()].map((r) => r.data),
    );
    // deps_done は Project で絞る前の全チケットから求める（別の Project の依存先も見る。WF-2）
    return ok(
      docs.map((d): TicketRow => ({
        ...d.data,
        deps_done: ctx.store.depsDone(d.data),
        run_agent: agents.get(d.data.id) ?? null,
      })),
    );
  },
});

export const ticketShow = defineCommand({
  name: "ticket.show",
  positionals: ["ticket"],
  group: "ticket",
  summary:
    "Show a ticket's attributes and body, its acceptance items (acceptance), dependents (dependents), whether its dependencies are finished (deps_done) and the unfinished ones (pending_deps), the open Plan it is in (plan), the worktree path of its work branch (worktree; null if none), and its work stage (stage; derived the same way as dg next)",
  input: z.object({ ticket: ticketRef }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const doc = ctx.store.require("ticket", input.ticket);
    return ok<TicketDetail>({
      ...withBody(doc),
      acceptance: parseAcceptance(doc.body) ?? [],
      dependents: dependents(ctx.store, doc.data.id),
      deps_done: ctx.store.depsDone(doc.data),
      pending_deps: ctx.store.pendingDeps(doc.data).map((id) => ({
        id,
        status: ctx.store.tickets.get(id)?.data.status ?? null,
      })),
      plan: openPlanOf(ctx.store, doc.data.id)?.id ?? null,
      worktree: doc.data.branch ? await findBranchWorktree(ctx.repo, doc.data.branch) : null,
      stage: stageOf(await stageFactsOf(ctx, doc.data)),
    });
  },
});

export const ticketUpdate = defineCommand({
  name: "ticket.update",
  positionals: ["ticket"],
  group: "ticket",
  summary:
    "Edit a ticket's attributes and body. Change status with ticket.move. Recording a pr closes the implementation Run running on this machine with success, and sets finished_at to the PR's creation time (now, if gh cannot provide it)",
  input: z.object({
    ticket: ticketRef,
    title: z.string().min(1).optional().describe("Title"),
    body: z.string().optional().describe("Replace the whole body"),
    acceptance: acceptanceItems
      .optional()
      .describe(
        "Acceptance items. Replaces only the ## Acceptance criteria (or ## 受け入れ条件) section, and keeps the check marks of items with the same text. Appends the section at the end if there is none. Cannot be given together with body",
      ),
    ...ticketAttributes,
    labels: z
      .array(z.string())
      .optional()
      .describe("Labels. Replaces the whole list (specify all of them, including existing ones)"),
    depends_on: z
      .array(z.string())
      .optional()
      .describe(
        "IDs of tickets this one depends on. Replaces the whole list (specify all of them, including existing ones)",
      ),
    iteration: z.string().nullable().optional().describe("Iteration ID"),
    epic: z.string().nullable().optional().describe("Epic ID"),
    workflow: slugSchema
      .nullable()
      .optional()
      .describe("Workflow. Removing it returns to the Project's default"),
    pr: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(
        "PR number. When recorded, closes the running implementation Run with success (finished_at is the PR's creation time)",
      ),
    branch: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "Work branch name. Removing it makes this a task with no PR, which is left out of reconciliation. Names in use, and names whose tip is still a true ancestor of base, are rejected (BRANCH_IN_USE)",
      ),
    assignee: actorRef
      .nullable()
      .optional()
      .describe("Assignee. human for yourself, agent for your own AI. The creator is not changed"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const warnings: string[] = [];
    // PR の作成時刻は gh で取る（待ちが長くなりうる）ので、書き込みのロックの外で先に取る。閉じる実装の Run があるときだけ取る
    const prCreated =
      typeof input.pr === "number"
        ? await prCreatedAtForRun(ctx, input.ticket, input.pr)
        : undefined;
    const result = await withWrite(
      ctx,
      async () => {
        const store = ctx.store;
        const doc = store.require("ticket", input.ticket);
        const t = doc.data;
        if (input.body !== undefined && input.acceptance !== undefined) {
          throw new UsageError("body and acceptance cannot be given together");
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
        if (input.branch !== undefined && input.branch !== (t.branch ?? null)) {
          if (input.branch !== null) await requireBranchAvailable(ctx, t.id, input.branch);
          patch["branch"] = input.branch ?? undefined;
          patch["branch_at"] = input.branch === null ? undefined : patch["updated_at"];
        }
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
            throw new OperationError("NOT_FOUND", `Workflow ${input.workflow} not found`);
          }
          patch["workflow"] = input.workflow ?? undefined;
        }
        if (input.depends_on !== undefined) {
          const ids = input.depends_on.map((ref) => store.require("ticket", ref).data.id);
          if (ids.includes(t.id) || wouldCreateCycle(store, t.id, ids)) {
            throw new OperationError("REJECTED", "This would create a dependency cycle");
          }
          patch["depends_on"] = ids;
        }
        if (input.fields) {
          const wfId =
            (input.workflow === undefined ? t.workflow : (input.workflow ?? undefined)) ??
            store.requireProject(t.project).data.workflow;
          const wf = store.workflows.get(wfId);
          if (!wf) throw new OperationError("NOT_FOUND", `Workflow ${wfId} not found`);
          Object.assign(patch, validateFields(wf, input.fields));
        }
        // PR を記録したら実装は終わっている。実行中の実装の Run を PR の作成時刻で閉じる（RN-6）。
        // 検査がすべて通った後に閉じる（拒否される更新で Run だけ閉じない）
        const closed: ClosedRun[] = [];
        const running =
          typeof input.pr === "number" ? await findOpenedRun(ctx, t, "claim") : undefined;
        if (running && typeof input.pr === "number") {
          const created = prCreated ?? {
            reason: `Implementation Run ${running.id} started after the PR's creation time was taken`,
          };
          // PR より後に開き直した Run（PR の後の作業は fix の Run にする）は、PR の作成時刻では終わっていない
          const reason =
            created.createdAt === undefined
              ? created.reason
              : created.createdAt < running.data.started_at
                ? `PR #${input.pr} was created before Run ${running.id} started`
                : undefined;
          const result = await closeOpenedRunUnlessClosed(
            ctx,
            running,
            {
              opener: "claim",
              result: "success",
              finishedAt: reason ? undefined : created.createdAt,
            },
            "this operation",
            warnings,
          );
          if (result) {
            if (reason)
              warnings.push(
                `${reason}, so the finished_at of the implementation Run is set to the current time`,
              );
            warnings.push(...result.warnings);
            closed.push({ ...result, opener: "claim" });
          }
        }
        return { doc: await store.update("ticket", t.id, patch, body), closed };
      },
      {
        message: ({ doc, closed }) => withClosedRun(`Update ${doc.id}: ${doc.data.title}`, closed),
      },
    );
    await dropClosed(ctx, result.value.closed);
    return ok(withBody(result.value.doc), result.write, warnings);
  },
});

export const ticketCheck = defineCommand({
  name: "ticket.check",
  positionals: ["ticket", "items"],
  group: "ticket",
  summary:
    "Mark acceptance items as done. Specify items by number; use all for every item, and undo to remove the mark. The numbers are the index in ticket show's acceptance",
  input: z.object({
    ticket: ticketRef,
    items: z
      .array(z.number().int().positive())
      .optional()
      .describe("Item numbers (starting at 1). The index in ticket show's acceptance"),
    all: z.boolean().optional().describe("Apply to all items"),
    undo: z.boolean().optional().describe("Remove the mark and return to not done"),
    base: z
      .string()
      .optional()
      .describe(
        "The body as it was when read. If it differs from the current body (another write happened after reading), nothing is written and the result is REJECTED. The screen uses this to check and uncheck items",
      ),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    // CLI は可変長の位置引数を省くと [] を渡すので、番号の有無はここで見る
    const numbers = [...new Set(input.items ?? [])].sort((a, b) => a - b);
    if (input.all && numbers.length > 0)
      throw new UsageError("all and item numbers cannot be given together");
    if (!input.all && numbers.length === 0) throw new UsageError("Give item numbers or all");
    const checked = !input.undo;
    const result = await withWrite(
      ctx,
      async () => {
        const doc = ctx.store.require("ticket", input.ticket);
        if (input.base !== undefined && input.base !== doc.body) {
          throw new OperationError(
            "REJECTED",
            `The body of ${doc.id} changed after it was read. Read it again, then check the items again`,
          );
        }
        const items = parseAcceptance(doc.body);
        if (items === undefined)
          throw new OperationError(
            "NOT_FOUND",
            `The body of ${doc.id} has no ## Acceptance criteria (or ## 受け入れ条件) section`,
          );
        if (items.length === 0)
          throw new OperationError(
            "NOT_FOUND",
            `${doc.id} has no items in its acceptance criteria`,
          );
        const missing = numbers.filter((n) => n > items.length);
        if (missing.length > 0) {
          throw new OperationError(
            "NOT_FOUND",
            `${doc.id} has no acceptance criteria items numbered ${missing.join(", ")} (1 to ${items.length})`,
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
          `${checked ? "Check" : "Uncheck"} ${input.all ? "all acceptance criteria" : `items ${numbers.join(", ")}`} of ${doc.id}`,
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
      since: doc.data.branch_at ?? doc.data.created_at,
    });
    Object.assign(facts, collected.facts);
  }
  return facts;
}

/**
 * ブランチ名の使い回しを拒否する（ST-3）。終わっていない別のチケットが同じ名前を記録しているか、
 * 前の作業でマージ済みのブランチが同じ名前で残っていれば BRANCH_IN_USE。残ったブランチは照合が branch_merged で
 * done にし、PR を見ない照合では claim の時刻で外せないので、記録する前に止める
 */
async function requireBranchAvailable(
  ctx: CommandContext,
  ticketId: string,
  branch: string,
): Promise<void> {
  const other = [...ctx.store.tickets.values()].find(
    (d) => d.id !== ticketId && d.data.branch === branch && !isTerminal(d.data.status),
  );
  if (other) {
    throw new OperationError(
      "BRANCH_IN_USE",
      `Branch ${branch} is in use by ${other.id} (${other.data.status}). Give a different name`,
    );
  }
  const leftover = await findMergedLeftover(ctx.repo, branch);
  if (leftover) {
    throw new OperationError(
      "BRANCH_IN_USE",
      `The tip of branch ${leftover} is an ancestor of base (merged in earlier work, or cut from an old base), so reconcile would mark it done. Give a different name, or delete the old branch or bring it up to base, then try again`,
    );
  }
}

/** 遷移に伴う担当者とブランチの扱い（ST-8）。旧名の claimed_by も消す */
function transitionSideEffects(to: Status): Record<string, unknown> {
  // todo に戻すと前の作業の PR も外す（次の claim を手直しに見せない。ST-7）。abandoned は PR の記録を残す
  if (to === "todo")
    return {
      assignee: undefined,
      claimed_by: undefined,
      branch: undefined,
      branch_at: undefined,
      pr: undefined,
    };
  if (to === "abandoned")
    return { assignee: undefined, claimed_by: undefined, branch: undefined, branch_at: undefined };
  return {};
}

export const ticketMove = defineCommand({
  name: "ticket.move",
  positionals: ["ticket", "status"],
  group: "ticket",
  summary:
    "Change the Status. Transitions that break the Workflow's transitions constraints (by, requires), and moves to the same Status, are rejected. Closes Runs running on this machine (RN-6): abandoned closes implementation and fix Runs with failure; review and done for a ticket with no branch, and done with no PR, close the implementation Run with success",
  input: z.object({
    ticket: ticketRef,
    status: statusSchema.describe(`Next Status (${STATUSES.join(" / ")})`),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const warnings: string[] = [];
    const result = await withWrite(
      ctx,
      async () => {
        const doc = ctx.store.require("ticket", input.ticket);
        const from = doc.data.status;
        if (from === input.status)
          throw new OperationError("REJECTED", `${doc.id} is already ${from}`);
        const wf = ctx.store.requireWorkflowFor(doc.data);
        const facts = await factsFor(ctx, doc, wf, from, input.status);
        const check = canTransition(wf.resolved, from, input.status, ctx.actor.kind, facts);
        if (!check.ok)
          throw new OperationError(
            "TRANSITION_REJECTED",
            describeRejection(check, from, input.status),
          );
        // PR の要らない作業（branch なし）は照合が進めないので、review・done にしたときが実装の終わり（RN-6）。
        // branch のあるチケットの実装の Run は PR の記録・発見が PR の作成時刻で閉じる
        const endRuns = runsClosedByMove(doc.data, input.status);
        const closed = endRuns
          ? await closeRunsWith(
              ctx,
              doc.data,
              endRuns.openers,
              { result: endRuns.result },
              warnings,
            )
          : [];
        const updated = await ctx.store.update("ticket", doc.id, {
          status: input.status,
          ...transitionSideEffects(input.status),
          updated_at: nowIso(ctx),
        });
        return { doc: updated, from, closed };
      },
      {
        message: ({ doc, from, closed }) =>
          withClosedRun(`Move ${doc.id} from ${from} to ${doc.data.status}`, closed),
      },
    );
    await dropClosed(ctx, result.value.closed);
    return ok({ ...withBody(result.value.doc), from: result.value.from }, result.write, warnings);
  },
});

export const ticketDelete = defineCommand({
  name: "ticket.delete",
  positionals: ["ticket"],
  group: "ticket",
  summary: "Move a ticket to the tombstones (tickets/deleted/). Its number is not reused",
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
          warnings.push(`${doc.id} is depended on by ${deps.join(", ")}. Fix depends_on`);
        await store.deleteTicket(doc.data.id);
        return doc;
      },
      { message: (doc) => `Delete ${doc.id}: ${doc.data.title}` },
    );
    return ok({ id: result.value.id, title: result.value.data.title }, result.write, warnings);
  },
});

/** 作業ブランチの既定の名前。title の ASCII 部分を slug にする */
function defaultBranchName(ticket: Ticket): string {
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `feature/${ticket.id}-${slug}` : `feature/${ticket.id}`;
}

/** もう一度の claim になる条件：自分（同じユーザの人と AI）が claim 済みで PR のある in_progress・review のチケット（ST-9） */
function isReclaim(ctx: CommandContext, ticket: Ticket): boolean {
  return (
    (ticket.status === "in_progress" || ticket.status === "review") &&
    ticket.assignee !== undefined &&
    sameUser(ticket.assignee, ctx.actor.id) &&
    ticket.pr !== undefined
  );
}

/**
 * claim の書き込みの中（取り込みと索引の読み直しの後）で、もう一度の claim と分かったときに抜けるための印。
 * 書くものがないので書き込みを捨て、外で reclaim に回す（古い索引で判定すると、別のマシンで済んだ claim と PR の記録を見落とす）
 */
class ReclaimRequested extends AbortWrite {
  constructor(readonly doc: Doc<Ticket>) {
    super(`${doc.id} needs claiming again`);
  }
}

/** やり直しの理由の形（run finish の retry_reasons と同じ）。1 件 1 行 */
const retryReasons = z
  .array(
    z
      .string()
      .regex(/^[^\r\n]+$/, "Write each reason on one line")
      .regex(/\S/, "The reason is only whitespace"),
  )
  .meta({ freeText: true });

/**
 * ticket.claim の出力。run は claim が開いた実行中の Run の ID（開かなかったときは null。RN-5）。
 * worktree は claim が用意した作業ブランチの worktree の場所（作らなかった・作れなかったときは null。ST-3）
 */
export type ClaimView = Ticket & { body: string; run: RunId | null; worktree: string | null };

/**
 * agent の claim が開く Run の step と agent（RN-5。claim は実装、reclaim は手直し）。開けない理由は warnings に入れて null を返す
 * （claim は成功している（コミット済み、もう一度の claim では書くものがない）ので、Run の都合では失敗させない）
 */
async function openClaimRun(
  ctx: CommandContext,
  doc: Doc<Ticket>,
  opener: StepOpener,
  input: {
    agent: string | undefined;
    retryReasons: readonly string[] | undefined;
  } & TranscriptInput,
  warnings: string[],
): Promise<RunId | null> {
  const step = openedStepOf(ctx, doc.data, opener);
  const detected = input.agent
    ? { agent: input.agent, reason: undefined }
    : agentFromEnv(ctx.env ?? process.env);
  const skipped = (reason: string) =>
    `The ${step} Run is not open: ${reason} (to open one, run dg run start ${doc.id} ${step} --agent <agent>)`;
  if (detected.agent === null) {
    warnings.push(skipped(detected.reason));
    return null;
  }
  try {
    const opened = await openRun(ctx, doc.data, {
      step,
      agent: detected.agent,
      retryReasons: input.retryReasons,
      reopensFix: opener === "reclaim",
      session: input.session,
      transcript: input.transcript,
    });
    warnings.push(...opened.warnings);
    return opened.run.id;
  } catch (e) {
    if (!(e instanceof OperationError)) throw e;
    warnings.push(skipped(e.message));
    return null;
  }
}

/**
 * もう一度の claim（自分が claim 済みで PR のあるチケット）。手直し（見直しの修正ループ・人のレビューの後）の開始とみなし、チケットは変えない（ST-9）。
 * agent なら手直しの Run（opens_on: reclaim の step、なければ fix）を開く（RN-5）。開いたままの前の手直しの Run は、
 * openRun が次の Run の開始を区切りとして閉じてから開く（RN-6）。前の Run が別のセッションで開いたものなら、
 * そのセッションが落ちた残りとみなして interrupted で閉じる（RN-6）。この claim のセッションは sessionOf で決め、
 * サブエージェントの claim でも起動した親のセッションになる
 */
async function reclaim(
  ctx: CommandContext,
  doc: Doc<Ticket>,
  input: {
    branch?: string | undefined;
    without_branch?: boolean | undefined;
    agent?: string | undefined;
    no_run?: boolean | undefined;
    retry_reasons?: string[] | undefined;
  } & TranscriptInput,
  warnings: string[],
): Promise<RunId | null> {
  if (input.without_branch || (input.branch !== undefined && input.branch !== doc.data.branch)) {
    throw new UsageError(
      `${doc.id} is already claimed (branch ${doc.data.branch ?? "none"}, PR #${doc.data.pr}). Claiming again cannot change the branch`,
    );
  }
  warnings.push(
    `${doc.id} is already claimed by you (${doc.data.assignee}) and has PR #${doc.data.pr}, so this is treated as the start of a fix and the ticket is not changed`,
  );
  if (ctx.actor.kind !== "agent" || input.no_run) return null;
  // 開いたままの前の手直しの Run は、openRun が閉じてから開く
  return openClaimRun(
    ctx,
    doc,
    "reclaim",
    {
      agent: input.agent,
      retryReasons: input.retry_reasons,
      session: input.session,
      transcript: input.transcript,
    },
    warnings,
  );
}

export const ticketClaim = defineCommand({
  name: "ticket.claim",
  positionals: ["ticket"],
  group: "ticket",
  summary:
    "Start work on a ticket. Sets the assignee to yourself, records the branch, and sets in_progress. Winning the push gives exclusive access. Follows any todo → in_progress constraint (such as requires: [deps_done]). " +
    "If lint.require_iteration is true and the ticket has no Iteration, it goes into the Project's active Iteration (or else the planned one with the earliest start, or the lowest ID when tied). If there is no target, the warnings say to ask a person. If the ticket's Iteration is planned, it becomes active; if that fails (another active one, or actor.human_only), the failure goes into the warnings and claim still succeeds. Both are pushed in the same write as the claim. " +
    "After the push, it creates the work branch's worktree at worktree.root/<branch name> (change with --worktree-path) from base, and puts its path in worktree. If a worktree for that branch already exists, it uses that; if only the local branch exists, it checks it out. If it cannot be created, the failure goes into the warnings and claim still succeeds. In a worktree it created (not an existing one), it runs config's worktree.setup commands; a failure goes into the warnings and claim still succeeds. That setup can take several minutes, such as pnpm install (limit 10 minutes), and claim does not return until it finishes. It creates no worktree with --no-worktree or --without-branch. " +
    "For an agent, it then opens an implementation Run (the step in the Workflow's steps with opens_on: claim, or else implement) and prints its ID as run (on the last line of stdout in human output). The Run opens before the setup commands run. If it cannot be opened, only a warning is given and claim still succeeds. " +
    "If you claim again a ticket that you (the same user, human or AI) already claimed and that has a PR (in_progress or review), it is treated as the start of a fix (the review fix loop, or after a person's review). The ticket is not changed; for an agent it opens a fix Run (the step with opens_on: reclaim, or else fix). For either an implementation Run or a fix Run, when it opens, any still-open earlier fix Run on the same ticket is first closed with success at the time of the last push after that Run started (or at this claim's time if there is none), using this claim as the boundary. If the earlier fix Run's session differs from this claim's session (--session, else DEGUBOARD_SESSION from the environment, else the session ID the calling agent sets in its environment; for a sub-agent's claim, the parent session that started it), it is treated as left over from a crashed session and closed as interrupted. If either session is unknown, it is closed with success. Claims by other actors are rejected",
  input: z.object({
    ticket: ticketRef,
    branch: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Work branch name. Defaults to feature/<id>-<slug> when omitted. Names in use, and names whose tip is still a true ancestor of base, are rejected (BRANCH_IN_USE)",
      ),
    without_branch: z
      .boolean()
      .optional()
      .describe(
        "Work that needs neither a PR nor a work branch. Does not record a branch and is not reconciled",
      ),
    no_worktree: z
      .boolean()
      .optional()
      .describe(
        "Do not create the work branch's worktree (no branch is created either; only branch is recorded)",
      ),
    worktree_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Where to create the worktree (relative to the top of the working tree, or absolute). Defaults to worktree.root/<branch name>",
      ),
    agent: token
      .optional()
      .describe(
        "Agent name for the Run to open (see dg run start --help). When omitted, the agent calling dg is detected from the environment; if it cannot be detected, a warning is given and no Run is opened. Cannot be used for a person's claim (usage error)",
      ),
    no_run: z
      .boolean()
      .optional()
      .describe(
        "Do not open a Run. Use when passing implementation to a sub-agent (asked with the marker deguboard: ticket=<id> step=<step>; the hook opens the Run)",
      ),
    retry_reasons: retryReasons
      .optional()
      .describe(
        "Use only when claiming again (a fix made by a person or by the parent). One-line summary of the finding to fix, which goes into the fix Run's retry_reasons (see run finish --help for how to write it). A fix sub-agent asked with the marker does not claim; it writes with run retry-reason",
      ),
    ...transcriptFields,
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const warnings: string[] = [];
    if (input.without_branch && input.branch !== undefined) {
      throw new UsageError("branch and without_branch cannot be given together");
    }
    if (input.worktree_path !== undefined && (input.no_worktree || input.without_branch)) {
      throw new UsageError("worktree_path cannot be given with no_worktree or without_branch");
    }
    if (input.no_run && input.agent !== undefined) {
      throw new UsageError("agent and no_run cannot be given together");
    }
    if (input.agent !== undefined && ctx.actor.kind !== "agent") {
      throw new UsageError(
        "agent can be used only when an agent claims, because the agent opens a Run (a person's claim does not open a Run)",
      );
    }
    if (
      (input.session !== undefined || input.transcript !== undefined) &&
      (input.no_run || ctx.actor.kind !== "agent")
    ) {
      throw new UsageError(
        "session and transcript can be used only when an agent claims and opens a Run",
      );
    }
    // 空の配列は省いたのと同じに扱う
    const retryReasonsGiven = input.retry_reasons?.length ? input.retry_reasons : undefined;
    if (retryReasonsGiven && (input.no_run || ctx.actor.kind !== "agent")) {
      throw new UsageError(
        "retry_reason can be used only when an agent claims and opens a fix Run",
      );
    }
    // もう一度の claim（自分が claim 済みで PR のあるチケット。ST-9・RN-5）かは、書き込みの中で取り込んだ後の索引で決める。
    // 書くものがないので ReclaimRequested で書き込みを抜け、外で reclaim に回す
    // Iteration の準備の警告は書き込みのやり直し（cas）ごとに作り直し、最後の 1 回の分だけ返す
    let iterationWarnings: string[] = [];
    const result = await withWrite(
      ctx,
      async () => {
        iterationWarnings = [];
        const doc = ctx.store.require("ticket", input.ticket);
        if (isReclaim(ctx, doc.data)) throw new ReclaimRequested(doc);
        if (doc.data.status !== "todo") {
          const owner = doc.data.assignee;
          const own = owner !== undefined && sameUser(owner, ctx.actor.id);
          if (owner && !own) {
            throw new OperationError("CLAIM_LOST", `${doc.id} is already claimed by ${owner}`);
          }
          // 自分の claim でも PR がなければ手直しにはならない（実装の途中。続けるなら run start、やめるなら unclaim）
          if (own && (doc.data.status === "in_progress" || doc.data.status === "review")) {
            throw new OperationError(
              "CLAIM_LOST",
              `${doc.id} is claimed by you (${owner}) and has no PR yet. To keep implementing, use run start. To stop, use ticket unclaim`,
            );
          }
          throw new OperationError(
            "TRANSITION_REJECTED",
            `${doc.id} is ${doc.data.status}, so it cannot be claimed`,
          );
        }
        if (retryReasonsGiven) {
          throw new UsageError(
            `retry_reason can be used only when claiming again a ticket that you have claimed and that has a PR (${doc.id} is todo)`,
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
          warnings.push(`Changed the assignee from ${previous} to ${ctx.actor.id}`);
        const branch = input.without_branch
          ? undefined
          : (input.branch ?? defaultBranchName(doc.data));
        if (branch) await requireBranchAvailable(ctx, doc.id, branch);
        // Iteration への追加と開始は claim と同じ書き込みに入れ、claim の push で一緒に決まるようにする（ST-3）
        const iteration = await prepareIterationForClaim(ctx, doc, iterationWarnings);
        const now = nowIso(ctx);
        return ctx.store.update("ticket", doc.id, {
          iteration,
          status: "in_progress",
          assignee: ctx.actor.id,
          claimed_by: undefined,
          // 新しい claim は新しい作業の周期。todo にあった前の作業の PR（unclaim 前の記録）は残さない（ST-3・ST-7・ST-9）
          pr: undefined,
          branch,
          branch_at: branch ? now : undefined,
          updated_at: now,
        });
      },
      {
        message: (doc) => `Claim ${doc.id}: ${doc.data.assignee}`,
        immediate: true,
        cas: true,
      },
    ).catch((e: unknown) => (e instanceof ReclaimRequested ? e : Promise.reject(e)));
    if (result instanceof ReclaimRequested) {
      warnings.push(...result.warnings);
      const run = await reclaim(
        ctx,
        result.doc,
        { ...input, retry_reasons: retryReasonsGiven },
        warnings,
      );
      return ok<ClaimView>({ ...withBody(result.doc), run, worktree: null }, undefined, warnings);
    }
    warnings.push(...iterationWarnings);
    // worktree を作るのは claim が push で取れた後（取れなかった claim でブランチを残さない）
    const branch = result.value.data.branch;
    const made =
      branch && !input.no_worktree
        ? await prepareWorktreeForClaim(ctx, branch, input.worktree_path, warnings)
        : null;
    // Run を開くのは claim が push で取れた後。人の claim と no_run では開かない（RN-5）
    const run =
      ctx.actor.kind === "agent" && !input.no_run
        ? await openClaimRun(
            ctx,
            result.value,
            "claim",
            {
              agent: input.agent,
              retryReasons: undefined,
              session: input.session,
              transcript: input.transcript,
            },
            warnings,
          )
        : null;
    // 準備のコマンドは Run を開いた後に回す。pnpm install などで長くかかり、呼ぶ側の上限で切れても Run は残る（t621）
    if (made?.created) await runSetupInWorktree(ctx, made.path, warnings);
    return ok<ClaimView>(
      { ...withBody(result.value), run, worktree: made?.path ?? null },
      result.write,
      warnings,
    );
  },
});

export const ticketUnclaim = defineCommand({
  name: "ticket.unclaim",
  positionals: ["ticket"],
  group: "ticket",
  summary:
    "Remove the claim and return to todo. Also removes branch, branch_at, and pr (the PR record of the earlier work). Only your own claim (same user, human or AI) or a claim with no record; others' claims need force. Implementation and fix Runs running on this machine are closed with failure (to keep a reason, close them first with run finish --result failure --error)",
  input: z.object({
    ticket: ticketRef,
    force: z.boolean().optional().describe("Also remove other people's claims"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const warnings: string[] = [];
    const result = await withWrite(
      ctx,
      async () => {
        const doc = ctx.store.require("ticket", input.ticket);
        if (doc.data.status !== "in_progress") {
          throw new OperationError(
            "TRANSITION_REJECTED",
            `${doc.id} is ${doc.data.status}, so it cannot be unclaimed`,
          );
        }
        const owner = doc.data.assignee;
        if (owner && !sameUser(owner, ctx.actor.id) && !input.force) {
          throw new OperationError(
            "REJECTED",
            `${doc.id} is claimed by ${owner}. To release it, add force`,
          );
        }
        // 実装（か手直し）を途中でやめたので、開いたままの実装・手直しの Run は失敗で閉じる（RN-6）
        const closed = await closeRunsWith(
          ctx,
          doc.data,
          ["claim", "reclaim"],
          { result: "failure", error: "ticket unclaim で todo に戻した" },
          warnings,
        );
        const updated = await ctx.store.update("ticket", doc.id, {
          status: "todo",
          assignee: undefined,
          claimed_by: undefined,
          // 前の作業の PR も外す。次の claim は手直しではなく新しい作業になる（ST-7）
          pr: undefined,
          branch: undefined,
          branch_at: undefined,
          updated_at: nowIso(ctx),
        });
        return { doc: updated, closed };
      },
      { message: ({ doc, closed }) => withClosedRun(`Unclaim ${doc.id}`, closed) },
    );
    await dropClosed(ctx, result.value.closed);
    return ok(withBody(result.value.doc), result.write, warnings);
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
