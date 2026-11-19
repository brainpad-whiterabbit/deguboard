// 検査とテストに数えるコマンドの見分け（MT-1）。会話記録を読まない関数だけを置き、Adapter が Bash のコマンドの文字列を渡す。
// 返すのは数えるかどうかだけで、コマンドの文字列は Run に残さない（MT-4）

import type { Config } from "../model/config.js";

/** 数えるコマンド。語の並びで持ち、コマンドの部分の先頭の語がこの並びと同じなら数える */
export type CheckCommands = ReadonlyArray<readonly string[]>;

/**
 * config から数えるコマンドを決める：actions.test・actions.light_test（空でなければ）と、metrics.check_commands の各行を空白で分けた語。
 * dg gate --only check は呼び方（mise run dg --、node …/dg.js）がリポジトリごとに違い、語の並びで書けないので、isCheckCommand がいつも数える
 */
export function checkCommandsOf(config: Pick<Config, "metrics" | "actions">): CheckCommands {
  return [
    config.actions.test,
    config.actions.light_test,
    ...config.metrics.check_commands.map((line) => line.trim().split(/\s+/)),
  ].filter((words) => words.length > 0 && words[0] !== "");
}

/**
 * コマンドの文字列を、つなぎ（&& || ; | & 改行）と括弧で部分に分け、部分ごとの語にする。引用符の中のつなぎと空白では分けない
 * （コミットメッセージや echo の文の中のコマンド名を数えないため）。シェルの展開（変数・$( ) の中身の実行結果）は解釈しない
 */
export function commandParts(command: string): string[][] {
  const parts: string[][] = [];
  let words: string[] = [];
  let word = "";
  /** 引用符か \ で始まった語は、空でも語にする */
  let started = false;
  let quote: '"' | "'" | undefined;
  const endWord = (): void => {
    if (started || word !== "") words.push(word);
    word = "";
    started = false;
  };
  const endPart = (): void => {
    endWord();
    if (words.length > 0) parts.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i]!;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < command.length) {
      // 行の継続（\ と改行）は空白と同じ
      if (command[i + 1] === "\n") endWord();
      else {
        word += command[i + 1]!;
        started = true;
      }
      i++;
    } else if (c === " " || c === "\t") endWord();
    else if ("\n;|&(){}".includes(c)) endPart();
    else word += c;
  }
  endPart();
  return parts;
}

/** 先頭の VAR=value の代入を除いた語 */
function withoutAssignments(words: readonly string[]): readonly string[] {
  let n = 0;
  while (n < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[n]!)) n++;
  return words.slice(n);
}

/** dg を呼ぶ語か（dg、パスの末尾が dg か dg.js）。mise run dg -- と pnpm run dg と node …/dg.js のどれも、この語を含む */
const isDgWord = (word: string): boolean => /(^|\/)dg(\.js)?$/.test(word);

/** dg の語の前に置ける呼び出しの形の先頭の語（mise run dg --、pnpm run dg、node …/dg.js） */
const DG_LAUNCHERS: ReadonlySet<string> = new Set(["mise", "pnpm", "node"]);

/**
 * dg の語の前の語が呼び出しの形か。何もないか、先頭が呼び出しの語で、残りが run かオプション（- で始まる語）だけ。
 * `echo dg gate …` や `timeout 600 dg gate …` のように別のコマンドが前に付いた部分は、語の並びのコマンドと同じく数えない
 */
function isDgLauncher(before: readonly string[]): boolean {
  if (before.length === 0) return true;
  return (
    DG_LAUNCHERS.has(before[0]!) && before.slice(1).every((w) => w === "run" || w.startsWith("-"))
  );
}

/** dg gate の --only check か。部分が dg の語か呼び出しの形で始まり、dg の語の後に gate があり、--only の値（, 区切り）に check がある */
function isGateCheck(words: readonly string[]): boolean {
  const dg = words.findIndex(isDgWord);
  if (dg < 0 || !isDgLauncher(words.slice(0, dg))) return false;
  const rest = words.slice(dg + 1);
  if (!rest.includes("gate")) return false;
  return rest.some((w, i) => {
    const value = w === "--only" ? rest[i + 1] : w.startsWith("--only=") ? w.slice(7) : undefined;
    return value?.split(",").includes("check") === true;
  });
}

/**
 * コマンドの文字列を検査とテストに数えるか。部分（commandParts）のどれかが、先頭の代入を除いて、数えるコマンドの語の並びで始まるか、
 * dg gate --only check なら数える。語で比べるので、`mise run test` は `mise run test:related` に当たらない。
 * 後ろに引数やリダイレクトが続いても数え、前に別のコマンド（timeout など）が付いた部分は数えない（dg gate も同じ。
 * dg の語の前に置けるのは isDgLauncher の呼び出しの形だけ）
 */
export function isCheckCommand(command: string, counted: CheckCommands): boolean {
  return commandParts(command).some((part) => {
    const words = withoutAssignments(part);
    return (
      counted.some((c) => c.length <= words.length && c.every((w, i) => w === words[i])) ||
      isGateCheck(words)
    );
  });
}
