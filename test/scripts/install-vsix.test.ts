// scripts/install-vsix.mjs が code CLI の応答を待ち続けないことを確かめる（t230）。
// 本物の code の代わりに、PATH の先頭に置いた node のスクリプト（偽の code）を使う。偽の code は本物のリモートの CLI と同じく
// 子のプロセスを起こすので、上限を超えたときに子まで止まることも見る

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/install-vsix.mjs");

/**
 * 偽の code。--version と --install-extension のそれぞれで、FAKE_VERSION・FAKE_INSTALL の指定どおりに振る舞う。
 * hang は子のプロセスを起こしてその pid を FAKE_PID_FILE に書き、上限なく待つ。数字はその終了コードで終える
 */
const FAKE_CODE = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const mode = process.argv[2] === "--version" ? process.env.FAKE_VERSION : process.env.FAKE_INSTALL;
if (mode === "hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_PID_FILE, String(child.pid));
  setInterval(() => {}, 1000);
} else {
  if (process.argv[2] === "--version") console.log("1.0.0");
  process.exit(Number(mode ?? 0));
}
`;

let dir: string;
let vsix: string;
let pidFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "install-vsix-"));
  vsix = join(dir, "fake.vsix");
  pidFile = join(dir, "child.pid");
  await writeFile(vsix, "");
  const code = join(dir, "bin", "code");
  await mkdir(join(dir, "bin"));
  await writeFile(code, FAKE_CODE);
  await chmod(code, 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

/** install-vsix を動かす。withCode が false なら PATH に code を置かない（node だけ） */
function run(env: Record<string, string>, withCode = true): Promise<Outcome> {
  const nodeDir = dirname(process.execPath);
  const PATH = withCode ? [join(dir, "bin"), nodeDir].join(delimiter) : nodeDir;
  const started = Date.now();
  return new Promise((done) => {
    execFile(
      process.execPath,
      [SCRIPT, vsix],
      {
        env: { PATH, FAKE_PID_FILE: pidFile, DEGUBOARD_VSIX_INSTALL_TIMEOUT_MS: "1000", ...env },
        timeout: 15_000,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        done({ code, stdout, stderr, ms: Date.now() - started });
      },
    );
  });
}

/** pid のプロセスが生きているか */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("install-vsix の code の呼び出しの上限", () => {
  it("--install-extension が上限までに終わらなければ、子のプロセスごと止め、手で入れるコマンドを出して成功で終える", async () => {
    const out = await run({ FAKE_INSTALL: "hang" });
    expect(out.code).toBe(0);
    expect(out.ms).toBeLessThan(10_000);
    expect(out.stdout).toContain("1 秒で終わらなかった");
    expect(out.stdout).toContain(`code --install-extension ${vsix} --force`);
    const pid = Number(await readFile(pidFile, "utf8"));
    // SIGKILL の後に消えるまでわずかに待つ
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });

  it("--version が上限までに答えなければ、導入を飛ばして成功で終える", async () => {
    const out = await run({ FAKE_VERSION: "hang" });
    expect(out.code).toBe(0);
    expect(out.ms).toBeLessThan(10_000);
    expect(out.stdout).toContain("1 秒で答えなかった");
    expect(out.stdout).toContain(`code --install-extension ${vsix} --force`);
  });

  it("code が PATH になければ、導入を飛ばして成功で終える", async () => {
    const out = await run({}, false);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("code CLI が見つからない");
  });

  it("code がすぐ終われば、再読み込みを案内して成功で終える", async () => {
    const out = await run({});
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("ウィンドウを再読み込み");
  });

  it("code が失敗すれば、その終了コードで失敗にする", async () => {
    const out = await run({ FAKE_INSTALL: "3" });
    expect(out.code).toBe(3);
    expect(out.stderr).toContain("導入に失敗した");
  });
});
