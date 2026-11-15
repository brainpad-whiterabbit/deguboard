// PATH の dg を引く 1 か所（ADR-027）。画面は dg なしで動く。ない・版のメジャーが同梱の core と違うことは、
// 通知にせず導入のチェックリストの推奨の項目で示す（項目の組み立ては setup.ts の dgCommandItem。UI-11）。同梱した dg の起動ファイルは launcher.ts が書く

import { execFile } from "node:child_process";
import { t } from "./l10n.js";
import { parseVersion } from "./launcher.js";

export type DgLookup =
  | { kind: "found"; version: string }
  | { kind: "missing" }
  | { kind: "error"; detail: string };

/** テスト用に差し替えられる `dg --version` の実行。cwd がなければ拡張のプロセスの cwd で動く */
export type RunVersion = (cwd?: string) => Promise<string>;

export function runDgVersion(cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("dg", ["--version"], { timeout: 5_000, ...(cwd ? { cwd } : {}) }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

/**
 * cwd はワークスペースのフォルダを渡す。mise などの shim は cwd の設定（mise.toml・.node-version）で
 * node と dg の版を選ぶので、拡張のプロセスの cwd（`/` や `~`）で確かめると、ターミナル・エージェント・
 * フックが dg を使う場所と結果が食い違う
 */
export async function resolveDg(cwd?: string, run: RunVersion = runDgVersion): Promise<DgLookup> {
  try {
    const version = (await run(cwd)).trim();
    return version
      ? { kind: "found", version }
      : { kind: "error", detail: t("dg --version printed nothing") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** 版のメジャー。読めない版（major.minor.patch の形でない）は undefined */
export function majorOf(version: string): number | undefined {
  return parseVersion(version)?.[0];
}

/**
 * dg --version の cwd にするフォルダ。cwd にできるのは手元のファイル（scheme が file）のフォルダだけで、
 * それ以外（リモートの仮想のファイルなど）では cwd を渡さない
 */
export function dgCheckCwd(folder: { scheme: string; fsPath: string }): string | undefined {
  return folder.scheme === "file" && folder.fsPath ? folder.fsPath : undefined;
}
