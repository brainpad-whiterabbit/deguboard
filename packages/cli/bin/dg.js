#!/usr/bin/env node
// ビルド済みの dist（fast-hook と main）を呼ぶだけ。mise run build で dist を作る
// コンパイルキャッシュを有効にしてから速い経路を試し、受け持たない入力を main に回す流れは、同梱の dg.mjs の入口（src/bundle.ts）と
// 共通の run-entry.mjs に置く。ここに置くのは、この入口だけが持つ次の 2 つ。
// 速い経路のファイルが読めないときは、速さを諦めて main に回す（t777）。
// main も読めないときは dist が無いか古いので、直し方を英語で出して終える。ほかの読み込みの失敗は握りつぶさない
// Node が 24 より古いときは、dist を読む前に直し方を英語で出して終える（t782）。dist と依存は Node 24 以上向け（engines）なので、
// 古い node では読み込みや実行がどこで壊れるか分からない。拡張の起動ファイルは current の node を検査せずに使うが、
// それは拡張ホストの node で、engines により 24 以上に決まる。ここはどの node で呼ばれても見る。
// 終了コードは PreToolUse のフック（hook PreToolUse）だけ 2 にする。Claude Code は PreToolUse の終了コード 1 を
// ツールを止めない誤りとして扱うので、1 だとフックの守りが黙って外れる。2 はツールの呼び出しを拒む。ほかのコマンドは 1
import { nodeVersionExitCodeOf, nodeVersionProblemOf } from "./node-version.mjs";
import { runEntry } from "./run-entry.mjs";

const argv = process.argv.slice(2);
const nodeProblem = nodeVersionProblemOf(process.versions.node, argv);
if (nodeProblem !== undefined) {
  process.stderr.write(nodeProblem);
  process.exitCode = nodeVersionExitCodeOf(argv);
} else {
  // dist が今のものでないときの失敗。ファイルが無いとき（ERR_MODULE_NOT_FOUND）と、部分的な再ビルドで古い dist が
  // import 先の名前を持たないとき（SyntaxError の "does not provide an export named"）。どちらも同じく扱う
  const isStaleDist = (error) =>
    error?.code === "ERR_MODULE_NOT_FOUND" ||
    (error instanceof SyntaxError && error.message.includes("does not provide an export named"));

  process.exitCode = await runEntry(argv, {
    loadFastHook: async () => {
      try {
        return (await import("../dist/fast-hook.js")).tryFastHook;
      } catch (error) {
        if (!isStaleDist(error)) throw error;
        return undefined;
      }
    },
    runMain: async (opts) => {
      let main;
      try {
        ({ main } = await import("../dist/main.js"));
      } catch (error) {
        if (!isStaleDist(error)) throw error;
        process.stderr.write(
          [
            `dg: the built CLI in dist/ is missing or out of date (${error.message}).`,
            "Run `mise run build` in the deguboard repository (`mise run setup` in a new worktree), then run dg again.",
            "",
          ].join("\n"),
        );
        return 1;
      }
      return main(argv, opts);
    },
  });
}
