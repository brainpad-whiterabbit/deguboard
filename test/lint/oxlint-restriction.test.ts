// .oxlintrc.json の web の import の制限が効いていることを確かめる（ADR-007）。
// 制限は設定の書き方しだいで黙って効かなくなる（t176：patterns の否定に当たると paths 以外の制限が外れた）ので、
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
  "packages/web/src/value-import.test.tsx":
    'import { progressOf } from "@deguboard/core";\nexport const f = progressOf;\n',
};

interface Diagnostic {
  code: string;
  filename: string;
}

let dir: string;
/** ファイルごとの no-restricted-imports の指摘の数 */
const restricted = new Map<string, number>();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "dg-oxlint-"));
  await copyFile(join(ROOT, ".oxlintrc.json"), join(dir, ".oxlintrc.json"));
  for (const [path, content] of Object.entries(SAMPLES)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  // 指摘があると oxlint は 1 で終わるので、失敗しても標準出力の JSON を読む
  const stdout = await execFileAsync(
    process.execPath,
    [OXLINT, "-c", ".oxlintrc.json", "-f", "json", "packages"],
    { cwd: dir },
  ).then(
    (r) => r.stdout,
    (e: { stdout?: string }) => e.stdout ?? "",
  );
  const { diagnostics } = JSON.parse(stdout) as { diagnostics: Diagnostic[] };
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
});
