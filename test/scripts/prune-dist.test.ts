// scripts/prune-dist.mjs が、tsc -b のあとの dist/ から今のソースに対応しない出力だけを消すことを確かめる（t871）。
// build のスクリプトから呼ぶことも見て、build を書き換えて黙って古い出力が残るようになるのを防ぐ。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/prune-dist.mjs");

let pkg: string;

beforeEach(async () => {
  pkg = await mkdtemp(join(tmpdir(), "prune-dist-"));
});

afterEach(async () => {
  await rm(pkg, { recursive: true, force: true });
});

/** pkg の下にファイルを作る */
async function touch(...rels: string[]) {
  for (const rel of rels) {
    await mkdir(dirname(join(pkg, rel)), { recursive: true });
    await writeFile(join(pkg, rel), "");
  }
}

function run(...dirs: string[]) {
  return new Promise<number>((done) => {
    execFile(process.execPath, [SCRIPT, ...dirs], (error) => {
      done(error ? (typeof error.code === "number" ? error.code : 1) : 0);
    });
  });
}

describe("prune-dist.mjs", () => {
  it("ソースがある出力は残し、ソースが消えた出力と空になったディレクトリは消す", async () => {
    await touch(
      "src/a.ts",
      "src/sub/b.tsx",
      "src/guide/guide-x.md",
      "dist/a.js",
      "dist/a.d.ts",
      "dist/a.js.map",
      "dist/a.d.ts.map",
      "dist/sub/b.js",
      "dist/sub/b.d.ts",
      "dist/gone.js",
      "dist/gone.d.ts",
      "dist/gone.js.map",
      "dist/gone.d.ts.map",
      "dist/old/c.js",
      "dist/old/c.d.ts",
      "dist/a.test.js",
      "dist/guide/guide-x.md",
      "dist/guide/guide-gone.md",
    );

    expect(await run(pkg)).toBe(0);

    for (const kept of [
      "dist/a.js",
      "dist/a.d.ts",
      "dist/a.js.map",
      "dist/a.d.ts.map",
      "dist/sub/b.js",
      "dist/sub/b.d.ts",
      "dist/guide/guide-x.md",
    ]) {
      expect(existsSync(join(pkg, kept)), kept).toBe(true);
    }
    for (const removed of [
      "dist/gone.js",
      "dist/gone.d.ts",
      "dist/gone.js.map",
      "dist/gone.d.ts.map",
      "dist/old",
      "dist/a.test.js",
      "dist/guide/guide-gone.md",
    ]) {
      expect(existsSync(join(pkg, removed)), removed).toBe(false);
    }
  });

  it("dist がなければ何もせずに終わる", async () => {
    await touch("src/a.ts");
    expect(await run(pkg)).toBe(0);
    expect(existsSync(join(pkg, "dist"))).toBe(false);
  });

  it("build は dist を先に消さず、tsc -b と guide の写しのあとで prune-dist を呼ぶ", async () => {
    const { scripts } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const steps: string[] = scripts.build.split("&&").map((s: string) => s.trim());
    const prune = steps.indexOf("node scripts/prune-dist.mjs");
    expect(prune).toBeGreaterThan(steps.indexOf("tsc -b tsconfig.build.json"));
    expect(prune).toBeGreaterThan(steps.findIndex((s) => s.includes("guide-*.md")));
    expect(steps.indexOf("tsc -b tsconfig.build.json")).toBe(0);
    expect(scripts.build).not.toMatch(/rm -rf packages\/(core|server|cli)\/dist/);
  });
});
