// scripts/check-pack.mjs が、tarball のどれかに package/LICENSE がなければ失敗することを確かめる（t471）。
// 本物の pack の代わりに、一時ディレクトリに tar で作った小さな tgz を使う

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/check-pack.mjs");
const run = promisify(execFile);

let dir: string;
let release: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "check-pack-"));
  release = join(dir, "release");
  await mkdir(release);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** package/ の下に files を置いた tgz を release/ に作る */
async function tarball(name: string, files: string[]): Promise<void> {
  const src = join(dir, `src-${name}`);
  await mkdir(join(src, "package"), { recursive: true });
  for (const file of files) await writeFile(join(src, "package", file), "x");
  await run("tar", ["czf", join(release, `${name}.tgz`), "-C", src, "package"]);
}

async function check(): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, release]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("check-pack", () => {
  it("3 つの tarball のどれにも LICENSE があれば通る", async () => {
    for (const name of ["a", "b", "c"]) await tarball(name, ["LICENSE", "package.json"]);
    const outcome = await check();
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("ok c.tgz");
  });

  it("どれかに LICENSE がなければ失敗し、その tarball の名前を出す", async () => {
    await tarball("a", ["LICENSE", "package.json"]);
    await tarball("b", ["package.json"]);
    await tarball("c", ["LICENSE", "package.json"]);
    const outcome = await check();
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("b.tgz");
  });

  it("tarball が 3 つそろっていなければ失敗する", async () => {
    await tarball("a", ["LICENSE"]);
    const outcome = await check();
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("check-pack: tarball が 1 個");
  });

  it("ディレクトリがなければ pack を先に走らせるよう案内して失敗する", async () => {
    await rm(release, { recursive: true });
    const outcome = await check();
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("先に mise run pack を実行する");
  });
});
