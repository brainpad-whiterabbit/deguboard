# 起票（create）

会話で固まった要件・調査の結果・レビューの指摘を、チケットに起こす。

## 流れ

1. 要件の整理が終わったら、チケット化を**提案**する。勝手に起票しない。分解の案（題・概要・受け入れ条件・依存・Epic）を箇条書きで見せ、承認を得る
2. 1 枚なら `dg --json --actor agent ticket create "<題>" --summary "<概要>" [--epic e3] [--depends-on t9,t10] [--priority high]`
3. 複数なら YAML の下書きを 1 ファイルに書いて `dg --json --actor agent ticket import <file>`。1 回のコミットでまとめて採番される
4. 結果の `data` から ID を読み、人に報告する

## 下書きの形（import）

```yaml
- key: schema # 下書きの中だけで使う仮キー
  title: スキーマを決める
  summary: …
  epic: e3 # 既存の Epic。省略可
  priority: high # low / medium / high。既定は medium
  labels: [backend]
- key: api
  title: API を実装する
  depends_on: [schema] # 仮キーか既存の ID（t9）
  body: | # summary の代わりに本文全体を書いてもよい
    ## 概要

    …

    ## 受け入れ条件

    - [ ] …
```

## よいチケットの書き方

- 題は「何をどうする」が一読でわかる 1 行。実装の手段ではなく成果で書く
- 本文は `## 概要` と `## 受け入れ条件`（`- [ ]` のチェックリスト）。`dg lint` が欠けを指摘する
- 受け入れ条件は、PR や成果物を見て真偽を判定できる文にする
- 1 枚は 1 つの PR で終わる大きさにする。大きければ分けて `depends_on` でつなぐ
- 目的で束ねるなら Epic（`dg --json epic list` で既存を見る。なければ作ることを提案する）
- 任意フィールド（Workflow の `fields`）は `--field key=value`。定義は `dg --json workflow show <id>`

## してはいけないこと

- 依存の循環を作る（作成時に拒否される）
- 閉じた Epic にチケットを足す（拒否される）
- 着手していないのに `status` を変える。起票したチケットは todo のまま
