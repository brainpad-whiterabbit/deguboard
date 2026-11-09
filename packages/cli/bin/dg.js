#!/usr/bin/env node
// ビルド済みの main を呼ぶだけ。mise run build で dist を作る
// dg は呼び出しのたびに起動する（フックは使うたびに呼ばれる）ので、読み込むモジュールのコンパイル結果を
// Node のコンパイルキャッシュ（既定は一時ディレクトリの下）に残して 2 回目以降の起動を速くする（t624）。
// 使えない Node（22.1 より前）や置き場所に書けないときは黙って飛ばす。キャッシュがなくても dg は動く。
import module from "node:module";
try {
  module.enableCompileCache?.();
} catch {
  // キャッシュは速さのための任意の機能なので、失敗しても起動は続ける
}
const { main } = await import("../dist/main.js");
process.exitCode = await main(process.argv.slice(2));
