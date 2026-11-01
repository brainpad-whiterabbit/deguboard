// 拡張ホストが見張るファイルの対象（UI-12）。VS Code API に触れない純粋な関数にしてテストする。
// CLI やエージェントの書き込みはどれも、データ worktree（<common>/deguboard/）か実行中の Run の記録（<common>/deguboard-local/runs/）のファイルを変える

import path from "node:path";

/** 見張る 1 件。base のディレクトリからの相対の glob で対象を表す（vscode.RelativePattern に渡す） */
export interface WatchTarget {
  base: string;
  pattern: string;
}

/**
 * data_dir（status の返す <common>/deguboard/）から見張る対象を決める。
 * - データ worktree の md・yaml（チケット・Epic・Iteration・Plan・Workflow・設定）
 * - データ worktree の runs/<id>.json（run finish が書く完了時の集計）
 * - <common>/deguboard-local/runs/<id>.json（run start が置き、finish が消す実行中の記録。core の repo.ts の localDir と同じ場所）
 */
export function watchTargets(dataDir: string): WatchTarget[] {
  const localDir = path.join(path.dirname(dataDir), "deguboard-local");
  return [
    { base: dataDir, pattern: "**/*.{md,yaml,yml}" },
    { base: dataDir, pattern: "runs/*.json" },
    { base: localDir, pattern: "runs/*.json" },
  ];
}

/** 絶対パスのファイルがどれかの対象に入るか。テストで対象を確かめるために使う */
export function isWatched(targets: WatchTarget[], file: string): boolean {
  return targets.some((t) => {
    const rel = path.relative(t.base, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return path.matchesGlob(rel.split(path.sep).join("/"), t.pattern);
  });
}
