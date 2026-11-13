import { execFile, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 入口に渡す環境。DEGUBOARD_ の変数は外して、結果が呼び出し元のセッション（DEGUBOARD_ACTOR など）に左右されないようにする */
const baseEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DEGUBOARD_")));

/** git のコミットに要る名前を足した、入口に渡す環境 */
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...baseEnv(),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});

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

  // NODE_COMPILE_CACHE は環境に置かず、入口の呼び出しだけで既定の置き場所（TMPDIR の下）が使われることを確かめる（t780）。
  // 置き場所は TMPDIR で一時ディレクトリに隔離する。入口の呼び出しを消すと、置き場所もキャッシュのファイルもできない
  const envWithTmpDir = (dir: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...baseEnv(), TMPDIR: dir };
    delete env.NODE_COMPILE_CACHE;
    return env;
  };

  it("入口は、コンパイルキャッシュを既定の置き場所に有効にして、本体の chunk のコンパイル結果を残す", async () => {
    const tmpDir = path.join(tmp, "tmpdir-hit");
    await mkdir(tmpDir);
    const dg = path.join(outDir, "dg.mjs");
    const { stdout } = await run(process.execPath, [dg, "--version"], {
      env: envWithTmpDir(tmpDir),
    });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const entries = await readdir(path.join(tmpDir, "node-compile-cache"), {
      recursive: true,
      withFileTypes: true,
    });
    expect(entries.some((e) => e.isFile())).toBe(true);
  });

  it("2 回目からの起動で、本体の chunk をコンパイルキャッシュから読む", async () => {
    const tmpDir = path.join(tmp, "tmpdir-reuse");
    await mkdir(tmpDir);
    const env = { ...envWithTmpDir(tmpDir), NODE_DEBUG_NATIVE: "COMPILE_CACHE" };
    const dg = path.join(outDir, "dg.mjs");
    await run(process.execPath, [dg, "--version"], { env });
    const second = await run(process.execPath, [dg, "--version"], { env });
    const main = (await readdir(outDir)).find((f) => /^dg-main-[\w-]+\.mjs$/.test(f))!;
    // 本体の chunk を読むときのデバッグ出力で確かめる。この文言は Node の内部のものなので、この 1 件だけが頼る
    // （Node の版が変わって文言が変わったら、このテストだけが落ちる）
    const log = second.stdout + second.stderr;
    expect(log).toMatch(new RegExp(`reading cache from .*${main.replaceAll(".", "\\.")}.*success`));
  });

  it("キャッシュの置き場所に書けなくても、黙って飛ばして動く", async () => {
    // 入口が有効にできなかった失敗を出力せず（標準エラーが空）、続けて本体を動かすことを守るテスト。
    // 入口がキャッシュを有効にする呼び出しの有無は、1 件目のテスト（キャッシュのファイルが残る）が確かめる。
    // 既定の置き場所（TMPDIR の下）がファイルの下になるので、ディレクトリを作れない。Node は投げずに「作れない」と返すだけで、
    // 入口は続けて本体を動かす
    const blocker = path.join(tmp, "not-a-dir");
    await writeFile(blocker, "");
    const { stdout, stderr } = await run(
      process.execPath,
      [path.join(outDir, "dg.mjs"), "--version"],
      { env: envWithTmpDir(blocker) },
    );
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(stderr).toBe("");
  });

  it("PreToolUse と Stop は本体の chunk を読まずに判定する（入口の速い経路。t769・t786）", async () => {
    // 本体の chunk を消したコピーでも、初期化した repo の PreToolUse の拒みは出る。本体が要る --version は動かない
    const copy = path.join(tmp, "cli-no-main");
    await cp(outDir, copy, { recursive: true });
    const mainChunk = (await readdir(copy)).find((f) => /^dg-main-[\w-]+\.mjs$/.test(f))!;
    await rm(path.join(copy, mainChunk));
    const repo = path.join(tmp, "pre-tool-repo");
    await mkdir(repo);
    const env = gitEnv();
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
    // Stop も、データのリポジトリの dg の外の未コミットの変更を本体の chunk なしで伝える（t786）
    await writeFile(path.join(repo, ".git", "deguboard", "outside.md"), "x\n");
    const stop = spawnSync(
      process.execPath,
      [path.join(copy, "dg.mjs"), "--actor", "agent", "hook", "Stop", "--payload", "-"],
      {
        cwd: repo,
        input: JSON.stringify({ session_id: "s-bundle", stop_hook_active: false }),
        encoding: "utf8",
        env,
      },
    );
    expect(stop.status).toBe(0);
    expect(JSON.parse(stop.stdout).decision).toBe("block");
    expect(JSON.parse(stop.stdout).reason).toContain("outside.md");
    const main = spawnSync(process.execPath, [path.join(copy, "dg.mjs"), "--version"], {
      encoding: "utf8",
      env,
    });
    expect(main.status).not.toBe(0);
  }, 60_000);

  it("入口の速い経路が受け持たない入力は、読んだ標準入力を添えて本体の chunk に回り、本体だけを動かした結果と同じになる（t781）", async () => {
    const repo = path.join(tmp, "fallback-repo");
    await mkdir(repo);
    const env = gitEnv();
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await run("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo, env });
    await run(
      process.execPath,
      [path.join(outDir, "dg.mjs"), "init", "--template", "software-development"],
      { cwd: repo, env },
    );
    // 本体だけを動かす参照。入口を通さず、本体の runBundled が標準入力を自分で読む（今の経路）
    const bundleMain = (await readdir(outDir)).find((f) => /^dg-bundle-main-[\w-]+\.mjs$/.test(f))!;
    const mainOnly = path.join(tmp, "main-only.mjs");
    await writeFile(
      mainOnly,
      [
        `import { runBundled } from ${JSON.stringify(pathToFileURL(path.join(outDir, bundleMain)).href)};`,
        `process.exitCode = await runBundled(${JSON.stringify(path.join(outDir, "dg.mjs"))}, {});`,
        "",
      ].join("\n"),
    );
    // 初期化した repo で、標準入力の中身が本体の出力と記録を決める入力を使う（初期化していない repo は標準入力に依らない）
    const cases: Array<[string, string]> = [
      [
        "JSON でない（YAML）で拒む Bash",
        'tool_name: Bash\nsession_id: s-yaml-bundle\ntool_input:\n  command: "gh pr merge 5 --squash"\n',
      ],
      [
        "別のツール（記録だけ残る）",
        JSON.stringify({
          session_id: "s-read-bundle",
          tool_name: "Read",
          tool_input: { file_path: "/etc/hosts" },
          cwd: repo,
        }),
      ],
    ];
    const hookArgs = ["--actor", "agent", "hook", "PreToolUse", "--payload", "-"];
    const localDir = path.join(repo, ".git", "deguboard-local");
    const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g;
    // 記録（hook-inputs と hook-sessions）。時刻は伏せて比べる。入力を読めなければ、どちらにも何も残らない
    const records = async () => {
      const names = await readdir(path.join(localDir, "hook-sessions")).catch(() => [] as string[]);
      const inputs = await readFile(
        path.join(localDir, "hook-inputs", "PreToolUse.json"),
        "utf8",
      ).catch(() => "");
      return `${names.join("\n")}\n${inputs}`.replace(ISO, "<time>");
    };
    const clearRecords = () =>
      Promise.all(
        ["hook-inputs", "hook-sessions"].map((sub) =>
          rm(path.join(localDir, sub), { recursive: true, force: true }),
        ),
      );
    const stdouts: string[] = [];
    for (const [name, input] of cases) {
      const run1 = (script: string[]) => {
        const r = spawnSync(process.execPath, [...script, ...hookArgs], {
          cwd: repo,
          input,
          encoding: "utf8",
          env,
        });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      };
      await clearRecords();
      const expected = run1([mainOnly]);
      const expectedRecords = await records();
      await clearRecords();
      const actual = run1([path.join(outDir, "dg.mjs")]);
      const actualRecords = await records();
      await clearRecords();
      expect(actual, name).toEqual(expected);
      expect(actualRecords, name).toEqual(expectedRecords);
      expect(actual.status, name).toBe(0);
      // 本体が標準入力の中身を読んだこと（読めなければ記録が残らない）
      expect(actualRecords.trim(), name).not.toBe("");
      stdouts.push(actual.stdout);
    }
    // 最初の入力（YAML の拒む Bash）は、本体が読んだ入力で拒まれる（読めなければ拒まれない）
    expect(JSON.parse(stdouts[0]!)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  }, 60_000);
});
