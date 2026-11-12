import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// 拡張に同梱する dg を、core・server・cli と MCP SDK などの依存ごと 1 つの ESM（dist/cli/dg.mjs）に束ねる。
// ネイティブのモジュールはないので、プラットフォームごとの VSIX に分けない。拡張の本体（vite.config.ts）の後に走り、dist を消さない。
// Web の画面（dist/web）と guide（dist/guide-*.md）は拡張の本体と共有する。dg.mjs からは ../web と bundleLayout の guideDir で引く
// （packages/cli/src/bundle.ts）。skill.md は dg.mjs の隣に置く（package.json の build）。束ねた依存のライセンス表示は dist/cli/ に集める
const cliPkg = JSON.parse(
  readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

export default defineConfig({
  ssr: { noExternal: true, resolve: { conditions: ["development", "node"] } },
  define: { __DG_VERSION__: JSON.stringify(cliPkg.version) },
  build: {
    ssr: "../cli/src/bundle.ts",
    target: "node24",
    outDir: "dist/cli",
    emptyOutDir: true,
    license: { fileName: "THIRD_PARTY_LICENSES.md" },
    rollupOptions: {
      // 動的な import（dg serve の server・dg mcp）も同じファイルに入れ、1 つのファイルで動かす
      output: { format: "esm", entryFileNames: "dg.mjs", codeSplitting: false },
    },
  },
});
