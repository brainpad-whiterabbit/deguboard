import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// コマンドが書き込むか（write）を照らすためだけに core の実行時のコードを取り込む（画面のコードは型だけを取る）
import { findCommand } from "@deguboard/core";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** 画面のコード（テストとテストの部品を除く）のファイル。SRC からの相対の道 */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name) || e.name.endsWith(".d.ts"))
      return [];
    if (e.name === "test-helpers.ts") return [];
    return [relative(SRC, path).split("\\").join("/")];
  });
}

/**
 * `.run("name"` と `.run<型>("name"` の呼び出しと、読むためのフック `useCommandData("name"`（command-data.ts）の呼び出し。
 * フックの宣言（function useCommandData）は除く。型引数は 1 段の入れ子まで読む。name は第 1 引数の字句（文字列なら引用符つき）
 */
const RUN_CALL =
  /(?:\.run|(?<!function )\buseCommandData)\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*([^\s,)]+)/g;

function runCalls(file: string): string[] {
  const text = readFileSync(join(SRC, file), "utf8");
  return [...text.matchAll(RUN_CALL)].map((m) => m[1]!);
}

/**
 * 書き込みのコマンドを呼んでよい場所（UI-7）。チケット詳細（pages/ticket.tsx と右の列の部品）と設定画面だけ。
 * 同期（UI-6）はビューのタイトル行のボタンから拡張ホストが呼び、画面のコードは呼ばない
 */
const ALLOWED_WRITES: Readonly<Record<string, readonly string[]>> = {
  "pages/ticket.tsx": ["ticket.check", "ticket.update"],
  "components/ticket-props.tsx": ["ticket.move"],
  "components/ticket-props-panel.tsx": ["ticket.update"],
  "pages/config.tsx": ["config.set", "config.unset"],
};

describe("画面から呼ぶ書き込みのコマンド（UI-7）", () => {
  const files = sourceFiles();

  it("コマンドの名前は文字列で直に書く（名前を変数で渡すのは store.run と useCommandData の中だけ）", () => {
    const dynamic = files.flatMap((f) =>
      runCalls(f)
        .filter((name) => !name.startsWith('"'))
        .map((name) => `${f}: ${name}`),
    );
    expect(dynamic.sort()).toEqual(["command-data.ts: name", "store.tsx: name"]);
  });

  it("呼ぶコマンドはすべて core にある", () => {
    const unknown = files.flatMap((f) =>
      runCalls(f)
        .filter((name) => name.startsWith('"'))
        .map((name) => name.slice(1, -1))
        .filter((name) => !findCommand(name))
        .map((name) => `${f}: ${name}`),
    );
    expect(unknown).toEqual([]);
  });

  it("書き込みのコマンドを呼ぶのはチケット詳細と設定画面だけ", () => {
    const writes: Record<string, string[]> = {};
    for (const f of files) {
      const names = runCalls(f)
        .filter((name) => name.startsWith('"'))
        .map((name) => name.slice(1, -1))
        .filter((name) => findCommand(name)?.write);
      if (names.length > 0) writes[f] = [...new Set(names)].sort();
    }
    expect(writes).toEqual(ALLOWED_WRITES);
  });
});
