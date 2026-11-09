# ADR-009 Epic と Iteration

- ステータス：承認

## 要約

Epic は目的ごとにチケットを束ねる独立したエンティティで、期間の目標は Milestone を置かず Iteration で表す。Epic と Iteration の閉じる・再開は Workflow の外に置き、既定では誰でも行える。active な Iteration は Project に 1 つに限る。

## 背景

チケットは目的ごと・期間ごとに束ねて進める。束ねる単位をチケットの一種にするか独立したエンティティにするか、所属をどちらに持つか、期間の目標を何で表すか、同時に進める期間をいくつ許すかを決める。チケットの Status と遷移は ADR-003 で決める。

## 決定

### Epic は置き、Milestone は置かない

- Epic は目的ごとにチケットを束ねる独立したエンティティ（`epics/e3.md`）。チケットの一種にはせず、claim・ブランチ・5 つの Status を持たない
- 状態は `open` / `closed` で、進捗は保存しない（EP-1・EP-3）。所属はチケット側の `epic` だけで表し、入れ子にせず、Iteration をまたぐ（EP-2）。チケットの遷移は縛らない
- Milestone は持たず、期間の目標は Iteration で表す。Iteration の所属もチケット側の `iteration` だけで表す（IT-2）

### 閉じる・再開するのは Workflow の外に置く

- Epic と Iteration を閉じる・再開するのは Workflow の外で、既定では誰でも行える。人に限るなら config の `actor.human_only` にコマンド名を書く。再開の細部は EP-4・IT-1

### active の Iteration は Project に 1 つ

- active の Iteration は Project に 1 つに限り、`start`・`reopen` はほかに active があれば拒否する。claim と同じく即座に push して排他にし、それでも 2 つになったもの（直接の編集・マージ）は `lint` が指摘する（IT-1）

## 理由

- Epic（目的の範囲）・Iteration（期間）・Plan（実行順）は役割が違うので別のエンティティにする。Epic に 5 つの Status を持たせないのは、「作業中」「確認待ち」が Epic に意味を持たないため。進捗を保存しないのは、チケットを動かすたびに Epic も書き換えて衝突させないため
- Epic と Iteration の操作を既定で自由にし、制限を config の `actor.human_only` に置くのは、チケットの遷移と同じく「誰に任せるか」がチームで違うため。Workflow はチケットの遷移の語彙なので、Workflow の外の操作はコマンド名で縛る
- active を 1 つに限るのは、「今の Iteration」を手順（チケットを入れる先・既定の勧め）とカンバンの既定の選択が同じ 1 つに決められるようにするため。複数を許すと、前の Iteration を閉じ忘れたまま次を始めたときに古い方が既定になる。閉じ忘れは拒否で気づかせ、どちらを閉じるかは人が決める

## 採らなかった案

- **Epic をチケットの一種にする**（`type: epic` と `parent`）：claim・カンバン・照合に例外が入る
- **Epic や Iteration 側にチケットの一覧を持つ**：チケット側と二重の正本になり、食い違いと push の衝突が起きる
- **ラベルで Epic を代用する**：目的の本文・進捗・閉じる操作を表せない
- **Milestone を置く**：Iteration と役割が重なり、データモデルが増えるだけ
- **active を複数許し、画面と手順が選ぶ**：「今の Iteration」が人と画面と手順で食い違う。並行の作業は 1 つの Iteration の中で表せる
