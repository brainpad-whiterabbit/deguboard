# 作業（work）

1 枚のチケットを claim から PR まで進める。状態は作業ブランチの Git 上の事実（ある・push 済み・PR・マージ）から `dg sync` が進める。

## 流れ

1. 着手できるか確かめる：`dg --json ticket show <id>`。`status` が todo で `deps_done` が true。`claimed_by` があれば他の誰かが進めている
2. claim する：`dg --json --actor agent ticket claim <id> --branch <種類>/<内容>`。in_progress になり、`claimed_by` とブランチ名が記録され、push の成功で排他を得る。拒否（`CLAIM_LOST`）されたら別のチケットへ
3. 作業ブランチと worktree を作る（リポジトリの規約に従う。既定の置き場所は `{{worktree.root}}`）

   ```sh
   git fetch {{git.remote}}
   git worktree add --no-track -b <ブランチ名> <worktree の場所> {{git.remote}}/{{git.base_branch}}
   ```

4. 実装する。本文の `## 受け入れ条件` を満たすことを目標にする。リポジトリの検査（lint・テスト）を通す
5. コミットして push し、PR を作る。PR の本文にチケットの ID（`t12`）を書く
6. `dg --json --actor agent sync` を回す。PR が開いていれば review に進む（`gh` が要る。なければ `ticket move <id> review`）
7. レビューの指摘は同じブランチで直して push する。マージは人が行う。マージ後は `dg guide finish`

## 状態について

- 自分で `status` を進めるのは in_progress → review だけ。done は照合（マージ）か人が決める
- in_progress → done（レビューなし）、abandoned、再開はエージェントにはできない。必要なら人に頼む
- 途中でやめるなら `dg --json --actor agent ticket unclaim <id>`（自分の claim だけ外せる。todo に戻る）
- 作業中に別の作業が見つかったら、そのチケットに混ぜず `dg guide create` の手順で起票を提案する

## 任意フィールドと PR 番号

- Workflow の `fields`（見積など）は `dg --json --actor agent ticket update <id> --field estimate=3`
- PR 番号をチケットに残すなら `ticket update <id> --pr 42`。照合は PR 番号があればそれで、なければブランチ名で PR を引く
