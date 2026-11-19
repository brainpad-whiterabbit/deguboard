import { describe, expect, it } from "vitest";
import { defaultConfig } from "../model/config.js";
import { checkCommandsOf, commandParts, isCheckCommand } from "./check-commands.js";

/** このリポジトリの設定と同じ形：actions.test・actions.light_test と、足したコマンド */
const counted = checkCommandsOf({
  actions: {
    ...defaultConfig().actions,
    test: ["mise", "run", "check"],
    light_test: ["mise", "run", "check:light"],
  },
  metrics: {
    read_transcripts: true,
    check_commands: ["mise run test:related", "  mise   run test "],
  },
});

describe("検査とテストに数えるコマンド（MT-1）", () => {
  it("数えるコマンドは actions.test・actions.light_test と、metrics.check_commands の各行を空白で分けた語。空の項目は入れない", () => {
    expect(counted).toEqual([
      ["mise", "run", "check"],
      ["mise", "run", "check:light"],
      ["mise", "run", "test:related"],
      ["mise", "run", "test"],
    ]);
    // 既定は actions.test も足したコマンドも空で、語の並びで数えるコマンドはない（dg gate --only check だけを数える）
    expect(checkCommandsOf(defaultConfig())).toEqual([]);
    expect(
      checkCommandsOf({
        actions: { ...defaultConfig().actions, test: ["make", "check"] },
        metrics: { read_transcripts: true, check_commands: ["   "] },
      }),
    ).toEqual([["make", "check"]]);
  });

  it.each([
    ["数えるコマンドそのもの", "mise run check"],
    ["軽い検査", "mise run check:light"],
    ["足したコマンド", "mise run test:related"],
    ["後ろに引数が続く", "mise run test -- packages/core/src/model/run.test.ts"],
    ["後ろにリダイレクトとパイプが続く", "mise run check 2>&1 | tail -20"],
    ["cd の後に && でつなぐ", "cd /repo/worktree && mise run test:related"],
    ["; でつなぐ", "mise run format; mise run check"],
    ["|| でつなぐ", "mise run build || mise run check"],
    ["改行でつなぐ", "cd /repo\nmise run test"],
    ["行の継続（\\ と改行）をまたぐ", "mise run \\\n  check"],
    ["先頭に代入が付く", "CI=1 FORCE_COLOR=0 mise run test"],
    ["括弧の中", "(cd /repo && mise run check)"],
    ["語を引用符で囲む", "mise run 'check'"],
    ["語の間の空白がいくつもある", "mise   run\tcheck"],
    [
      "mise run dg -- での dg gate --only check",
      "mise run dg -- --json --actor agent gate t12 --only check",
    ],
    ["PATH の dg での dg gate --only check", "dg gate t12 --only check"],
    ["node で呼ぶ dg gate --only check", "node packages/cli/bin/dg.js gate 12 --only=check"],
    ["絶対パスの dg", "/usr/local/bin/dg --json gate t12 --only check 2>&1 | tail -3"],
    ["--only が gate より前にある", "dg --only check gate t12"],
    ["pnpm run で呼ぶ dg gate --only check", "pnpm run dg gate t12 --only check"],
    [
      "呼び出しの形にオプションが付く dg gate --only check",
      "node --enable-source-maps packages/cli/bin/dg.js gate t12 --only check",
    ],
    ["先頭に代入が付く dg gate --only check", "CI=1 mise run dg -- gate t12 --only check"],
  ])("数える：%s", (_name, command) => {
    expect(isCheckCommand(command, counted)).toBe(true);
  });

  it.each([
    ["ほかのコマンド", "git status"],
    ["語の途中までが同じ（test と test:related）", "mise run test:layout"],
    ["語の途中までが同じ（check と check:docs）", "mise run check:docs"],
    ["数えるコマンドより語が少ない", "mise run"],
    ["前に別のコマンドが付く", "timeout 600 mise run check"],
    ["部分の先頭でない", "echo mise run check"],
    [
      "引用符の中の文（コミットメッセージ）",
      'git commit -m "fix; mise run check && mise run test"',
    ],
    ["単引用符の中の文", "echo 'a | mise run test'"],
    ["引用符で 1 語にまとめたもの", '"mise run check"'],
    ["エスケープした空白で 1 語になったもの", "mise\\ run\\ check"],
    ["--only のない dg gate", "mise run dg -- --json gate t12"],
    ["--only の値が check でない", "dg gate t12 --only review"],
    ["gate でない dg のコマンド", "dg ticket show t12 --only check"],
    ["dg でないコマンドの gate --only check", "other gate t12 --only check"],
    ["語の末尾だけが dg", "mydg gate t12 --only check"],
    ["dg gate と --only check が別の部分にある", "dg gate t12 && echo --only check"],
    ["dg gate の前に echo が付く", "echo dg gate t1 --only check"],
    ["dg gate の前に別のコマンドが付く", "timeout 600 dg gate t1 --only check"],
    ["呼び出しの形の前に別のコマンドが付く", "timeout 600 mise run dg -- gate t1 --only check"],
    ["ほかのタスクの引数にある dg gate", "mise run build -- dg gate t1 --only check"],
    ["空のコマンド", ""],
  ])("数えない：%s", (_name, command) => {
    expect(isCheckCommand(command, counted)).toBe(false);
  });

  it("数えるコマンドがなくても、dg gate --only check は数える", () => {
    expect(isCheckCommand("dg gate t1 --only check", [])).toBe(true);
    expect(isCheckCommand("mise run check", [])).toBe(false);
  });

  it("コマンドの文字列を、つなぎと括弧で部分に分け、引用符の中では分けない", () => {
    expect(commandParts(`A=1 a "b c" && d 'e;f' | g; (h)\ni &`)).toEqual([
      ["A=1", "a", "b c"],
      ["d", "e;f"],
      ["g"],
      ["h"],
      ["i"],
    ]);
    // 空の引用符も語にし、二重引用符の中の \ は次の字をそのまま入れる
    expect(commandParts(`a "" "x\\"y"`)).toEqual([["a", "", 'x"y']]);
    // 閉じていない引用符は、最後までを 1 語にする
    expect(commandParts(`a "b; c`)).toEqual([["a", "b; c"]]);
  });
});
