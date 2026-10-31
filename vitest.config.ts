import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // Git を使うテストは bare リモートと clone を作るので余裕を持たせる
    testTimeout: 20_000,
  },
});
