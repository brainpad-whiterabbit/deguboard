import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// 拡張ホスト向けに 1 つの CommonJS に束ねる。core は src から取り込み（development 条件）、vscode だけ外に残す
// 束ねた依存のライセンス表示は dist/THIRD_PARTY_LICENSES.md に集める
const corePkg = JSON.parse(
  readFileSync(new URL("../core/package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

export default defineConfig({
  ssr: { noExternal: true, resolve: { conditions: ["development", "node"] } },
  define: { __CORE_VERSION__: JSON.stringify(corePkg.version) },
  build: {
    ssr: "src/extension.ts",
    target: "node24",
    outDir: "dist",
    emptyOutDir: true,
    license: { fileName: "THIRD_PARTY_LICENSES.md" },
    rollupOptions: {
      external: ["vscode"],
      output: { format: "cjs", entryFileNames: "extension.cjs" },
    },
  },
});
