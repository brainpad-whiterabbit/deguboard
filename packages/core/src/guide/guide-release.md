---
description: deguboard の Iteration のチケットがすべて done かを確かめ、リポジトリのリリースの手順で進めて、承認を得て Iteration を閉じる。リリースの PR のマージと公開の前に承認を求める。「s3 をリリースして」「リリースを進めて」と頼まれたときに使う。
argument-hint: "[Iteration]"
---

# リリース（release）

Iteration のチケットがすべて done かを確かめ、リポジトリのリリースの手順で進めて、Iteration を閉じる。リリースの処理（版の決め方・CHANGELOG・タグ・配布先）は deguboard に持たず、リポジトリの手順に従う。この手順に版の付け方やリリースのコマンドを書かない。見直し（`dg guide audit`）が済んでいるかは確かめない（リリースの条件ではない）。

## 対象を決める

- Iteration（`s3`）：その Iteration をリリースする
- 指定が空：active の Iteration を勧めて確かめる。なければどれかを聞く

以下では対象の ID を `<S>` と書く。

## リリースの手順

1. **done かを確かめる**：`dg --json --actor agent sync` の後、`dg --json --actor agent iteration show <S>` で、チケットがすべて done か abandoned かを確かめる。チケットがなければそう伝えて止まる。残っていれば一覧（ID・題・状態・PR）を示し、「完了にする」（`dg guide done`。Skill があれば `/dgdone <S>`）と「ここで止める」で聞く
2. **リリースの手順を探す**：リポジトリの規約（CLAUDE.md・README・開発の文書）のリリースの節を探し、どの文書のどの手順に従うかを示す。なければ下の「リリースの手順がないとき」
3. **手順に従って進める**：手順にない操作（版の決め方を変える、手でタグを打つ、手順を飛ばす）はしない。止まったら理由を示して聞く
   - 作業中の checkout ではなく、`git fetch {{git.remote}} {{git.base_branch}}` の後に `git worktree add --detach {{worktree.root}}/release-<S> {{git.remote}}/{{git.base_branch}}` で作った一時 worktree で進める。リリースのブランチ・依存のインストール・ビルドもこの中で行う
   - リリースの PR のマージは一時 worktree の外で行う。マージの後の確かめと公開は、マージを取り込んでから一時 worktree を作り直して行う
   - 承認を待たずに進めてよいのは準備の操作（一時 worktree、ブランチ、版の更新、CHANGELOG、確かめのコマンド、PR の作成）。PR の中で見直せるため
   - リリースの PR で別のサブエージェントの見直しを省けるかは、the "Quality gate" section of `dg guide review` の版上げの条件に従う
   - **承認を得てから行う**：リリースの PR のマージ、公開の操作（タグの push・配布先への公開）。それぞれの前に聞く。手順に `--dry-run` などの確かめ方があれば先に実行し、結果を判断の材料に示す
   - 終わったら（やめたときも）一時 worktree を消す。`git worktree remove` が止まったら `git -C <パス> status --short --branch` で残りを確かめ、リリースに要る変更が残っていなければ `--force` で消す。残っていれば消さずに伝える
4. **Iteration を閉じる**：「閉じる」「ここで止める」で聞き、承認されたら `dg --json --actor agent iteration close <S>`。次の Iteration は、それに入ったチケットに着手するときに the "Before and after claim" section of `dg guide work` で始まる（聞かない）
5. **結果を伝える**：リリースした版・PR・公開したもの・Iteration の状態・残した一時 worktree（あれば）

## リリースの手順がないとき

版・タグ・CHANGELOG を推測して作らない。手順が見つからなかったことを伝え、「Iteration を閉じる（リリースはしない）」と「ここで止める」で聞く。

{{choices}}

## 次の手順を選ぶ

結果を伝えたら、次の選択肢で聞く。

- **次の計画を立てる**：todo のチケットが残っていれば `dg guide plan` の手順で計画する（Skill があれば `/dgplan next`）
- **割り当てる**：未割り当ての todo を `dg guide assign` の手順で Iteration に入れる（Skill があれば `/dgassign`）
- **ここで止める**
