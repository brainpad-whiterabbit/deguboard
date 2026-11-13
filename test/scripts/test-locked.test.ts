// scripts/test-locked.sh（mise run check のテストの段）が、git-common-dir の下の lock を取ってから引数のコマンドを回すことを確かめる（t799）。
// 本物のリポジトリの lock に触れないよう、一時ディレクトリに作ったリポジトリで動かし、回すコマンドは echo にする。
// lock が取られているときに lock の絶対パス付きで待つ 1 行を出し、外れてから回すこと、flock がないときと lock を作れないときに
// lock なしで回すことを見る。
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/test-locked.sh");
const LOCK_NAME = "deguboard-check-test.lock";

/** PATH からコマンドの絶対パスを引く（なければ空） */
function which(name: string): string {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const SH = which("sh");
const GIT = which("git");
const FLOCK = which("flock");

let dir: string;
let repo: string;
let holder: ChildProcess | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "test-locked-"));
  repo = join(dir, "repo");
  await mkdir(repo);
  execFileSync(GIT, ["init", "-q"], { cwd: repo });
});

afterEach(async () => {
  holder?.kill();
  holder = undefined;
  await rm(dir, { recursive: true, force: true });
});

type Result = { code: number; stdout: string; stderr: string };

/** スクリプトに echo を回させる。PATH を変えるときは env で渡す */
function run(env: NodeJS.ProcessEnv = process.env): Promise<Result> {
  return new Promise((done) => {
    execFile(SH, [SCRIPT, SH, "-c", "echo ran"], { cwd: repo, env }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      done({ code, stdout, stderr });
    });
  });
}

describe("mise run check のテストの段（test-locked.sh）", () => {
  it.skipIf(!FLOCK)("lock が空いていれば、何も出さずに回す", async () => {
    const result = await run();
    expect(result).toEqual({ code: 0, stdout: "ran\n", stderr: "" });
  });

  it.skipIf(!FLOCK)(
    "lock が取られていれば、lock の絶対パス付きで待つ 1 行を出し、外れてから回す",
    async () => {
      // 別の worktree の全体のテストの代わりに、lock を取って標準入力が閉じるまで待つプロセスを置く
      holder = spawn(FLOCK, [join(repo, ".git", LOCK_NAME), SH, "-c", "echo held; exec cat"], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      await new Promise<void>((held) => holder!.stdout!.once("data", () => held()));

      const child = spawn(SH, [SCRIPT, SH, "-c", "echo ran"], { cwd: repo });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      const exited = new Promise<number | null>((done) => child.on("close", done));
      await new Promise<void>((waiting) =>
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          if (stderr.includes("\n")) waiting();
        }),
      );

      const line = stderr.trim();
      expect(line).toMatch(
        /^Waiting for the full test run in another worktree to finish \(lock: .+\)$/,
      );
      const lock = line.slice(line.indexOf("(lock: ") + "(lock: ".length, -1);
      expect(isAbsolute(lock)).toBe(true);
      expect(lock.endsWith(`/.git/${LOCK_NAME}`)).toBe(true);
      // 待っている間はコマンドを回さない
      expect(stdout).toBe("");

      holder.stdin!.end();
      expect(await exited).toBe(0);
      expect(stdout).toBe("ran\n");
      expect(stderr.trim().split("\n")).toHaveLength(1);
    },
  );

  it("flock がなければ、lock なしで回す", async () => {
    // git と sh だけを置いた PATH にして flock を見えなくする
    const bin = join(dir, "bin");
    await mkdir(bin);
    await symlink(GIT, join(bin, "git"));
    await symlink(SH, join(bin, "sh"));
    const result = await run({ ...process.env, PATH: bin });
    expect(result).toEqual({ code: 0, stdout: "ran\n", stderr: "" });
  });

  it.skipIf(!FLOCK)("lock を作れなければ、理由を 1 行出して lock なしで回す", async () => {
    // lock の場所に同じ名前のディレクトリを置くと、権限に関わらず（root でも）書き込みで開けない
    await mkdir(join(repo, ".git", LOCK_NAME));
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ran\n");
    expect(result.stderr).toMatch(/^Running the tests without the lock: cannot open \/.+\n$/);
  });
});
