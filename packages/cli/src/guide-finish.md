# 完了（finish）

PR がマージされたあとの後始末。done にするのは照合か人で、エージェントは確認と記録を行う。受け入れ条件の印は普段 `dg guide work` の段階で付いている。

## 流れ

1. `dg --json --actor agent sync` を回す。PR のマージ（または作業ブランチが `{{git.base_branch}}` に入ったこと）を照合してチケットが done になる。`reconciled` に `{ id, from, to, when }` が出る（`when` は根拠になった事実）
2. `dg --json --actor agent ticket show <id>` で `status` が done になったことを確かめる。なっていなければ `sync` の `warnings` を読む。事実が足りない（`gh` がない、ブランチがまだ push されていない）か、Workflow がその遷移の `by` に reconcile を含めていない。後者は人に確かめて `ticket move <id> done` で進める
3. 残った受け入れ条件を確かめる。`sync` の `warnings`（`受け入れ条件 2, 3 が未チェックのまま done になった`）と `ticket show --json` の `acceptance` で未チェックの項目を見て、マージされた成果物で満たしたと確認できたものだけ `dg --json --actor agent ticket check <id> <番号...>` で付ける（deguboard が自動で付けることはない）。確認できない項目はそのまま残し、人に伝える
4. 作業ブランチと worktree を片付ける（リポジトリの規約に従う）
5. 人に報告する：何が done になったか、残った受け入れ条件、次に着手できるもの（`dg --json --actor agent ticket list --ready`）

## 終わらなかったとき

- 作業をやめるなら `dg --json --actor agent ticket unclaim <id>`（in_progress のときだけ。todo に戻す）。チケット自体をやめる（abandoned）のは人に確かめてから `ticket move <id> abandoned`
- 要件が変わって別のチケットにすべきなら、`dg guide create` の手順で新しく起票を提案し、元のチケットの扱いは人に確かめる

## Iteration と Epic

- Iteration を閉じる、Epic を閉じる・再開するのは人の指示で行う（`dg guide assign`）。閉じられそうなら（残りがすべて done か abandoned）人に知らせる
- Epic の進捗は `dg --json --actor agent epic show <e3>` の `progress` で都度求まる。保存はされない
