import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 相対パスで出す（dg serve の / でも VS Code の Webview の URI でも読めるように）
// 束ねた依存のライセンス表示を THIRD_PARTY_LICENSES.md に集める（cli の web と VSIX の dist/web に入る）
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, license: { fileName: "THIRD_PARTY_LICENSES.md" } },
});
