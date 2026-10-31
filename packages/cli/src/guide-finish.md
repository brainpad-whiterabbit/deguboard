# 完了（finish）

PR がマージされたあとの後始末。done にするのは照合か人で、エージェントは確認と記録を行う。

## 流れ

1. `dg --json --actor agent sync` を回す。PR のマージ（または作業ブランチが `{{git.base_branch}}` に入ったこと）を照合してチケットが done になる。`reconciled` に `{ id, from, to }` が出る
2. `dg --json --actor agent ticket show <id>` で `status` が done になったことを確かめる。なっていなければ `sync` の `warnings` を読む。事実が足りない（`gh` がない、ブランチがまだ push されていない）か、Workflow が照合にその遷移を許していない（consulting の review → done など）。後者は人に done にしてもらう
3. 受け入れ条件を確かめる。PR や成果物で満たしたことを確認できた項目だけチェックを付ける（deguboard が自動で付けることはない）。本文は `ticket show --json` の `body` を読み、該当の `- [ ]` を `- [x]` にして `dg --json --actor agent ticket update <id> --body "<本文全体>"` で書き戻す。確認できない項目はそのまま残し、人に伝える
4. 作業ブランチと worktree を片付ける（リポジトリの規約に従う）
5. 人に報告する：何が done になったか、残った受け入れ条件、次に着手できるもの（`dg --json --actor agent ticket list --ready`）

## 終わらなかったとき

- 作業をやめるなら `dg --json --actor agent ticket unclaim <id>`（in_progress のときだけ。todo に戻す）。チケット自体をやめる（abandoned）のは人だけ
- 要件が変わって別のチケットにすべきなら、`dg guide create` の手順で新しく起票を提案し、元のチケットの扱いは人に確かめる

## Iteration と Epic

- Iteration を閉じる、Epic を閉じる・再開するのは人だけ（`dg guide overview`）。閉じられそうなら（残りがすべて done か abandoned）人に知らせる
- Epic の進捗は `dg --json --actor agent epic show <e3>` の `progress` で都度求まる。保存はされない
