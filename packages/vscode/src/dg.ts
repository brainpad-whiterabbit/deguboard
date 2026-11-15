// PATH の dg を引く 1 か所（ADR-027）。画面は dg なしで動き、ないときはインストールを案内し、
// 版のメジャーが同梱の core と違えば知らせる（UI-11）。同梱した dg の起動ファイルは launcher.ts が書く

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

export interface DgAdvice {
  /** info は案内（画面は動く）、warning は放置すると食い違う */
  level: "info" | "warning";
  text: string;
}

/** 確かめたフォルダ。folderCount はウィンドウの作業フォルダの数 */
export interface DgCheckedFolder {
  name: string;
  folderCount: number;
}

/** 最初に使ったフォルダのうち、確かめに要るもの（vscode.WorkspaceFolder の写し。VS Code の API に触れずに試せるようにする） */
export interface DgFirstFolder {
  name: string;
  scheme: string;
  fsPath: string;
}

/**
 * 最初に使ったフォルダから、dg --version の cwd と警告に入れるフォルダを決める。
 * cwd にできるのは手元のファイル（scheme が file）のフォルダだけで、それ以外（リモートの仮想のファイルなど）と
 * フォルダがないときは cwd を渡さず、警告にフォルダも入れない。folderCount はウィンドウの作業フォルダの数
 */
export function dgCheckTarget(
  folder: DgFirstFolder | undefined,
  folderCount: number,
): { cwd?: string; checked?: DgCheckedFolder } {
  if (!folder || folder.scheme !== "file" || !folder.fsPath) return {};
  return { cwd: folder.fsPath, checked: { name: folder.name, folderCount } };
}

/**
 * 利用者に知らせる文。何もなければ undefined。
 * 確かめはウィンドウで 1 回だけで、フォルダごとにはしない。フォルダが複数あるときは、どのフォルダの
 * 結果かが分からないので、警告に確かめたフォルダの名前を入れる（1 つなら明らかなので入れない）
 */
export function dgAdvice(
  lookup: DgLookup,
  coreVersion: string,
  folder?: DgCheckedFolder,
): DgAdvice | undefined {
  const advice = adviceOf(lookup, coreVersion);
  if (advice?.level !== "warning" || !folder || folder.folderCount <= 1) return advice;
  return { ...advice, text: t("{0} (checked in the folder {1})", advice.text, folder.name) };
}

function adviceOf(lookup: DgLookup, coreVersion: string): DgAdvice | undefined {
  switch (lookup.kind) {
    case "missing":
      return {
        level: "info",
        text: t(
          "dg is not on your PATH. The views work without dg. To use dg from agents and the terminal, run “deguboard: Install dg command” from the Command Palette.",
        ),
      };
    case "error":
      return { level: "warning", text: t("dg --version failed: {0}", lookup.detail) };
    case "found": {
      const dg = majorOf(lookup.version);
      const core = majorOf(coreVersion);
      if (dg === undefined || core === undefined || dg === core) return undefined;
      return {
        level: "warning",
        text: t(
          "The major version of dg ({0}) differs from the extension's core ({1}). Update one of them to match.",
          lookup.version,
          coreVersion,
        ),
      };
    }
  }
}
