// scripts/test-related.mjs（mise run test:related の本体）が、origin/main との分岐点を取れないときに 1 行を出して
// 非 0 で終わることを確かめる（t1132）。スクリプトはそれ自身の場所からリポジトリのルートを決めるので、本物のリポジトリに
// 触れないよう、origin のない一時のリポジトリにスクリプトと選び方のファイルを写して動かす。回す・知らせる・何もしないの
// 組み合わせは test/scripts/related-tests.test.ts が planRelatedRun で確かめる
import { execFile, execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "test-related-"));
  await mkdir(join(dir, "scripts", "lib"), { recursive: true });
  await copyFile(join(ROOT, "scripts/test-related.mjs"), join(dir, "scripts/test-related.mjs"));
  await copyFile(
    join(ROOT, "scripts/lib/related-tests.mjs"),
    join(dir, "scripts/lib/related-tests.mjs"),
  );
  execFileSync("git", ["init", "-q"], { cwd: dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("mise run test:related の本体（test-related.mjs）", () => {
  it("origin/main との分岐点が取れなければ、1 行を出して非 0 で終わる", async () => {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      execFile(
        process.execPath,
        [join(dir, "scripts/test-related.mjs")],
        { cwd: dir },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
          done({ code, stdout, stderr });
        },
      );
    });
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "test:related: cannot find the merge base with origin/main (fetch origin, or check that the remote is named origin)\n",
    });
  });
});
