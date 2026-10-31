import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 相対パスで出す（dg serve の / でも VS Code の Webview の URI でも読めるように）
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
