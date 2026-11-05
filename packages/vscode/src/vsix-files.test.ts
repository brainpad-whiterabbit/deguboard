import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * VSIX に入れてよいファイルの許可リスト（パッケージ直下からの相対パス）。
 * ここにないファイルが入ると落ちる。足すときは、配布してよいものか（ソース・テスト・設定・秘密でないか）を確かめてから足す。
 * dist の中のファイル名はビルドごとにハッシュが変わるので、assets は拡張子で許す。
 * dist が未ビルド・LICENSE が未コピーでも通るよう、「許可リストの全部が入っていること」は求めない。
 */
const allowed: RegExp[] = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^dist\/extension\.cjs$/,
  /^dist\/THIRD_PARTY_LICENSES\.md$/,
  /^dist\/assets\/[\w.-]+\.cjs$/,
  /^dist\/web\/THIRD_PARTY_LICENSES\.md$/,
  /^dist\/web\/index\.html$/,
  /^dist\/web\/assets\/[\w.-]+\.(js|css)$/,
  /^media\/deguboard\.svg$/,
  /^media\/icon\.png$/,
];

/** 許可リストにないファイルを返す */
function unexpectedFiles(files: string[]): string[] {
  return files.filter((f) => !allowed.some((re) => re.test(f)));
}

describe("VSIX に入るファイル", () => {
  it("vsce ls の結果がすべて許可リストにある", async () => {
    const { stdout } = await run("pnpm", ["exec", "vsce", "ls", "--no-dependencies"], {
      cwd: packageDir,
    });
    const files = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(files).toContain("package.json");
    expect(unexpectedFiles(files)).toEqual([]);
  });

  it("許可リストにないファイルは見つける", () => {
    expect(
      unexpectedFiles(["package.json", "src/extension.ts", ".env", "dist/extension.cjs.map"]),
    ).toEqual(["src/extension.ts", ".env", "dist/extension.cjs.map"]);
  });
});
