// Store の読みの結果（ファイルごとの印と値）をディスクに残し、プロセスをまたいで使う（ADR-033）。
// CLI は呼び出しごとにプロセスが終わるので、残さないと毎回すべてのファイルを読んで解析する。
//   - 置き場所は deguboard-local/store-cache/（Git 管理外）。ファイルは鍵（キャッシュの形・dg の版・読みのコードの印・データの場所・
//     Action の一覧）の要約ごとに分ける。版の違う CLI と VS Code 拡張が並んで動いても、互いのキャッシュを捨て合わない
//   - 値を使うのは、ファイルの今の印が覚えた印と同じときだけ（Store.rescan）。他のプロセスが書いた後の古い値は印が違うので使わない
//   - 読めない・形の違うキャッシュは無いものとして読み直す。書くのは一時ファイルからの rename だけで、途中の形を他のプロセスに見せない。
//     キャッシュは捨ててよいものなので fsync しない（壊れても読み直すだけ）

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 1 ファイルの読みの結果と、読んだときの印 */
export interface CachedRead {
  stamp: string;
  value: unknown;
}

/**
 * キャッシュの形の版。覚える値（Doc・Issue・config・Workflow）の形や、読みの解釈を変えたら上げる。
 * dg の版と読みのコードの印も鍵に入れるので、上げ忘れても版を上げたときか作り直したときに捨てる
 */
export const STORE_CACHE_FORMAT = 1;

/**
 * 鍵の違う他のキャッシュのファイルは、新しい順にこの数だけ残して消す（使われていない版の分を溜めない）。
 * 並んで動く別の版（CLI と VS Code 拡張）の分は書き直されて新しいので残る。開発で作り直すたびに鍵が変わっても溜まらない
 */
const KEEP_OTHERS = 3;

let codeStampPromise: Promise<string> | undefined;

/**
 * 読みのコード（core の model・storage・workflow）の印。開発中は版が同じままスキーマを変えるので、作り直したら別の鍵にする。
 * 束ねた拡張（VS Code）にはこの配置がないので、束ねたファイルそのものの印を使う。プロセスで 1 回だけ取る
 */
function codeStamp(): Promise<string> {
  codeStampPromise ??= (async () => {
    const self = fileURLToPath(import.meta.url);
    const base = path.dirname(path.dirname(self));
    const parts: string[] = [];
    for (const dir of ["model", "storage", "workflow"]) {
      const files = await readdir(path.join(base, dir)).catch(() => [] as string[]);
      for (const file of files.sort()) {
        if (!/\.(js|ts)$/.test(file) || /\.(d|test)\.ts$/.test(file)) continue;
        const s = await stat(path.join(base, dir, file)).catch(() => undefined);
        if (s) parts.push(`${dir}/${file}:${s.size}:${s.mtimeMs}`);
      }
    }
    if (parts.length === 0) {
      const s = await stat(self).catch(() => undefined);
      if (s) parts.push(`${path.basename(self)}:${s.size}:${s.mtimeMs}`);
    }
    return parts.join(",");
  })();
  return codeStampPromise;
}

/**
 * core の版（package.json）。束ねた拡張（VS Code）では読めないので空になり、版の区別は codeStamp の束ねたファイルの印
 * （大きさと更新時刻）だけに頼る。拡張を入れ替えると束ねたファイルが書き直されて印が変わるので、それで足りるとする
 */
async function coreVersion(): Promise<string> {
  try {
    const text = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(text) as { name?: unknown; version?: unknown };
    return pkg.name === "@deguboard/core" ? String(pkg.version) : "";
  } catch {
    return "";
  }
}

/** キャッシュの鍵。これが違うキャッシュは使わない */
export async function storeCacheKey(root: string, actions: readonly string[] | undefined) {
  return JSON.stringify({
    format: STORE_CACHE_FORMAT,
    version: await coreVersion(),
    code: createHash("sha256")
      .update(await codeStamp())
      .digest("hex"),
    root: path.resolve(root),
    actions: actions ?? null,
  });
}

/** 鍵ごとのキャッシュのファイル */
export function storeCacheFile(dir: string, key: string): string {
  return path.join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`);
}

/** キャッシュを読む。無い・読めない・鍵や形が違うときは空（すべて読み直す） */
export async function loadStoreCache(file: string, key: string): Promise<Map<string, CachedRead>> {
  const entries = new Map<string, CachedRead>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return entries;
  }
  if (!isRecord(parsed) || parsed["key"] !== key || !isRecord(parsed["entries"])) return entries;
  for (const [relPath, entry] of Object.entries(parsed["entries"])) {
    // 形の違う項目が 1 つでもあれば、壊れたものとして全体を捨てる
    if (!isRecord(entry) || typeof entry["stamp"] !== "string" || !isRecord(entry["value"]))
      return new Map();
    entries.set(relPath, { stamp: entry["stamp"], value: entry["value"] });
  }
  return entries;
}

/**
 * キャッシュを書く。失敗しても黙って続ける（次の呼び出しが読み直すだけ）。
 * cleanup のときは、鍵の違う古いキャッシュのファイルも消す
 */
export async function saveStoreCache(
  file: string,
  key: string,
  entries: ReadonlyMap<string, CachedRead>,
  cleanup: boolean,
): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify({ key, entries: Object.fromEntries(entries) }));
    await rename(tmp, file);
  } catch {
    await unlink(tmp).catch(() => undefined);
    return;
  }
  if (!cleanup) return;
  const names = await readdir(dir).catch(() => [] as string[]);
  const others: { file: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const other = path.join(dir, name);
    if (other === file) continue;
    const s = await stat(other).catch(() => undefined);
    if (!s) continue;
    if (name.endsWith(".json")) others.push({ file: other, mtimeMs: s.mtimeMs });
    // 落ちたプロセスが残した一時ファイル。書いている最中の他のプロセスの分は消さないよう、1 分より古いものだけ
    else if (name.endsWith(".tmp") && Date.now() - s.mtimeMs > 60_000)
      await unlink(other).catch(() => undefined);
  }
  others.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { file: old } of others.slice(KEEP_OTHERS)) await unlink(old).catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
