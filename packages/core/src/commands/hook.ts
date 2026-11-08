// harness のフックの出来事を Run の操作に写す（AG-1・AG-9・RN-5・RN-6、ADR-012・ADR-014）。入力の形は Adapter の hooks.parse が製品ごとに読み、
// ここは製品によらない出来事（HookEvent）だけを見る（AG-5）。フックはエージェントの作業を止めないよう、失敗は警告にして成功で返す。
//   - session_start：以後の Bash の環境に DEGUBOARD_ACTOR=agent・DEGUBOARD_SESSION・DEGUBOARD_TRANSCRIPT を export で書く
//     （届くのは親の Bash だけ。サブエージェントの claim・run start のセッションは Adapter の sessionFromEnv が補う。ADR-016）
//   - subagent_launched：頼んだ文の先頭の印（deguboard: ticket=<id> step=<step>）があれば、その Run を開いて記録の場所をサブエージェントの記録にする。
//     見直しは、別のセッションで開いたままの同じチケットの見直しの Run を先に interrupted で閉じる（ADR-015）。
//     手直しは、開いたままの前の手直しの Run をもう一度の claim と同じ規則で区切りとして閉じる（ADR-018）
//   - subagent_started：同じ記録の開いた Run（親への質問で止まっていたもの）を続きとして使い、止まって待っている印と書き終わり待ちの印を消す
//   - subagent_stopped：記録の場所で Run を引き、記録の最初の文の印で照らしてから、step を終えた事実があれば記録の書き終わりを待って
//     記録の全体から数えて閉じる。事実がなければ閉じずに止まって待っている印を付ける。
//     前景のサブエージェントが Run のないうちに保留にした見直しの結果とやり直しの理由は、閉じる前の Run に結び付ける。
//     印のある Run がなければ、サブエージェントが自分で開いた Run（記録に ID が出る。run start で開いたものなど）に記録の場所を結び付け、
//     事実がなければ止まって待っている印を付ける（移行期の経路）
//   - session_end：このセッションのサブエージェントの Run のうち開いたままのものをすべて閉じる。親が自分で開いた Run は残す
//   どのイベントでも、扱うイベントなら読む項目の有無と時刻を deguboard-local/hook-inputs/ に残す（t542。dg hooks check が読む）
//   どのフックの後も、前のフックで書き終わりを待ちきれずに残した Run を閉じる（dg sync も同じ）

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { collectRunUsage, hookAgentNames, hooksOf, type HookEvent } from "../agents/index.js";
import { OperationError } from "../errors.js";
import { collectBranchFacts, lastPushedAt } from "../git/facts.js";
import { toIsoDateTime } from "../model/common.js";
import { ticketIdSchema, type TicketId } from "../model/id.js";
import { REVIEW_STEP, type Run, type RunId, type RunResult } from "../model/run.js";
import type { Ticket } from "../model/ticket.js";
import {
  amendRunning,
  appendRetryReasons,
  bindTranscript,
  finishRun,
  moveReviewToPending,
  readRunningRuns,
  readTranscriptPaths,
  takePendingReview,
  takePendingRetryReasons,
} from "../run/record.js";
import { defineCommand, ok, runCommand, type CommandContext } from "./define.js";
import {
  closePreviousFixRun,
  openedInOtherSession,
  openedStepOf,
  openRun,
  REVIEW_UNRECORDED,
  runRefresh,
  STALE_SESSION_ERROR,
  transcriptUnderRoot,
  usageContext,
} from "./run.js";

/** 頼んだ文の先頭の印。最初の空でない行が `deguboard: ticket=<id> step=<step>` のとき */
export function parseMarker(prompt: string): { ticket: TicketId; step: string } | undefined {
  const first = prompt.split(/\r?\n/).find((l) => l.trim() !== "");
  const m = /^\s*deguboard:\s*ticket=(\S+)\s+step=(\S+)\s*$/.exec(first ?? "");
  if (!m) return undefined;
  const ticket = ticketIdSchema.safeParse(m[1]);
  return ticket.success ? { ticket: ticket.data, step: m[2]! } : undefined;
}

/**
 * dg hook が受け取った入力の記録（deguboard-local/hook-inputs/<イベント>.json。イベントごとに最新の 1 件を上書きする。t542）。
 * 項目の有無と時刻だけを持ち、値は残さない（MT-4）。dg hooks check が読み、受け取らなかった項目があれば警告する
 */
export interface HookInputRecord {
  event: string;
  /** 受け取った時刻 */
  received_at: string;
  /** Adapter が読むとした項目（ドット区切りのパス）ごとに、入力にあったか */
  fields: Record<string, boolean>;
}

const HOOK_INPUTS_DIR = "hook-inputs";

/** ドット区切りのパスの値がある（null と未定義でない） */
function hasField(input: Record<string, unknown>, dotted: string): boolean {
  let cur: unknown = input;
  for (const key of dotted.split(".")) {
    if (typeof cur !== "object" || cur === null) return false;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur !== undefined && cur !== null;
}

/** 受け取った入力の項目の有無を記録する。一時ファイルに書いてから置き換え、読む側が途中の内容を見ないようにする */
async function recordHookInput(
  localDir: string,
  event: string,
  receivedAt: string,
  fields: readonly string[],
  payload: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(localDir, HOOK_INPUTS_DIR);
  await mkdir(dir, { recursive: true });
  const record: HookInputRecord = {
    event,
    received_at: receivedAt,
    fields: Object.fromEntries(fields.map((f) => [f, hasField(payload, f)])),
  };
  const file = path.join(dir, `${event}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record)}\n`, "utf8");
  await rename(tmp, file);
}

/** イベントの直近の入力の記録。なければ、読めなければ undefined */
export async function readHookInput(
  localDir: string,
  event: string,
): Promise<HookInputRecord | undefined> {
  const text = await readFile(path.join(localDir, HOOK_INPUTS_DIR, `${event}.json`), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  try {
    const d = JSON.parse(text) as Partial<HookInputRecord>;
    if (typeof d.received_at !== "string" || typeof d.fields !== "object" || d.fields === null)
      return undefined;
    return { event, received_at: d.received_at, fields: d.fields };
  } catch {
    return undefined;
  }
}

/** シェルの単一引用符で囲む */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export interface HookView {
  event: string;
  /** 行ったこと（1 件 1 行） */
  done: string[];
  /** フックが標準出力に書く文（ツールの使用を拒むときの製品の形。Adapter の denyOutput が作る） */
  output?: string;
}

export const hook = defineCommand({
  name: "hook",
  positionals: ["event"],
  group: "hook",
  summary:
    "harness のフックが呼ぶ（dg hooks install が設定に書く。人が打つものではない）。--payload - で標準入力のフックの入力（JSON）を読み、" +
    "セッションの始まりに主体とセッション ID・記録のパスを環境に入れ、頼んだ文の先頭に `deguboard: ticket=<id> step=<step>` の印のあるサブエージェントの Run を起動で開き" +
    "（同じチケットと step の Run が開いたままなら開かずに警告する。見直しは、その Run が別のセッションのものなら落ちたセッションの残りとみなして interrupted で閉じてから開く。前景の起動で起動より後にその Run に書かれた見直しの結果は、保留に移して新しい Run に結び付ける）、step を終えた事実があれば止まったときに閉じ" +
    "（なければ止まって待っている印を付け、再開で続ける。自分で開いた Run も同じ）、セッションの終わりにそのセッションのサブエージェントの開いたままの Run を閉じる。" +
    "ツールを使う前（PreToolUse）には、.git/deguboard/ の下への書き込み（書くツールと Bash）を拒み（Bash の判定は字句の手がかりで、任意の言語のコードや eval の中は見ない）、" +
    "dg を経由しない gh pr ready・gh pr merge（gh api の同じ操作も）を拒んで dg pr ready・dg pr merge へ案内する" +
    "（PR の指定は読まない。字句を読まずに、dg pr ready・dg pr merge と gh pr ready --undo を除いた残りに gh・pr・merge か ready の語があれば止める。" +
    "引用符・ヒアドキュメント・コメントの中も伏せず、本文の語はファイルに書いて --body-file・git commit -F で渡すよう案内する）。" +
    "扱うイベントは、読む入力の項目の有無と時刻を deguboard-local/hook-inputs/ にイベントごとの最新の 1 件で残す（値は残さない。dg hooks check が読む）。ほかの失敗は作業を止めないよう、警告にして成功で返す",
  input: z.object({
    event: z
      .string()
      .min(1)
      .describe("フックのイベント名（製品のイベント名。dg hooks install が書く）"),
    agent: z
      .string()
      .min(1)
      .optional()
      .describe(
        `フックを持つエージェント名（${hookAgentNames().join("・")}）。フックを持つ Adapter が 1 つなら省ける`,
      ),
    payload: z
      .record(z.string(), z.unknown())
      .meta({ cliFile: "payload" })
      .optional()
      .describe("フックの入力（JSON）。CLI では --payload - で標準入力から読む"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const view: HookView = { event: input.event, done: [] };
    const warnings: string[] = [];
    const names = hookAgentNames();
    const agent = input.agent ?? (names.length === 1 ? names[0]! : "");
    const hooks = hooksOf(agent);
    if (!hooks) return ok(view, undefined, [`agent ${agent} にはフックがない`]);
    // フックの入力の項目の有無を、イベントごとの最新の 1 件に残す（dg hooks check が読む）。扱うイベントの名前だけを使う
    if (hooks.events.some((e) => e.event === input.event)) {
      try {
        const payload = input.payload ?? {};
        await recordHookInput(
          ctx.repo.localDir,
          input.event,
          toIsoDateTime(ctx.now()),
          hooks.inputFields(input.event, payload),
          payload,
        );
      } catch (e) {
        warnings.push(
          `フックの入力の記録を書けなかった（${e instanceof Error ? e.message : String(e)}）`,
        );
      }
    }
    const env = ctx.env ?? process.env;
    const event = hooks.parse(input.event, input.payload ?? {}, env);
    if (!event) return ok(view, undefined, warnings);
    try {
      await handle(ctx, agent, event, view, warnings);
    } catch (e) {
      // フックの失敗で作業を止めない
      warnings.push(
        `${input.event} のフックを最後まで行えなかった（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
    return ok(view, undefined, warnings);
  },
});

async function handle(
  ctx: CommandContext,
  agent: string,
  event: HookEvent,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const calledAt = toIsoDateTime(ctx.now());
  switch (event.kind) {
    case "session_start":
      return sessionStart(event, view, warnings);
    case "subagent_launched":
      await subagentLaunched(ctx, agent, event, view, warnings);
      break;
    case "subagent_started":
      await subagentStarted(ctx, agent, event, view);
      break;
    case "subagent_stopped":
      await subagentStopped(ctx, agent, event, view, warnings);
      break;
    case "session_end":
      return sessionEnd(ctx, event, view, warnings);
    case "tool_requested":
      // ツールのたびに呼ばれるので、止まった Run の掃除はしない
      toolRequested(ctx, agent, event, view);
      return;
  }
  // 記録の書き終わりを待ちきれずに残した Run を、次のフックの機会に閉じる（ADR-014）
  await closeStoppedRuns(ctx, warnings, view, { session: event.session, markedBefore: calledAt });
}

async function sessionStart(
  event: Extract<HookEvent, { kind: "session_start" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  if (!event.envFile) {
    warnings.push(
      "環境を書くファイルが渡されなかったので、主体とセッション ID を環境に入れていない",
    );
    return;
  }
  // export を付けないとシェルの変数になるだけで、dg に届かない
  const lines = [
    "export DEGUBOARD_ACTOR=agent",
    `export DEGUBOARD_SESSION=${quote(event.session)}`,
    ...(event.transcript ? [`export DEGUBOARD_TRANSCRIPT=${quote(event.transcript)}`] : []),
  ];
  await appendFile(event.envFile, `${lines.join("\n")}\n`);
  view.done.push("主体（agent）とセッション ID・記録のパスを以後の Bash の環境に入れた");
}

async function subagentLaunched(
  ctx: CommandContext,
  agent: string,
  event: Extract<HookEvent, { kind: "subagent_launched" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const marker = parseMarker(event.prompt);
  // 印のないサブエージェント（調べものなど）は Run にしない
  if (!marker) return;
  const ticket = ctx.store.tickets.get(marker.ticket);
  if (!ticket) {
    warnings.push(`印のチケット ${marker.ticket} が見つからないので Run を開いていない`);
    return;
  }
  if (event.transcript && !(await underRoot(ctx, agent, event.transcript, warnings))) return;
  // 前景の起動で、先に来た終わりの出来事がサブエージェント自身の開いた Run をこの記録に結び付けていたら、もう 1 本は開かない
  if (
    event.transcript &&
    [...(await readTranscriptPaths(ctx.repo)).values()].includes(event.transcript)
  ) {
    view.done.push(
      `${marker.ticket} の ${marker.step} は、この記録に結び付いた Run があるので開かない`,
    );
    return;
  }
  const now = ctx.now();
  // 前景の起動は終わってから返るので、かかった時間だけ開始を前にする。かかった時間が渡されなければ、サブエージェントの記録の
  // 最初の行（頼んだ文）の時刻を起動の時刻にする（今の時刻にすると、見直し役が古い Run に書いた結果を起動より前のものと見誤る。ADR-017）
  const startedAt = !event.finished
    ? undefined
    : event.durationMs !== null
      ? new Date(now.getTime() - event.durationMs)
      : event.transcript
        ? await firstLineTime(event.transcript)
        : undefined;
  // 別のセッションで開いたままの見直しの Run は、そのセッションが落ちた残り。閉じてから開く（ADR-015）。
  // 同じセッションの見直しを重ねて開くのは二重の起動なので、閉じずに下の openRun が拒否する
  if (marker.step === REVIEW_STEP)
    await closeStaleReviewRuns(ctx, marker.ticket, event.session, startedAt ?? now, view, warnings);
  // 手直しの起動は、開いたままの前の手直しの Run の区切り。もう一度の claim と同じ規則で閉じてから開く（開いている手直しの Run はいつも 1 本。ADR-018）。
  // 区切りは起動の時刻（前景では、それより後の push は今回の手直しのもの）
  if (marker.step === openedStepOf(ctx, ticket.data, "reclaim")) {
    try {
      await closePreviousFixRun(
        ctx,
        ticket.data,
        { session: event.session, boundaryAt: toIsoDateTime(startedAt ?? now) },
        warnings,
      );
    } catch (e) {
      warnings.push(
        `${marker.ticket} の前の手直しの Run を閉じられなかった（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }
  let run: Run;
  try {
    const opened = await openRun(ctx, ticket.data, {
      step: marker.step,
      agent,
      model: event.model ?? undefined,
      session: event.session,
      transcript: event.transcript ?? undefined,
      startedAt,
    });
    run = opened.run;
    warnings.push(...opened.warnings);
    view.done.push(`${run.ticket} の ${run.step} の Run ${run.id} を開いた`);
  } catch (e) {
    if (!(e instanceof OperationError)) throw e;
    warnings.push(`${marker.ticket} の ${marker.step} の Run を開いていない: ${e.message}`);
    return;
  }
  // 前景の起動はもう終わっている（終わりの出来事は先に来て、閉じる Run がなかった）ので、ここで閉じる
  if (event.finished && event.transcript)
    await stopSubagentRun(ctx, agent, run, event.transcript, view, warnings);
}

/**
 * 見直しの起動の前に、このマシンで開いたままの同じチケットの見直しの Run のうち別のセッションのものを interrupted で閉じる（ADR-015）。
 * 使用量はその Run の記録の場所から数える。前景の起動では見直し役が終わってからここに来るので、その間の run review-result は
 * 古い Run に書かれている。起動（launchedAt）より後に書かれた結果は古い Run から外して保留に移し、新しい Run を閉じるときに結び付ける。
 * 閉じられなければ警告して続ける（下の openRun が拒否して警告する）
 */
async function closeStaleReviewRuns(
  ctx: CommandContext,
  ticket: TicketId,
  session: string,
  launchedAt: Date,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const paths = await readTranscriptPaths(ctx.repo);
  for (const { data: stale } of (await readRunningRuns(ctx.repo)).runs) {
    if (stale.ticket !== ticket || stale.step !== REVIEW_STEP) continue;
    if (!openedInOtherSession(stale, session)) continue;
    try {
      let run = stale;
      if (await moveReviewToPending(ctx.repo, run.id, launchedAt)) {
        run = { ...run, review: null };
        view.done.push(
          `${ticket} の見直しの結果は今回の見直し役が書いたものなので、Run ${run.id} から外して保留に移した`,
        );
      }
      await closeSubagentRun(
        ctx,
        run,
        paths.get(run.id),
        { result: "interrupted", error: STALE_SESSION_ERROR },
        view,
        warnings,
      );
    } catch (e) {
      warnings.push(
        `別のセッション（${stale.session}）で開いたままの Run ${stale.id} を閉じられなかった（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }
}

/** パスが agent の会話記録の置き場所の下か。外なら警告して false（HTTP・MCP から hook を呼んでも任意のファイルを読ませない） */
async function underRoot(
  ctx: CommandContext,
  agent: string,
  transcript: string,
  warnings: string[],
): Promise<boolean> {
  if (await transcriptUnderRoot(agent, transcript, ctx.env ?? process.env)) return true;
  warnings.push(`記録のパスが ${agent} の会話記録の置き場所の下にないので使わない`);
  return false;
}

/** 記録の最初の行の時刻（サブエージェントの記録では、頼んだ文を受け取った時刻）。読めなければ undefined */
async function firstLineTime(transcript: string): Promise<Date | undefined> {
  const text = await readFile(transcript, "utf8").catch(() => "");
  const firstLine = text.slice(0, text.indexOf("\n") >>> 0);
  const at = Date.parse(/"timestamp":"([^"]+)"/.exec(firstLine)?.[1] ?? "");
  return Number.isNaN(at) ? undefined : new Date(at);
}

/**
 * サブエージェントが自分で開いた Run（記録に ID が出る、実行中か閉じた Run）。同じセッションで、記録の最初の行より後に始まった
 * ものだけにする（一覧を読んだ・頼んだ文が前の Run の ID を含むだけの Run を結び付け直さない）
 */
async function mentionedRuns(
  ctx: CommandContext,
  transcript: string,
  agent: string,
  session: string,
): Promise<RunId[]> {
  const since = (await firstLineTime(transcript))?.getTime();
  if (since === undefined) return [];
  // run start・ticket claim の結果に出た、自分で開いた Run だけ（警告・一覧・詳細に出るほかの Run の ID は取らない）
  const ids = new Set(await hooksOf(agent)!.selfOpenedRunIds(transcript));
  // すでにほかのサブエージェントの記録に結び付いた Run（起動のフックが開いた兄弟の Run）は外す
  const paths = await readTranscriptPaths(ctx.repo);
  const boundElsewhere = (id: string) => {
    const p = paths.get(id);
    return p !== undefined && p !== transcript && path.basename(path.dirname(p)) === "subagents";
  };
  const running = (await readRunningRuns(ctx.repo)).runs.map((r) => r.data);
  const known = (id: string) =>
    running.find((r) => r.id === id) ?? ctx.store.runs.get(id as RunId)?.data;
  return [...ids].filter((id) => {
    const run = known(id);
    // 開始は秒までなので、その秒の初めまで許す
    return (
      run?.agent === agent &&
      run.session === session &&
      Date.parse(run.started_at) >= since - 999 &&
      !boundElsewhere(id)
    );
  }) as RunId[];
}

async function subagentStopped(
  ctx: CommandContext,
  agent: string,
  event: Extract<HookEvent, { kind: "subagent_stopped" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const transcript = event.transcript;
  if (!transcript) {
    warnings.push(`サブエージェント ${event.agentId} の記録のパスが渡されなかった`);
    return;
  }
  if (!(await underRoot(ctx, agent, transcript, warnings))) return;
  const paths = await readTranscriptPaths(ctx.repo);
  const running = (await readRunningRuns(ctx.repo)).runs;
  // 起動のフックが開いた Run は、記録の場所がこのサブエージェントの記録のもの
  const opened = running.find(
    (r) =>
      r.data.agent === agent && paths.get(r.id) === transcript && r.data.session === event.session,
  );
  if (!opened) {
    await bindSelfOpened(ctx, agent, transcript, event.session, view, warnings);
    return;
  }
  await stopSubagentRun(ctx, agent, opened.data, transcript, view, warnings);
}

/** 記録の書き終わりを待つ間隔と上限（ミリ秒）。テストが短くする */
export const hookTiming: {
  settleMs: number;
  pollMs: number;
  /** 待ちきれなかった直後に呼ぶ（テストが、その後の掃除の前に記録を書き足すため） */
  onGiveUp?: (() => Promise<void>) | undefined;
} = { settleMs: 3000, pollMs: 100 };

/** 記録のパスがサブエージェントの記録（<session>/subagents/ の下）か。agent_id 付きの Run の見分けに使う */
const isSubagentTranscript = (p: string | undefined) =>
  p !== undefined && path.basename(path.dirname(p)) === "subagents";

/**
 * サブエージェントが止まったときの Run の扱い（ADR-014）。記録の最初の文の印で照らしてチケットと step を直し、記録の場所を
 * サブエージェントの記録にする。step を終えた事実（resultOf が success）があり、記録が書き終わっていれば閉じる。
 * 事実がなければ（親への質問で止まったなど）閉じずに止まって待っている印（waiting_since）を付ける。記録が書き終わらなければ
 * 書き終わり待ちの印（settling_since）を付けて残し、次のフック・sync・SessionEnd が閉じる（closeStoppedRuns）。settle が false なら書き終わりを待たない
 */
async function stopSubagentRun(
  ctx: CommandContext,
  agent: string,
  opened: Run,
  transcript: string,
  view: HookView,
  warnings: string[],
  settle = true,
): Promise<void> {
  const prompt = await hooksOf(agent)!.firstPrompt(transcript);
  const marker = prompt ? parseMarker(prompt) : undefined;
  let run = opened;
  // 印は起動のフックが開いた Run を照らす。サブエージェントが自分で開いた Run（手直しを続きで頼んだあとの claim など）は、
  // 記録の最初の文の印（実装の step）で直さない。直すと手直しが実装に書き換わる
  const selfOpened = (await hooksOf(agent)!.selfOpenedRunIds(transcript)).includes(run.id);
  if (marker && !selfOpened && (marker.ticket !== run.ticket || marker.step !== run.step)) {
    // 並べて起動して取り違えた。記録の最初の文が正しい
    run = await amendRunning(ctx.repo, run.id, marker);
    warnings.push(
      `Run ${run.id} のチケットと step を記録の印に合わせて ${marker.ticket} の ${marker.step} に直した`,
    );
  }
  await bindTranscript(ctx.repo, run.id, transcript);
  const ticket = ctx.store.tickets.get(run.ticket)?.data;
  run = await bindPending(ctx, run, ticket, view);
  const decided = await resultOf(ctx, run, ticket);
  if (decided.result !== "success") {
    // 書き終わり待ちで呼び直したときに事実が取れなかった（gh・fetch の一時的な失敗など）なら、書き終わり待ちをやめて答え待ちにする。
    // 両方の印を残すと、掃除がフックのたびに事実を取り直し続ける
    if (run.settling_since !== null)
      run = await amendRunning(ctx.repo, run.id, { settling_since: null });
    await markWaiting(ctx, run, view);
    return;
  }
  if (settle && !(await waitSettled(agent, transcript))) {
    await hookTiming.onGiveUp?.();
    if (run.settling_since === null)
      await amendRunning(ctx.repo, run.id, { settling_since: toIsoDateTime(ctx.now()) });
    warnings.push(
      `Run ${run.id} の記録の最後の応答が ${hookTiming.settleMs} ミリ秒のうちに書かれなかったので、まだ閉じない（次のフック・dg sync・セッションの終わりで閉じる）`,
    );
    return;
  }
  await closeSubagentRun(ctx, run, transcript, decided, view, warnings);
}

/**
 * 前景のサブエージェントが Run のないうちに保留にしたものを、閉じる前の Run に結び付ける。見直しは結果（ADR-014）、
 * 手直しはやり直しの理由（ADR-018）。どちらもその Run の開始より後に置いたものだけ
 */
async function bindPending(
  ctx: CommandContext,
  run: Run,
  ticket: Ticket | undefined,
  view: HookView,
): Promise<Run> {
  if (run.step === REVIEW_STEP && run.review === null) {
    const review = await takePendingReview(ctx.repo, run.ticket, run.started_at);
    if (!review) return run;
    view.done.push(`${run.ticket} の保留の見直しの結果を Run ${run.id} に結び付けた`);
    return amendRunning(ctx.repo, run.id, { review });
  }
  if (ticket && run.step === openedStepOf(ctx, ticket, "reclaim")) {
    const reasons = await takePendingRetryReasons(ctx.repo, run.ticket, run.started_at);
    if (reasons.length === 0) return run;
    view.done.push(`${run.ticket} の保留のやり直しの理由を Run ${run.id} に結び付けた`);
    return appendRetryReasons(ctx.repo, run.id, reasons);
  }
  return run;
}

/** 止まって待っている印を付ける（付いていれば今のまま） */
async function markWaiting(ctx: CommandContext, run: Run, view: HookView): Promise<void> {
  if (run.waiting_since !== null) return;
  await amendRunning(ctx.repo, run.id, { waiting_since: toIsoDateTime(ctx.now()) });
  view.done.push(`${run.ticket} の ${run.step} の Run ${run.id} は止まって待っている（閉じない）`);
}

/** 記録の最後の api-request の後に使用量付きの応答が出るまで待つ。上限を過ぎたら false */
async function waitSettled(agent: string, transcript: string): Promise<boolean> {
  const hooks = hooksOf(agent)!;
  const until = Date.now() + hookTiming.settleMs;
  for (;;) {
    if (await hooks.transcriptSettled(transcript)) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, hookTiming.pollMs));
  }
}

/** サブエージェントの Run を、記録の全体から数えて閉じる。見直しの成否はロックの中で読み直した記録で決める */
async function closeSubagentRun(
  ctx: CommandContext,
  run: Run,
  transcript: string | undefined,
  decided: { result: RunResult; error?: string },
  view: HookView,
  warnings: string[],
): Promise<void> {
  const { others } = await usageContext(ctx, (await readRunningRuns(ctx.repo)).runs);
  const now = ctx.now();
  const collected = await collectRunUsage(ctx.config, {
    run,
    finishedAt: toIsoDateTime(now),
    env: ctx.env ?? process.env,
    topLevel: ctx.repo.topLevel,
    others,
    transcript,
  });
  const closed = await finishRun(ctx, run.id, {
    result: decided.result,
    error: decided.error,
    // 見直しの成否は、閉じる直前にロックの中で読み直した記録の結果で決める（数えている間に書かれた結果を落とさない）
    decide:
      run.step === REVIEW_STEP && decided.result !== "interrupted" ? reviewResultOf : undefined,
    model: collected.model ?? undefined,
    usage: collected.usage,
    tools: collected.tools,
    now,
  });
  warnings.push(...collected.warnings.map((w) => `Run ${run.id}: ${w}`), ...closed.write.warnings);
  view.done.push(`${run.ticket} の ${run.step} の Run ${run.id} を ${closed.run.result} で閉じた`);
}

/**
 * 書き終わり待ちの印（settling_since）の付いたサブエージェントの Run のうち、記録が書き終わったものを閉じる（ADR-014）。
 * フックのたびと dg sync が呼ぶ。止まって待っている印（質問への答え待ち）の Run は、再開で続くので閉じない。
 * session を渡せばそのセッションの Run だけ、markedBefore を渡せばその時刻より前に印を付けたものだけ（今のフックで残した Run を、
 * 同じフックの中で閉じない）。reviewSession を渡せば、見直しの Run のうちそのセッションと別のセッションのものを閉じない（dg sync。
 * 落ちたセッションの見直しの Run には、前景で動いている今回の見直し役が結果を書いているかもしれない。次の見直しの起動が振り分けて閉じる。ADR-017）
 */
export async function closeStoppedRuns(
  ctx: CommandContext,
  warnings: string[],
  view: HookView = { event: "", done: [] },
  only: {
    session?: string | undefined;
    markedBefore?: string | undefined;
    reviewSession?: string | undefined;
  } = {},
): Promise<void> {
  const { session, markedBefore, reviewSession } = only;
  const paths = await readTranscriptPaths(ctx.repo);
  for (const { data: run } of (await readRunningRuns(ctx.repo)).runs) {
    const transcript = paths.get(run.id);
    if (run.settling_since === null || !isSubagentTranscript(transcript) || !hooksOf(run.agent))
      continue;
    if (session !== undefined && run.session !== session) continue;
    if (markedBefore !== undefined && run.settling_since >= markedBefore) continue;
    if (run.step === REVIEW_STEP && openedInOtherSession(run, reviewSession)) continue;
    // まだ書き終わっていない記録は、待たずに次の機会に回す
    if (!(await hooksOf(run.agent)!.transcriptSettled(transcript!))) continue;
    try {
      await stopSubagentRun(ctx, run.agent, run, transcript!, view, warnings, false);
    } catch (e) {
      warnings.push(
        `書き終わりを待っていた Run ${run.id} を閉じられなかった（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }
}

/** サブエージェントがもう一度始まった（親の SendMessage で続きを頼まれた）。同じ記録の開いた Run を続きとして使い、印を消す */
async function subagentStarted(
  ctx: CommandContext,
  agent: string,
  event: Extract<HookEvent, { kind: "subagent_started" }>,
  view: HookView,
): Promise<void> {
  if (!event.transcript) return;
  const paths = await readTranscriptPaths(ctx.repo);
  const run = (await readRunningRuns(ctx.repo)).runs.find(
    (r) =>
      r.data.agent === agent &&
      paths.get(r.id) === event.transcript &&
      r.data.session === event.session,
  )?.data;
  // 初めての起動（Run は起動の呼び出しが返ってから開く）と、印のない Run は何もしない
  if (!run || (run.waiting_since === null && run.settling_since === null)) return;
  await amendRunning(ctx.repo, run.id, { waiting_since: null });
  // 続きの作業があるので、書き終わり待ちもやめる（次の Stop がもう一度決める）
  if (run.settling_since !== null) await amendRunning(ctx.repo, run.id, { settling_since: null });
  view.done.push(`${run.ticket} の ${run.step} の Run ${run.id} を続きとして使う（印を消した）`);
}

/**
 * 移行期の経路：サブエージェントが自分で開いた Run（run start や、印なしで頼んだ手直しの claim）に記録の場所を結び付け、閉じていれば
 * 取り直す。開いたままで、step を終えた事実がなければ（手直しで push がないなど）止まって待っている印を付ける。印のない返った Run をここで見分ける。
 * 手直しも印で開く（ADR-018）ので、ほかの手順がサブエージェントに Run を開かせなくなれば要らない
 */
async function bindSelfOpened(
  ctx: CommandContext,
  agent: string,
  transcript: string,
  session: string,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const ids = await mentionedRuns(ctx, transcript, agent, session);
  const running = (await readRunningRuns(ctx.repo)).runs.map((r) => r.data);
  const closed: RunId[] = [];
  for (const id of ids) {
    await bindTranscript(ctx.repo, id, transcript);
    view.done.push(`Run ${id} の記録の場所をサブエージェントの記録にした`);
    if (ctx.store.runs.has(id)) {
      closed.push(id);
      continue;
    }
    // 開いたままで返った Run にも、印のある Run と同じく、step を終えた事実がなければ止まって待っている印を付ける（ADR-014）。
    // 事実があれば印は付けず、閉じない（手直しは sync の区切り、ほかはセッションの終わりが閉じる）
    const run = running.find((r) => r.id === id);
    if (!run) continue;
    const decided = await resultOf(ctx, run, ctx.store.tickets.get(run.ticket)?.data);
    if (decided.result !== "success") await markWaiting(ctx, run, view);
  }
  if (closed.length === 0) return;
  const refreshed = await runCommand(runRefresh, ctx, { runs: closed });
  warnings.push(...refreshed.warnings);
  view.done.push(`閉じた Run ${closed.join("・")} の使用量を取り直した`);
}

/**
 * フックが閉じる Run の結果（ADR-012）。step ごとの事実で決める。見直しは結果（run review-result）が記録されていれば success（ADR-013）。
 * 実装は PR があれば success。手直しは開始より後の push があれば success。ほかの step は success
 */
async function resultOf(
  ctx: CommandContext,
  run: Run,
  ticket: Ticket | undefined,
): Promise<{ result: RunResult; error?: string }> {
  if (!ticket) return { result: "success" };
  const claimStep = openedStepOf(ctx, ticket, "claim");
  const fixStep = openedStepOf(ctx, ticket, "reclaim");
  if (run.step === claimStep) {
    if (ticket.pr !== undefined) return { result: "success" };
    if (!ticket.branch)
      return { result: "failure", error: "サブエージェントが終わったとき PR がない" };
    const facts = await collectBranchFacts(ctx.repo, ticket.branch, {
      needPr: true,
      status: ticket.status,
      since: ticket.branch_at,
    }).catch(() => undefined);
    return facts?.pr !== undefined
      ? { result: "success" }
      : { result: "failure", error: "サブエージェントが終わったとき PR がない" };
  }
  if (run.step === fixStep) {
    const pushed = ticket.branch
      ? await lastPushedAt(ctx.repo, ticket.branch, { fetch: true }).catch(() => undefined)
      : undefined;
    return pushed !== undefined && pushed >= run.started_at
      ? { result: "success" }
      : { result: "failure", error: "サブエージェントが終わったとき手直しの push がない" };
  }
  if (run.step === REVIEW_STEP) return reviewResultOf(run);
  return { result: "success" };
}

/** 見直しの Run の結果。結果（run review-result）が記録されていれば success（ADR-013） */
function reviewResultOf(run: Run): { result: RunResult; error?: string } {
  return run.review !== null
    ? { result: "success" }
    : { result: "failure", error: REVIEW_UNRECORDED };
}

/**
 * セッションの終わり（ADR-014）。このセッションのサブエージェントの Run（記録の場所がサブエージェントの記録のもの）のうち開いたままのものを閉じる。
 * step を終えた事実があれば成功で閉じ、なければ見直し・手直しなどは interrupted、実装は PR がないので failure。親が自分で進める Run は残す
 */
async function sessionEnd(
  ctx: CommandContext,
  event: Extract<HookEvent, { kind: "session_end" }>,
  view: HookView,
  warnings: string[],
): Promise<void> {
  const paths = await readTranscriptPaths(ctx.repo);
  for (const { data: run } of (await readRunningRuns(ctx.repo)).runs) {
    const transcript = paths.get(run.id);
    if (run.session !== event.session || !isSubagentTranscript(transcript) || !hooksOf(run.agent))
      continue;
    try {
      const ticket = ctx.store.tickets.get(run.ticket)?.data;
      const current = await bindPending(ctx, run, ticket, view);
      const decided = await resultOf(ctx, current, ticket);
      const claimStep = ticket ? openedStepOf(ctx, ticket, "claim") : undefined;
      const closing =
        decided.result === "success" || run.step === claimStep
          ? decided
          : { result: "interrupted" as const, error: "セッションが終わったとき開いたままだった" };
      await closeSubagentRun(ctx, current, transcript!, closing, view, warnings);
    } catch (e) {
      warnings.push(
        `Run ${run.id} をセッションの終わりに閉じられなかった（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }
}

/** 括弧の始まりと終わりの印（splitCommands が単純なコマンドの並びに入れる。cd の行き先を括弧の中に閉じる） */
export const SUBSHELL_OPEN = "(";
export const SUBSHELL_CLOSE = ")";

/**
 * シェルのコマンドを単純なコマンドの並び（; && || | & と改行で区切る）と、その字句に分ける。引用符（' と "）の中の空白と区切りは割らない。
 * 括弧は [SUBSHELL_OPEN]・[SUBSHELL_CLOSE] の 1 字句のコマンドとして並びに入れる。リダイレクト（> >> >| &> >& <& < 2> など）と
 * ヒアドキュメント（<< <<- <<<）は 1 つの字句にし、ヒアドキュメントの本文と、語の頭の # からのコメントは読み飛ばす。置き換え（$(...)・`...`）や入れ子は解かない。
 * フックの判定の手がかりにだけ使う
 */
export function splitCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  /** 次の改行の後に読み飛ばすヒアドキュメントの終わりの語 */
  const heredocs: string[] = [];
  let heredocNext = false;
  const endWord = () => {
    if (started) {
      words.push(word);
      if (heredocNext) heredocs.push(word);
      heredocNext = false;
    }
    word = "";
    started = false;
    quotedWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  /** 演算子の直前に接した fd の数字（2> の 2）を、今の語から取り出す */
  let quotedWord = false;
  const takeFd = () => {
    if (!started || quotedWord || !/^[0-9]+$/.test(word)) return "";
    const fd = word;
    word = "";
    started = false;
    return fd;
  };
  /** $( の置き換えの深さ。中は解かず、閉じ括弧まで 1 つの語として読む */
  let substitution = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (substitution > 0) {
      word += c;
      if (c === "(") substitution++;
      else if (c === ")") substitution--;
      continue;
    }
    if (c === "(" && word.endsWith("$") && started && !quote) {
      word += c;
      substitution = 1;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "#" && !started) {
      // 語の頭の # から行の終わりまではコメント（中の引用符を引用と読まない。改行は次で読む）
      const eol = command.indexOf("\n", i);
      i = (eol === -1 ? command.length : eol) - 1;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
      quotedWord = true;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      started = true;
    } else if (c === "<" && next === "<" && word.includes("$((")) {
      // 算術の中の << はヒアドキュメントでない
      word += "<<";
      i++;
    } else if (c === "<" && next === "<") {
      const fd = takeFd();
      endWord();
      let op = `${fd}<<`;
      i++;
      if (command[i + 1] === "<") op += command[++i];
      else if (command[i + 1] === "-") op += command[++i];
      words.push(op);
      // <<< は本文を取らない（次の語がそのまま入力）
      if (op !== "<<<") heredocNext = true;
    } else if (c === ">" || c === "<" || (c === "&" && next === ">")) {
      // リダイレクトは 1 つの字句にする（前に接した fd の数字と、>& <& の後の fd の数字も同じ字句に入れる）
      const fd = takeFd();
      endWord();
      let op = fd + c;
      if (c === "&") op += command[++i];
      if (command[i + 1] === ">" || command[i + 1] === "|") op += command[++i];
      if (command[i + 1] === "&") {
        op += command[++i];
        while (/[0-9-]/.test(command[i + 1] ?? "")) op += command[++i];
      }
      words.push(op);
    } else if (c === "\n") {
      endCommand();
      // ヒアドキュメントの本文を、終わりの語だけの行まで読み飛ばす
      while (heredocs.length > 0) {
        const end = heredocs.shift()!;
        for (;;) {
          const eol = command.indexOf("\n", i + 1);
          const line = command.slice(i + 1, eol === -1 ? command.length : eol);
          i = eol === -1 ? command.length : eol;
          if (line.replace(/^\t+/, "") === end || eol === -1) break;
        }
      }
    } else if (c === "(" || c === ")") {
      endCommand();
      commands.push([c === "(" ? SUBSHELL_OPEN : SUBSHELL_CLOSE]);
    } else if (c === ";" || c === "|" || c === "&") {
      endCommand();
    } else if (c === " " || c === "\t") {
      endWord();
    } else {
      word += c;
      started = true;
    }
  }
  endCommand();
  return commands;
}

/** 書き込み先を取るリダイレクトの字句 */
const isWriteRedirect = (w: string) => /^[0-9]*(&>>?|>>?\|?)$/.test(w);
/** リダイレクトかヒアドキュメントの字句（引数から外す） */
const isRedirect = (w: string) => /^[0-9]*(<<<|<<-?|[<>]&?[0-9-]*|>>|>\||&>>?)$/.test(w);

/** シェルの予約語（コマンドの前に来て、その後の字句が本当のコマンド） */
const RESERVED = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "!",
  "{",
  "}",
]);
/** コマンドを包むだけのコマンドと、その値を取るフラグ（値をコマンド名と取り違えない） */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
  ["command", new Set<string>()],
  ["builtin", new Set<string>()],
  ["exec", new Set(["-a"])],
  ["time", new Set(["-f", "--format", "-o", "--output"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["nohup", new Set<string>()],
  [
    "sudo",
    new Set([
      "-u",
      "--user",
      "-g",
      "--group",
      "-h",
      "--host",
      "-C",
      "-D",
      "--chdir",
      "-p",
      "--prompt",
      "-r",
      "-t",
      "-U",
    ]),
  ],
  ["doas", new Set(["-u", "-C"])],
  [
    "xargs",
    new Set([
      "-n",
      "--max-args",
      "-I",
      "-i",
      "-P",
      "--max-procs",
      "-L",
      "-s",
      "-d",
      "-E",
      "-a",
      "--arg-file",
    ]),
  ],
  ["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
]);

/**
 * 単純なコマンドの本当のコマンド名と引数。予約語（if・then・do・{・! など）、前の環境変数の代入（NAME=value）、
 * 包むコマンド（env・sudo・time など）とそのフラグ（値を取るものは値も）を読み飛ばす。timeout の時間も 1 つ読み飛ばす
 */
export function commandOf(words: readonly string[]): { name: string; args: string[] } {
  let k = 0;
  // function f { ... } の形は、名前の後が本体
  if (words[0] === "function") k = 2;
  for (;;) {
    while (
      k < words.length &&
      (RESERVED.has(words[k]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!))
    )
      k++;
    const w = words[k];
    const flags = w === undefined ? undefined : WRAPPERS.get(w);
    if (!flags) break;
    k++;
    while (k < words.length && words[k]!.startsWith("-")) {
      if (flags.has(words[k]!)) k++;
      k++;
    }
    if (w === "timeout" && k < words.length) k++;
  }
  return { name: words[k] ?? "", args: withoutRedirects(words.slice(k + 1)) };
}

/** 次の字句を行き先（か、ヒアドキュメントの終わりの語）に取るリダイレクト。>&1 のように fd を含むものは取らない */
const takesTarget = (w: string) => /^[0-9]*(<<<|<<-?|>>|>\||&>>?|[<>])$/.test(w);

/** 引数からリダイレクトとその行き先を外す（2>&1 や > /tmp/out を PR の指定や写す先と取り違えない） */
function withoutRedirects(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (!isRedirect(a)) out.push(a);
    else if (takesTarget(a)) k++;
  }
  return out;
}

/**
 * .git/deguboard/ の下を指す字句か（相対・絶対）。このリポジトリのデータに限らず、どのリポジトリの .git/deguboard/ も指すとみなす
 * （手がかりで見分けるので、別のリポジトリのデータへの書き込みも拒む。そのときは人に打ってもらう）
 */
const isDataPath = (w: string) => /(^|\/)\.git\/deguboard(\/|$)/.test(w);

/** cd・pushd の行き先を、今の場所（相対）に重ねる。今の場所が分からなければ undefined */
function changeDir(current: string | undefined, to: string | undefined): string | undefined {
  if (to === undefined || to === "-" || to.startsWith("~")) return undefined;
  if (path.posix.isAbsolute(to)) return path.posix.normalize(to);
  return path.posix.normalize(path.posix.join(current ?? ".", to));
}

/** 写す先がデータを指せば書き込みになるコマンド（データから外へ写すだけなら読み取り）。-t <dir> の形も見る */
const COPY_LIKE = new Set(["cp", "mv", "rsync", "install", "ln"]);
/** 引数のどれかがデータを指せば書き込みになるコマンド */
const WRITE_LIKE = new Set([
  "rm",
  "rmdir",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "truncate",
  "unlink",
  "tee",
  "dd",
  "shred",
  "patch",
]);
/** データのリポジトリを変える git のサブコマンド */
const GIT_WRITES = new Set([
  "add",
  "commit",
  "rm",
  "mv",
  "reset",
  "checkout",
  "switch",
  "restore",
  "stash",
  "merge",
  "rebase",
  "cherry-pick",
  "apply",
  "am",
  "push",
  "pull",
  "update-ref",
  "branch",
  "tag",
  "revert",
  "clean",
]);

/** 1 つの単純なコマンドがデータに書くか。inData は今の場所がデータの下か */
function writesWords(words: readonly string[], inData: boolean): boolean {
  const { name, args } = commandOf(words);
  for (let k = 0; k < words.length - 1; k++)
    if (
      isWriteRedirect(words[k]!) &&
      (isDataPath(words[k + 1]!) || (inData && !words[k + 1]!.startsWith("/")))
    )
      return true;
  const touchesData = (list: readonly string[]) => list.some(isDataPath) || inData;
  const plain = args.filter((a) => !a.startsWith("-") && !isRedirect(a));
  const target = args.includes("-t") ? args[args.indexOf("-t") + 1] : plain.at(-1);
  if (COPY_LIKE.has(name) && target !== undefined && (isDataPath(target) || inData)) return true;
  if (WRITE_LIKE.has(name) && touchesData(args)) return true;
  if (
    (name === "sed" || name === "perl") &&
    args.some((a) => /^-\w*i/.test(a) || a.startsWith("--in-place")) &&
    touchesData(args)
  )
    return true;
  if (name === "find") {
    if (args.includes("-delete") && touchesData(args)) return true;
    // -exec・-execdir の後のコマンドを掛け直す（{} は find が見つけたデータのファイル）
    for (let k = 0; k < args.length; k++) {
      if (args[k] !== "-exec" && args[k] !== "-execdir") continue;
      const end = args.findIndex((a, n) => n > k && (a === ";" || a === "+"));
      const sub = args.slice(k + 1, end === -1 ? undefined : end);
      if (
        writesWords(
          sub.map((a) => (a === "{}" && touchesData(args) ? ".git/deguboard/x" : a)),
          inData,
        )
      )
        return true;
    }
  }
  const tarExtracts =
    name === "tar" &&
    args.some(
      (a, n) => (n === 0 || a.startsWith("-")) && /^-?[A-Za-z]*x/.test(a) && !a.startsWith("--"),
    );
  if (tarExtracts || name === "unzip") {
    const flag = name === "tar" ? "-C" : "-d";
    const dest = args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    if ((dest !== undefined && isDataPath(dest)) || (dest === undefined && inData)) return true;
  }
  if (name === "git") {
    // git の全体のオプション（-C <path>・-c <k=v>・--git-dir=<path> など）を読み飛ばしてサブコマンドを取る
    let dir: string | undefined;
    let k = 0;
    while (k < args.length && args[k]!.startsWith("-")) {
      const a = args[k]!;
      if (a === "-C" || a === "--git-dir" || a === "--work-tree") dir = args[++k];
      else if (a.startsWith("--git-dir=") || a.startsWith("--work-tree="))
        dir = a.slice(a.indexOf("=") + 1);
      else if (a === "-c") k++;
      k++;
    }
    const sub = args[k];
    if (sub && GIT_WRITES.has(sub) && ((dir !== undefined && isDataPath(dir)) || inData))
      return true;
  }
  return false;
}

/**
 * Bash のコマンドが .git/deguboard/ の下に書くか（t532）。読むだけ（cat・ls・grep・git log・外へ写す cp など）は通す。
 * 見分けは字句の手がかりで、書き間違いを防ぐためのもの。任意の言語のコード（python -c・node -e など）・eval・置き換えの中での書き込みは見ない
 */
export function writesDataDir(command: string): boolean {
  let where: string | undefined;
  const saved: Array<string | undefined> = [];
  for (const words of splitCommands(command)) {
    if (words[0] === SUBSHELL_OPEN && words.length === 1) {
      saved.push(where);
      continue;
    }
    if (words[0] === SUBSHELL_CLOSE && words.length === 1) {
      // 開きのない )（case の分かれ目など）は見ない
      if (saved.length > 0) where = saved.pop();
      continue;
    }
    const { name, args } = commandOf(words);
    // cd・pushd でデータの下に入った後のコマンドは、データに書くものとみなす
    if (name === "cd" || name === "pushd") {
      where = changeDir(
        where,
        args.find((a) => !a.startsWith("-")),
      );
      continue;
    }
    if (writesWords(words, where !== undefined && isDataPath(where))) return true;
  }
  return false;
}

/** gh api で PR をマージ・ready にする手がかり（REST の pulls/<n>/merge と GraphQL の mutation 名） */
const GH_API_ADVANCE =
  /pulls\/[^/\s]+\/merge\b|mergePullRequest|markPullRequestReadyForReview|enablePullRequestAutoMerge/;
/**
 * 正しい道の dg pr ready・dg pr merge（mise run dg -- pr merge・dg.js も）。区切り（; & | 改行）と gh の語を越えない。
 * 同じ区切りの中で前に gh の語があるもの（gh -R o/dg pr merge）は、gh の引数の dg なので除かない（advancesPrOutsideDg）
 */
const DG_PR = /\bdg(?:\.js)?\b(?:(?!\bgh\b)[^;&|\n])*?\bpr\s+(?:ready|merge)\b/g;
/** 取り消しの gh pr ready --undo（-- の後の --undo はフラグでなく引数なので、-- を越えない。--undo=false も除かない） */
const GH_READY_UNDO = /\bgh\s+pr\s+ready\b(?:(?!\s--(?:\s|$))[^;&|\n])*\s--undo(?=\s|$)/g;
/** 語に分ける区切り（英数字・_・.・/・- のほかすべて。引用符・\・=・括弧・任意の言語の配列の記号も区切る） */
const WORD_SPLIT = /[^\w./-]+/;
/** gh の語（/usr/bin/gh・フラグに接した -Ogh も） */
const isGh = (w: string) => /(^|\/|^-[A-Za-z]*)gh$/.test(w);

/**
 * Bash のコマンドが、dg を経由せずに PR を ready にするかマージするか（gh pr ready・gh pr merge・gh api の同じ操作。t545・t555、ADR-020）。
 * 字句を読まず、生のコマンドで粗く見る：正しい道の dg pr ready・dg pr merge と gh pr ready --undo を除いた残りに、
 * gh の語があり、pr の語と merge・ready の語がどこかにあれば（語は隣り合わなくてよい。2>&1・$PR・python -c の中・1 要素ずつ改行した配列も）、
 * gh api の同じ操作（GH_API_ADVANCE）があれば止める。引用符・ヒアドキュメント・コメントの中も伏せない（本文の語も止める。
 * そのときは拒む文が、ファイルに書いて --body-file・git commit -F で渡す道を案内する）。
 * わざと隠した形は個々に見ない。$(which gh)・GH=gh; $GH pr merge のように語が現れれば止まるが、
 * 語として現れない形（g\h・"mer""ge"・gh pr $OP・gh のエイリアス・ファイルに書いたスクリプトなど）は通る。
 * 見分けは書き間違いを防ぐ手がかりで、すり抜けは事後の検査（t546）で補う
 */
export function advancesPrOutsideDg(command: string): boolean {
  const text = command.replace(/\\\n/g, " ");
  const words = (t: string) => t.split(WORD_SPLIT).filter((w) => w !== "");
  const rest = text
    .replace(DG_PR, (m: string, at: number) =>
      words(
        text
          .slice(0, at)
          .split(/[;&|\n]/)
          .pop()!,
      ).some(isGh)
        ? m
        : " ",
    )
    .replace(GH_READY_UNDO, " ");
  const all = words(rest);
  if (!all.some(isGh)) return false;
  // GraphQL の mutation は括弧を含むので、語に分けずに全体で見る
  if (GH_API_ADVANCE.test(rest)) return true;
  return all.includes("pr") && all.some((w) => w === "merge" || w === "ready");
}

/** dg を経由しない gh pr ready・merge を拒む文（t545・t555） */
export const GH_PR_DENIED =
  "PR を ready にする・マージするのは dg のコマンドで行う：dg pr ready <ticket>・dg pr merge <ticket>（品質ゲート dg gate を満たすときだけ gh を呼び、満たさなければ条件と理由を返す）。" +
  "ゲートを満たさないまま進める（見直し役を起動できない・修正ループの上限を超えた・版上げの PR・人が回数を指示した）のは人の判断なので、人に gh pr ready・gh pr merge を打ってもらう（dg guide review）。" +
  "このフックは引用符・ヒアドキュメント・コメントの中も伏せずに、gh・pr・merge か ready の語がどこかにあれば止める。" +
  "本文にその語を書くなら、Write でファイルに書いて gh pr create --body-file <ファイル>・git commit -F <ファイル> で渡す。ほかのコマンドと一緒に打って止まったなら、分けて打つ";

/**
 * ツールを使う前（PreToolUse。t532・t545・t555）。.git/deguboard/ の下への書き込み（書くツールと Bash）を拒み、dg を経由しない gh pr ready・gh pr merge を
 * 拒んで dg pr ready・dg pr merge へ案内する（advancesPrOutsideDg。字句を読まずに粗く止める）
 */
function toolRequested(
  ctx: CommandContext,
  agent: string,
  event: Extract<HookEvent, { kind: "tool_requested" }>,
  view: HookView,
): void {
  const deny = (reason: string) => {
    // イベント名は製品のもの（入力のまま返す。AG-5）
    view.output = hooksOf(agent)!.denyOutput(view.event, reason);
    view.done.push(`拒んだ: ${reason}`);
  };
  const dataWrite =
    "deguboard のデータ（.git/deguboard/）はファイルを直接書かず、dg のコマンドで読み書きする";
  if (event.tool === "write") {
    if (!event.path) return;
    const target = path.resolve(event.cwd ?? ctx.repo.topLevel, event.path);
    const inside = (dir: string) => {
      const rel = path.relative(dir, target);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    if (inside(ctx.repo.dataDir) || /(^|[\\/])\.git[\\/]deguboard([\\/]|$)/.test(target))
      deny(dataWrite);
    return;
  }
  const command = event.command ?? "";
  if (writesDataDir(command)) {
    deny(dataWrite);
    return;
  }
  if (advancesPrOutsideDg(command)) deny(GH_PR_DENIED);
}

export const hookCommands = [hook];
