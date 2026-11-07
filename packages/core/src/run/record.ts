// Run の記録（requirements.md 5.9・RN-3・RN-6・SY-5・EX-2、ADR-005）。
//   - 実行中の Run は deguboard-local/runs/<id>.json に、runs/ と同じスキーマ（finished_at・result は null）で置く。Git には入れない
//   - finish で runs/<id>.json（完了時の集計）を書き、実行中の記録を消す。チケットの操作に付随して閉じるとき（RN-6）は
//     closeRun をその操作の書き込みの中で呼び、同じコミットに入れる
//   - 同じチケットと step の二重の start は、deguboard-local/locks/ のロックの中で実行中の記録を見て拒否する
//   - チケットの frontmatter には書き足さない。チケットの Run は Run の ticket から引く（書き足すと Run のたびにチケットが衝突する）
//   - 会話記録のパスは Run に書かず、deguboard-local/transcripts/<id>.json に置く（ADR-005）。ホームのパスとユーザ名を含み、
//     別のマシンでは読めないので Git に入れない。閉じた後の run refresh も同じファイルから数えるので、Run を閉じても消さない

import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
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
  type RunTools,
  type RunUsage,
} from "../model/run.js";
import { createDoc, readDoc, type Doc } from "../storage/documents.js";
import { writeFileAtomic } from "../storage/atomic.js";
import { pathExists } from "../storage/exists.js";
import type { Issue } from "../storage/issue.js";
import { DIRS, runPath, TRANSCRIPTS_DIR, transcriptPath } from "../storage/paths.js";
import type { Store } from "../storage/store.js";

/** start と finish の確かめと書き込みを直列にするロックの名前（deguboard-local/locks/runs） */
const RUN_LOCK = "runs";

type RunDirs = Pick<GitRepo, "localDir" | "dataDir">;

/** runs/ に集計があるか。索引は古いことがあるのでファイルで確かめる（batch でまだコミットしていない集計も含む） */
async function hasSummary(repo: RunDirs, id: string): Promise<boolean> {
  return pathExists(path.join(repo.dataDir, runPath(id)));
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
 * running は実行中の Run、finished は runs/ の集計。どちらも Run の ID（開始の時刻で始まる）の順で後のものを取る。
 * 同じ秒に始めた Run の順は ID の末尾の乱数で決まるので、どちらを取るかは決まらない
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
 * runs/ に同じ ID の集計がある記録（finish の残り）は、readRunningRuns と同じくファイルで確かめて除く。読めないファイルは飛ばす
 */
export async function peekRunningRuns(repo: RunDirs): Promise<Run[]> {
  const { runs } = await readLocalRuns(repo);
  const consumed = await Promise.all(runs.map((r) => hasSummary(repo, r.id)));
  return runs.filter((_, n) => !consumed[n]).map((r) => r.data);
}

export interface StartRunInput {
  ticket: TicketId;
  step: string;
  agent: string;
  model?: string | null | undefined;
  /** やり直しの理由（もう一度の claim が開く手直しの Run。RN-5）。回数は理由の数にする */
  retryReasons?: readonly string[] | undefined;
  /** 会話記録のセッション ID。Run に書く */
  session?: string | undefined;
  /** 会話記録のファイルのパス。Run に書かず deguboard-local/transcripts/ に置く */
  transcript?: string | undefined;
  now: Date;
}

/**
 * このマシンに置いた、Run ごとの会話記録のパス（ID → パス）。読めないファイルは飛ばす
 * （Adapter は場所がないものとして、セッション ID か今の推測で数える）
 */
export async function readTranscriptPaths(
  repo: Pick<GitRepo, "localDir">,
): Promise<Map<string, string>> {
  const dir = path.join(repo.localDir, TRANSCRIPTS_DIR);
  const files = await readdir(dir).catch(() => [] as string[]);
  const paths = new Map<string, string>();
  for (const file of files) {
    const id = file.endsWith(".json") ? file.slice(0, -5) : "";
    if (!isRunId(id)) continue;
    try {
      const value: unknown = JSON.parse(await readFile(path.join(dir, file), "utf8"));
      const p = (value as { path?: unknown } | null)?.path;
      if (typeof p === "string" && p) paths.set(id, p);
    } catch {
      // 書きかけか壊れたファイル
    }
  }
  return paths;
}

/** Run の会話記録のパスを置き換える（フックがサブエージェントの記録を結び付けるとき。ADR-012）。パスは絶対パスにする */
export async function bindTranscript(
  repo: Pick<GitRepo, "localDir">,
  id: RunId,
  transcript: string,
): Promise<void> {
  await writeFileAtomic(
    path.join(repo.localDir, transcriptPath(id)),
    `${JSON.stringify({ path: path.resolve(transcript) })}\n`,
  );
}

/**
 * 実行中の Run のチケットと step を直す（フックが開いた Run を、サブエージェントの記録の印で照らして直すとき。ADR-012）。
 * 実行中の記録がなければ NOT_FOUND
 */
export async function amendRunning(
  repo: RunDirs,
  id: RunId,
  patch: { ticket: TicketId; step: string },
): Promise<Run> {
  return withRunLock(repo, async () => {
    const result = await readDoc(repo.localDir, runPath(id), "json", runSchema, id);
    if (!result.ok) throw new OperationError("NOT_FOUND", `実行中の Run ${id} が見つからない`);
    const next = { ...(result.doc.yaml.toJS() as Record<string, unknown>), ...patch };
    await writeFileAtomic(
      path.join(repo.localDir, runPath(id)),
      `${JSON.stringify(next, null, 2)}\n`,
    );
    return runSchema.parse(next);
  });
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
      retries: input.retryReasons?.length ?? 0,
      retry_reasons: [...(input.retryReasons ?? [])],
      usage: emptyUsage(),
      tools: null,
      session: input.session ?? null,
    };
    // 場所を先に置く。実行中の記録より後に置くと、その間に閉じた Run が場所なしで数えられうる。
    // 相対パスは呼んだ作業ディレクトリで絶対パスにする（finish・refresh・serve は別の場所から呼ばれうる）
    const located = input.transcript ? path.join(repo.localDir, transcriptPath(id)) : undefined;
    if (located) {
      await mkdir(path.dirname(located), { recursive: true });
      await writeFileAtomic(
        located,
        `${JSON.stringify({ path: path.resolve(input.transcript!) })}\n`,
      );
    }
    try {
      const doc = await createDoc(repo.localDir, runPath(id), "json", runSchema, run);
      return doc.data;
    } catch (e) {
      // 開けなかった Run の場所を残すと、後の同じ ID の Run が引き継ぎうる
      if (located) await unlink(located).catch(() => undefined);
      throw e;
    }
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
  /** 会話記録から数えたツールの回数。渡さなければ実行中の記録の値（start は null を書く） */
  tools?: RunTools | null | undefined;
  /**
   * 終了時刻（ISO）。渡さなければ now。チケットの操作に付随して閉じるとき、PR の作成時刻など実際に終わった時刻にする（RN-6）。
   * 開始より前なら開始の時刻に揃える
   */
  finishedAt?: string | undefined;
  now: Date;
}

/** 実行中の記録を読む。前の finish が集計を書いた後、実行中の記録を消す前に止まっていたら、記録を消してから拒否する */
async function readRunning(repo: RunDirs, id: RunId): Promise<Doc<Run>> {
  return withRunLock(repo, async () => {
    if (await hasSummary(repo, id)) {
      await removeRunning(repo, id);
      throw new OperationError("REJECTED", `Run ${id} は終わっている`);
    }
    const result = await readDoc(repo.localDir, runPath(id), "json", runSchema, id);
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
}

/**
 * 実行中の Run を閉じ、完了時の集計を runs/ に書く。呼び出し側の書き込み（withWrite の変更か sync の照合）の中で呼び、
 * コミットの後に dropRunning で実行中の記録を消す。finishRun と、チケットの操作と照合に付随して閉じる closeOpenedRun が使う
 */
export async function closeRun(
  store: Pick<Store, "runs" | "create">,
  repo: RunDirs,
  id: RunId,
  input: FinishRunInput,
): Promise<Run> {
  const local = await readRunning(repo, id);
  const finishedAt = input.finishedAt ?? toIsoDateTime(input.now);
  // 実行中の記録に重ねる。中の未知のキーは残す（DT-2）。実行中の記録は集計を書くまで書き換えない
  const base = local.yaml.toJS() as Record<string, unknown>;
  const closed: Record<string, unknown> = {
    ...base,
    finished_at: finishedAt < local.data.started_at ? local.data.started_at : finishedAt,
    result: input.result,
    error: input.error ?? null,
    retries: input.retries ?? local.data.retries,
    retry_reasons: [...(input.retryReasons ?? local.data.retry_reasons)],
    model: input.model === undefined ? local.data.model : input.model,
    // 項目より前の記録にもキーを省かずに書く（RN-1）
    session: local.data.session,
    // 渡されなかったキー（undefined）は重ねない
    usage: {
      ...(base["usage"] as Record<string, unknown>),
      ...Object.fromEntries(Object.entries(input.usage ?? {}).filter(([, v]) => v !== undefined)),
    },
    tools: input.tools === undefined ? local.data.tools : input.tools,
  };
  // 別のプロセスが先に閉じていないか、ファイルで確かめる（索引は古いことがある）
  if ((await hasSummary(repo, id)) || store.runs.has(id)) {
    await removeRunning(repo, id);
    throw new OperationError("REJECTED", `Run ${id} は終わっている`);
  }
  return (await store.create("run", closed)).data;
}

/** 集計を書いた Run の実行中の記録を消す。ここで止まっても、次の start・finish・list が runs/ の集計を見て記録を消す */
export async function dropRunning(repo: RunDirs, id: RunId): Promise<void> {
  await withRunLock(repo, () => removeRunning(repo, id));
}

/** 実行中の Run を閉じ、完了時の集計を runs/ に書いて commit.mode に従ってコミットする */
export async function finishRun(
  ctx: WriteContext,
  id: RunId,
  input: FinishRunInput,
): Promise<{ run: Run; write: WriteOutcome }> {
  const written = await withWrite(ctx, () => closeRun(ctx.store, ctx.repo, id, input), {
    message: (run) => `Run ${run.id} を記録: ${run.ticket} ${run.step} ${run.result ?? ""}`,
  });
  await dropRunning(ctx.repo, id);
  return { run: written.value, write: written.write };
}
