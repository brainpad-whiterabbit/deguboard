// 用意と同期：init・sync・commit・validate・lint・config（show・set・unset）・whoami

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OperationError } from "../errors.js";
import {
  branchCommitTimes,
  collectBranchFacts,
  fetchPrCreatedAt,
  lastPushedAt,
  type BranchFacts,
  type BranchFactsOptions,
} from "../git/facts.js";
import { withLock } from "../git/lock.js";
import { checkOutside, describeOutside, dirtyFiles, recordBaseline } from "../git/outside.js";
import { settleRebase } from "../git/rebase.js";
import { DATA_REMOTE_NAME } from "../git/repo.js";
import { retireProjects } from "../git/retire-projects.js";
import { renumberCollisions, renumberProvisional, type Renumbered } from "../git/renumber.js";
import { ensureGitattributes, ensureMergeDriver, mergeDriverProblem } from "../git/merge.js";
import {
  commitPaths,
  conflictFields,
  describeAutoResolved,
  describeConflictFields,
  fetchAll,
  type ConflictField,
  integrateLogged,
  isDirty,
  push,
  type ResolvedFile,
  syncStatus,
  type ResolveSide,
} from "../git/sync.js";
import {
  CONFLICT_REMEDY,
  flushPending,
  requireDataRemote,
  stopIfDataRemoteChanged,
  UNRESOLVABLE_REMEDY,
  withWrite,
  withWriteLock,
} from "../git/write.js";
import {
  isAgentActorId,
  ownActorIds,
  sameUser,
  type ActorKind,
  type UserSource,
} from "../model/actor.js";
import { isFinishedSet, isTerminal } from "../model/common.js";
import {
  configFields,
  configSchema,
  dataRemoteNameOf,
  dataTargetOf,
  DEFAULT_DATA_BRANCH,
  defaultConfig,
  nestedConfigValue,
  type Config,
  type ConfigField,
} from "../model/config.js";
import { REVIEW_STEP, type Run, type RunId, type RunResult } from "../model/run.js";
import type { StepOpener } from "../model/workflow.js";
import { hasBodySection, parseAcceptance, type Ticket } from "../model/ticket.js";
import { dropRunning, peekRunningRuns, readRunningRuns } from "../run/record.js";
import type { Doc } from "../storage/documents.js";
import { pathExists } from "../storage/exists.js";
import { checkReferences } from "../storage/integrity.js";
import type { Issue } from "../storage/issue.js";
import { CONFIG_FILE, workflowPath } from "../storage/paths.js";
import type { WorkflowEntry } from "../storage/store.js";
import { cyclePath, findCrossingCycle } from "../storage/wait-cycle.js";
import { reconcileStatus, regressionWarnings } from "../workflow/reconcile.js";
import { WORKFLOW_TEMPLATES } from "../workflow/templates/index.js";
import { removeMergedWork, type MergedWork, type RemovedWork } from "./branch-cleanup.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { closeStoppedRuns, type HookView } from "./hook.js";
import { nowIso, sortedDocs } from "./helpers.js";
import {
  linkOrphanRounds,
  recordOrphanReviews,
  type RecordedOrphanReviews,
} from "./orphan-review.js";
import {
  closeOpenedRunUnlessClosed,
  describeClosedRuns,
  findOpenedRun,
  fixRunFinishedAt,
  openedStepOf,
  runsClosedByMove,
  sessionOf,
} from "./run.js";

const TEMPLATE_IDS = WORKFLOW_TEMPLATES.map((t) => t.id) as [string, ...string[]];

export const init = defineCommand({
  name: "init",
  group: "setup",
  summary:
    "Set up the deguboard branch and its dedicated worktree, and put in the config and the template Workflows",
  input: z.object({
    template: z
      .enum(TEMPLATE_IDS)
      .optional()
      .describe(
        "Default Workflow of a new board (config's default_workflow). Defaults to general when omitted",
      ),
    remote: z
      .string()
      .optional()
      .describe(
        "Remote of the code (work branches and pull requests). The kanban data also syncs with it unless --data-remote is given. Defaults to origin when omitted",
      ),
    data_remote: z
      .string()
      .min(1)
      .optional()
      .describe(
        `Remote that the kanban data (the deguboard branch) is fetched from and pushed to, when the data is kept in a repository other than the code's. A remote name or a URL: for a URL, dg uses the remote that already has that URL, or adds it as ${DATA_REMOTE_NAME}, and then takes the data in from it. A new board records the name in config's git.data_remote; when the board already exists and its config names another remote, the name is recorded in this clone's personal settings. Every clone passes this on its first init (the config is inside the data, so it cannot be read before the data is fetched)`,
      ),
    data_branch: z
      .string()
      .min(1)
      .optional()
      .describe(
        `Branch of the data remote that holds this repository's kanban. Defaults to ${DEFAULT_DATA_BRANCH}. Give each repository its own branch (deguboard-<name> is recommended) to keep several kanbans in one dedicated data repository: only this branch is fetched and pushed. A name with / is rejected. A new board records it in config's git.data_branch; when the board already exists and its config names another branch, the name is recorded in this clone's personal settings. Every clone passes this on its first init, as with --data-remote`,
      ),
    base_branch: z
      .string()
      .optional()
      .describe("Base of work branches. Defaults to main when omitted"),
  }),
  write: true,
  needs: "repo",
  async run(ctx, input) {
    await ensureMergeDriver(ctx.repo, ctx.mergeDriver);
    const result = await withWrite(
      ctx,
      async () => {
        const store = ctx.store;
        const created: string[] = [];
        const configPath = path.join(store.root, CONFIG_FILE);
        if (!(await pathExists(configPath))) {
          await store.writeConfig({
            // 既定（general）のときは書かない（スキーマの既定で読む）
            ...(input.template && input.template !== defaultConfig().default_workflow
              ? { default_workflow: input.template }
              : {}),
            git: {
              remote: input.remote ?? "origin",
              ...(input.data_remote && ctx.repo.dataRemote
                ? { data_remote: ctx.repo.dataRemote }
                : {}),
              ...(input.data_branch && input.data_branch !== DEFAULT_DATA_BRANCH
                ? { data_branch: input.data_branch }
                : {}),
              base_branch: input.base_branch ?? "main",
            },
          });
          created.push(CONFIG_FILE);
        }
        const ignorePath = path.join(store.root, ".gitignore");
        if (!(await pathExists(ignorePath))) {
          // 原子的書き込みの一時ファイルをコミットに入れない
          await writeFile(ignorePath, "*.tmp\n");
          created.push(".gitignore");
        }
        // frontmatter のフィールド単位のマージドライバ（SY-4）
        if (await ensureGitattributes(store.root)) created.push(".gitattributes");
        for (const t of WORKFLOW_TEMPLATES) {
          // 誤りがあって索引から外れた Workflow も、ファイルがあれば書き換えない（WF-4）
          if (await pathExists(path.join(store.root, workflowPath(t.id)))) continue;
          await store.writeWorkflow(
            t as Record<string, unknown>,
            `${t.name} のワークフロー。dg init が同梱のテンプレートから置いた`,
          );
          created.push(workflowPath(t.id));
        }
        return created;
      },
      { message: "Initialize deguboard", immediate: true },
    );
    // 取り込んだ config が別の名前のリモートを指すとき（ほかの人は別の名前で足した）は、このクローンの個人の設定に
    // --data-remote で決めた名前を書く。次のコマンドからも同じリモートを使えるように（チームの値は書き換えない）
    if (
      input.data_remote &&
      ctx.repo.dataRemote &&
      dataRemoteNameOf(ctx.store.config) !== ctx.repo.dataRemote
    )
      await ctx.store.writeLocalConfig("git.data_remote", ctx.repo.dataRemote);
    // データのブランチ名も同じ：取り込んだ config が別の名前を指すときは、--data-branch の名前をこのクローンの個人の設定に書く
    if (input.data_branch && ctx.store.config.git.data_branch !== ctx.repo.dataBranch)
      await ctx.store.writeLocalConfig("git.data_branch", ctx.repo.dataBranch);
    return ok(
      {
        data_dir: ctx.repo.dataDir,
        worktree: ctx.worktree ?? "existing",
        remote: ctx.repo.codeRemote,
        data_remote: ctx.repo.dataRemote,
        data_branch: ctx.repo.dataBranch,
        created: result.value,
      },
      // 何も書かなかった init（2 回目や、リモートから取り込んだ 2 人目の clone）は書き込みの結果を返さない。
      // committed: false を返すと入口が「作業ツリーに残した」と案内してしまう。取り込みの警告は残す
      result.write.committed ? result.write : undefined,
      result.write.committed ? [] : result.write.warnings,
    );
  },
});

/** Workflow が pr_* を参照していれば gh を呼ぶ */
function needsPr(wf: WorkflowEntry): boolean {
  const refs = [
    ...wf.resolved.reconcile.flatMap((r) => r.when),
    ...wf.resolved.transitions.flatMap((t) => t.requires),
  ];
  return refs.some((c) => c.replace(/^!/, "").startsWith("pr_"));
}

export interface ReconciledTicket {
  id: string;
  from: string;
  to: string;
  /** 当てはまった reconcile 規則の条件（根拠の事実。例：["pr_merged"]） */
  when: string[];
  /** done にしたときに消した worktree とブランチ（config の merge.delete_branch が true のときだけ付く。ST-4） */
  removed?: RemovedWork;
}

/** 照合がチケットに記録した、マージされた PR の追加・削除の行数（MT-6） */
export interface ReconciledLines {
  id: string;
  additions: number;
  deletions: number;
}

/** 照合が閉じた Run（RN-6）。opener は開いた操作（claim は実装、reclaim は手直し）、result は閉じた結果 */
export interface ReconciledRun {
  id: string;
  run: RunId;
  opener: StepOpener;
  result: RunResult;
}

export interface Reconciled {
  /** 状態を進めたチケット */
  changed: ReconciledTicket[];
  /** PR 番号を記録したチケット（ST-6） */
  prRecorded: Array<{ id: string; pr: number }>;
  /** マージされた PR の行数を記録したチケット（MT-6） */
  linesRecorded: ReconciledLines[];
  /** 照合が閉じた実装の Run（PR の発見・終わったチケット・戻った・取られたチケット）と手直しの Run（区切り）（RN-6）。コミットの後に dropRunning で実行中の記録を消す */
  runsClosed: ReconciledRun[];
  /** 持ち主のない保留から書いた見直しの記録（RN-9。orphan-review.ts）。コミットの後に linkOrphanRounds で保留を結び付ける */
  reviewsRecorded: Array<{ ticket: Doc<Ticket>; recorded: RecordedOrphanReviews }>;
  /** done にしたチケットの片付けの対象（config の merge.delete_branch が true のときだけ）。ロックを放した後に removeMergedWork で消す */
  merged: MergedWork[];
}

/**
 * 開いたままの手直しの Run（もう一度の claim が開いた step。RN-5）を閉じる区切り（RN-6）。手直しにはチケットの操作がないので、
 * 照合が区切りを見たときに、それまでの最後の push の時刻で閉じる。
 *   - 同じチケットの次の Run の開始（実行中・終わったものを問わず、手直しの Run と同じ秒か後に始まったもの。普段は開いた openRun が先に閉じている）
 *   - PR の ready（review への前進）・マージ（done への前進）。照合が今回進めるときに見る
 *   - チケットが終わっている（別のマシンの照合や ticket move で done・abandoned になっていた）
 * 区切りがなければ undefined
 */
function fixRunBoundary(
  ctx: CommandContext,
  ticket: Ticket,
  run: Doc<Run>,
  running: readonly Doc<Run>[],
  advanced: boolean,
): { at?: string | undefined; why: string } | undefined {
  const later = [...running, ...ctx.store.runs.values()]
    .filter((r) => r.id !== run.id && r.data.ticket === ticket.id)
    .filter((r) => r.data.started_at >= run.data.started_at)
    .sort((a, b) => a.data.started_at.localeCompare(b.data.started_at))[0];
  if (later) return { at: later.data.started_at, why: `start of the next Run ${later.id}` };
  if (advanced) return { why: `advance to ${ticket.status}` };
  if (isTerminal(ticket.status)) return { why: `ticket finished (${ticket.status})` };
  return undefined;
}

/**
 * 手直しの Run を区切りで閉じる（RN-6）。finished_at はこの Run の開始より後で区切りまでの最後の push の時刻（作業ブランチのリモートの先端のコミット）。
 * その push がなければ区切りの時刻、マージの区切りでは PR のマージ時刻（fallback）、それもなければ今
 */
async function closeFixRun(
  ctx: CommandContext,
  doc: Doc<Ticket>,
  run: Doc<Run>,
  boundary: { at?: string | undefined; why: string },
  fallback: string | undefined,
  out: { runsClosed: ReconciledRun[]; warnings: string[] },
): Promise<void> {
  const pushedAt = doc.data.branch ? await lastPushedAt(ctx.repo, doc.data.branch) : undefined;
  const { finishedAt, pushed } = fixRunFinishedAt({
    pushedAt,
    startedAt: run.data.started_at,
    boundaryAt: boundary.at,
    fallback,
  });
  const basis = pushed
    ? "time of the last push"
    : boundary.at !== undefined
      ? "time of the boundary, since there was no push before it"
      : fallback !== undefined
        ? "PR merge time, since there was no push"
        : "current time, since there was no push";
  const closed = await closeOpenedRunUnlessClosed(
    ctx,
    run,
    { opener: "reclaim", result: "success", finishedAt },
    "reconcile",
    out.warnings,
  );
  if (!closed) return;
  out.runsClosed.push({ id: doc.id, run: closed.run.id, opener: "reclaim", result: "success" });
  out.warnings.push(
    `${doc.id}: closed with ${boundary.why} as the boundary (${basis})`,
    ...closed.warnings,
  );
}

/**
 * 実装の Run を照合の事実で閉じる（RN-6）。終わったチケットは ticket move と同じ結果（PR のある done は PR の発見と同じ success）、戻った・取られたチケットは failure。
 * 閉じた取り込みの警告（結果と finished_at）は closeOpenedRunUnlessClosed が返す
 */
async function closeImplRun(
  ctx: CommandContext,
  doc: Doc<Ticket>,
  run: Doc<Run>,
  input: { result: RunResult; error?: string | undefined; finishedAt?: string | undefined },
  out: { runsClosed: ReconciledRun[]; warnings: string[] },
): Promise<void> {
  const closed = await closeOpenedRunUnlessClosed(
    ctx,
    run,
    { opener: "claim", ...input },
    "reconcile",
    out.warnings,
  );
  if (!closed) return;
  out.runsClosed.push({ id: doc.id, run: closed.run.id, opener: "claim", result: input.result });
  out.warnings.push(...closed.warnings);
}

/**
 * 照合に使う gh と git の事実。sync が書き込みのロックの外で集め（collectReconcileFacts）、ロックの中の照合（reconcileAll）が使う（t758）。
 * branches はチケットごとの作業ブランチの事実と、集めたときの入力（factsKey）。prCreated は PR の番号ごとの作成時刻
 * （終わったチケットに開いたままの実装の Run を閉じる finished_at）
 */
interface CollectedFacts {
  branches: Map<string, { key: string; result: BranchFacts }>;
  prCreated: Map<number, Awaited<ReturnType<typeof fetchPrCreatedAt>>>;
}

type BranchTicket = Doc<Ticket> & { data: Ticket & { branch: string } };

/** 照合の対象：作業ブランチを持つ、終わっていないチケット */
function reconcileTargets(ctx: CommandContext): BranchTicket[] {
  return [...ctx.store.tickets.values()].filter(
    (t): t is BranchTicket => t.data.branch !== undefined && !isTerminal(t.data.status),
  );
}

/** collectBranchFacts に渡す入力と、その入力を比べる鍵。ロックの中で鍵が変わっていれば、集めた事実はもう今のチケットのものでない */
function branchFactsInput(doc: BranchTicket, wf: WorkflowEntry) {
  const opts: BranchFactsOptions = {
    pr: doc.data.pr,
    needPr: needsPr(wf),
    status: doc.data.status,
    since: doc.data.branch_at ?? doc.data.created_at,
    start: doc.data.branch_base,
  };
  const key = JSON.stringify([
    doc.data.branch,
    opts.pr ?? null,
    opts.needPr,
    opts.status ?? null,
    opts.since ?? null,
    opts.start ?? null,
  ]);
  return { opts, key };
}

/**
 * 照合の事実を、書き込みのロックを持たずに集める（t758）。gh はチケットごとに直列に呼ぶので遅く、ロックを持つとほかの書き込み
 * （フックの Run の記録・claim・画面からの書き込み）がロックの待ち時間の上限で落ちる。ここでは何も書かない。
 * 照合はロックの中で最新の状態を読み直し、集めたときと入力の変わったチケットはこの事実で判定しない
 */
async function collectReconcileFacts(ctx: CommandContext): Promise<CollectedFacts> {
  const collected: CollectedFacts = { branches: new Map(), prCreated: new Map() };
  for (const doc of reconcileTargets(ctx)) {
    const wf = ctx.store.workflowFor(doc.data);
    if (!wf) continue;
    const { opts, key } = branchFactsInput(doc, wf);
    const result = await collectBranchFacts(ctx.repo, doc.data.branch, opts);
    collected.branches.set(doc.id, { key, result });
  }
  // PR のある done に開いたままの実装の Run（別のマシンの照合が done にした後の残り）を閉じる時刻
  for (const run of await peekRunningRuns(ctx.repo)) {
    const ticket = ctx.store.tickets.get(run.ticket)?.data;
    const pr = ticket?.status === "done" ? ticket.pr : undefined;
    if (pr === undefined || collected.prCreated.has(pr)) continue;
    collected.prCreated.set(pr, await fetchPrCreatedAt(ctx.repo, pr));
  }
  return collected;
}

/**
 * 照合（ST-4〜ST-6）。書き込みのロックの中で、最新の状態に対して collected の事実で判定し直して書く。
 * 状態を進めたチケットと、PR 番号を記録したチケット、閉じた実装・手直しの Run を返す
 */
async function reconcileAll(
  ctx: CommandContext,
  collected: CollectedFacts,
  warnings: string[],
): Promise<Reconciled> {
  const changed: ReconciledTicket[] = [];
  const prRecorded: Array<{ id: string; pr: number }> = [];
  const linesRecorded: ReconciledLines[] = [];
  const runsClosed: ReconciledRun[] = [];
  const reviewsRecorded: Reconciled["reviewsRecorded"] = [];
  const merged: MergedWork[] = [];
  const running = (await readRunningRuns(ctx.repo)).runs;
  for (const doc of reconcileTargets(ctx)) {
    const wf = ctx.store.workflowFor(doc.data);
    if (!wf) {
      warnings.push(`${doc.id}: cannot read the Workflow, so it is not reconciled`);
      continue;
    }
    // 事実を集めた後に claim・update・move などで入力が変わったチケットと、集めたときに対象でなかった（ロックの間に claim した・
    // Workflow を読めなかった）チケットは、その事実で判定しない（ロックの中で gh を呼ばない）。どちらか分からないので文言は中立にする
    const got = collected.branches.get(doc.id);
    if (got?.key !== branchFactsInput(doc, wf).key) {
      warnings.push(
        `${doc.id}: the facts of its work branch were not read for its current state, so it is reconciled at the next sync`,
      );
      continue;
    }
    const { pr, prCreatedAt, prMergedAt, prMergedHead, prLines, prMissing, ignoredPr } = got.result;
    const facts = { ...got.result.facts, deps_done: ctx.store.depsDone(doc.data) };
    if (pr !== undefined && prCreatedAt !== undefined && !collected.prCreated.has(pr))
      collected.prCreated.set(pr, { createdAt: prCreatedAt });
    // 作業ブランチの PR があれば実装は終わっている。実行中の実装の Run を PR の作成時刻で閉じる（RN-6）。
    // 実装は PR を作るまでなので、PR がマージされずに閉じていても success にする。
    // 記録済みの番号で引いた PR でも閉じる（番号を記録したときに閉じられなかった Run の拾い直し）
    if (pr !== undefined) {
      const implementing = await findOpenedRun(ctx, doc.data, "claim", running);
      if (implementing && prCreatedAt !== undefined && prCreatedAt < implementing.data.started_at) {
        // PR より後に開き直した Run は PR では終わらない。閉じずに知らせる（PR の後の作業はもう一度の claim で手直しの Run にする）
        warnings.push(
          `${doc.id}: implementation Run ${implementing.id} started after PR #${pr} was created (${prCreatedAt}), so reconcile does not close it. When it is finished, close it with run finish (work after the PR becomes a fix Run, by claiming again)`,
        );
      } else if (implementing) {
        const closed = await closeOpenedRunUnlessClosed(
          ctx,
          implementing,
          { opener: "claim", result: "success", finishedAt: prCreatedAt },
          "reconcile",
          warnings,
        );
        if (closed) {
          runsClosed.push({ id: doc.id, run: closed.run.id, opener: "claim", result: "success" });
          warnings.push(...closed.warnings);
        }
      }
    }
    if (ignoredPr) {
      warnings.push(
        `${doc.id}: PR #${ignoredPr.number}, found by branch name, is ${ignoredPr.state.toLowerCase()} and was created (${ignoredPr.createdAt}) before the branch was recorded. It is taken as a PR of earlier work with the same name, so reconcile does not use it. If this PR belongs to this ticket, record it with ticket update ${doc.id} --pr ${ignoredPr.number}, then run sync again to reconcile it. If it belongs to earlier work, do nothing`,
      );
    }
    const outcome = reconcileStatus(wf.resolved, doc.data.status, facts);
    // done に進むなら、消えたブランチは正常（マージ後に消した）なので警告しない
    if (!(outcome.kind === "advance" && outcome.to === "done")) {
      for (const w of regressionWarnings(doc.data.status, facts, { prMissing }))
        warnings.push(`${doc.id}: ${w}`);
    }
    // ブランチ名で見つけた PR の番号は、状態が進まなくても記録する（記録済みなら触れない）
    const patch: Record<string, unknown> = {};
    if (pr !== undefined && doc.data.pr === undefined) {
      patch["pr"] = pr;
      prRecorded.push({ id: doc.id, pr });
    }
    // マージされた PR の行数は、状態が done に進まなくても記録する（記録済みなら触れない。MT-6）。
    // 同じ gh pr view の応答から採るので、gh を呼ぶ回数は増えない
    if (prLines !== undefined && doc.data.lines === undefined) {
      patch["lines"] = prLines;
      linesRecorded.push({ id: doc.id, ...prLines });
    }
    if (outcome.kind === "advance") {
      patch["status"] = outcome.to;
      changed.push({
        id: doc.id,
        from: doc.data.status,
        to: outcome.to,
        when: [...outcome.rule.when],
      });
      // done にしたチケットの残りの worktree とブランチは、ロックを放した後に消す（設定が true のときだけ。t849）
      if (outcome.to === "done" && ctx.config.merge.delete_branch)
        merged.push({ id: doc.id, branch: doc.data.branch, mergedHead: prMergedHead });
    }
    if (Object.keys(patch).length > 0) {
      await ctx.store.update("ticket", doc.id, { ...patch, updated_at: nowIso(ctx) });
    }
    // 開いたままの手直しの Run は、次の Run の開始・PR の ready・マージの区切りで閉じる（RN-6）
    const fixing = await findOpenedRun(ctx, doc.data, "reclaim", running);
    if (fixing) {
      const after = outcome.kind === "advance" ? { ...doc.data, status: outcome.to } : doc.data;
      const boundary = fixRunBoundary(ctx, after, fixing, running, outcome.kind === "advance");
      if (boundary)
        await closeFixRun(ctx, doc, fixing, boundary, prMergedAt, { runsClosed, warnings });
    }
    // フックが記録しなかった見直し（持ち主のない保留）を、見直しの記録として書く（RN-9。dg next・dg gate と同じ判定。t700）。
    // 今回閉じた Run は開いたものとして見ない
    const recorded = await recordOrphanReviews(
      ctx,
      doc.data,
      running.filter((r) => !runsClosed.some((c) => c.run === r.id)).map((r) => r.data),
    );
    if (recorded.linked.length > 0) reviewsRecorded.push({ ticket: doc, recorded });
    if (outcome.kind === "advance") {
      // 遷移は止めず、受け入れ条件の確認が残っていることだけ知らせる（TK-5）
      const left = uncheckedAcceptance(doc);
      if (outcome.to === "done" && left.length > 0) {
        warnings.push(
          `${doc.id}: acceptance criteria items ${left.join(", ")} were left unchecked when the ticket became done`,
        );
      }
    } else if (outcome.kind === "blocked") {
      warnings.push(
        `${doc.id}: the facts point to ${outcome.to}, but the Workflow does not allow that transition in reconcile`,
      );
    }
  }
  // このマシンで開いたままの Run のうち、照合の対象にならなかったものを閉じる（RN-6）
  for (const run of running) {
    if (runsClosed.some((c) => c.run === run.data.id)) continue;
    const doc = ctx.store.tickets.get(run.data.ticket);
    if (!doc) continue;
    const out = { runsClosed, warnings };
    if (isTerminal(doc.data.status)) {
      // 終わったチケットに開いたままの手直しの Run は、次の区切り（チケットの終了を含む）で success にする
      if (run.data.step === openedStepOf(ctx, doc.data, "reclaim")) {
        const boundary = fixRunBoundary(ctx, doc.data, run, running, false);
        if (boundary) await closeFixRun(ctx, doc, run, boundary, undefined, out);
      } else if (run.data.step === openedStepOf(ctx, doc.data, "claim")) {
        // 終わったチケットの実装の Run は ticket move と同じ結果で閉じる
        const ends = runsClosedByMove(doc.data, doc.data.status);
        if (ends?.openers.includes("claim")) {
          await closeImplRun(ctx, doc, run, { result: ends.result }, out);
        } else if (doc.data.status === "done" && doc.data.pr !== undefined) {
          // PR のある done は、PR を見つけた別のマシンの照合が done にした後の残り。PR の発見と同じく success で、
          // finished_at は PR の作成時刻（実行中の Run の開始より前なら使わず、取れなければ今の時刻）
          // 作成時刻はロックの外で集めたもの。集めた後に done になったチケットで集めていなければ、次の sync で閉じる
          const created = collected.prCreated.get(doc.data.pr);
          if (!created) {
            warnings.push(
              `${doc.id}: the creation time of PR #${doc.data.pr} was not read before the ticket was reconciled, so the implementation Run is closed at the next sync`,
            );
            continue;
          }
          if (created.createdAt === undefined)
            warnings.push(
              `${doc.id}: cannot get the creation time of PR #${doc.data.pr}, so the implementation Run is closed at the current time (${created.reason})`,
            );
          const finishedAt =
            created.createdAt !== undefined && created.createdAt >= run.data.started_at
              ? created.createdAt
              : undefined;
          await closeImplRun(ctx, doc, run, { result: "success", finishedAt }, out);
        }
      }
      continue;
    }
    // 戻った（todo）か、ほかの主体の claim になったチケットの実装の Run は failure で閉じる（unclaim と同じ）。自分のユーザの claim は触らない
    if (run.data.step !== openedStepOf(ctx, doc.data, "claim")) continue;
    if (doc.data.status === "todo") {
      await closeImplRun(
        ctx,
        doc,
        run,
        { result: "failure", error: "Went back to todo during reconcile" },
        out,
      );
    } else if (doc.data.assignee !== undefined && !sameUser(doc.data.assignee, ctx.actor.id)) {
      await closeImplRun(
        ctx,
        doc,
        run,
        { result: "failure", error: "Became claimed by another actor during reconcile" },
        out,
      );
    }
  }
  return { changed, prRecorded, linesRecorded, runsClosed, reviewsRecorded, merged };
}

/** 未チェックの受け入れ条件の番号 */
function uncheckedAcceptance(doc: Doc<Ticket>): number[] {
  return (parseAcceptance(doc.body) ?? []).filter((i) => !i.checked).map((i) => i.index);
}

// 要件 SY-4（--resolve で人が選んだ側に競合を解く）
export const sync = defineCommand({
  name: "sync",
  group: "setup",
  summary:
    "Fetch deguboard from the remote, send unpushed commits, and advance ticket states from the facts of the work branches. The data is fetched from and pushed to the data branch (config's git.data_branch, deguboard by default) of the data remote (config's git.data_remote, or git.remote when it is empty); other branches of that remote, such as other repositories' kanbans, are not taken in. The work branches are fetched from git.remote. When the config names a data remote that this clone does not have, sync fails with DATA_REMOTE_MISSING and tells how to add it; when the config just fetched changed the data remote or the data branch, sync stops with DATA_REMOTE_CHANGED before pushing, and running it again uses the new one. When config's merge.delete_branch is true and a ticket becomes done, the worktree and the local and remote work branch that remain are deleted, and each data.reconciled entry gets removed: { worktree, local_branch, remote_branch } (null for what was not deleted or did not exist). Nothing is deleted when the worktree has uncommitted changes, when sync is called from that worktree, or when a branch tip is neither the head of the merged PR nor in the base branch; the reason and the commands to delete by hand are in warnings. When a work branch's PR is found, the implementation Run running on this machine is closed with success (finished_at is the PR's creation time). When the PR is merged, its added and deleted lines are recorded on the ticket as lines (data.lines_recorded; a ticket that already has lines is not rewritten; done tickets with no lines are filled by dg metrics lines). An open fix Run is closed with success at the last push before the next boundary is seen: the next Run's start on the same ticket (including the same second as the fix Run's start), the PR's ready or merge, or the ticket's end. The next Run's start is preceded by closing the earlier Run in the claim, run start, or hook that opened it; reconciliation picks up any that were missed. An implementation Run still open on a finished ticket is closed with the same result as ticket move (abandoned is failure; done with no PR is success; done with a PR is success at the PR's creation time). An implementation Run on a ticket moved back to todo, or claimed by another actor, is closed with failure. " +
    "A review result held with no Run (run review-result with no review Run, left by an environment the hook does not reach) that dg next and dg gate count as a review is written as a closed review Run marked capture: none (started and finished at the time the result was written, usage null), and the held result is linked to it (data.reviews_recorded). " +
    "A sub-agent Run left open because its record was not finished being written (one with a settling_since mark) is also closed once it has finished writing. Review Runs from a session other than the sync's are not closed; the next review start closes them. " +
    "When the import stops on a conflict, data.conflicts lists the files and data.conflict_fields lists each conflicting field as { file, field, base, local, remote }, found by running the merge driver's rule on the fork point, the local head, and the remote head (so it includes conflicts in commits after the one the rebase stopped at). For a body, field is body and each colliding block of lines is one entry. Files outside the merge driver (config.yaml and workflows) appear only in data.conflicts. " +
    "--resolve remote|local resolves a sync conflict in favor of the side a person chooses: it renumbers colliding provisional numbers, commits pending changes (even in manual mode) before importing, and takes the chosen side's value only for conflicting fields (for a body, only where the same line collided). Non-conflicting fields and commits are kept; history is not discarded and nothing is force-pushed. The values taken and discarded appear in data.resolved. Without --resolve, a sync also resolves a field itself when both sides have the same status (for a Plan, which has no status, when both sides have the time field) and differ only in closed_at, started_at, or approved_at: it takes the earlier time, reports it in a warning, and lists it in data.resolved with auto: true (a write that pulls, such as create or claim, does the same and reports it in a warning). Conflicts in files the merge driver does not handle (config.yaml and workflows) are not resolved and stay in data.conflicts",
  input: z.object({
    resolve: z
      .enum(["remote", "local"])
      .optional()
      .describe(
        "Side to take for a conflicting field. remote takes the remote's value, local takes the local commit's value. Pass only when a person chooses",
      ),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const { result: synced, merged } = await syncLocked(ctx, input.resolve);
    // 照合が done にしたチケットの、残っている worktree とブランチを消す（config の merge.delete_branch が true のとき。ST-4）。
    // リモートを待つので書き込みのロックを外してから行い、消したものを reconciled に添える。消せない理由と消し方は warnings に出す
    const cleanup: string[] = [];
    for (const work of merged) {
      const entry = synced.data.reconciled.find((r) => r.id === work.id);
      if (entry) entry.removed = await removeMergedWork(ctx, work, cleanup);
    }
    // 記録の書き終わりを待ちきれずに残したサブエージェントの Run を閉じる（RN-7）。閉じる書き込みは write のロックを取るので、外してから行う。
    // 別のセッションの見直しの Run は閉じない（前景の見直し役が今回の結果を書いているかもしれない）。
    // セッションの分からない sync（人が端末や画面から呼ぶもの）は閉じるので、人が前景の見直しの最中に呼ぶ場合は防げない
    const closing: string[] = [];
    const view: HookView = { event: "sync", done: [] };
    await closeStoppedRuns(ctx, closing, view, { reviewSession: sessionOf(ctx, undefined) });
    return ok(synced.data, synced.write, [
      ...synced.warnings,
      ...cleanup,
      ...view.done,
      ...closing,
    ]);
  },
});

/**
 * sync の本体。書き込みのロックを 2 回に分けて取る（t758）。
 *   1. ロックの中で取り込みと push（pullLocked）
 *   2. ロックを持たずに、照合の事実を gh と git で集める（collectReconcileFacts）
 *   3. ロックの中で最新の状態を読み直し、集めた事実で照合して書き、push する（reconcileLocked）
 * 2 の間はほかの書き込みが通る。3 は 1 の後に入った書き込みを読み直してから判定する。
 * 3 のロックが取れない（待ち時間の上限・2 の間に入った dg の外の変更・人が始めた rebase）ときは、照合を書かずに 1 の結果を返す。
 * 1 は取り込みと push を済ませているので、投げると --resolve で採った値と捨てた値（data.resolved）・振り直し・取り込みの警告が消える
 */
async function syncLocked(ctx: CommandContext, resolve?: ResolveSide) {
  const pulled = await withWriteLock(ctx.repo, () => pullLocked(ctx, resolve));
  const collected = pulled.conflicts.length === 0 ? await collectReconcileFacts(ctx) : undefined;
  // ロックを取った後（照合を始めた後）の失敗は、照合が作業ツリーに書いた後かもしれないので握りつぶさずに投げる。
  // 握ると、コミットされない照合の書き込みが withWriteLock の基準に入り、次の sync の照合のコミットからも外れる
  let entered = false;
  try {
    return await withWriteLock(ctx.repo, () => {
      entered = true;
      return reconcileLocked(ctx, pulled, collected);
    });
  } catch (e) {
    if (entered || !(e instanceof OperationError)) throw e;
    const reason = e.detail ? `${e.message} (${e.detail})` : e.message;
    const result = await syncResult(ctx, pulled, {
      warnings: [
        ...pulled.warnings,
        `The pull was done, but the reconcile was skipped because it could not write: ${reason}. Run sync again to reconcile`,
      ],
    });
    return { result, merged: [] as MergedWork[] };
  }
}

type Pulled = Awaited<ReturnType<typeof pullLocked>>;

/**
 * sync の取り込みと push（write のロックの中）。resolve があれば、振り直し → まとめ待ちのコミット → 選んだ側での取り込みの順に行う
 * （振り直しは未 push のコミットを積み直すので、まとめ待ちの変更を退けてから行い、番号を書き換えて戻してからコミットする）。
 * 書き換えた履歴と作業ツリーは、withWriteLock がロックを放す前に dg の外の変更の基準に記録する（dg 自身の書き換えを外の変更とみなさないため。SY-8）。
 * push が済んだ仮番号（DT-5）は confirmable で返し、照合と同じコミットで確定する
 */
async function pullLocked(ctx: CommandContext, resolve: ResolveSide | undefined) {
  const warnings: string[] = [];
  const repo = ctx.repo;
  let flushed = false;
  // 名指ししたデータのリモートがこのクローンにないときは、同期なし（SY-6）として進めずに止める
  requireDataRemote(ctx);
  // 取り込みの前にマージドライバの登録を揃える（init より前に作ったリポジトリでも効くように。SY-4）
  await ensureMergeDriver(repo, ctx.mergeDriver);
  // 登録がない・登録したコマンドが消えた（入口がドライバを渡さない・node を上げた）と、git は行単位のマージに落ちる（t759）
  const driverProblem = await mergeDriverProblem(repo);
  if (driverProblem) warnings.push(driverProblem);
  if (await ensureGitattributes(repo.dataDir))
    await commitPaths(repo, [".gitattributes"], "Add .gitattributes for the merge driver");
  // やめた Project の残り（projects/）は、印付きのコミットで一度だけ消す（git/retire-projects.ts）
  await retireProjects(repo, ctx.store);
  const fetched = await fetchAll(repo);
  if (fetched.ok && fetched.codeDetail)
    warnings.push(
      `Cannot fetch from the code remote, so the work branches are reconciled from what is already fetched: ${fetched.codeDetail}`,
    );
  const nameBefore = dataTargetOf(ctx.store.config);
  let renumbered: Renumbered[] = [];
  if (resolve && fetched.ok && fetched.remoteBranch) {
    renumbered = await renumberCollisions(repo);
    if (await isDirty(repo)) flushed = await flushPending(ctx);
  }
  const dirty = await isDirty(repo);
  if (dirty && ctx.config.commit.mode !== "manual") flushed = await flushPending(ctx);
  // まとめ待ちの変更があって上で消すのを見送ったときは、まとめ待ちをコミットした後のここで消す（同じ同期で projects/ をなくす）
  if (flushed) await retireProjects(repo, ctx.store);

  let conflicts: string[] = [];
  let integrated = renumbered.length > 0;
  let resolved: ResolvedFile[] = [];
  if (!fetched.ok) {
    warnings.push(`Cannot fetch from the remote: ${fetched.detail}`);
  } else if (fetched.remoteBranch) {
    // 取り込みを中止したときは、積み直しの途中で解いた分も捨てられたので resolved は空。自動で解いた分（auto）はここで警告に出す
    const { result: r, resolved: done } = await integrateLogged(repo, {
      autostash: dirty && !flushed,
      ...(resolve ? { resolve } : {}),
    });
    resolved = done;
    if (r.ok) integrated ||= r.changed;
    else {
      // 仮番号の衝突（オフラインで起票した番号がリモートで使われた）なら振り直して取り込み直す（DT-5）。
      // 作業ツリーに未コミットが残る manual のときは扱わない
      const fixed =
        (dirty && !flushed) || resolve ? null : await renumberProvisional(repo, r.conflicts);
      if (fixed) {
        renumbered = fixed.renumbered;
        integrated = fixed.renumbered.length > 0;
        conflicts = fixed.conflicts;
        resolved = fixed.resolved;
      } else conflicts = r.conflicts;
    }
  }
  // 競合したフィールドと両側の値。rebase を中止して HEAD がローカルの先頭に戻った後に、先頭どうしで求める（git/sync.ts）
  let fields: ConflictField[] = [];
  if (conflicts.length > 0) {
    fields = await conflictFields(repo);
    // 競合したフィールドが 1 つもない（マージドライバの対象でないファイルだけの）競合は、--resolve でも解けないので
    // どちらかを選ぶ手順ではなく手で解く手順を出す。フィールドが 1 つでもあれば、選ぶ手順で先にそれを解く（t802）
    warnings.push(
      resolve
        ? `Conflicts that --resolve cannot resolve remain (files outside the merge driver, or files that cannot be read): ${conflicts.join(", ")}. ${UNRESOLVABLE_REMEDY}`
        : fields.length === 0
          ? `Conflicts with remote changes that --resolve cannot resolve (files outside the merge driver, or files that cannot be read): ${conflicts.join(", ")}. ${UNRESOLVABLE_REMEDY}`
          : `Conflicts with remote changes: ${conflicts.join(", ")}.${describeConflictFields(fields)} ${CONFLICT_REMEDY}`,
    );
  }
  const autoResolved = describeAutoResolved(resolved, true);
  if (autoResolved) warnings.push(autoResolved);
  if (integrated) {
    await ctx.store.rescan();
    // 取り込んだ config でデータのリモートが変わった（データを別のリポジトリへ移す途中）：元のリモートへ push せずに止める
    stopIfDataRemoteChanged(ctx, nameBefore);
  }

  let pushed = false;
  const before = await syncStatus(repo);
  if (repo.dataRemote && conflicts.length === 0 && before.ahead > 0) {
    const r = await push(repo);
    if (r.ok) pushed = true;
    else warnings.push(`Cannot push: ${r.detail}`);
  }

  // push が済んだ仮番号。ロックを放した後に起票された仮番号（まだ push していない）を確定しないよう、ここで決めておく
  const confirmable =
    repo.dataRemote && (pushed || before.ahead === 0)
      ? [...ctx.store.tickets.values()].filter((t) => t.data.provisional).map((t) => t.data.id)
      : [];
  return {
    warnings,
    fetched,
    integrated,
    pushed,
    conflicts,
    conflictFields: fields,
    renumbered,
    resolved,
    confirmable,
  };
}

/**
 * sync の照合と、その結果のコミットと push（write のロックの中）。ロックを放していた間のほかの書き込みを読み直してから、
 * 集めた事実（collected。取り込みで競合したときは undefined で照合しない）で最新の状態を判定する（t758）
 */
async function reconcileLocked(
  ctx: CommandContext,
  pulled: Pulled,
  collected: CollectedFacts | undefined,
) {
  const repo = ctx.repo;
  const warnings = [...pulled.warnings];
  let pushed = pulled.pushed;
  await ctx.store.rescan();
  const pendingBefore = await dirtyFiles(repo);
  // push が済んだ仮番号は確定する（DT-5）
  const confirmed: string[] = [];
  for (const id of pulled.confirmable) {
    if (!ctx.store.tickets.get(id)?.data.provisional) continue;
    await ctx.store.update("ticket", id, { provisional: undefined });
    confirmed.push(id);
  }
  const {
    changed: reconciled,
    prRecorded,
    linesRecorded,
    runsClosed,
    reviewsRecorded,
    merged,
  }: Reconciled = collected
    ? await reconcileAll(ctx, collected, warnings)
    : {
        changed: [],
        prRecorded: [],
        linesRecorded: [],
        runsClosed: [],
        reviewsRecorded: [],
        merged: [],
      };
  const reviewsWritten = reviewsRecorded.flatMap((r) =>
    r.recorded.written.map((run) => ({ id: r.ticket.id, run: run.id })),
  );
  if (
    reconciled.length > 0 ||
    prRecorded.length > 0 ||
    linesRecorded.length > 0 ||
    runsClosed.length > 0 ||
    reviewsWritten.length > 0 ||
    confirmed.length > 0
  ) {
    const parts = [
      ...(reconciled.length > 0
        ? [
            `Reconcile ${reconciled
              .map((r) => `${r.id}: ${r.from} → ${r.to} (${r.when.join(", ")})`)
              .join(", ")}`,
          ]
        : []),
      ...(prRecorded.length > 0
        ? [`Record PR numbers: ${prRecorded.map((r) => `${r.id}: #${r.pr}`).join(", ")}`]
        : []),
      ...(linesRecorded.length > 0 ? [describeLinesRecorded(linesRecorded)] : []),
      ...describeClosedRuns(
        runsClosed.map((r) => ({
          run: { ticket: r.id, id: r.run, result: r.result },
          opener: r.opener,
        })),
      ),
      ...(reviewsWritten.length > 0
        ? [
            `Record held review results: ${reviewsWritten.map((r) => `${r.id}: ${r.run}`).join(", ")}`,
          ]
        : []),
      ...(confirmed.length > 0 ? [`Confirm provisional IDs: ${confirmed.join(", ")}`] : []),
    ];
    // 照合が書いたファイルだけをコミットする。ロックを放していた間にほかのプロセスがまとめ待ち（batch・manual）にした変更を、
    // 照合のメッセージでコミットしない（manual は人が自分でコミットする）。まとめ待ちのファイルを照合も書き換えたときは、そのファイルごと入る
    const after = await dirtyFiles(repo);
    const written = Object.keys(after).filter((p) => after[p] !== pendingBefore[p]);
    if (written.length > 0) await commitPaths(repo, written, parts.join(". "));
    for (const r of runsClosed) await dropRunning(repo, r.run);
    if (repo.dataRemote) {
      const r = await push(repo);
      if (r.ok) pushed = true;
      else warnings.push(`Cannot push the reconcile result: ${r.detail}`);
    }
  }
  // 書いた記録（前に書いて結び付け損ねた記録を含む）に保留を結び付ける。コミットの後に行い、コミットの前に止まれば保留が残る
  for (const r of reviewsRecorded) await linkOrphanRounds(ctx, r.ticket.data, r.recorded);
  const result = await syncResult(ctx, pulled, {
    warnings,
    pushed,
    reconciled,
    prRecorded,
    linesRecorded,
    runsClosed,
    reviewsWritten,
    confirmed,
  });
  return { result, merged };
}

/** 行数を記録したコミットの題の一部（照合と `dg metrics lines` が同じ形で書く） */
export function describeLinesRecorded(recorded: readonly ReconciledLines[]): string {
  return `Record changed lines: ${recorded
    .map((r) => `${r.id}: +${r.additions} -${r.deletions}`)
    .join(", ")}`;
}

/** sync の結果。照合しなかったとき（取り込みで競合した・照合のロックが取れなかった）は照合の分を空で返す */
async function syncResult(
  ctx: CommandContext,
  pulled: Pulled,
  r: {
    warnings: string[];
    pushed?: boolean;
    reconciled?: ReconciledTicket[];
    prRecorded?: Array<{ id: string; pr: number }>;
    linesRecorded?: ReconciledLines[];
    runsClosed?: ReconciledRun[];
    reviewsWritten?: Array<{ id: string; run: string }>;
    confirmed?: string[];
  },
) {
  const { fetched, integrated, conflicts, conflictFields, renumbered, resolved } = pulled;
  return ok(
    {
      fetched: fetched.ok,
      integrated,
      pushed: r.pushed ?? pulled.pushed,
      conflicts,
      conflict_fields: conflictFields,
      renumbered,
      resolved,
      reconciled: r.reconciled ?? [],
      pr_recorded: r.prRecorded ?? [],
      lines_recorded: r.linesRecorded ?? [],
      runs_closed: r.runsClosed ?? [],
      reviews_recorded: r.reviewsWritten ?? [],
      confirmed: r.confirmed ?? [],
      status: await syncStatus(ctx.repo),
    },
    undefined,
    r.warnings,
  );
}

export const commit = defineCommand({
  name: "commit",
  group: "setup",
  summary:
    "Make pending changes into one commit (when commit.mode is batch or manual). Pushes if push.mode is auto",
  input: z.object({ message: z.string().min(1).optional().describe("Commit message") }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    return withWriteLock(ctx.repo, async () => {
      const warnings: string[] = [];
      if (ctx.config.push.mode === "auto") requireDataRemote(ctx);
      // やめた Project の残り（projects/）は、まとめ待ちの変更とは別のコミットで消す（git/retire-projects.ts）。
      // 先にまとめ待ちをコミットする：消すときに書き換えるファイルにまとめ待ちの変更があると消すのを見送るので、ここで必ず消せるようにする
      const flushed = await flushPending(ctx, input.message);
      const committed = (await retireProjects(ctx.repo, ctx.store)) || flushed;
      let pushed = false;
      if (committed && ctx.repo.dataRemote && ctx.config.push.mode === "auto") {
        const r = await push(ctx.repo);
        if (r.ok) pushed = true;
        else warnings.push(`Cannot push. The next dg sync will send it again (${r.detail})`);
      }
      return ok({ committed, pushed }, undefined, warnings);
    });
  },
});

export const validate = defineCommand({
  name: "validate",
  group: "setup",
  summary: "Show unreadable files and inconsistent references. ok is false if there are errors",
  input: z.object({}),
  write: false,
  needs: "store",
  async run(ctx) {
    await ctx.store.rescan();
    const issues = [...ctx.store.issues, ...checkReferences(ctx.store)];
    return ok({ ok: issues.every((i) => i.severity !== "error"), issues });
  },
});

export const adopt = defineCommand({
  name: "adopt",
  group: "setup",
  summary:
    "Adopt changes made outside dg in the data repository (uncommitted changes, and commits with no mark). If dg validate's checks find no errors, the current state becomes the baseline for later checks (uncommitted changes are committed as pending changes by the next dg commit or dg sync). If there are errors, nothing is adopted and VALIDATION_FAILED is returned. " +
    "To discard them, a person restores them in the deguboard worktree (.git/deguboard) with git restore --staged --worktree and git reset --keep <base HEAD> (the base HEAD appears in the check's text), then runs dg adopt to make the current state the baseline (for how agents handle this, see 'Changes outside dg' in dg guide overview)",
  input: z.object({}),
  write: true,
  needs: "store",
  ownsOutsideCheck: true,
  async run(ctx) {
    return withLock(ctx.repo.localDir, "write", async () => {
      // rebase の途中は取り込まない（dg の残りは取り消してから比べ、人が始めたものは止める。t753）
      await settleRebase(ctx.repo);
      const check = await checkOutside(ctx.repo, { underLock: true });
      if (check.kind !== "found") return ok({ adopted: false, commits: [], files: [] });
      await ctx.store.rescan();
      const issues = [...ctx.store.issues, ...checkReferences(ctx.store)];
      const errors = issues.filter((i) => i.severity === "error");
      if (errors.length > 0)
        throw new OperationError(
          "VALIDATION_FAILED",
          `Changes made outside dg have check errors, so they are not taken in (${describeOutside(check.changes)}). Fix or discard them, then run dg adopt again`,
          errors.map((i) => `${i.path}: ${i.message}`).join("\n"),
        );
      await recordBaseline(ctx.repo);
      return ok({ adopted: true, commits: check.changes.commits, files: check.changes.files });
    });
  },
});

export const lint = defineCommand({
  name: "lint",
  group: "setup",
  summary:
    "Point out missing or empty recommended body sections (## Summary and ## Acceptance criteria; the Japanese headings ## 概要 and ## 受け入れ条件 are also read), values that do not fit the Workflow's fields, unfinished tickets left in a closed Epic, tickets that moved past todo or abandoned without being in an Iteration when lint.require_iteration is true (except done tickets in closed Epics), open Epics and Plans whose tickets are all finished, cycles across an open Plan's after and depends_on, and two or more active Iterations. Gaps in implementation and fix Runs (an agent got to a PR with no implementation Run, a commit after a closed implementation Run that falls within no Run's window, or a commit after a review with no fix Run) only look at unfinished tickets and done tickets in Iterations that are not closed. Unchecked acceptance criteria on done tickets are not flagged",
  input: z.object({}),
  write: false,
  needs: "store",
  async run(ctx) {
    const issues: Issue[] = [];
    const warn = (path: string, id: string, code: string, message: string) =>
      issues.push({ severity: "warning", code, path, id, message });
    for (const doc of ctx.store.tickets.values()) {
      if (!hasBodySection(doc.body, "summary"))
        warn(doc.path, doc.id, "lint_summary_missing", "The body has no ## Summary (or ## 概要)");
      const acceptance = parseAcceptance(doc.body);
      if (acceptance === undefined)
        warn(
          doc.path,
          doc.id,
          "lint_acceptance_missing",
          "The body has no ## Acceptance criteria (or ## 受け入れ条件) section",
        );
      else if (acceptance.length === 0)
        warn(doc.path, doc.id, "lint_acceptance_empty", "The acceptance criteria have no items");
      const wf = ctx.store.workflowFor(doc.data);
      for (const f of wf?.resolved.fields ?? []) {
        const v = doc.data[f.id];
        if (v === undefined) continue;
        const okType =
          f.type === "number"
            ? typeof v === "number"
            : f.type === "boolean"
              ? typeof v === "boolean"
              : f.type === "enum"
                ? typeof v === "string" && (f.options ?? []).includes(v)
                : f.type === "date"
                  ? typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
                  : typeof v === "string";
        if (!okType)
          warn(
            doc.path,
            doc.id,
            "lint_field_type",
            `The value of field ${f.id} does not match type ${f.type}`,
          );
      }
      if (ctx.store.config.lint.require_iteration && !doc.data.iteration) {
        const status = doc.data.status;
        const closedEpic =
          doc.data.epic !== undefined &&
          ctx.store.epics.get(doc.data.epic)?.data.status === "closed";
        if (status !== "todo" && status !== "abandoned" && !(status === "done" && closedEpic))
          warn(
            doc.path,
            doc.id,
            "lint_iteration_missing",
            `Moved to ${status} without being in an Iteration`,
          );
      }
    }
    for (const doc of ctx.store.epics.values()) {
      if (!hasBodySection(doc.body, "summary"))
        warn(doc.path, doc.id, "lint_summary_missing", "The body has no ## Summary (or ## 概要)");
    }
    // Epic・Plan の状態と、所属するチケットの状態の食い違い。Iteration は閉じると終わっていないチケットを外すので見ない
    const tickets = [...ctx.store.tickets.values()];
    const finished = (t: Doc<Ticket>) => isTerminal(t.data.status);
    const unfinished = (members: Doc<Ticket>[]) =>
      members
        .filter((t) => !finished(t))
        .map((t) => t.id)
        .join(", ");
    for (const doc of ctx.store.epics.values()) {
      const members = tickets.filter((t) => t.data.epic === doc.id);
      const left = unfinished(members);
      if (doc.data.status === "closed" && left)
        warn(
          doc.path,
          doc.id,
          "lint_epic_closed_unfinished",
          `Unfinished tickets ${left} remain in a closed Epic`,
        );
      if (doc.data.status === "open" && isFinishedSet(members.map((t) => t.data.status)))
        warn(
          doc.path,
          doc.id,
          "lint_epic_finished_open",
          "All tickets are finished, but the Epic is open",
        );
    }
    for (const doc of ctx.store.plans.values()) {
      if (doc.data.closed_at !== undefined || doc.data.tickets.length === 0) continue;
      if (isFinishedSet(doc.data.tickets.map((id) => ctx.store.tickets.get(id)?.data.status)))
        warn(
          doc.path,
          doc.id,
          "lint_plan_finished_open",
          "All tickets are finished, but the Plan is open",
        );
    }
    // 開いた Plan の after と depends_on をまたぐ循環（PL-3）。直接の編集や、終わったチケットを戻したことでできたものを拾う
    for (const doc of ctx.store.plans.values()) {
      if (doc.data.closed_at !== undefined) continue;
      const crossing = findCrossingCycle(ctx.store, doc.data.tickets, doc.data.after);
      if (crossing)
        warn(
          doc.path,
          doc.id,
          "lint_plan_wait_cycle",
          `after and depends_on form a cycle: ${cyclePath(crossing, true)}`,
        );
    }
    // active の Iteration はカンバンに 1 つ（IT-1）。同時の start や直接の編集・マージで 2 つになったものを拾う
    const active = sortedDocs([...ctx.store.iterations.values()]).filter(
      (doc) => doc.data.status === "active",
    );
    if (active.length >= 2) {
      const ids = active.map((d) => d.id).join(", ");
      for (const doc of active)
        warn(
          doc.path,
          doc.id,
          "lint_iteration_multiple_active",
          `There are ${active.length} active Iterations (${ids})`,
        );
    }
    // 実装の Run の抜け（RN-5・RN-6）。Run を開けなかった環境や手順の抜けで、agent の PR があるのに実装の Run がないもの、
    // 閉じた実装の Run の後のコミットが、どの Run の期間（開始から終わりまで。実行中は今まで）にも入らないもの、
    // 見直しの後のコミットに手直しの Run がないもの（t509）を拾う
    const runsByTicket = new Map<string, Run[]>();
    const seen = new Set<string>();
    for (const run of [
      ...[...ctx.store.runs.values()].map((r) => r.data),
      ...(await peekRunningRuns(ctx.repo)),
    ]) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      runsByTicket.set(run.ticket, [...(runsByTicket.get(run.ticket) ?? []), run]);
    }
    // 終わったチケットは Run を後から作り直せないので対象にしない。閉じていない Iteration の done は直せるので残す
    const inRunScope = (t: Doc<Ticket>) =>
      !isTerminal(t.data.status) ||
      (t.data.status === "done" &&
        t.data.iteration !== undefined &&
        ctx.store.iterations.get(t.data.iteration)?.data.status !== "closed");
    for (const doc of tickets.filter(inRunScope)) {
      const own = runsByTicket.get(doc.id) ?? [];
      const implStep = openedStepOf(ctx, doc.data, "claim");
      const implRuns = own.filter((r) => r.step === implStep);
      const agentClaimed = doc.data.assignee !== undefined && isAgentActorId(doc.data.assignee);
      // フックが結ばなかった見直しの記録（capture: none）があるチケットは、フックが届かない環境で進めた作業。
      // 実装や手直しの Run が残らないのは環境のせいなので、抜けとしては指摘しない（t702）
      const hookless = own.some((r) => r.step === REVIEW_STEP && r.capture === "none");
      if (doc.data.pr !== undefined && agentClaimed && implRuns.length === 0 && !hookless)
        warn(
          doc.path,
          doc.id,
          "lint_run_implement_missing",
          `Reached PR ${doc.data.pr}, but there is no implementation Run (${implStep})`,
        );
      const closedAt = implRuns.flatMap((r) =>
        r.finished_at === null ? [] : [Date.parse(r.finished_at)],
      );
      // 見直しの Run（review）が終わった時刻。その後のコミットには手直しの Run（fix）があるはず（t509）
      const reviewedAt = own.flatMap((r) =>
        r.step === REVIEW_STEP && r.finished_at !== null ? [Date.parse(r.finished_at)] : [],
      );
      if ((closedAt.length === 0 && reviewedAt.length === 0) || !doc.data.branch) continue;
      const commits = await branchCommitTimes(ctx.repo, doc.data.branch);
      if (closedAt.length > 0) {
        const outside = (commits ?? []).filter((c) => {
          const at = Date.parse(c.at);
          return (
            at > Math.max(...closedAt) &&
            !own.some(
              (r) =>
                Date.parse(r.started_at) <= at &&
                (r.finished_at === null || at <= Date.parse(r.finished_at)),
            )
          );
        });
        if (outside.length > 0)
          warn(
            doc.path,
            doc.id,
            "lint_commit_outside_run",
            `${outside.length} commit(s) after a closed implementation Run (${outside[0]?.sha.slice(0, 7)} etc.) fall in no Run's period. Do not rewrite the Run records. Check the content of the commits (git show <sha>) and tell a person (this also happens with a push or rebase by a person, or with a Run opened on another machine)`,
          );
      }
      // 見直しの後のコミットがあるのに、見直しの後に開いた手直しの Run（reclaim の step）がない。コミットが修正かは分からないので安全網として出す
      if (reviewedAt.length > 0) {
        const fixStep = openedStepOf(ctx, doc.data, "reclaim");
        const lastReview = Math.max(...reviewedAt);
        const afterReview = (commits ?? []).filter((c) => Date.parse(c.at) > lastReview);
        const fixedAfter = own.some(
          (r) => r.step === fixStep && Date.parse(r.started_at) >= lastReview,
        );
        if (afterReview.length > 0 && !fixedAfter && !hookless)
          warn(
            doc.path,
            doc.id,
            "lint_run_fix_missing",
            `${afterReview.length} commit(s) after the review (${afterReview[0]?.sha.slice(0, 7)} etc.), but no fix Run (${fixStep}) after them. Do not rewrite the Run records. Check the content of the commits (git show <sha>) and tell a person whether they are fixes (this also happens with a push by a person or a rebase after the review, or with a Run opened on another machine)`,
          );
      }
    }
    return ok({ ok: issues.length === 0, issues });
  },
});

export const configShow = defineCommand({
  name: "config.show",
  group: "setup",
  summary:
    "Show settings filled in with defaults: the values each command uses, layered as personal overrides (deguboard-local/config.yaml) > team config.yaml > defaults",
  input: z.object({
    fields: z
      .boolean()
      .optional()
      .describe(
        "Also show, with the values, each leaf item's key, type, default, summary, description, example, empty (what an empty value does), option_descriptions, and scope (scope: team is team-only, local can be overridden personally), plus the team values and personal overrides (in the form { config, team, local, fields }; used by the settings screen). fields leaves out the perspectives of the retrospective (retro.perspectives), which are nested by perspective and written with dg retro",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    // 同じ文脈で config.set した後も今の値を出すよう、ctx.config（開いたときの写し）でなく store から読む
    const config = ctx.store.config;
    if (input.fields) {
      return ok<ConfigShowView | Config>({
        config,
        team: ctx.store.teamConfig,
        local: ctx.store.localConfig,
        fields: configFields(),
      });
    }
    return ok<ConfigShowView | Config>(config);
  },
});

/** config.show --fields の出力。設定画面が値・既定値・要約と説明・例・空のときの動き・選択肢ごとの説明・範囲・空にすると既定に戻るか（clears_to_default）を一度に読む */
export interface ConfigShowView {
  /** 個人 > チーム > 既定 を重ねた、各コマンドが使う値 */
  config: Config;
  /** チームの config.yaml を既定で補った値（個人の上書きを含まない） */
  team: Config;
  /** 個人の上書き（ドット区切りの項目名 → 値）。上書きできる項目でスキーマに合うものだけ */
  local: Record<string, unknown>;
  fields: ConfigField[];
}

/** whoami の出力。操作している主体と、その人本人とみなす主体の ID */
export interface WhoamiView {
  /** 主体の ID（`eiki` か `eiki/agent`） */
  id: string;
  /** ユーザ名（`eiki`） */
  user: string;
  /** ユーザ名の出どころ（flag・env・git-config・user.name・os） */
  user_source: UserSource;
  kind: ActorKind;
  /** そのユーザ本人とみなす主体の ID（`eiki` と `eiki/agent`）。担当者が自分か自分の agent かはこれに含まれるかで決める */
  own_ids: string[];
}

export const whoami = defineCommand({
  name: "whoami",
  group: "setup",
  summary:
    "Show the acting actor (user name and where it came from, kind, and ID) and the ID of the actor treated as the person themselves",
  input: z.object({}),
  write: false,
  needs: "store",
  async run(ctx) {
    const { id, user, userSource, kind } = ctx.actor;
    return ok<WhoamiView>({ id, user, user_source: userSource, kind, own_ids: ownActorIds(user) });
  },
});

/** "true"/"false"/数字の文字列は値に直す（CLI から来る）。文字列の項目に合わなければ config.set は元の文字列で試し直す */
function coerce(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** CLI から来た配列の項目。カンマ区切りで、空文字は空の配列 */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** 項目の名前を最上位と残りに分け、--local なら個人で上書きできる項目かも確かめる */
function splitKey(
  key: string,
  local: boolean,
): { top: string; rest: string[]; field?: ConfigField } {
  const [top, ...rest] = key.split(".");
  if (!top) throw new OperationError("VALIDATION_FAILED", "key is empty");
  const field = configFields().find((f) => f.key === key);
  if (local && field?.scope !== "local") {
    throw new OperationError(
      "VALIDATION_FAILED",
      `${key} cannot be set in personal settings`,
      field
        ? "This item is team-only. Drop --local and change the team's config.yaml"
        : `Not in the schema. Items you can override: ${configFields()
            .filter((f) => f.scope === "local")
            .map((f) => f.key)
            .join(", ")}`,
    );
  }
  return { top, rest, ...(field ? { field } : {}) };
}

/**
 * 入力の値を、スキーマに合う葉の値に直す。base（チームの値か、個人を重ねた値）に当てて確かめる。
 * 空にすると既定に戻る項目（ConfigField の clears_to_default。既定が空でない文字列の項目）を空にしたら undefined（キーを消して既定か、チームの値に戻す）。
 * どの項目がそうかは項目の定義だけが決め、ここでは型や既定値を見ない（設定画面も同じ値を読む）
 */
function resolveLeaf(
  key: string,
  rawValue: unknown,
  field: ConfigField | undefined,
  rest: string[],
  base: Config,
): unknown {
  const top = key.split(".")[0]!;
  // enum の項目は空文字・null と同じく、値を省いた（undefined）呼び出しも誤りとして弾く。
  // 通すと葉が undefined になり、スキーマの既定で補われて黙って既定に戻ってしまう（戻すのは config.unset）
  if (field?.type === "enum" && rawValue === undefined)
    throw new OperationError(
      "VALIDATION_FAILED",
      `Invalid value for ${key}`,
      `A value is required. Options: ${(field.options ?? []).join(", ")}`,
    );
  const clearsToDefault =
    field?.clears_to_default === true &&
    (rawValue === "" || rawValue === undefined || rawValue === null);
  // CLI の文字列は値に直したもの・元の文字列・カンマ区切りの配列の順に試す。元の文字列も試すので、文字列の項目に "2026"・"true" を入れられる
  const candidates: unknown[] = clearsToDefault ? [undefined] : [coerce(rawValue)];
  if (!clearsToDefault && typeof rawValue === "string")
    candidates.push(rawValue, splitList(rawValue));
  let error: z.ZodError | undefined;
  for (const leaf of candidates) {
    const next = nestedConfigValue((base as Record<string, unknown>)[top], rest, leaf);
    const probe = configSchema.safeParse({ ...base, [top]: next });
    if (probe.success) return leaf;
    error ??= probe.error;
  }
  throw new OperationError(
    "VALIDATION_FAILED",
    `Invalid value for ${key}`,
    z.prettifyError(error!),
  );
}

const LOCAL_FILE_NOTE =
  "Personal settings are in <git-common-dir>/deguboard-local/config.yaml (not put into Git, and never committed or pushed). Only items that can be overridden personally (scope is local in config show --fields) are read there, and values are read in the order personal > team > default";
const LOCAL_SET_DESCRIPTION = `Write to personal settings instead of the team's config.yaml. ${LOCAL_FILE_NOTE}`;
const LOCAL_UNSET_DESCRIPTION = `Remove the personal override and return to the team's value. ${LOCAL_FILE_NOTE}`;

/**
 * チームのデータの置き場所（git.data_remote・git.data_branch）を変える書き込みは、commit.mode によらずすぐコミットして、今の置き場所へ push する。
 * まとめ待ちに残すと、次のコマンドは新しい置き場所を使うので、元の置き場所に変更が届かず、元の置き場所を使うクローンが移ったことを知れない
 */
function moveOptions(key: string): { immediate?: true } {
  return key === "git.data_remote" || key === "git.data_branch" ? { immediate: true } : {};
}

export const configSet = defineCommand({
  name: "config.set",
  positionals: ["key", "value"],
  group: "setup",
  summary:
    "Change one item of config.yaml (point to it with dots, like commit.mode). Separate array items with commas, and set an empty string to empty the list. For a non-empty string default (such as priority.*; clears_to_default is true in config show --fields), an empty string returns it to the default. For items with choices (such as commit.mode), empty, null, and omitted values are rejected. For number items (such as work.parallel), a string of digits is turned into a number, and values out of range are rejected. --local writes to personal settings. The perspectives of the retrospective (retro.perspectives) are not written here but with dg retro perspective and dg retro metric. Returns the value that was written: the team value, or the value layered with personal settings",
  input: z.object({
    key: z.string().min(1).describe("Item. Example: commit.mode"),
    value: z.unknown().describe("Value"),
    local: z.boolean().optional().describe(LOCAL_SET_DESCRIPTION),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    // 振り返りの観点は観点ごとの入れ子で、1 つの値では書けない（指標の定義は数え方と出どころが揃って 1 つ）。
    // --local の分岐より先に弾く。後に置くと --local では splitKey の「スキーマにない」の案内になり、dg retro に辿り着けない
    if (input.key === "retro" || input.key.startsWith("retro."))
      throw new OperationError(
        "VALIDATION_FAILED",
        `${input.key} cannot be set with config set`,
        "Write the perspectives of the retrospective with dg retro perspective, dg retro metric, and dg retro remove (dg config unset retro.perspectives returns to the defaults)",
      );
    if (input.local) {
      // 個人の設定は Git 管理外なので withWrite（取り込み・コミット・push）を通さず、同じマシンの書き込みの排他だけ取る
      const config = await withLock(ctx.repo.localDir, "write", async () => {
        const { rest, field } = splitKey(input.key, true);
        const leaf = resolveLeaf(input.key, input.value, field, rest, ctx.store.config);
        return ctx.store.writeLocalConfig(input.key, leaf);
      });
      return ok(config);
    }
    const result = await withWrite(
      ctx,
      async () => {
        const { top, rest, field } = splitKey(input.key, false);
        // チームの値を元にする（個人の上書きを重ねた値を元にすると、上書きがチームのファイルに写ってしまう）。
        // 戻りも書いたチームの値（writeConfig）。重ねた値を返すと、個人の上書きがある項目で保存が効かなかったように見える
        const team = ctx.store.teamConfig;
        let leaf = resolveLeaf(input.key, input.value, field, rest, team);
        if (input.key === "actor.human_only") {
          // コマンド名の存在を確かめ、エイリアス（sprint.close）は正式名に直す。registry と循環するので動的 import
          const { findCommand } = await import("./registry.js");
          const names = leaf as string[];
          const unknown = names.filter((n) => !findCommand(n));
          if (unknown.length > 0)
            throw new OperationError(
              "VALIDATION_FAILED",
              `actor.human_only has unknown commands: ${unknown.join(", ")}`,
            );
          leaf = names.map((n) => findCommand(n)!.name);
        }
        const value = nestedConfigValue((team as Record<string, unknown>)[top], rest, leaf);
        return ctx.store.writeConfig({ [top]: value });
      },
      { message: `Change config ${input.key}`, ...moveOptions(input.key) },
    );
    return ok(result.value, result.write);
  },
});

export const configUnset = defineCommand({
  name: "config.unset",
  positionals: ["key"],
  group: "setup",
  summary:
    "Remove one item from config.yaml and return it to the default (point to it with dots, like commit.mode). With --local, remove the personal override and return to the team value. Returns the value that was written: the team value, or the value layered with personal settings",
  input: z.object({
    key: z.string().min(1).describe("Item. Example: commit.mode"),
    local: z.boolean().optional().describe(LOCAL_UNSET_DESCRIPTION),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    if (input.local) {
      const config = await withLock(ctx.repo.localDir, "write", async () => {
        splitKey(input.key, true);
        return ctx.store.writeLocalConfig(input.key, undefined);
      });
      return ok(config);
    }
    const result = await withWrite(
      ctx,
      async () => {
        const { top, rest } = splitKey(input.key, false);
        const team = ctx.store.teamConfig as Record<string, unknown>;
        return ctx.store.writeConfig({ [top]: nestedConfigValue(team[top], rest, undefined) });
      },
      { message: `Reset config ${input.key} to the default`, ...moveOptions(input.key) },
    );
    return ok(result.value, result.write);
  },
});

export const setupCommands = [
  init,
  sync,
  commit,
  validate,
  adopt,
  lint,
  configShow,
  configSet,
  configUnset,
  whoami,
];
