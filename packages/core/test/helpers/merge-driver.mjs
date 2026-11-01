// テスト用のマージドライバ。ビルドせずに core の src（TypeScript）の runMergeDriver を git から呼ぶ。
// node --experimental-transform-types で動かし、相対 import の .js を .ts に読み替える
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js"))
        return next(`${specifier.slice(0, -3)}.ts`, context);
      throw error;
    }
  },
});

const { runMergeDriver } = await import("../../src/git/merge.ts");
process.exitCode = await runMergeDriver(process.argv.slice(2));
