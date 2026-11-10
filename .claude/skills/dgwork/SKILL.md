---
name: dgwork
description: deguboard の承認済みの Plan のチケットを、着手できるものから claim して実装し、受け入れ条件を確かめて PR まで進める。PR の要らない作業は done まで進める。「p3 を進めて」「計画を再開して」「t12 を進めて」と頼まれたときに使う。Plan のない複数のチケットは dgplan で計画を立ててから使う。
argument-hint: <Plan の ID|チケットの ID>
---

<!-- dg skill sha256:6fd1b7a90e4c119e2fba3412284141657f09d30050c28a76148d0bba47cf3013 -->

# 作業（work）

承認済みの Plan かチケットを、着手できるものから実装して PR まで進めます。

最初に `dg guide work` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」（英語の手順では "Deciding the target"）に従う。
