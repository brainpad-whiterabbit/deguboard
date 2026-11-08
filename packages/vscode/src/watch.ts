// 拡張ホストが見張るファイルの対象（UI-12）。VS Code API に触れない純粋な関数にしてテストする。
// dg init 前はデータ worktree がなく見張れないので、できるのを待つ対象（initWatchTarget）も持つ。
// CLI やエージェントの書き込みはどれも、データ worktree（<common>/deguboard/）か実行中の Run の記録（<common>/deguboard-local/runs/）のファイルを変える

import { execFile } from "node:child_process";
import path from "node:path";
import { DIRS, repoDirsOf } from "@deguboard/core";

/** 見張る 1 件。base のディレクトリからの相対の glob で対象を表す（vscode.RelativePattern に渡す） */
export interface WatchTarget {
  base: string;
  pattern: string;
}

/**
 * data_dir（status の返す <common>/deguboard/）から見張る対象を決める。
 * - データ worktree の md・yaml（チケット・Epic・Iteration・Plan・Workflow・設定）
 * - データ worktree の runs/<id>.json（run finish が書く完了時の集計）
 * - <common>/deguboard-local/runs/<id>.json（run start が置き、finish が消す実行中の記録。場所は core の repoDirsOf の localDir）
 *
 * runs/ は base を runs/ そのものにして単純なパターンで見張る。VS Code はパスの区切りや ** を含むパターンを再帰で見張り、
 * 再帰の見張りには files.watcherExclude が効くが、単純なパターン（非再帰）には効かない。
 * base がまだないとき（run start の前の deguboard-local/runs/）も、VS Code はできるまで待ってから見張る
 */
export function watchTargets(dataDir: string): WatchTarget[] {
  const { localDir } = repoDirsOf(path.dirname(dataDir));
  return [
    { base: dataDir, pattern: "**/*.{md,yaml,yml}" },
    { base: path.join(dataDir, DIRS.runs), pattern: "*.json" },
    { base: path.join(localDir, DIRS.runs), pattern: "*.json" },
  ];
}

/**
 * dg init 前に見張る対象：git common dir の下にデータ worktree（<common>/deguboard/）ができること。
 * 初期化済みかは core が <common>/deguboard/.git の有無で決める（isInitialized）。確かめ直しは watchData が status を呼ぶ。
 * データの見張り（watchTargets）は data_dir が取れてからしか張れないので、初期化前はこちらで待つ。
 * base は今ある <common> にする。deguboard/ がまだない base を VS Code はポーリングで待ち、できた瞬間の base 自身の追加しか出さず、
 * init が base とほぼ同時に書く .git の作成を取りこぼすため。そのぶん .git の配下を再帰で見て広いが、
 * 確かめ直しは status を呼ぶだけで、見張りは init の後に外す
 */
export function initWatchTarget(commonDir: string): WatchTarget {
  return { base: commonDir, pattern: "deguboard/{.git,**}" };
}

/**
 * git common dir の絶対パス。リポジトリでないフォルダや git が動かないときは undefined（見張らない）。
 * --path-format は Git 2.31 から（約束は 2.30 以上）なので使わず、core の resolveRepoPaths と同じく cwd から解く
 */
export function gitCommonDir(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--git-common-dir"], { cwd, timeout: 5_000 }, (error, stdout) => {
      const raw = error ? "" : stdout.trim();
      resolve(raw === "" ? undefined : path.resolve(cwd, raw));
    });
  });
}

/** 絶対パスのファイルがどれかの対象に入るか。テストで対象を確かめるために使う */
export function isWatched(targets: WatchTarget[], file: string): boolean {
  return targets.some((t) => {
    const rel = path.relative(t.base, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return path.matchesGlob(rel.split(path.sep).join("/"), t.pattern);
  });
}
