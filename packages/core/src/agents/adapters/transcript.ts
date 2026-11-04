// Adapter が会話記録を読むときに共通で使う小さな部品（AG-5、ADR-005）。特定の AI 製品の形はここに書かない

import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEnv, CollectedUsage, UsageQuery } from "../define.js";

export function homeDir(env: AgentEnv): string {
  return env["HOME"] || os.homedir();
}

/** dir が base と同じか、その下にあるか */
export function within(dir: string, base: string): boolean {
  const rel = path.relative(base, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 会話記録を探す作業ディレクトリ。作業ツリーと主の作業ツリー（common dir の親）と、主の作業ツリーの親までの上位。
 * HOME とその上はほかのリポジトリの会話記録も入るので探さない
 */
export function searchRoots(topLevel: string, commonDir: string, home: string): string[] {
  const main = path.dirname(path.resolve(commonDir));
  const limit = path.dirname(main);
  const roots = new Set([path.resolve(topLevel), main]);
  for (let d = path.dirname(path.resolve(topLevel)); within(d, limit); d = path.dirname(d)) {
    roots.add(d);
    if (path.dirname(d) === d) break;
  }
  return [...roots].filter((d) => !within(path.resolve(home), d));
}

/** ディレクトリの中の名前。読めなければ空 */
export async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

/** started_at より前に書き終えたファイルに Run は載っていない */
export async function fresh(query: UsageQuery, files: string[]): Promise<string[]> {
  const since = Date.parse(query.run.started_at);
  const out: string[] = [];
  for (const file of files) {
    const s = await stat(file).catch(() => undefined);
    if (s?.isFile() && s.mtimeMs >= since) out.push(file);
  }
  return out;
}

/** 0 以上の整数だけを数として受け取る */
export const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;

export const parse = (line: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // 書きかけの行
  }
};

/** 行の最上位の timestamp。なければ NaN */
export const timeOf = (entry: Record<string, unknown>): number =>
  typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : NaN;

/** 行の順が少し前後しても読み切るための猶予。期間の終わりからこれだけ過ぎた行で読むのをやめる */
export const TAIL_MS = 60_000;

/** 何も取れなかったときの値 */
export const none = (warning: string): CollectedUsage => ({
  usage: { input: null, output: null, cache_read: null, cache_write: null },
  model: null,
  warnings: [warning],
});
