import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("dg.mjs は入口だけを持ち、隣の 1 つの本体の chunk を読む", async () => {
    const files = await readdir(outDir);
    const mains = files.filter((f) => /^dg-main-[\w-]+\.mjs$/.test(f));
    expect(mains).toHaveLength(1);
    // dg.mjs の外の .mjs は、本体の chunk と、本体から名前を写すだけの chunk だけ
    for (const f of files.filter((f) => f.endsWith(".mjs") && f !== "dg.mjs" && f !== mains[0])) {
      expect(await readFile(path.join(outDir, f), "utf8")).toMatch(
        new RegExp(`^export \\{[^}]*\\} from "\\./${mains[0]!.replaceAll(".", "\\.")}";\\s*$`),
      );
    }
    const entry = await readFile(path.join(outDir, "dg.mjs"), "utf8");
    expect(entry).toContain("enableCompileCache");
    expect(entry.length).toBeLessThan(2_000);
    // 本体は、キャッシュを有効にした後に動的な import で読む
    expect(entry.indexOf("enableCompileCache")).toBeLessThan(entry.indexOf("import("));
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
});
