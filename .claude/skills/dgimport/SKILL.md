---
name: dgimport
description: 会話で検討した結果（設計の相談・不具合の調査・レビューの指摘など）や計画・設計書を deguboard のチケットに分解し、承認を得てから一度に起票する。既存のチケットの修正・分割で済むものは直す。「起票して」「チケットにして」「チケットを直して」と頼まれたときや、要件の整理が終わってチケット化を提案するときに使う。
argument-hint: "[対象（案の名前・文書のパス・チケットの ID）]"
---

<!-- dg skill sha256:382adff2060c2d4099bb8fb1b6fad9bfc1f5a83df3e04ffd51024cce0fc0eca2 -->

# 起票（import）

最初に `dg guide import` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内（`CLAUDE.md` など）が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」に従う。
