import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// 拡張に同梱する dg を、小さな入口（dist/cli/dg.mjs）と、core・server・cli と MCP SDK などの依存を束ねた本体の chunk
// （dist/cli/dg-main-<hash>.mjs）の ESM に分ける。入口はコンパイルキャッシュを有効にしてから、PreToolUse の速い経路（dg-fast-<hash>.mjs）か本体を読む（packages/cli/src/bundle.ts）。
// 本体の中の動的な import（dg serve の server・dg mcp など）も本体の chunk に入れる。動的な import の先ごとに、本体から名前を
// 写すだけの小さな chunk（dg-<name>-<hash>.mjs）ができる。ネイティブのモジュールはないので、プラットフォームごとの VSIX に分けない。
// 拡張の本体（vite.config.ts）の後に走り、dist を消さない。Web の画面（dist/web）と guide（dist/guide-*.md）は拡張の本体と共有する。
// 本体の chunk は dg.mjs の隣にあるので、../web と bundleLayout の guideDir で引ける（packages/cli/src/bundle-main.ts）。
// skill.md は dg.mjs の隣に置く（package.json の build）。束ねた依存のライセンス表示は dist/cli/ に集める
const cliPkg = JSON.parse(
  readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

const entryPath = "/cli/src/bundle.ts";

// PreToolUse の速い経路（t769）が静的に読むファイル（packages/ からの相対）。入口の dg.mjs はこれだけを読み、本体の chunk を読まない。
// 一覧の正本は fast-hook.test.ts の ALLOWED。足すときは両方に足す（bundle-cli.test.ts が、本体の chunk を読まずに判定することを確かめる）
const FAST_PATH_FILES = [
  "cli/src/fast-hook.ts",
  "core/src/fast-hook.ts",
  "core/src/agents/fast-hooks.ts",
  "core/src/agents/adapters/claude-code-hooks.ts",
  "core/src/agents/adapters/transcript.ts",
  "core/src/commands/hook-argv.ts",
  "core/src/commands/hook-records.ts",
  "core/src/commands/pre-tool-use.ts",
  "core/src/model/time.ts",
  "core/src/git/repo.ts",
  "core/src/git/run.ts",
  "core/src/errors.ts",
  "core/src/storage/exists.ts",
].map((f) => `/packages/${f}`);

export default defineConfig({
  ssr: { noExternal: true, resolve: { conditions: ["development", "node"] } },
  define: { __DG_VERSION__: JSON.stringify(cliPkg.version) },
  build: {
    ssr: `..${entryPath}`,
    target: "node24",
    outDir: "dist/cli",
    emptyOutDir: true,
    license: { fileName: "THIRD_PARTY_LICENSES.md" },
    rollupOptions: {
      output: {
        format: "esm",
        entryFileNames: "dg.mjs",
        chunkFileNames: "dg-[name]-[hash].mjs",
        // 入口のほかのモジュールをすべて 1 つの本体の chunk に集める（既定の分け方では依存ごとに chunk が散る）。
        // ただし速い経路のファイルは、本体より先の group に入れて小さな chunk（dg-fast-*.mjs）にする
        codeSplitting: {
          groups: [
            { name: "fast", test: (id: string) => FAST_PATH_FILES.some((f) => id.endsWith(f)) },
            { name: "main", test: (id: string) => !id.endsWith(entryPath) },
          ],
        },
      },
    },
  },
});
