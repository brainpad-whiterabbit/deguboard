#!/usr/bin/env node
// ビルド済みの main を呼ぶだけ。mise run build で dist を作る
const { main } = await import("../dist/main.js");
process.exitCode = await main(process.argv.slice(2));
