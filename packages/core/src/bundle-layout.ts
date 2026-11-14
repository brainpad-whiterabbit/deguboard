// 束ねた CLI（VS Code 拡張に同梱する dist/cli/dg.mjs とその隣の本体の chunk）の配置。束ねると import.meta.url はどのモジュールでも
// 本体の chunk を指し、package.json も bin/dg.js もないので、import.meta.url からの相対で引く場所のうち引けないものを、
// 束ねた本体の入口（packages/cli/src/bundle-main.ts）が起動の最初にここへ置く。置かれていなければ（clone したリポジトリの dg と VS Code 拡張の本体）は今までどおり import.meta.url から引く。
// Web の画面（../web）は束ねた配置でも同じ相対で引けるよう、ビルドが置く（packages/vscode/package.json の build）

import { readFile } from "node:fs/promises";

export interface BundleLayout {
  /** 束ねたファイル（dg.mjs）の絶対パス。フックとマージドライバが呼ぶ dg、store-cache の印に使う */
  entry: string;
  /** guide-*.md のあるフォルダ（拡張の本体と共有する dist/） */
  guideDir: string;
  /** dg の版（束ねたときに cli の package.json から埋める） */
  version: string;
}

let layout: BundleLayout | undefined;

/** 束ねた入口が起動の最初に呼ぶ。テストのほかで呼び直さない */
export function setBundleLayout(next: BundleLayout | undefined): void {
  layout = next;
}

/** 束ねた配置で動いていればその配置、そうでなければ undefined */
export function bundleLayout(): BundleLayout | undefined {
  return layout;
}

/**
 * core の版（package.json）。束ねた CLI（dg.mjs）は束ねたときに埋めた版を使う。束ねた拡張（VS Code）では読めないので空になる
 * （store-cache は束ねたファイルの印で足り、Skill の印の版は拡張がビルドで埋めた版を渡す）
 */
export async function coreVersion(): Promise<string> {
  if (layout !== undefined) return layout.version;
  try {
    const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(text) as { name?: unknown; version?: unknown };
    return pkg.name === "@deguboard/core" ? String(pkg.version) : "";
  } catch {
    return "";
  }
}
