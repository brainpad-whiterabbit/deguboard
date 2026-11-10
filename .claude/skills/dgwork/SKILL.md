---
name: dgwork
description: Advances the tickets of an approved Plan, starting with the ones that can be started. Claims a ticket, implements it, checks its acceptance criteria, and takes it to a PR. Work that needs no PR goes to done. Use when asked「p3 を進めて」「計画を再開して」「t12 を進めて」. For several tickets with no Plan, make a plan with dgplan first.
argument-hint: <Plan ID|ticket ID>
---

<!-- dg skill sha256:234644cccafc41ee203874b7456ae23568c30947ca4ef03d7ddaef2c0e29bc6a -->

# Work (work)

承認済みの Plan かチケットを、着手できるものから実装して PR まで進めます。

最初に `dg guide work` を実行し、出力された手順のとおりに、次の指定の対象を進める。この Skill は手順を持たない。手順の正本は dg に同梱されていて、dg の版に合う。

- `dg` は必ず `--json --actor agent` を付けて呼ぶ（例：`dg --json --actor agent ticket show t12`）。あなたは agent を名乗る。拒否された操作（`TRANSITION_REJECTED`）は人に頼む
- チケットは `dg` でだけ読み書きする。データのファイル（`.git/deguboard/` の下）を直接編集しない
- PATH に `dg` がなければ、リポジトリの案内が書く呼び方（`npx deguboard`、`mise run dg --` など）で `dg` を置き換える。手順の中の `dg` も同じ。

指定：$ARGUMENTS

指定が空なら、手順の「対象を決める」（英語の手順では "Deciding the target"）に従う。
