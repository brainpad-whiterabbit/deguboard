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
      "この操作",
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
  [message, ...describeClosedRuns(closed)].join("。");

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

const draftsSchema = z
  .array(createInput.extend({ key: z.string().optional().describe("下書きの中だけで使う仮キー") }))
  .min(1);

/** source（YAML か JSON の本文）から下書きを読み、形を検査する。行末コメントの判定は draft-source.ts */
function draftsFromSource(source: string) {
  const parsed = draftsSchema.safeParse(parseDraftSource(source));
  if (!parsed.success) throw new UsageError("下書きの形が正しくない", prettifyError(parsed.error));
  return parsed.data;
}

export const ticketImport = defineCommand({
  name: "ticket.import",
  positionals: ["file"],
  group: "ticket",
  summary: "下書きの配列を 1 コミットで取り込む。下書きの key を depends_on から参照できる",
  input: z.object({
    drafts: draftsSchema.optional().describe("チケットの下書きの配列（source と一緒には渡せない）"),
    source: z
      .string()
      .meta({ cliSource: true })
      .optional()
      .describe("下書きの本文（YAML か JSON。drafts の代わり）"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    if (input.drafts && input.source !== undefined)
      throw new UsageError("drafts と source は一緒に渡せない");
    const drafts = input.source !== undefined ? draftsFromSource(input.source) : input.drafts;
    if (!drafts) throw new UsageError("drafts か source のどちらかで下書きを渡す");
    const keys = new Set<string>();
    for (const d of drafts) {
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
        drafts.forEach((d, i) => {
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
    "チケットを番号順に出す。各行に依存先が終わったか（deps_done。ticket.show と同じ）と、Run の agent（run_agent。実行中の Run、なければ最後の Run の agent）を足す。abandoned は include_abandoned か status の指定で出す",
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
    "チケットの属性と本文、受け入れ条件の項目（acceptance）、依存元（dependents）、依存先が終わったか（deps_done）と終わっていない依存先（pending_deps）、入っている開いた Plan（plan）、作業ブランチの worktree のパス（worktree。なければ null）、作業の段階（stage。dg next と同じ求め方）を出す",
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
    "チケットの属性と本文を直す。status は ticket.move で変える。pr を記録すると、このマシンで実行中の実装の Run を success で閉じ、finished_at を PR の作成時刻（gh から取れなければ今）にする",
  input: z.object({
    ticket: ticketRef,
    title: z.string().min(1).optional().describe("タイトル"),
    body: z.string().optional().describe("本文全体を置き換える"),
    acceptance: acceptanceItems
      .optional()
      .describe(
        "受け入れ条件の項目。## Acceptance criteria（か ## 受け入れ条件）の節だけを置き換え、同じ文の済みの印は保つ。節がなければ末尾に足す。body とは同時に指定できない",
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
    pr: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(
        "PR 番号。記録すると実行中の実装の Run を success で閉じる（finished_at は PR の作成時刻）",
      ),
    branch: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "作業ブランチ名。外すと PR の要らない作業になり、照合の対象から外れる。使用中の名前と、先端が base の真の祖先のまま残った名前は拒否（BRANCH_IN_USE）",
      ),
    assignee: actorRef
      .nullable()
      .optional()
      .describe("担当者。human で自分、agent で自分の AI。起票者は変えない"),
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
        // PR を記録したら実装は終わっている。実行中の実装の Run を PR の作成時刻で閉じる（RN-6）。
        // 検査がすべて通った後に閉じる（拒否される更新で Run だけ閉じない）
        const closed: ClosedRun[] = [];
        const running =
          typeof input.pr === "number" ? await findOpenedRun(ctx, t, "claim") : undefined;
        if (running && typeof input.pr === "number") {
          const created = prCreated ?? {
            reason: `実装の Run ${running.id} は PR の作成時刻を取った後に始まった`,
          };
          // PR より後に開き直した Run（PR の後の作業は fix の Run にする）は、PR の作成時刻では終わっていない
          const reason =
            created.createdAt === undefined
              ? created.reason
              : created.createdAt < running.data.started_at
                ? `PR #${input.pr} は Run ${running.id} の開始より前に作られた`
                : undefined;
          const result = await closeOpenedRunUnlessClosed(
            ctx,
            running,
            {
              opener: "claim",
              result: "success",
              finishedAt: reason ? undefined : created.createdAt,
            },
            "この操作",
            warnings,
          );
          if (result) {
            if (reason) warnings.push(`${reason}ので、実装の Run の finished_at は今の時刻にする`);
            warnings.push(...result.warnings);
            closed.push({ ...result, opener: "claim" });
          }
        }
        return { doc: await store.update("ticket", t.id, patch, body), closed };
      },
      {
        message: ({ doc, closed }) => withClosedRun(`${doc.id} を更新: ${doc.data.title}`, closed),
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
    "受け入れ条件の項目に済みの印を付ける。項目は番号で指定し、全部なら all、印を外すなら undo のオプションを使う。番号は ticket show の acceptance の index",
  input: z.object({
    ticket: ticketRef,
    items: z
      .array(z.number().int().positive())
      .optional()
      .describe("項目の番号（1 始まり）。ticket show の acceptance の index"),
    all: z.boolean().optional().describe("すべての項目を対象にする"),
    undo: z.boolean().optional().describe("印を外して未済に戻す"),
    base: z
      .string()
      .optional()
      .describe(
        "読んだときの本文。今の本文と違えば（読んだ後に別の書き込みがあれば）書かずに REJECTED。画面が付け外しに使う",
      ),
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
        if (input.base !== undefined && input.base !== doc.body) {
          throw new OperationError(
            "REJECTED",
            `${doc.id} の本文は読んだ後に変わっている。読み直してから付け直す`,
          );
        }
        const items = parseAcceptance(doc.body);
        if (items === undefined)
          throw new OperationError(
            "NOT_FOUND",
            `${doc.id} の本文に ## Acceptance criteria（か ## 受け入れ条件）がない`,
          );
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
      `ブランチ ${branch} は ${other.id}（${other.data.status}）が使っている。別の名前を指定する`,
    );
  }
  const leftover = await findMergedLeftover(ctx.repo, branch);
  if (leftover) {
    throw new OperationError(
      "BRANCH_IN_USE",
      `ブランチ ${leftover} の先端が base の真の祖先（前の作業でマージ済みか、古い base から切ったまま）で、照合が done にしてしまう。別の名前を指定するか、古いブランチを消すか base に揃えてからやり直す`,
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
    "Status を変える。Workflow の transitions の制約（by・requires）に反する遷移と、同じ Status への move は拒否する。このマシンで実行中の Run を閉じる（RN-6）：abandoned は実装と手直しの Run を failure で、branch のないチケットの review・done と PR のない done は実装の Run を success で閉じる",
  input: z.object({
    ticket: ticketRef,
    status: statusSchema.describe(`次の Status（${STATUSES.join(" / ")}）`),
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
        if (from === input.status) throw new OperationError("REJECTED", `${doc.id} は既に ${from}`);
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
          withClosedRun(`${doc.id} を ${from} から ${doc.data.status} へ`, closed),
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
    super(`${doc.id} はもう一度の claim`);
  }
}

/** やり直しの理由の形（run finish の retry_reasons と同じ）。1 件 1 行 */
const retryReasons = z
  .array(
    z
      .string()
      .regex(/^[^\r\n]+$/, "理由は 1 件 1 行で書く")
      .regex(/\S/, "理由が空白だけ"),
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
    `${step} の Run を開いていない: ${reason}（開くなら dg run start ${doc.id} ${step} --agent <エージェント>）`;
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
      `${doc.id} は claim 済み（branch ${doc.data.branch ?? "なし"}、PR #${doc.data.pr}）。もう一度の claim ではブランチを変えられない`,
    );
  }
  warnings.push(
    `${doc.id} は自分（${doc.data.assignee}）が claim 済みで PR #${doc.data.pr} があるので、手直しの開始とみなしてチケットは変えない`,
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
    "チケットに着手する。担当者（assignee）を自分にしてブランチを記録し、in_progress にする。push の成功で排他を得る。todo → in_progress の制約（requires: [deps_done] など）があれば従う。" +
    "lint.require_iteration が true で Iteration が空なら、Project の active の Iteration（なければ planned のうち start が最も早いもの、並べば ID の小さいもの）に入れる。入れ先がなければ warnings で人に頼むよう伝える。チケットの Iteration が planned なら active にし、できなければ（ほかの active・actor.human_only）warnings に出して claim は成功にする。どちらも claim と同じ書き込みで push する。" +
    "push の後、作業ブランチの worktree を worktree.root/<ブランチ名>（--worktree-path で変えられる）に base から作り、場所を worktree に出す。そのブランチの worktree が既にあればそれを、ローカルにブランチだけあればそれを checkout する。作れなければ warnings に出して claim は成功にする。作った worktree（既存のものは除く）では config の worktree.setup のコマンドを回し、失敗は warnings に出して claim は成功にする。その準備は pnpm install などで数分かかることがあり（上限 10 分）、claim はその間戻らない。--no-worktree・--without-branch では作らない。" +
    "agent なら続けて実装の Run（Workflow の steps のうち opens_on: claim のもの、なければ implement）を開き、ID を run（人向けの出力では標準出力の最後の行）に出す。Run は準備のコマンドより先に開く。開けなければ警告だけして claim は成功にする。" +
    "自分（同じユーザの人と AI）が claim 済みで PR のあるチケット（in_progress か review）をもう一度 claim すると、手直し（見直しの修正ループ・人のレビューの後）の開始とみなす。チケットは変えず、agent なら手直しの Run（opens_on: reclaim のもの、なければ fix）を開く。実装の Run でも手直しの Run でも、開くときに同じチケットの開いたままの前の手直しの Run があれば、この claim を区切りとして、その Run の開始より後の最後の push の時刻（なければこの claim の時刻）で success にしてから開く（手直しの Run を開くとき、前の手直しの Run の session がこの claim のセッション（--session、なければ環境の DEGUBOARD_SESSION、なければ dg を呼んだエージェントが環境に付けるセッション ID。サブエージェントの claim では起動した親のセッション）と違えば、落ちたセッションの残りとみなして interrupted にする。どちらかのセッションが分からなければ success）。ほかの主体の claim は拒否する",
  input: z.object({
    ticket: ticketRef,
    branch: z
      .string()
      .min(1)
      .optional()
      .describe(
        "作業ブランチ名。省略時は feature/<id>-<slug>。使用中の名前と、先端が base の真の祖先のまま残った名前は拒否（BRANCH_IN_USE）",
      ),
    without_branch: z
      .boolean()
      .optional()
      .describe("PR も作業ブランチも要らない作業。branch を記録せず、照合の対象にしない"),
    no_worktree: z
      .boolean()
      .optional()
      .describe("作業ブランチの worktree を作らない（ブランチも作らず、branch を記録するだけ）"),
    worktree_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "作る worktree の場所（作業ツリーの最上位からの相対か絶対パス）。省略時は worktree.root/<ブランチ名>",
      ),
    agent: token
      .optional()
      .describe(
        "開く Run のエージェント名（dg run start --help）。省けば dg を呼んだエージェントを環境変数から判定し、判定できなければ Run を開かずに警告する。人の claim では使えない（使い方の誤り）",
      ),
    no_run: z
      .boolean()
      .optional()
      .describe(
        "Run を開かない。実装をサブエージェントに渡すとき（印 deguboard: ticket=<id> step=<step> で頼み、フックが Run を開く）",
      ),
    retry_reasons: retryReasons
      .optional()
      .describe(
        "もう一度の claim（人や親が自分で直す手直し）でだけ使う。直す指摘の 1 行の要約で、手直しの Run の retry_reasons に入る（書き方は run finish --help）。印で頼んだ手直しのサブエージェントは claim せず run retry-reason で書く",
      ),
    ...transcriptFields,
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const warnings: string[] = [];
    if (input.without_branch && input.branch !== undefined) {
      throw new UsageError("branch と without_branch は同時に指定できない");
    }
    if (input.worktree_path !== undefined && (input.no_worktree || input.without_branch)) {
      throw new UsageError("worktree_path は no_worktree・without_branch と同時に指定できない");
    }
    if (input.no_run && input.agent !== undefined) {
      throw new UsageError("agent と no_run は同時に指定できない");
    }
    if (input.agent !== undefined && ctx.actor.kind !== "agent") {
      throw new UsageError(
        "agent は Run を開く agent の claim でだけ使える（人の claim は Run を開かない）",
      );
    }
    if (
      (input.session !== undefined || input.transcript !== undefined) &&
      (input.no_run || ctx.actor.kind !== "agent")
    ) {
      throw new UsageError("session と transcript は Run を開く agent の claim でだけ使える");
    }
    // 空の配列は省いたのと同じに扱う
    const retryReasonsGiven = input.retry_reasons?.length ? input.retry_reasons : undefined;
    if (retryReasonsGiven && (input.no_run || ctx.actor.kind !== "agent")) {
      throw new UsageError("retry_reason は手直しの Run を開く agent の claim でだけ使える");
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
            throw new OperationError("CLAIM_LOST", `${doc.id} は ${owner} が claim 済み`);
          }
          // 自分の claim でも PR がなければ手直しにはならない（実装の途中。続けるなら run start、やめるなら unclaim）
          if (own && (doc.data.status === "in_progress" || doc.data.status === "review")) {
            throw new OperationError(
              "CLAIM_LOST",
              `${doc.id} は自分（${owner}）が claim 済みで PR がまだない。実装を続けるなら run start、やめるなら ticket unclaim`,
            );
          }
          throw new OperationError(
            "TRANSITION_REJECTED",
            `${doc.id} は ${doc.data.status} なので claim できない`,
          );
        }
        if (retryReasonsGiven) {
          throw new UsageError(
            `retry_reason は自分が claim 済みで PR のあるチケットのもう一度の claim でだけ使える（${doc.id} は todo）`,
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
        message: (doc) => `${doc.id} を claim: ${doc.data.assignee}`,
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
    "claim を外して todo に戻す。branch・branch_at と pr（前の作業の PR の記録）も外す。自分（同じユーザの人と AI）の claim か記録のない claim だけ。他人のものは force。このマシンで実行中の実装・手直しの Run は failure で閉じる（理由を残すなら先に run finish --result failure --error で閉じる）",
  input: z.object({
    ticket: ticketRef,
    force: z.boolean().optional().describe("他人の claim も外す"),
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
      { message: ({ doc, closed }) => withClosedRun(`${doc.id} の claim を外す`, closed) },
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
