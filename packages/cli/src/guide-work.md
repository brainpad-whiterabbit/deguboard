# 作業（work）

1 枚のチケットを claim から PR まで進める（PR の要らない作業は下の「PR の要らない作業」）。状態は作業ブランチの Git 上の事実（ある・push 済み・PR・マージ）から `dg sync` が進める。受け入れ条件の印は、PR を出す前に自分で確かめて `ticket check` で付ける。

## 流れ

1. 着手できるか確かめる：`dg --json --actor agent ticket show <id>`。`status` が todo で `deps_done` が true。todo でも `assignee` が別のユーザなら、その人の予定なので避ける（自分か自分のユーザのものなら着手してよい）。承認済みの Plan に従って進めるなら、下の「Plan に従って進める」も確かめる
2. claim する：`dg --json --actor agent ticket claim <id> --branch <種類>/<内容>`。in_progress になり、担当者（`assignee`）が自分になってブランチ名が記録され、push の成功で排他を得る。`CLAIM_LOST`（誰かが先に claim した）なら別のチケットへ。`TRANSITION_REJECTED` なら Workflow の制約に当たっている（依存先が終わっていないなど）。`error.message` を読む
3. 作業ブランチと worktree を作る（リポジトリの規約に従う。既定の置き場所は `{{worktree.root}}`）

   ```sh
   git fetch {{git.remote}}
   git worktree add --no-track -b <ブランチ名> <worktree の場所> {{git.remote}}/{{git.base_branch}}
   ```

4. 実装する。本文の `## 受け入れ条件` を満たすことを目標にする。リポジトリの検査（lint・テスト）を通す
5. 受け入れ条件を 1 項目ずつ確かめる。`dg --json --actor agent ticket show <id>` の `acceptance`（`index`・`text`・`checked`）を読み、成果物やテストで満たしたと確認できた項目だけ `dg --json --actor agent ticket check <id> <番号...>` で付ける（`--all` で全部、`--undo` で外す）。確認できない項目は付けず、PR の本文と人への報告に理由を書く。印を付けたあとに `ticket update --acceptance` で文を書き換えると、文が変わった項目の印は外れる
6. コミットして push し、PR を作る。PR の本文にチケットの ID（`t12`）と、付けられなかった受け入れ条件を書く。PR の番号をチケットに記録する：`dg --json --actor agent ticket update <id> --pr <番号>`
7. `dg --json --actor agent sync` を回す。Workflow が PR の事実を見るなら（software-development）、PR が開いていれば review に進む（`gh` が要る）。見ないなら（general など）、PR を出したら自分で `dg --json --actor agent ticket move <id> review` に進める
8. レビューの指摘は同じブランチで直して push する。マージは人が行う。マージ後は `dg guide finish`

## Plan に従って進める

承認済みの Plan（`dg guide plan`）があれば、その順と中身に従う。

- 着手する前に `dg --json --actor agent plan show <p>` を読む。`pending_approval` が true（承認待ち）なら着手せず、人に承認を求める
- 順は `items`（Plan の順）と `after`。`items[].waiting`（まだ終わっていない待ち先）が空のチケットだけに着手する。after は claim では検査されないので、自分で守る。着手できるものが複数あれば `items` の順で先のものから
- 着手するチケットの `details.<id>.scope`（範囲）と `approach`（方針）を読み、その範囲と方針で実装する。範囲を広げる・方針を変えるなら、先に人に確かめる
- 1 枚終えたら（PR を出したら）`plan show` を読み直して次を選ぶ。Plan のチケットがすべて終わったら `dg guide finish` の「Plan を閉じる」

## PR の要らない作業

チケットのデータの整備・確認・調査など、リポジトリのファイルを変えない作業は、ブランチも PR も作らない。照合には頼らず、自分で done まで進める。

1. claim する：`dg --json --actor agent ticket claim <id> --without-branch`。branch を記録しないので、照合の対象にならず `sync` も警告しない
2. 作業する（worktree は作らない）。何をしたかと結果は、最後に人への報告に書く
3. 受け入れ条件を 1 項目ずつ確かめ、満たした項目だけ `ticket check` で付ける（上の手順 5 と同じ）
4. すべて付いたら `dg --json --actor agent ticket move <id> done`。付けられない項目が残ったら `ticket move <id> review` にして、残った項目と理由を人に報告する（done にするのは人）
5. 途中でリポジトリのファイルを変える必要が出たら、`ticket update <id> --branch <種類>/<内容>` でブランチを記録し、上の流れ（worktree・PR）に移る。逆に、claim したブランチが要らなくなったら `--branch none` で外す

## 状態について

- 自分で `status` を進めるのは普段 in_progress → review まで。done は照合（マージ）で進むので自分で move する必要はない。照合で進まないときや、人に指示されたときは `ticket move <id> done` で進める（制限は `dg guide overview`）
- 途中でやめるなら `dg --json --actor agent ticket unclaim <id>`（in_progress で自分か自分のユーザの claim のときだけ。todo に戻り、担当者が外れる）。review にあるなら人に差し戻しを頼む
- 作業中に別の作業が見つかったら、そのチケットに混ぜず `dg guide create` の手順で起票を提案する

## 任意フィールドと PR 番号

- Workflow の `fields`（見積など）は `dg --json --actor agent ticket update <id> --field estimate=3`
- PR 番号は `dg --json --actor agent ticket update <id> --pr 42` で記録する。照合は PR 番号があればそれで、なければブランチ名で PR を引き、見つけた番号を `pr` に補う（Workflow が PR の事実を見るときだけ）。ブランチを使い回すと別の PR を拾いうるので、PR を作ったら自分で記録する
