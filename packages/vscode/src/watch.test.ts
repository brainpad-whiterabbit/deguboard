import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commonDirOf, initWatchTarget, isWatched, watchTargets } from "./watch.js";

const common = path.join("/repo", ".git");
const dataDir = path.join(common, "deguboard");
const localDir = path.join(common, "deguboard-local");
const targets = watchTargets(dataDir);

describe("watchTargets", () => {
  it("データ worktree のチケット・Epic・Iteration・Plan・Workflow・設定を見張る", () => {
    for (const rel of [
      "tickets/t1.md",
      "tickets/deleted/t2.md",
      "epics/e1.md",
      "iterations/s1.yaml",
      "plans/p1.yaml",
      "workflows/default.yaml",
      "projects/default.yml",
      "config.yaml",
    ]) {
      expect(isWatched(targets, path.join(dataDir, rel)), rel).toBe(true);
    }
  });

  it("run finish が書く完了時の集計（データ worktree の runs/<id>.json）を見張る", () => {
    expect(isWatched(targets, path.join(dataDir, "runs", "r20261101-080717-eb75.json"))).toBe(true);
  });

  it("run start が置く実行中の記録（<common>/deguboard-local/runs/<id>.json）を見張る", () => {
    expect(isWatched(targets, path.join(localDir, "runs", "r20261101-080717-eb75.json"))).toBe(
      true,
    );
  });

  it("deguboard-local のロックや属性ファイル、リポジトリのほかのファイルは見張らない", () => {
    for (const file of [
      path.join(localDir, "locks", "runs"),
      path.join(localDir, "attributes"),
      path.join(common, "index"),
      path.join("/repo", "README.md"),
      path.join(dataDir, "tickets", "t1.json"),
    ]) {
      expect(isWatched(targets, file), file).toBe(false);
    }
  });
});

describe("initWatchTarget（dg init 前に待つ対象）", () => {
  const init = [initWatchTarget(common)];

  it("データ worktree の .git（isInitialized の目印）と配下のファイルができるのを拾う", () => {
    for (const rel of ["deguboard/.git", "deguboard/config.yaml", "deguboard/tickets/t1.md"]) {
      expect(isWatched(init, path.join(common, rel)), rel).toBe(true);
    }
  });

  it("deguboard-local やほかの .git の中身には反応しない", () => {
    for (const rel of ["deguboard-local/runs/r1.json", "HEAD", "objects/ab/cdef"]) {
      expect(isWatched(init, path.join(common, rel)), rel).toBe(false);
    }
  });
});

describe("commonDirOf（core の resolveRepoPaths から得る）", () => {
  it("リポジトリでは .git の絶対パス、worktree からでも同じ場所を返す", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "dg-wi-")));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
      git("init", "-q", "-b", "main");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i");
      git("worktree", "add", "-q", path.join(dir, "wt"), "-b", "x");
      expect(await commonDirOf(dir)).toBe(path.join(dir, ".git"));
      expect(await commonDirOf(path.join(dir, "wt"))).toBe(path.join(dir, ".git"));
      // 作業フォルダがリポジトリの下のディレクトリでも、相対で返る出力を絶対にする
      mkdirSync(path.join(dir, "sub"));
      expect(await commonDirOf(path.join(dir, "sub"))).toBe(path.join(dir, ".git"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("git のリポジトリでないフォルダでは undefined（見張らない）", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "dg-wi-")));
    try {
      expect(await commonDirOf(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("リポジトリでも git が動かないとき（PATH に git がない）は undefined（見張らない）", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "dg-wi-")));
    const noGit = realpathSync(mkdtempSync(path.join(tmpdir(), "dg-wi-nogit-")));
    const savedPath = process.env["PATH"];
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
      process.env["PATH"] = noGit;
      expect(await commonDirOf(dir)).toBeUndefined();
    } finally {
      if (savedPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = savedPath;
      rmSync(dir, { recursive: true, force: true });
      rmSync(noGit, { recursive: true, force: true });
    }
  });
});
