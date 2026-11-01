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

type LocalDirOf = Pick<GitRepo, "localDir">;

/** deguboard-local/runs/ を読む。読めないファイルは issues に入れて飛ばす */
export async function readRunningRuns(
  repo: LocalDirOf,
): Promise<{ runs: Doc<Run>[]; issues: Issue[] }> {
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

export interface StartRunInput {
  ticket: TicketId;
  step: string;
  agent: string;
  model?: string | null | undefined;
  now: Date;
}

/** 実行中の Run を deguboard-local/runs/ に置く。同じチケットと step の Run が実行中なら拒否する */
export async function startRun(repo: LocalDirOf, input: StartRunInput): Promise<Run> {
  await mkdir(path.join(repo.localDir, DIRS.runs), { recursive: true });
  await mkdir(path.join(repo.localDir, "locks"), { recursive: true });
  return withLock(repo.localDir, RUN_LOCK, async () => {
    const { runs } = await readRunningRuns(repo);
    const dup = runs.find((r) => r.data.ticket === input.ticket && r.data.step === input.step);
    if (dup) {
      throw new OperationError(
        "ALREADY_EXISTS",
        `${input.ticket} の ${input.step} の Run ${dup.id} が実行中。終わっていなければ dg run finish ${dup.id} --result interrupted で閉じる`,
      );
    }
    let id = newRunId(input.now);
    while (runs.some((r) => r.id === id)) id = newRunId(input.now);
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
  model?: string | null | undefined;
  /**
   * 公式の使用量（Adapter・会話記録）から取った値。渡さなければ null のまま（RN-2）。
   * エージェントの自己申告の数字は入れない（MT-1）ので、CLI・MCP の入力には出さない
   */
  usage?: Partial<RunUsage> | undefined;
  now: Date;
}

/** 実行中の Run を閉じ、完了時の集計を runs/ に書いて commit.mode に従ってコミットする */
export async function finishRun(
  ctx: WriteContext,
  id: RunId,
  input: FinishRunInput,
): Promise<{ run: Run; write: WriteOutcome }> {
  const local = await withLock(ctx.repo.localDir, RUN_LOCK, async () => {
    const result = await readDoc(ctx.repo.localDir, runPath(id), "json", runSchema, id);
    if (result.ok) return result.doc;
    if (result.issue.code !== "read_error") {
      throw new OperationError(
        "VALIDATION_FAILED",
        `実行中の Run ${id} の記録を読めない（${result.issue.message}）`,
        result.issue.detail,
      );
    }
    if (ctx.store.runs.has(id)) throw new OperationError("REJECTED", `Run ${id} は終わっている`);
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
    model: input.model === undefined ? local.data.model : input.model,
    usage: { ...(base["usage"] as Record<string, unknown>), ...input.usage },
  };
  const written = await withWrite(
    ctx,
    async () => {
      // 別のプロセスが先に閉じていないか、ファイルで確かめる（索引は古いことがある）
      const exists = await access(path.join(ctx.repo.dataDir, runPath(id))).then(
        () => true,
        () => false,
      );
      if (exists || ctx.store.runs.has(id))
        throw new OperationError("REJECTED", `Run ${id} は終わっている`);
      const doc = await ctx.store.create("run", closed);
      return doc.data;
    },
    {
      message: (run) => `Run ${run.id} を記録: ${run.ticket} ${run.step} ${run.result ?? ""}`,
    },
  );
  await withLock(ctx.repo.localDir, RUN_LOCK, () =>
    unlink(path.join(ctx.repo.localDir, runPath(id))).catch(() => undefined),
  );
  return { run: written.value, write: written.write };
}
