---
description: 会話で検討した結果（設計の相談・不具合の調査・レビューの指摘など）や計画・設計書を deguboard のチケットに分解し、承認を得てから一度に起票する。既存のチケットの修正・分割で済むものは直す。「起票して」「チケットにして」「チケットを直して」と頼まれたときや、要件の整理が終わってチケット化を提案するときに使う。
argument-hint: "[対象（案の名前・文書のパス・チケットの ID）]"
---

# 起票（import）

会話で固まった要件・調査の結果・レビューの指摘を、チケットに起こす。

## 対象を決める

- 案の名前・文書のパス：その案や文書（設計書・調査の結果）を対象にする
- チケットの ID：そのチケットの修正・分割を対象にする（`ticket update` で直し、分けるなら新しく起票して元の範囲を狭める）
- 指定が空：この会話で検討した結果のうち、まだチケットになっていないものを対象にする。何を対象にし、何を保留にするかを最初に示す

## 流れ

1. 要件の整理が終わったら、チケット化を**提案**する。勝手に起票しない。分解の案（題・概要・受け入れ条件・依存・Epic）を表で見せ、「承認して起票する」「修正する」「やめる」の選択肢で承認を得る
2. 1 枚なら `dg --json --actor agent ticket create "<題>" --created-by human --summary "<概要>" --acceptance "<条件>" --acceptance "<条件>" [--epic e3] [--depends-on t9,t10] [--priority high] [--assignee agent]`
3. 複数なら YAML の下書きを 1 ファイルに書いて `dg --json --actor agent ticket import <file>`。1 回のコミットでまとめて採番される
4. 結果の `data` から ID を読み、人に報告する

## 起票者と担当者

- 起票者（`created_by`）は、起票を指示・承認した人か、人の確認を経ずに起票した AI。人の指示や承認で起票するときは `--created-by human` を付けてユーザ本人にする。自動の手順の中などで人の確認を経ずに起票するときは付けない（`<ユーザ>/agent` になる）
- 担当者（`assignee`）は任意。自分が続けて進めるなら `--assignee agent`、人が進めるなら `--assignee human`。claim すると claim した主体で上書きされる

## 下書きの形（import）

```yaml
- key: schema # 下書きの中だけで使う仮キー
  title: スキーマを決める
  summary: …
  acceptance: [条件 1, 条件 2] # 本文の雛形のチェックリストに入る
  epic: e3 # 既存の Epic。省略可
  iteration: s3 # 既存の Iteration。省略可
  priority: high # low / medium / high。既定は medium
  labels: [backend]
  created_by: human # 起票者。省略時は操作した主体（あなたなら <ユーザ>/agent）
  assignee: agent # 担当者。省略可
  fields: { estimate: 3 } # Workflow の fields で定義した任意フィールド
- key: api
  title: API を実装する
  depends_on: [schema] # 仮キーか既存の ID（t9）
  body: | # summary の代わりに本文全体を書いてもよい
    ## 概要

    …

    ## 受け入れ条件

    - [ ] …
```

- 引用しない値の「空白＋#」以降は YAML のコメントになり、捨てられる。`#` を含む値（`#/config` など）は引用符で囲むか、body の `|` で書く
- 本文の項目（title・summary・acceptance の各項目・body）の引用しない値の行末にコメントがあると、import は本文が切れたとみなして起票しない（INVALID_INPUT）。ほかの項目の行末コメントと、行だけのコメントは使える

## 優先度の判断基準

`priority` は、次の基準で選ぶ（`config.yaml` の `priority` で書き換えられる）。

- high：{{priority.high}}
- medium（既定）：{{priority.medium}}
- low：{{priority.low}}

## よいチケットの書き方

- 題は「何をどうする」が一読でわかる 1 行。実装の手段ではなく成果で書く
- 本文は `## 概要` と `## 受け入れ条件`（`- [ ]` のチェックリスト）。`dg lint` が節の欠けと項目のない節を指摘する
- 起票時に調べた参照先は、任意の `## 参考` 節に書いて着手するエージェントに渡す。書いてよいのは、要件の ID・ADR の番号・関連するチケットの ID・ファイルのパス・関数名とコマンド名。行番号と docs の書き写しは入れず（すぐ古くなる）、どう直すか（実装の手段）は書かない。節は任意で、なくても `dg lint` は指摘しない
- 受け入れ条件は、PR や成果物を見て真偽を判定できる文にする
- 1 枚は 1 つの PR で終わる大きさにする。大きければ分けて `depends_on` でつなぐ
- 受け入れ条件が 7 項目以上になったら、分けることを勧める（deguboard 自身の開発では、7 項目以上のチケット 10 件のうち 9 件で手直しが要った）。分けないなら、そのまま 1 件で進める理由を人に示す
- PR の要らない作業（チケットのデータの整備・確認・調査）は、概要にそう書く。受け入れ条件はデータや報告で真偽を判定できる文にする
- 目的で束ねるなら Epic（`dg --json --actor agent epic list` で既存を見る。なければ作ることを提案する）
- 任意フィールド（Workflow の `fields`）は `--field key=value`。定義は `dg --json --actor agent workflow show <id>`

## してはいけないこと

- 依存の循環を作る（作成時に拒否される）
- 閉じた Epic にチケットを足す（拒否される）
- 着手していないのに `status` を変える。起票したチケットは todo のまま
- 結果が `provisional: true` のときに ID を確定として人に伝える（`dg guide overview`）

{{choices}}

## 次の手順を選ぶ

結果を伝えたら（やめたときも）、次の選択肢で聞く。

- **割り当てる**（勧める）：起票したチケットを `dg guide assign` の手順で Iteration と Epic に入れる（Claude Code では `/dgassign <ID...>`）
- **計画を立てる**：割り当てが要らなければ、`dg guide plan` の手順で進める順を決める（`/dgplan <ID...>`）
- **ここで止める**
