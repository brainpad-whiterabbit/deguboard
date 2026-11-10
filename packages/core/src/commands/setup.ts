// 用意と同期：init・sync・commit・validate・lint・config（show・set・unset）・whoami

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OperationError } from "../errors.js";
import {
  branchCommitTimes,
  collectBranchFacts,
  fetchPrCreatedAt,
  lastPushedAt,
} from "../git/facts.js";
import { withLock } from "../git/lock.js";
import { checkOutside, describeOutside, recordBaseline } from "../git/outside.js";
import { renumberCollisions, renumberProvisional, type Renumbered } from "../git/renumber.js";
import { ensureGitattributes, ensureMergeDriver, type ResolvedField } from "../git/merge.js";
import {
  commitAll,
  commitPaths,
  fetchAll,
  integrate,
  isDirty,
  push,
  syncStatus,
  type ResolveSide,
} from "../git/sync.js";
import {
  CONFLICT_REMEDY,
  flushPending,
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
import { isTerminal } from "../model/common.js";
import {
  configFields,
  configSchema,
  nestedConfigValue,
  type Config,
  type ConfigField,
} from "../model/config.js";
import type { Iteration } from "../model/iteration.js";
import type { Run, RunId, RunResult } from "../model/run.js";
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
import { defineCommand, ok, type CommandContext } from "./define.js";
import { closeStoppedRuns, type HookView } from "./hook.js";
import { nowIso, sortedDocs } from "./helpers.js";
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
/** 見直し役の Run の step（RN-1。同梱の software-development と general の steps の id） */
const REVIEW_STEP = "review";

export const init = defineCommand({
  name: "init",
  group: "setup",
  summary:
    "Set up the deguboard branch and its dedicated worktree, and put in the default Project and the template Workflow",
  input: z.object({
    template: z
      .enum(TEMPLATE_IDS)
      .optional()
      .describe("Workflow of the default Project. Defaults to general when omitted"),
    remote: z.string().optional().describe("Remote to sync with. Defaults to origin when omitted"),
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
            default_project: "default",
            git: { remote: input.remote ?? "origin", base_branch: input.base_branch ?? "main" },
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
        if (!store.projects.has("default")) {
          await store.create("project", {
            id: "default",
            name: "Default",
            description: "",
            workflow: input.template ?? "general",
            status: "active",
          });
          created.push("projects/default.yaml");
        }
        return created;
      },
      { message: "deguboard を初期化", immediate: true },
    );
    return ok(
      {
        data_dir: ctx.repo.dataDir,
        worktree: ctx.worktree ?? "existing",
        remote: ctx.repo.remote,
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
  /** 照合が閉じた実装の Run（PR の発見・終わったチケット・戻った・取られたチケット）と手直しの Run（区切り）（RN-6）。コミットの後に dropRunning で実行中の記録を消す */
  runsClosed: ReconciledRun[];
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

/** 照合（ST-4〜ST-6）。状態を進めたチケットと、PR 番号を記録したチケット、閉じた実装・手直しの Run を返す */
async function reconcileAll(ctx: CommandContext, warnings: string[]): Promise<Reconciled> {
  const changed: ReconciledTicket[] = [];
  const prRecorded: Array<{ id: string; pr: number }> = [];
  const runsClosed: ReconciledRun[] = [];
  const running = (await readRunningRuns(ctx.repo)).runs;
  const targets = [...ctx.store.tickets.values()].filter(
    (t): t is Doc<Ticket> & { data: Ticket & { branch: string } } =>
      t.data.branch !== undefined && !isTerminal(t.data.status),
  );
  for (const doc of targets) {
    const wf = ctx.store.workflowFor(doc.data);
    if (!wf) {
      warnings.push(`${doc.id}: cannot read the Workflow, so it is not reconciled`);
      continue;
    }
    const { facts, pr, prCreatedAt, prMergedAt, prMissing, ignoredPr } = await collectBranchFacts(
      ctx.repo,
      doc.data.branch,
      {
        pr: doc.data.pr,
        needPr: needsPr(wf),
        status: doc.data.status,
        since: doc.data.branch_at ?? doc.data.created_at,
      },
    );
    facts.deps_done = ctx.store.depsDone(doc.data);
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
        `${doc.id}: PR #${ignoredPr.number}, found by branch name, was merged (${ignoredPr.mergedAt}) before the branch was recorded. It is taken as a PR of earlier work with the same name, so reconcile does not use it. If this PR belongs to this ticket, record it with ticket update ${doc.id} --pr ${ignoredPr.number}, then run sync again to reconcile it. If it belongs to earlier work, do nothing`,
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
    if (outcome.kind === "advance") {
      patch["status"] = outcome.to;
      changed.push({
        id: doc.id,
        from: doc.data.status,
        to: outcome.to,
        when: [...outcome.rule.when],
      });
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
    if (outcome.kind === "advance") {
      // 遷移は止めず、受け入れ条件の確認が残っていることだけ知らせる（TK-5）
      const left = uncheckedAcceptance(doc);
      if (outcome.to === "done" && left.length > 0) {
        warnings.push(
          `${doc.id}: acceptance criteria ${left.join(", ")} were not checked, but the ticket became done`,
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
          const created = await fetchPrCreatedAt(ctx.repo, doc.data.pr);
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
  return { changed, prRecorded, runsClosed };
}

/** 未チェックの受け入れ条件の番号 */
function uncheckedAcceptance(doc: Doc<Ticket>): number[] {
  return (parseAcceptance(doc.body) ?? []).filter((i) => !i.checked).map((i) => i.index);
}

export const sync = defineCommand({
  name: "sync",
  group: "setup",
  summary:
    "Fetch deguboard from the remote, send unpushed commits, and advance ticket states from the facts of the work branches. When a work branch's PR is found, the implementation Run running on this machine is closed with success (finished_at is the PR's creation time). An open fix Run is closed with success at the last push before the next boundary is seen: the next Run's start on the same ticket (including the same second as the fix Run's start), the PR's ready or merge, or the ticket's end. The next Run's start is preceded by closing the earlier Run in the claim, run start, or hook that opened it; reconciliation picks up any that were missed. An implementation Run still open on a finished ticket is closed with the same result as ticket move (abandoned is failure; done with no PR is success; done with a PR is success at the PR's creation time). An implementation Run on a ticket moved back to todo, or claimed by another actor, is closed with failure. " +
    "A sub-agent Run left open because its record was not finished being written (one with a settling_since mark) is also closed once it has finished writing. Review Runs from a session other than the sync's are not closed; the next review start closes them. " +
    "--resolve remote|local resolves a sync conflict in favor of the side a person chooses (SY-4): it renumbers colliding provisional numbers, commits pending changes (even in manual mode) before importing, and takes the chosen side's value only for conflicting fields (for a body, only where the same line collided). Non-conflicting fields and commits are kept; history is not discarded and nothing is force-pushed. The values taken and discarded appear in data.resolved. Conflicts in files the merge driver does not handle (config.yaml and workflows) are not resolved and stay in data.conflicts",
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
    const synced = await syncLocked(ctx, input.resolve);
    // 記録の書き終わりを待ちきれずに残したサブエージェントの Run を閉じる（RN-7）。閉じる書き込みは write のロックを取るので、外してから行う。
    // 別のセッションの見直しの Run は閉じない（前景の見直し役が今回の結果を書いているかもしれない）。
    // セッションの分からない sync（人が端末や画面から呼ぶもの）は閉じるので、人が前景の見直しの最中に呼ぶ場合は防げない
    const closing: string[] = [];
    const view: HookView = { event: "sync", done: [] };
    await closeStoppedRuns(ctx, closing, view, { reviewSession: sessionOf(ctx, undefined) });
    return ok(synced.data, synced.write, [...synced.warnings, ...view.done, ...closing]);
  },
});

/**
 * sync の本体（write のロックの中）。resolve があれば、振り直し → まとめ待ちのコミット → 選んだ側での取り込みの順に行う
 * （振り直しは未 push のコミットを積み直すので、まとめ待ちの変更を退けてから行い、番号を書き換えて戻してからコミットする）。
 * 書き換えた履歴と作業ツリーは、withWriteLock がロックを放す前に dg の外の変更の基準に記録する（dg 自身の書き換えを外の変更とみなさないため。SY-8）
 */
async function syncLocked(ctx: CommandContext, resolve?: ResolveSide) {
  return withWriteLock(ctx.repo, async () => {
    const warnings: string[] = [];
    const repo = ctx.repo;
    let flushed = false;
    // 取り込みの前にマージドライバの登録を揃える（init より前に作ったリポジトリでも効くように。SY-4）
    await ensureMergeDriver(repo, ctx.mergeDriver);
    if (await ensureGitattributes(repo.dataDir))
      await commitPaths(repo, [".gitattributes"], "マージドライバの .gitattributes を置く");
    const fetched = await fetchAll(repo);
    let renumbered: Renumbered[] = [];
    if (resolve && fetched.ok && fetched.remoteBranch) {
      renumbered = await renumberCollisions(repo);
      if (await isDirty(repo)) flushed = await flushPending(ctx);
    }
    const dirty = await isDirty(repo);
    if (dirty && ctx.config.commit.mode !== "manual") flushed = await flushPending(ctx);

    let conflicts: string[] = [];
    let integrated = renumbered.length > 0;
    let resolved: Array<ResolvedField & { file: string }> = [];
    if (!fetched.ok) {
      warnings.push(`Cannot fetch from the remote: ${fetched.detail}`);
    } else if (fetched.remoteBranch) {
      const log = path.join(repo.localDir, RESOLVE_LOG);
      if (resolve) await writeFile(log, "");
      const r = await integrate(repo, {
        autostash: dirty && !flushed,
        ...(resolve ? { resolve: { side: resolve, log } } : {}),
      });
      if (resolve) {
        // 取り込みを中止したときは、積み直しの途中で解いた分も捨てられたので返さない
        if (r.ok) resolved = await readResolveLog(log);
        await rm(log, { force: true });
      }
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
        } else conflicts = r.conflicts;
      }
    }
    if (conflicts.length > 0) {
      warnings.push(
        resolve
          ? `Conflicts that --resolve cannot resolve remain (files outside the merge driver, or files that cannot be read): ${conflicts.join(", ")}. ${UNRESOLVABLE_REMEDY}`
          : `Conflicts with remote changes: ${conflicts.join(", ")}. ${CONFLICT_REMEDY}`,
      );
    }
    if (integrated) await ctx.store.rescan();

    let pushed = false;
    const before = await syncStatus(repo);
    if (repo.remote && conflicts.length === 0 && before.ahead > 0) {
      const r = await push(repo);
      if (r.ok) pushed = true;
      else warnings.push(`Cannot push: ${r.detail}`);
    }

    // push が済んだ仮番号は確定する（DT-5）
    let confirmed: string[] = [];
    if (repo.remote && (pushed || before.ahead === 0)) {
      for (const t of ctx.store.tickets.values()) {
        if (t.data.provisional) {
          await ctx.store.update("ticket", t.id, { provisional: undefined });
          confirmed.push(t.id);
        }
      }
    }
    const {
      changed: reconciled,
      prRecorded,
      runsClosed,
    }: Reconciled = conflicts.length === 0
      ? await reconcileAll(ctx, warnings)
      : { changed: [], prRecorded: [], runsClosed: [] };
    if (
      reconciled.length > 0 ||
      prRecorded.length > 0 ||
      runsClosed.length > 0 ||
      confirmed.length > 0
    ) {
      const parts = [
        ...(reconciled.length > 0
          ? [
              `照合で ${reconciled
                .map((r) => `${r.id}: ${r.from} → ${r.to}（${r.when.join(", ")}）`)
                .join(", ")}`,
            ]
          : []),
        ...(prRecorded.length > 0
          ? [`PR 番号を記録: ${prRecorded.map((r) => `${r.id}: #${r.pr}`).join(", ")}`]
          : []),
        ...describeClosedRuns(
          runsClosed.map((r) => ({
            run: { ticket: r.id, id: r.run, result: r.result },
            opener: r.opener,
          })),
        ),
        ...(confirmed.length > 0 ? [`仮番号を確定: ${confirmed.join(", ")}`] : []),
      ];
      await commitAll(repo, parts.join("。"));
      for (const r of runsClosed) await dropRunning(repo, r.run);
      if (repo.remote) {
        const r = await push(repo);
        if (r.ok) pushed = true;
        else warnings.push(`Cannot push the reconcile result: ${r.detail}`);
      }
    }
    const status = await syncStatus(repo);
    return ok(
      {
        fetched: fetched.ok,
        integrated,
        pushed,
        conflicts,
        renumbered,
        resolved,
        reconciled,
        pr_recorded: prRecorded,
        runs_closed: runsClosed,
        confirmed,
        status,
      },
      undefined,
      warnings,
    );
  });
}

/** --resolve の間だけ、マージドライバが採る側で解いたフィールドを書き足すファイル（deguboard-local/ の中） */
const RESOLVE_LOG = "resolve-log.jsonl";

/** ドライバが書き足した 1 行 1 件の JSON を読む */
async function readResolveLog(file: string): Promise<Array<ResolvedField & { file: string }>> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ResolvedField & { file: string });
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
      const committed = await flushPending(ctx, input.message);
      let pushed = false;
      if (committed && ctx.repo.remote && ctx.config.push.mode === "auto") {
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
      const check = await checkOutside(ctx.repo, { underLock: true });
      if (check.kind === "clean") return ok({ adopted: false, commits: [], files: [] });
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
    "Point out missing or empty recommended body sections (## Summary and ## Acceptance criteria; the Japanese headings ## 概要 and ## 受け入れ条件 are also read), values that do not fit the Workflow's fields, unfinished tickets left in a closed Epic, tickets that moved past todo or abandoned without being in an Iteration when lint.require_iteration is true (except done tickets in closed Epics), open Epics and Plans whose tickets are all finished, cycles across an open Plan's after and depends_on, and two or more active Iterations in the same Project. Gaps in implementation and fix Runs (an agent got to a PR with no implementation Run, a commit after a closed implementation Run that falls within no Run's window, or a commit after a review with no fix Run) only look at unfinished tickets and done tickets in Iterations that are not closed. Unchecked acceptance criteria on done tickets are not flagged",
  input: z.object({
    project: z.string().optional().describe("Filter by Project. Omit for all"),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const issues: Issue[] = [];
    const warn = (path: string, id: string, code: string, message: string) =>
      issues.push({ severity: "warning", code, path, id, message });
    for (const doc of ctx.store.tickets.values()) {
      if (input.project && doc.data.project !== input.project) continue;
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
      if (input.project && doc.data.project !== input.project) continue;
      if (!hasBodySection(doc.body, "summary"))
        warn(doc.path, doc.id, "lint_summary_missing", "The body has no ## Summary (or ## 概要)");
    }
    // Epic・Plan の状態と、所属するチケットの状態の食い違い。Iteration は閉じると終わっていないチケットを外すので見ない
    const tickets = [...ctx.store.tickets.values()].filter(
      (t) => !input.project || t.data.project === input.project,
    );
    const finished = (t: Doc<Ticket>) => isTerminal(t.data.status);
    const unfinished = (members: Doc<Ticket>[]) =>
      members
        .filter((t) => !finished(t))
        .map((t) => t.id)
        .join(", ");
    for (const doc of ctx.store.epics.values()) {
      if (input.project && doc.data.project !== input.project) continue;
      const members = tickets.filter((t) => t.data.epic === doc.id);
      const left = unfinished(members);
      if (doc.data.status === "closed" && left)
        warn(
          doc.path,
          doc.id,
          "lint_epic_closed_unfinished",
          `Unfinished tickets ${left} remain in a closed Epic`,
        );
      if (doc.data.status === "open" && members.some((t) => t.data.status === "done") && !left)
        warn(
          doc.path,
          doc.id,
          "lint_epic_finished_open",
          "All tickets are finished, but the Epic is open",
        );
    }
    for (const doc of ctx.store.plans.values()) {
      if (input.project && doc.data.project !== input.project) continue;
      if (doc.data.closed_at !== undefined || doc.data.tickets.length === 0) continue;
      const members = doc.data.tickets.map((id) => ctx.store.tickets.get(id));
      if (members.every((t) => t !== undefined && finished(t)))
        warn(
          doc.path,
          doc.id,
          "lint_plan_finished_open",
          "All tickets are finished, but the Plan is open",
        );
    }
    // 開いた Plan の after と depends_on をまたぐ循環（PL-3）。Plan を作った後の depends_on の変更でできたものを拾う
    for (const doc of ctx.store.plans.values()) {
      if (input.project && doc.data.project !== input.project) continue;
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
    // active の Iteration は Project に 1 つ（IT-1）。同時の start や直接の編集・マージで 2 つになったものを拾う
    const activeByProject = new Map<string, Doc<Iteration>[]>();
    for (const doc of sortedDocs([...ctx.store.iterations.values()])) {
      if (input.project && doc.data.project !== input.project) continue;
      if (doc.data.status !== "active") continue;
      activeByProject.set(doc.data.project, [
        ...(activeByProject.get(doc.data.project) ?? []),
        doc,
      ]);
    }
    for (const docs of activeByProject.values()) {
      if (docs.length < 2) continue;
      const ids = docs.map((d) => d.id).join(", ");
      for (const doc of docs)
        warn(
          doc.path,
          doc.id,
          "lint_iteration_multiple_active",
          `The same Project has ${docs.length} active Iterations (${ids})`,
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
      if (doc.data.pr !== undefined && agentClaimed && implRuns.length === 0)
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
        if (afterReview.length > 0 && !fixedAfter)
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
        "Also show, with the values, every item's key, type, default, description, and scope (scope: team is team-only, local can be overridden personally), plus the team values and personal overrides (in the form { config, team, local, fields }; used by the settings screen)",
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

/** config.show --fields の出力。設定画面が値・既定値・説明・範囲・空にすると既定に戻るか（clears_to_default）を一度に読む */
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

export const configSet = defineCommand({
  name: "config.set",
  positionals: ["key", "value"],
  group: "setup",
  summary:
    "Change one item of config.yaml (point to it with dots, like commit.mode). Separate array items with commas, and set an empty string to empty the list. For a non-empty string default (such as priority.*; clears_to_default is true in config show --fields), an empty string returns it to the default. For items with choices (such as commit.mode), empty, null, and omitted values are rejected. --local writes to personal settings. Returns the value that was written: the team value, or the value layered with personal settings",
  input: z.object({
    key: z.string().min(1).describe("Item. Example: commit.mode"),
    value: z.unknown().describe("Value"),
    local: z.boolean().optional().describe(LOCAL_SET_DESCRIPTION),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
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
      { message: `config の ${input.key} を変更` },
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
      { message: `config の ${input.key} を既定に戻す` },
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
