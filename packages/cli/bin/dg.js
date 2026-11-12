#!/usr/bin/env node
// ビルド済みの dist（fast-hook と main）を呼ぶだけ。mise run build で dist を作る
// dg は呼び出しのたびに起動する（フックは使うたびに呼ばれる）ので、読み込むモジュールのコンパイル結果を
// Node のコンパイルキャッシュ（既定は一時ディレクトリの下）に残して 2 回目以降の起動を速くする（t624）。
// 使えない Node（22.1 より前）や置き場所に書けないときは黙って飛ばす。キャッシュがなくても dg は動く。
// PreToolUse のフック（Bash・書くツールのたびに呼ばれる）は、main（CLI の全体）を読む前に速い経路で処理する（t768）。
// 受け持たない入力は、読んだ標準入力を添えて main に回す
// 速い経路のファイルが読めないときは、速さを諦めて main に回す（t777）。
// main も読めないときは dist が無いか古いので、直し方を英語で出して終える。ほかの読み込みの失敗は握りつぶさない
import module from "node:module";
try {
  module.enableCompileCache?.();
} catch {
  // キャッシュは速さのための任意の機能なので、失敗しても起動は続ける
}
const argv = process.argv.slice(2);
// dist が今のものでないときの失敗。ファイルが無いとき（ERR_MODULE_NOT_FOUND）と、部分的な再ビルドで古い dist が
// import 先の名前を持たないとき（SyntaxError の "does not provide an export named"）。どちらも同じく扱う
const isStaleDist = (error) =>
  error?.code === "ERR_MODULE_NOT_FOUND" ||
  (error instanceof SyntaxError && error.message.includes("does not provide an export named"));

let tryFastHook;
try {
  ({ tryFastHook } = await import("../dist/fast-hook.js"));
} catch (error) {
  if (!isStaleDist(error)) throw error;
}
const fast = tryFastHook ? await tryFastHook(argv) : { handled: false };
if (fast.handled) {
  process.exitCode = fast.exitCode;
} else {
  let main;
  let mainError;
  try {
    ({ main } = await import("../dist/main.js"));
  } catch (error) {
    if (!isStaleDist(error)) throw error;
    mainError = error;
  }
  if (main) {
    process.exitCode = await main(argv, fast.stdin === undefined ? {} : { stdinText: fast.stdin });
  } else {
    process.stderr.write(
      [
        `dg: the built CLI in dist/ is missing or out of date (${mainError.message}).`,
        "Run `mise run build` in the deguboard repository (`mise run setup` in a new worktree), then run dg again.",
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
  }
}
