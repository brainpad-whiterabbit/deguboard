---
name: dgimport
description: Breaks down the results of a conversation (design discussion, bug investigation, review findings, etc.) or a plan or design document into deguboard tickets, and files them in one batch after approval. Fixes or splits existing tickets when that is enough. Use when asked「起票して」「チケットにして」「チケットを直して」, or when proposing to turn settled requirements into tickets.
argument-hint: "[target (plan name, document path, or ticket ID)]"
---

<!-- dg skill sha256:8454d435489084b39bba4739bcabf1d97e26a1e8cdabfd7dbf281f3c9afc15f9 -->

# Filing (import)

会話で検討した内容や計画・設計書を、承認を得てからチケットに分けて起票します。

最初に `dg guide import` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」（英語の手順では "Deciding the target"）に従う。
