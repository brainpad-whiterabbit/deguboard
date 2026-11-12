import { defineConfig } from "vite";

// vscode:uninstall が走らせる dist/uninstall.mjs を 1 つのファイルに束ねる。VS Code の API には触れず、node だけで動く。
// 拡張の本体（vite.config.ts）の後に走り、dist を消さない（vite.cli.config.ts と同じ作り）
export default defineConfig({
  ssr: { noExternal: true, resolve: { conditions: ["development", "node"] } },
  build: {
    ssr: "src/uninstall.ts",
    target: "node24",
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      output: { format: "esm", entryFileNames: "uninstall.mjs" },
    },
  },
});
