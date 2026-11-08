// PATH の dg を引く 1 か所（ADR-027）。画面は dg なしで動き、ないときはインストールを案内し、
// 版のメジャーが同梱の core と違えば知らせる（UI-11）。同梱は npm が使えない環境が出たときに足す

import { execFile } from "node:child_process";
import { t } from "./l10n.js";

export type DgLookup =
  | { kind: "found"; version: string }
  | { kind: "missing" }
  | { kind: "error"; detail: string };

/** テスト用に差し替えられる `dg --version` の実行 */
export type RunVersion = () => Promise<string>;

// 手順そのものは書かず、ルートの README の「Getting started before release」を指す
const INSTALL_GUIDE_URL =
  "https://github.com/brainpad-whiterabbit/deguboard#getting-started-before-release";

/** 入れ方の案内。表示言語で変わるので、呼ぶたびに作る */
function installHint(): string {
  return t(
    "dg is not on npm yet. For now, clone and build it as described in the “Getting started before release” section of the README ({0}), and put dg on your PATH. Once released, install it with npm i -g deguboard (with mise: mise use -g npm:deguboard).",
    INSTALL_GUIDE_URL,
  );
}

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
          "dg is not on your PATH. The views work without dg; install dg to use deguboard from agents and the CLI. {0}",
          installHint(),
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
