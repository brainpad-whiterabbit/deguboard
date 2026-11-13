// dg の 2 つの入口（bin/dg.js と、VS Code 拡張に同梱する dg.mjs の入口 src/bundle.ts）に共通の流れ（t788）。
// dg は呼び出しのたびに起動する（フックは使うたびに呼ばれる）ので、読み込むモジュールのコンパイル結果を
// Node のコンパイルキャッシュ（既定は一時ディレクトリの下）に残して 2 回目以降の起動を速くする（t624・t767）。
// キャッシュは有効にした後に読むモジュールにだけ効くので、速い経路と本体は有効にした後に、渡された関数で読む。
// PreToolUse のフック（Bash・書くツールのたびに呼ばれる）と Stop のフック（応答のたびに呼ばれる）は、本体（CLI の全体）を読む前に
// 速い経路で処理する（t768・t769・t786）。
// 受け持たない入力は、読んだ標準入力を添えて本体に回す（標準入力は 1 度しか読めない。t781）。
// 入口ごとの違い（Node の版の確かめ・dist が古いときの回し）は呼ぶ側に置く。このファイルは node の組み込みのほかを読まない

import module from "node:module";

/**
 * コンパイルキャッシュを有効にし、速い経路を試し、受け持たなければ本体を動かして、終了コードを返す。
 * loadFastHook が undefined を返せば速い経路を飛ばす。runMain は速い経路が読んだ標準入力を受ける
 */
export async function runEntry(argv, { loadFastHook, runMain }) {
  try {
    // 使えない Node では関数がない。置き場所に書けないときは Node が失敗の状態を返すだけで、投げない
    module.enableCompileCache?.();
  } catch {
    // 思わぬ例外が出ても、キャッシュは速さのための任意の機能なので起動は続ける
  }
  const tryFastHook = await loadFastHook();
  const fast = tryFastHook ? await tryFastHook(argv) : { handled: false };
  if (fast.handled) return fast.exitCode;
  return runMain(fast.stdin === undefined ? {} : { stdinText: fast.stdin });
}
