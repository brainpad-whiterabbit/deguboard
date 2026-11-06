// scripts/vsix-sha256.mjs が、VSIX の SHA256 と Release の本文に貼る文を出すことを確かめる（t471）

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/vsix-sha256.mjs");
const run = promisify(execFile);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vsix-sha256-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("vsix-sha256", () => {
  it("VSIX の SHA256 と確かめ方の文を出す", async () => {
    const vsix = join(dir, "deguboard-vscode.vsix");
    await writeFile(vsix, "fake vsix");
    const sha256 = createHash("sha256").update("fake vsix").digest("hex");
    const { stdout } = await run(process.execPath, [SCRIPT, vsix]);
    expect(stdout).toContain(`deguboard-vscode.vsix の SHA256：${sha256}`);
    expect(stdout).toContain("`sha256sum deguboard-vscode.vsix` を実行し");
  });
});
