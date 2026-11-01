import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWatched, watchTargets } from "./watch.js";

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
