#!/bin/sh
# mise run check のテストの段。引数のコマンド（package.json の test:locked では vitest run）を、worktree が共有する
# git-common-dir の下の lock ファイルで flock を取ってから回す（t799）。
# 並列のエージェントが別々の worktree で check を同時に回すと、全体のテストどうしが CPU を取り合って遅くなり、
# 時間に頼るテストが落ちる。そこで全体のテストを 1 本ずつにする。書式・lint・型・文書の検査と、test:related・
# check:light は軽いので lock の外で回す。
# lock がすぐ取れないときは、待つことを lock の絶対パス付きで 1 行出して待つ。待ちに独自の上限は付けない（品質ゲートの
# 検査の打ち切りに任せる）。git の外・flock がない環境（macOS の既定など）・lock ファイルを作れないときは、検査を
# 落とさないように lock なしで回す。振る舞いは test/scripts/test-locked.test.ts が確かめる

# 相対パス（main の worktree では ".git"）だと、待つ 1 行からどの lock か分からないので絶対パスで受け取る
lock_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || lock_dir=""
if [ -n "$lock_dir" ] && command -v flock >/dev/null 2>&1; then
  lock="$lock_dir/deguboard-check-test.lock"
  # exec のリダイレクトの失敗はシェルを終わらせるので、command を付けて失敗を戻り値で受け取る。
  # 2>/dev/null を exec に直接付けるとこの後の stderr まで捨てるので、まとまりの外に付ける
  if { command exec 9>>"$lock"; } 2>/dev/null; then
    if ! flock -n 9; then
      echo "Waiting for the full test run in another worktree to finish (lock: $lock)" >&2
      flock 9
    fi
  else
    echo "Running the tests without the lock: cannot open $lock" >&2
  fi
fi
exec "$@"
