// .oxlintrc.json の web の import の制限が効いていることを確かめる（ADR-033）。
// 制限は設定の書き方しだいで黙って効かなくなる（t176：patterns のどれかの否定に当たると、ほかの patterns でも制限しなかった）ので、
// 本物の設定を一時ディレクトリに写し、web の本体とテストの位置に置いた見本に oxlint をかけて結果を見る

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OXLINT = join(ROOT, "node_modules/oxlint/bin/oxlint");

/** 見本のファイル。path は設定の overrides の files と照らす、リポジトリの根からの位置 */
const SAMPLES: Record<string, string> = {
  "packages/web/src/value-import.ts":
    'import { progressOf } from "@deguboard/core";\nexport const f = progressOf;\n',
  "packages/web/src/type-import.ts":
    'import type { Ticket } from "@deguboard/core";\nexport type T = Ticket;\n',
  "packages/web/src/server-import.ts":
    'import type { Server } from "@deguboard/server";\nexport type S = Server;\n',
  "packages/web/src/value-import.test.ts":
    'import { progressOf } from "@deguboard/core";\nexport const f = progressOf;\n',
  "packages/web/src/server-import.test.ts":
    'import type { Server } from "@deguboard/server";\nexport type S = Server;\n',
  "packages/web/src/value-import.test.tsx":
    'import { progressOf } from "@deguboard/core";\nexport const f = progressOf;\n',
  "packages/core/src/node-http-import.ts":
    'import { createServer } from "node:http";\nexport const s = createServer;\n',
  "packages/core/src/commands/bare-http-import.ts":
    'import { createServer } from "http";\nexport const s = createServer;\n',
  "packages/core/src/node-path-import.ts":
    'import { join } from "node:path";\nexport const j = join;\n',
};

interface Diagnostic {
  code: string;
  filename: string;
}

let dir: string;
/** oxlint が対象にしたファイルの数 */
let linted = 0;
/** ファイルごとの no-restricted-imports の指摘の数 */
const restricted = new Map<string, number>();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "dg-oxlint-"));
  await copyFile(join(ROOT, ".oxlintrc.json"), join(dir, ".oxlintrc.json"));
  for (const [path, content] of Object.entries(SAMPLES)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  // 指摘があると oxlint は 1 で終わるので、失敗しても標準出力の JSON を読む。JSON がなければ標準エラーを添えて投げる
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [OXLINT, "-c", ".oxlintrc.json", "-f", "json", "packages"],
    { cwd: dir },
  ).catch((e: { stdout?: string; stderr?: string }) => ({
    stdout: e.stdout ?? "",
    stderr: e.stderr ?? "",
  }));
  let result: { diagnostics: Diagnostic[]; number_of_files: number };
  try {
    result = JSON.parse(stdout) as typeof result;
  } catch {
    throw new Error(`oxlint の出力を JSON として読めない\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  const { diagnostics } = result;
  linted = result.number_of_files;
  for (const d of diagnostics) {
    if (d.code !== "eslint(no-restricted-imports)") continue;
    const file = d.filename.replaceAll("\\", "/");
    restricted.set(file, (restricted.get(file) ?? 0) + 1);
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("web の import の制限（.oxlintrc.json）", () => {
  it("見本がすべて oxlint の対象になる（外れると「通る」の確かめが空振りする）", () => {
    expect(linted).toBe(Object.keys(SAMPLES).length);
  });

  it("web の本体で core から値を import すると落ちる", () => {
    expect(restricted.get("packages/web/src/value-import.ts")).toBe(1);
  });

  it("web の本体で core から import type するのは通る", () => {
    expect(restricted.get("packages/web/src/type-import.ts")).toBeUndefined();
  });

  it("web の本体で core 以外の @deguboard/* を import すると落ちる", () => {
    expect(restricted.get("packages/web/src/server-import.ts")).toBe(1);
  });

  it("web のテストのファイルでは core から値を import しても通る", () => {
    expect(restricted.get("packages/web/src/value-import.test.ts")).toBeUndefined();
    expect(restricted.get("packages/web/src/value-import.test.tsx")).toBeUndefined();
  });

  it("web のテストのファイルでも core 以外の @deguboard/* を import すると落ちる", () => {
    expect(restricted.get("packages/web/src/server-import.test.ts")).toBe(1);
  });
});

describe("core の import の制限（.oxlintrc.json）", () => {
  it("core の本体で node:http を import すると落ちる", () => {
    expect(restricted.get("packages/core/src/node-http-import.ts")).toBe(1);
  });

  it("core の汎用部分（core/commands）で素の http を import すると落ちる。上の override が下の制限を上書きするので、ここも別に確かめる", () => {
    expect(restricted.get("packages/core/src/commands/bare-http-import.ts")).toBe(1);
  });

  it("core で node:path など HTTP 以外の node モジュールを import しても通る", () => {
    expect(restricted.get("packages/core/src/node-path-import.ts")).toBeUndefined();
  });
});
