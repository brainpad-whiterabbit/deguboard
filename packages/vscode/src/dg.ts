// PATH の dg を引く 1 か所（ADR-027）。画面は dg なしで動き、ないときはインストールを案内し、
// 版のメジャーが同梱の core と違えば知らせる（UI-11）。同梱した dg の起動ファイルは launcher.ts が書く

import { execFile } from "node:child_process";
import { t } from "./l10n.js";

export type DgLookup =
  | { kind: "found"; version: string }
  | { kind: "missing" }
  | { kind: "error"; detail: string };

/** テスト用に差し替えられる `dg --version` の実行 */
export type RunVersion = () => Promise<string>;

function runDgVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("dg", ["--version"], { timeout: 5_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

export async function resolveDg(run: RunVersion = runDgVersion): Promise<DgLookup> {
  try {
    const version = (await run()).trim();
    return version
      ? { kind: "found", version }
      : { kind: "error", detail: t("dg --version printed nothing") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

export function majorOf(version: string): number | undefined {
  const m = /^v?(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : undefined;
}

export interface DgAdvice {
  /** info は案内（画面は動く）、warning は放置すると食い違う */
  level: "info" | "warning";
  text: string;
}

/** 利用者に知らせる文。何もなければ undefined */
export function dgAdvice(lookup: DgLookup, coreVersion: string): DgAdvice | undefined {
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
