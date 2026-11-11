// scripts/link-dg.mjs が ~/.local/bin/dg をこのリポジトリの dg.js に張ることを確かめる（t668）。
// HOME を一時ディレクトリにして本物の ~/.local/bin に触れないようにする。張り替えと、通常のファイルを消さずに止まることも見る。
// PATH に ~/.local/bin がなければ足す一行を出すことも見る。

import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/link-dg.mjs");
const TARGET = join(ROOT, "packages/cli/bin/dg.js");

let home: string;
let bin: string;
let link: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "link-dg-"));
  bin = join(home, ".local", "bin");
  link = join(bin, "dg");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** link-dg を一時ディレクトリの HOME と指定の PATH で動かす */
function run(path: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { env: { ...process.env, HOME: home, PATH: path } },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        done({ code, stdout, stderr });
      },
    );
  });
}

describe("mise run dg:link（link-dg.mjs）", () => {
  it("~/.local/bin/dg をこのリポジトリの dg.js に張り、二度目は同じ結果で終わる", async () => {
    const first = await run(`${bin}:/usr/bin:/bin`);
    expect(first.code).toBe(0);
    expect(await readlink(link)).toBe(TARGET);
    expect(first.stdout).toContain("を張った");
    expect(first.stdout).toContain("dg --version");
    expect(first.stdout).not.toContain("PATH にない");

    const second = await run(`${bin}:/usr/bin:/bin`);
    expect(second.code).toBe(0);
    expect(await readlink(link)).toBe(TARGET);
    expect(second.stdout).toContain("既に");
  });

  it("前の張り先が別のリンク（壊れたリンクを含む）なら張り替える", async () => {
    await mkdir(bin, { recursive: true });
    await symlink("/nonexistent/old/dg.js", link);

    const result = await run(`${bin}:/usr/bin:/bin`);
    expect(result.code).toBe(0);
    expect(await readlink(link)).toBe(TARGET);
    expect(result.stdout).toContain("張り替えた");
    expect(result.stdout).toContain("/nonexistent/old/dg.js");
  });

  it("通常のファイルがあれば消さずに止まる", async () => {
    await mkdir(bin, { recursive: true });
    await writeFile(link, "other dg");

    const result = await run(`${bin}:/usr/bin:/bin`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("消さずに止めた");
    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await readFile(link, "utf8")).toBe("other dg");
  });

  it("PATH に ~/.local/bin がなければ、足す一行を案内する", async () => {
    const result = await run("/usr/bin:/bin");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });
});
