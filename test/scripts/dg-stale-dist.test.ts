// bin/dg.js が、dist をビルドしたコミットと今の HEAD が違うときだけ mise run build を案内する警告を stderr に出すことを確かめる（t973）。
// 判定は bin/build-info.mjs、記録は scripts/write-build-info.mjs（mise run build の最後）。
// 配線は、一時リポジトリに bin/ を写し、偽の dist/main.js を置いて dg.js を動かし、JSON の出力と終了コードが変わらないことも見る。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILD_INFO_FILE,
  readHeadCommit,
  staleDistWarningOf,
} from "../../packages/cli/bin/build-info.mjs";
import { createLocalOnlyRepo, git } from "../../packages/core/test/helpers/git-fixture.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "packages/cli/bin");
const WRITE_BUILD_INFO = path.join(ROOT, "scripts/write-build-info.mjs");

let repo: { dir: string; cleanup(): Promise<void> };

beforeEach(async () => {
  repo = await createLocalOnlyRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

/** dir に 1 つコミットして、その SHA を返す */
async function commit(dir: string, name: string): Promise<string> {
  await writeFile(path.join(dir, name), name);
  await git(dir, ["add", name]);
  await git(dir, ["commit", "--quiet", "-m", name]);
  return (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
}

async function writeBuiltCommit(dir: string, sha: string) {
  const dist = path.join(dir, "packages/cli/dist");
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, BUILD_INFO_FILE), `${JSON.stringify({ commit: sha })}\n`);
}

function run(file: string, args: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, [file, ...args], { cwd }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      done({ code, stdout, stderr });
    });
  });
}

describe("今の HEAD を git を起動せずに読む（t973）", () => {
  it("ブランチの ref を、loose の ref からも packed-refs からも git rev-parse と同じく読む", async () => {
    const sha = await commit(repo.dir, "a");
    expect(readHeadCommit(repo.dir)).toBe(sha);
    await git(repo.dir, ["pack-refs", "--all"]);
    expect(existsSync(path.join(repo.dir, ".git/refs/heads/main"))).toBe(false);
    expect(readHeadCommit(repo.dir)).toBe(sha);
  });

  it("HEAD を切り離した checkout は HEAD の SHA を読む", async () => {
    const first = await commit(repo.dir, "a");
    await commit(repo.dir, "b");
    await git(repo.dir, ["checkout", "--quiet", "--detach", first]);
    expect(readHeadCommit(repo.dir)).toBe(first);
  });

  it("git worktree（.git がファイル）は、その worktree の HEAD を読む", async () => {
    const first = await commit(repo.dir, "a");
    const wt = `${repo.dir}-wt`;
    await git(repo.dir, ["worktree", "add", "--quiet", "-b", "feat", wt]);
    const second = await commit(wt, "b");
    expect(readHeadCommit(wt)).toBe(second);
    expect(readHeadCommit(repo.dir)).toBe(first);
    await git(repo.dir, ["pack-refs", "--all"]);
    expect(readHeadCommit(wt)).toBe(second);
  });

  it("git の checkout でないところは読めない（undefined）", async () => {
    expect(readHeadCommit(path.dirname(repo.dir))).toBeUndefined();
  });
});

describe("dist が古いときの警告（t973）", () => {
  it("記録したコミットが今の HEAD と同じなら黙る", async () => {
    const sha = await commit(repo.dir, "a");
    await writeBuiltCommit(repo.dir, sha);
    expect(staleDistWarningOf(repo.dir)).toBeUndefined();
  });

  it("違えば、両方のコミットと mise run build を英語で案内する", async () => {
    const built = await commit(repo.dir, "a");
    await writeBuiltCommit(repo.dir, built);
    const head = await commit(repo.dir, "b");
    const warning = staleDistWarningOf(repo.dir);
    expect(warning).toContain(built.slice(0, 12));
    expect(warning).toContain(head.slice(0, 12));
    expect(warning).toContain(`Run \`mise run build\` in ${repo.dir}`);
    expect(warning?.endsWith("\n")).toBe(true);
  });

  it("記録がない・読めないときは判定できないので黙る", async () => {
    await commit(repo.dir, "a");
    expect(staleDistWarningOf(repo.dir)).toBeUndefined();
    await mkdir(path.join(repo.dir, "packages/cli/dist"), { recursive: true });
    await writeFile(path.join(repo.dir, "packages/cli/dist", BUILD_INFO_FILE), "{");
    expect(staleDistWarningOf(repo.dir)).toBeUndefined();
  });
});

describe("scripts/write-build-info.mjs（t973）", () => {
  it("今の HEAD を packages/cli/dist/build-info.json に書き、そのあとの判定は黙る", async () => {
    const sha = await commit(repo.dir, "a");
    expect((await run(WRITE_BUILD_INFO, [repo.dir], repo.dir)).code).toBe(0);
    const written = JSON.parse(
      await readFile(path.join(repo.dir, "packages/cli/dist", BUILD_INFO_FILE), "utf8"),
    );
    expect(written).toEqual({ commit: sha });
    expect(staleDistWarningOf(repo.dir)).toBeUndefined();
  });

  it("git の checkout でなければ、古い記録を消して何も書かない", async () => {
    const outside = path.join(path.dirname(repo.dir), "plain");
    await writeBuiltCommit(outside, "a".repeat(40));
    expect((await run(WRITE_BUILD_INFO, [outside], outside)).code).toBe(0);
    expect(existsSync(path.join(outside, "packages/cli/dist", BUILD_INFO_FILE))).toBe(false);
  });
});

describe("bin/dg.js の配線（t973）", () => {
  /** repo に bin/ の写しと、引数を JSON で出して 3 で終わる偽の dist/main.js を置く */
  async function layOut(): Promise<string> {
    const bin = path.join(repo.dir, "packages/cli/bin");
    await mkdir(bin, { recursive: true });
    for (const name of ["dg.js", "build-info.mjs", "node-version.mjs", "run-entry.mjs"]) {
      await copyFile(path.join(BIN, name), path.join(bin, name));
    }
    await writeFile(
      path.join(repo.dir, "packages/cli/dist/main.js"),
      'export async function main(argv) { process.stdout.write(JSON.stringify({ argv }) + "\\n"); return 3; }\n',
    );
    return path.join(bin, "dg.js");
  }

  it("dist が今の HEAD のものなら警告を出さず、古ければ stderr にだけ出す。stdout と終了コードは同じ", async () => {
    const built = await commit(repo.dir, "a");
    await writeBuiltCommit(repo.dir, built);
    const dg = await layOut();

    const fresh = await run(dg, ["--json", "status"], repo.dir);
    expect(fresh).toEqual({ code: 3, stdout: '{"argv":["--json","status"]}\n', stderr: "" });

    await commit(repo.dir, "b");
    const stale = await run(dg, ["--json", "status"], repo.dir);
    expect(stale.code).toBe(3);
    expect(stale.stdout).toBe(fresh.stdout);
    expect(stale.stderr).toContain("dg: warning: the built CLI in dist/ was built from commit");
    expect(stale.stderr).toContain("mise run build");
  });
});
