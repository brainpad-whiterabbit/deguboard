// Run の記録（requirements.md 5.9・RN-3・SY-5・EX-2、ADR-005）。
//   - 実行中の Run は deguboard-local/runs/<id>.json に、runs/ と同じスキーマ（finished_at・result は null）で置く。Git には入れない
//   - finish で runs/<id>.json（完了時の集計）を書き、実行中の記録を消す
//   - 同じチケットと step の二重の start は、deguboard-local/locks/ のロックの中で実行中の記録を見て拒否する
//   - チケットの frontmatter には書き足さない。チケットの Run は Run の ticket から引く（書き足すと Run のたびにチケットが衝突する）

import { access, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { OperationError } from "../errors.js";
import { withLock } from "../git/lock.js";
import type { GitRepo } from "../git/repo.js";
import { withWrite, type WriteContext, type WriteOutcome } from "../git/write.js";
import { toIsoDateTime } from "../model/common.js";
import type { TicketId } from "../model/id.js";
import {
  emptyUsage,
  isRunId,
  newRunId,
  runSchema,
  type Run,
  type RunId,
  type RunResult,
  type RunUsage,
} from "../model/run.js";
import { createDoc, readDoc, type Doc } from "../storage/documents.js";
import type { Issue } from "../storage/issue.js";
import { DIRS, runPath } from "../storage/paths.js";

/** start と finish の確かめと書き込みを直列にするロックの名前（deguboard-local/locks/runs） */
const RUN_LOCK = "runs";

type RunDirs = Pick<GitRepo, "localDir" | "dataDir">;

/** runs/ に集計があるか。索引は古いことがあるのでファイルで確かめる（batch でまだコミットしていない集計も含む） */
async function hasSummary(repo: RunDirs, id: string): Promise<boolean> {
  return access(path.join(repo.dataDir, runPath(id))).then(
    () => true,
    () => false,
  );
}

async function removeRunning(repo: RunDirs, id: string): Promise<void> {
  await unlink(path.join(repo.localDir, runPath(id))).catch(() => undefined);
}

/** deguboard-local/runs/ を読む。読めないファイルは issues に入れて飛ばす */
async function readLocalRuns(repo: RunDirs): Promise<{ runs: Doc<Run>[]; issues: Issue[] }> {
  let files: string[] = [];
  try {
    files = (await readdir(path.join(repo.localDir, DIRS.runs))).sort();
  } catch {
    // まだ 1 つも start していない
  }
  const runs: Doc<Run>[] = [];
  const issues: Issue[] = [];
  for (const file of files) {
    const id = file.endsWith(".json") ? file.slice(0, -5) : "";
    if (!isRunId(id)) continue;
    const result = await readDoc(repo.localDir, runPath(id), "json", runSchema, id);
    if (result.ok) runs.push(result.doc);
    else issues.push(result.issue);
  }
  return { runs, issues };
}

/**
 * 終わっていない Run を読む。集計のコミットの後、実行中の記録を消す前に止まった finish の残り
 * （runs/ に同じ ID の集計があるもの）はここで消す。呼び出し側がロックを持つ
 */
async function pruneRunning(repo: RunDirs): Promise<{ runs: Doc<Run>[]; issues: Issue[] }> {
  const { runs, issues } = await readLocalRuns(repo);
  const running: Doc<Run>[] = [];
  for (const run of runs) {
    if (await hasSummary(repo, run.id)) await removeRunning(repo, run.id);
    else running.push(run);
  }
  return { runs: running, issues };
}

async function withRunLock<T>(repo: RunDirs, fn: () => Promise<T>): Promise<T> {
  await mkdir(path.join(repo.localDir, DIRS.runs), { recursive: true });
  await mkdir(path.join(repo.localDir, "locks"), { recursive: true });
  return withLock(repo.localDir, RUN_LOCK, fn);
}

/** deguboard-local/runs/ の終わっていない Run。読めないファイルは issues に入れて飛ばす */
export async function readRunningRuns(
  repo: RunDirs,
): Promise<{ runs: Doc<Run>[]; issues: Issue[] }> {
  return withRunLock(repo, () => pruneRunning(repo));
}

/**
 * チケットごとの Run の agent（RN-1）：実行中の Run があればその agent（2 つ以上なら後に始めた方）、なければ最後に始めた終わった Run の agent。
 * running は実行中の Run、finished は runs/ の集計。どちらも Run の ID（開始の時刻で始まる）の順で後のものを取る
 */
export function runAgentByTicket(
  running: Iterable<Run>,
  finished: Iterable<Run>,
): Map<TicketId, string> {
  const latest = (runs: Iterable<Run>) => {
    const byTicket = new Map<TicketId, Run>();
    for (const run of runs) {
      const prev = byTicket.get(run.ticket);
      if (!prev || prev.id.localeCompare(run.id) < 0) byTicket.set(run.ticket, run);
    }
    return byTicket;
  };
  const agents = new Map<TicketId, string>();
  for (const [ticket, run] of latest(finished)) agents.set(ticket, run.agent);
  // 実行中の Run が終わった Run より優先する
  for (const [ticket, run] of latest(running)) agents.set(ticket, run.agent);
  return agents;
}

/**
 * 終わっていない Run を、ロックを取らず何も消さずに読む（一覧の表示のため）。
 * runs/ に同じ ID の集計がある記録（finish の残り）は、consumed で除く。読めないファイルは飛ばす
 */
export async function peekRunningRuns(
  repo: RunDirs,
  consumed: (id: RunId) => boolean,
): Promise<Run[]> {
  const { runs } = await readLocalRuns(repo);
  return runs.filter((r) => !consumed(r.data.id)).map((r) => r.data);
}

export interface StartRunInput {
  ticket: TicketId;
  step: string;
  agent: string;
  model?: string | null | undefined;
  now: Date;
}

/** 実行中の Run を deguboard-local/runs/ に置く。同じチケットと step の Run が実行中なら拒否する */
export async function startRun(repo: RunDirs, input: StartRunInput): Promise<Run> {
  return withRunLock(repo, async () => {
    const { runs } = await pruneRunning(repo);
    const dup = runs.find((r) => r.data.ticket === input.ticket && r.data.step === input.step);
    if (dup) {
      throw new OperationError(
        "ALREADY_EXISTS",
        `${input.ticket} の ${input.step} の Run ${dup.id} が実行中。終わっていなければ dg run finish ${dup.id} --result interrupted で閉じる`,
      );
    }
    let id = newRunId(input.now);
    // 実行中の Run とも、終わった Run（runs/）とも重ならない ID にする
    while (runs.some((r) => r.id === id) || (await hasSummary(repo, id))) id = newRunId(input.now);
    const run: Run = {
      id,
      ticket: input.ticket,
      step: input.step,
      agent: input.agent,
      model: input.model ?? null,
      started_at: toIsoDateTime(input.now),
      finished_at: null,
      result: null,
      error: null,
      retries: 0,
      retry_reasons: [],
      usage: emptyUsage(),
    };
    const doc = await createDoc(repo.localDir, runPath(id), "json", runSchema, run);
    return doc.data;
  });
}

export interface FinishRunInput {
  result: RunResult;
  error?: string | null | undefined;
  retries?: number | undefined;
  /** 渡さなければ実行中の記録の値（古い記録はスキーマが空の配列にそろえる）。回数との突き合わせは run.finish がする */
  retryReasons?: readonly string[] | undefined;
  model?: string | null | undefined;
  /**
   * 公式の使用量（Adapter・会話記録）から取った値。渡さなければ null のまま（RN-2）。
   * エージェントの自己申告の数字は入れない（MT-1）ので、CLI・MCP の入力には出さない
   */
  usage?: { [K in keyof RunUsage]?: RunUsage[K] | undefined } | undefined;
  now: Date;
}

/** 実行中の Run を閉じ、完了時の集計を runs/ に書いて commit.mode に従ってコミットする */
export async function finishRun(
  ctx: WriteContext,
  id: RunId,
  input: FinishRunInput,
): Promise<{ run: Run; write: WriteOutcome }> {
  const local = await withRunLock(ctx.repo, async () => {
    // 前の finish が集計をコミットした後、実行中の記録を消す前に止まっていたら、記録を消してから拒否する
    if (await hasSummary(ctx.repo, id)) {
      await removeRunning(ctx.repo, id);
      throw new OperationError("REJECTED", `Run ${id} は終わっている`);
    }
    const result = await readDoc(ctx.repo.localDir, runPath(id), "json", runSchema, id);
    if (result.ok) return result.doc;
    if (result.issue.code !== "read_error") {
      throw new OperationError(
        "VALIDATION_FAILED",
        `実行中の Run ${id} の記録を読めない（${result.issue.message}）`,
        result.issue.detail,
      );
    }
    throw new OperationError("NOT_FOUND", `実行中の Run ${id} が見つからない`);
  });
  const finishedAt = toIsoDateTime(input.now);
  // 実行中の記録に重ねる。中の未知のキーは残す（DT-2）。実行中の記録はコミットできるまで書き換えない
  const base = local.yaml.toJS() as Record<string, unknown>;
  const closed: Record<string, unknown> = {
    ...base,
    finished_at: finishedAt < local.data.started_at ? local.data.started_at : finishedAt,
    result: input.result,
    error: input.error ?? null,
    retries: input.retries ?? local.data.retries,
    retry_reasons: [...(input.retryReasons ?? local.data.retry_reasons)],
    model: input.model === undefined ? local.data.model : input.model,
    // 渡されなかったキー（undefined）は重ねない
    usage: {
      ...(base["usage"] as Record<string, unknown>),
      ...Object.fromEntries(Object.entries(input.usage ?? {}).filter(([, v]) => v !== undefined)),
    },
  };
  const written = await withWrite(
    ctx,
    async () => {
      // 別のプロセスが先に閉じていないか、ファイルで確かめる（索引は古いことがある）
      if ((await hasSummary(ctx.repo, id)) || ctx.store.runs.has(id)) {
        await removeRunning(ctx.repo, id);
        throw new OperationError("REJECTED", `Run ${id} は終わっている`);
      }
      const doc = await ctx.store.create("run", closed);
      return doc.data;
    },
    {
      message: (run) => `Run ${run.id} を記録: ${run.ticket} ${run.step} ${run.result ?? ""}`,
    },
  );
  // ここで止まっても、次の start・finish・list が runs/ の集計を見て記録を消す
  await withRunLock(ctx.repo, () => removeRunning(ctx.repo, id));
  return { run: written.value, write: written.write };
}
