// dg hook が deguboard-local/ に残す記録の書き方（hook-inputs/ と hook-sessions/。t542・t697・t756）。
// PreToolUse の速い経路（fast-hook.ts）も書くので、node の組み込みのほかに依存を持たない（t768）。
// 記録の意味と読む側は hook-sessions.ts の冒頭

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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
export async function recordHookInput(
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

export const HOOK_SESSIONS_DIR = "hook-sessions";
/** ファイル名に使えるセッション ID。ほかの形はパスを組み立てずに記録しない */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const WARNINGS_SUFFIX = ".warnings.jsonl";
export const KIND_PREFIX = ".kind-";

export const dirOf = (localDir: string) => path.join(localDir, HOOK_SESSIONS_DIR);
export const fileOf = (localDir: string, session: string, suffix = ".json") =>
  path.join(dirOf(localDir), `${session}${suffix}`);

/**
 * このセッションにフックが届いたことと、届いた出来事の種類（HookEvent の kind）を記録する。
 * 中身は時刻だけで、入力の値は残さない（MT-4）
 */
export async function recordHookSession(
  localDir: string,
  session: string,
  receivedAt: string,
  kind?: string,
): Promise<void> {
  if (!SESSION_ID.test(session)) return;
  await mkdir(dirOf(localDir), { recursive: true });
  const body = `${JSON.stringify({ received_at: receivedAt })}\n`;
  await Promise.all([
    writeFile(fileOf(localDir, session), body),
    ...(kind && /^[a-z_]+$/.test(kind)
      ? [writeFile(fileOf(localDir, session, `${KIND_PREFIX}${kind}.json`), body)]
      : []),
  ]);
}

/** フックの中で出た警告を、このセッションの警告に書き足す（1 件 1 行。追記なので同時に動くフックの記録を落とさない） */
export async function recordHookWarnings(
  localDir: string,
  session: string,
  event: string,
  at: string,
  warnings: readonly string[],
): Promise<void> {
  if (!SESSION_ID.test(session) || warnings.length === 0) return;
  await mkdir(dirOf(localDir), { recursive: true });
  await appendFile(
    fileOf(localDir, session, WARNINGS_SUFFIX),
    warnings.map((text) => `${JSON.stringify({ at, event, text })}\n`).join(""),
  );
}
