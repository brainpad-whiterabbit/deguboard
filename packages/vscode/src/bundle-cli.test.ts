import { execFile, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 同梱の dg を vite.cli.config.ts で一時ディレクトリに束ね、入口と本体の chunk の分け方と、コンパイルキャッシュが本体に効くことを確かめる（t767）
describe("同梱の dg の束ね方（vite.cli.config.ts）", () => {
  let tmp: string;
  let outDir: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "dg-bundle-"));
    outDir = path.join(tmp, "cli");
    await run("pnpm", ["exec", "vite", "build", "-c", "vite.cli.config.ts", "--outDir", outDir], {
      cwd: packageDir,
    });
  }, 120_000);

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("dg.mjs は入口だけを持ち、隣の本体の chunk と速い経路の小さな chunk を読む", async () => {
    const files = await readdir(outDir);
    const mains = files.filter((f) => /^dg-main-[\w-]+\.mjs$/.test(f));
    expect(mains).toHaveLength(1);
    const entry = await readFile(path.join(outDir, "dg.mjs"), "utf8");
    expect(entry).toContain("enableCompileCache");
    expect(entry.length).toBeLessThan(3_000);
    // 本体と速い経路は、キャッシュを有効にした後に動的な import で読む（入口の静的な import はない）
    expect(entry.indexOf("enableCompileCache")).toBeLessThan(entry.indexOf("import("));
    expect(entry).not.toMatch(/^import .* from "\.\//m);
    // 入口が読むのは、本体と速い経路の名前を写す chunk
    const reads = [...entry.matchAll(/import\("\.\/([^"]+)"\)/g)].map((m) => m[1]!);
    expect(reads).toHaveLength(2);
    const fastChunks = files.filter((f) => /^dg-fast-[\w-]+\.mjs$/.test(f) && !reads.includes(f));
    expect(fastChunks).toHaveLength(1);
    // 速い経路の chunk は本体の chunk を読まない（入口が本体より先に PreToolUse を処理するため）
    expect(await readFile(path.join(outDir, fastChunks[0]!), "utf8")).not.toContain(mains[0]!);
    // dg.mjs の外の .mjs は、本体か速い経路の chunk から名前を写すだけ
    const esc = (s: string) => s.replaceAll(".", "\\.");
    const shim = new RegExp(
      `^export \\{[^}]*\\} from "\\./(${esc(mains[0]!)}|${esc(fastChunks[0]!)})";\\s*$`,
    );
    for (const f of files.filter(
      (f) => f.endsWith(".mjs") && f !== "dg.mjs" && f !== mains[0] && f !== fastChunks[0],
    )) {
      expect(await readFile(path.join(outDir, f), "utf8")).toMatch(shim);
    }
  });

  it("2 回目からの起動で、本体の chunk をコンパイルキャッシュから読む", async () => {
    const cacheDir = path.join(tmp, "compile-cache");
    const env = {
      ...process.env,
      NODE_COMPILE_CACHE: cacheDir,
      NODE_DEBUG_NATIVE: "COMPILE_CACHE",
    };
    const dg = path.join(outDir, "dg.mjs");
    const first = await run(process.execPath, [dg, "--version"], { env });
    expect(first.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const second = await run(process.execPath, [dg, "--version"], { env });
    const log = second.stdout + second.stderr;
    expect(log).toMatch(/V8 code cache for ESM file:\/\/\S*dg-main-[\w-]+\.mjs was accepted/);
  });

  it("キャッシュの置き場所に書けなくても、黙って飛ばして動く", async () => {
    const blocker = path.join(tmp, "not-a-dir");
    // ファイルの下にはディレクトリを作れない
    await writeFile(blocker, "");
    const env = { ...process.env, NODE_COMPILE_CACHE: path.join(blocker, "cache") };
    const { stdout, stderr } = await run(
      process.execPath,
      [path.join(outDir, "dg.mjs"), "--version"],
      {
        env,
      },
    );
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(stderr).toBe("");
  });

  it("PreToolUse は本体の chunk を読まずに判定する（入口の速い経路。t769）", async () => {
    // 本体の chunk を消したコピーでも、初期化した repo の PreToolUse の拒みは出る。本体が要る --version は動かない
    const copy = path.join(tmp, "cli-no-main");
    await cp(outDir, copy, { recursive: true });
    const mainChunk = (await readdir(copy)).find((f) => /^dg-main-[\w-]+\.mjs$/.test(f))!;
    await rm(path.join(copy, mainChunk));
    const repo = path.join(tmp, "pre-tool-repo");
    await mkdir(repo);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await run("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo, env });
    await run(
      process.execPath,
      [path.join(outDir, "dg.mjs"), "init", "--template", "software-development"],
      { cwd: repo, env },
    );
    const input = JSON.stringify({
      session_id: "s-bundle",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 5 --squash" },
      cwd: repo,
    });
    const hook = spawnSync(
      process.execPath,
      [path.join(copy, "dg.mjs"), "--actor", "agent", "hook", "PreToolUse", "--payload", "-"],
      { cwd: repo, input, encoding: "utf8", env },
    );
    expect(hook.status).toBe(0);
    expect(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const main = spawnSync(process.execPath, [path.join(copy, "dg.mjs"), "--version"], {
      encoding: "utf8",
    });
    expect(main.status).not.toBe(0);
  }, 60_000);
});
