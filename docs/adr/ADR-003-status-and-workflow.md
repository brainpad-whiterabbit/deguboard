# ADR-003 ステータスとワークフロー

- ステータス：承認
- 更新日：2026-10-31

## 背景

deguboard はソフトウェア開発だけでなく、コンサルティングや調査などの業務にも使う。業務ごとに工程が違うので、ユーザーがワークフローを定義できる必要がある。一方で、何でも書ける宣言的エンジンは実装が重く、AI エージェントとの対話を硬直させる。ステータスを固定するか、ワークフロー定義に何を書かせるかを決める。

## 決定

### Status は 5 つに固定する

チケットの進捗は `status` の 1 軸で表し、値は全ワークフロー共通の 5 つに固定する。

| status        | 意味                       | 前進の順 |
| ------------- | -------------------------- | -------- |
| `todo`        | 未着手                     | 1        |
| `in_progress` | 作業中（claim 済み）       | 2        |
| `review`      | 確認待ち                   | 3        |
| `done`        | 完了。終端                 | 4        |
| `abandoned`   | やめた。終端。前進の軸の外 | -        |

- ワークフローは Status を増やせない。表示名（label）だけを変えられる
- 工程（調査・実装・テストなど）はチケットの属性にしない。Run を実装するときに `step` を持たせ、「チケットがどこまで進んだか」と「Run が何をしたか」を分ける。工程をチケットに表示したいだけなら Workflow の `fields` で任意フィールドを足す

### 遷移は既定で自由にし、Workflow が制約を足す

- 既定では 5 つの Status の間のどの遷移も、human / agent / reconcile の誰でも条件なしで行える。Core が固定するのは Status の集合と前進の順、同じ Status への move の拒否、`abandoned` と todo に入るときの副作用（`assignee` と `branch` を消す）だけ
- Workflow の `transitions` は from → to ごとに制約を足す。`by` は行える主体（省略なら誰でも、`[]` ならその遷移を禁止）、`requires` は満たすべき組み込みの条件（AND）。例：`{ from: todo, to: in_progress, requires: [deps_done] }` で依存が終わるまで着手を止め、`{ from: review, to: done, by: [human] }` で完了を人に限る。同じ from → to を 2 回書くのは誤りとして検証で指摘する（読み込めた場合は requires の和・by の積で合成する）
- 照合（reconcile）は遷移の制約とは別の仕様。前進の順に進めるだけで、`abandoned` と `done` には触れず、そこからも動かさない。`by` に `reconcile` を含まない遷移は照合でも止まる
- Epic と Iteration を閉じる・再開するのは Workflow の外で、既定では誰でも行える。人に限るなら config の `actor.human_only` にコマンド名（`epic.close` など）を書く。Iteration の再開は active に戻す（planned と active のどちらから閉じたかは記録しない）。閉じたときに外した持ち越しのチケットも記録しないので戻さず、入れ直してもらう

### Workflow YAML は制約と語彙を書く

ワークフロー定義（`workflows/<id>.yaml`）に書くもの：

- `labels`：Status の表示名（任意）
- `transitions`：from → to ごとの `by` と `requires` の制約（任意。書かない遷移は自由）
- `reconcile`：Git の事実から状態を導く規則。上から評価し、前進するときだけ書き換える
- `fields`：チケットに追加する任意フィールド（UI の表示項目が追従）
- Run を実装するときに `steps`（Run の step の語彙）と、各 step で使える Action・承認の要否を足す

書かないもの：

- 手続き（何をどの順で行うか、条件分岐、失敗時の処理）。手順は `dg guide <topic>` のテキストとして CLI に同梱し、AI が読んで判断する
- ユーザーのスクリプト。`requires` と `reconcile` の条件は組み込みの事実（`deps_done`、`branch_exists`、`branch_pushed`、`branch_merged`、`pr_open`、`pr_draft`、`pr_merged`）とその否定だけ。`deps_done` は依存先がすべて done か abandoned のとき真

定義の検証（存在しない Status を指す項目、未知の条件、同じ遷移の重複）は `dg workflow validate` と読み込み時に行う。

### テンプレート

`software-development`・`consulting`・`general` の 3 つを CLI に同梱し、`dg init --template` でコピーする。違いは `reconcile`・`fields`・`labels`（Run の実装後は `steps` も）で、Status は共通。

### Epic は置き、Milestone は置かない

- Epic は目的ごとにチケットを束ねる独立したエンティティ（`epics/e3.md`）。チケットの一種にはせず、claim・ブランチ・5 つの Status を持たない
- 状態は `open` / `closed` で、閉じる・再開は既定で誰でも行える。進捗はチケットの状態から都度求め、保存しない
- 所属はチケット側の `epic` で表し、Epic 側に一覧を持たない。入れ子にせず、Iteration をまたぐ。チケットの遷移は縛らない
- Milestone は持たず、期間の目標は Iteration で表す。Iteration の所属もチケット側の `iteration` だけで表し、一覧や並び順を持たない

## 理由

- Status を固定すれば、UI・CLI・照合・集計を 1 つの実装で書け、ワークフローごとの差を吸収する層が要らない。業務の違いは工程（Run の step）と照合規則と任意フィールドで表せる
- `abandoned` を終端として持つのは、「やめた」を done と混ぜると完了件数と実績が歪み、削除すると経緯が消えるため
- Status と工程を独立した 2 軸にすると、遷移表が積になり、カンバンの列も決まらない。必要なのは「チケットの進捗」と「Run が何をしたか」の区別で、後者は Run の属性で足りる
- 状態遷移・承認・排他・記録はプログラムで保証し、要件整理・分解・実装方針・レビュー判断は AI に任せる。Workflow YAML を「制約と語彙」に限れば、エンジンは制約の検査と照合だけで済む
- 条件を組み込みの事実に限るのは、照合が全員のマシンで走るため
- 遷移を既定で自由にするのは、望ましい遷移が業務で違う（レビューを経ない作業、やり直し、やめる判断）ため。Core が表を持つと拒否の理由が業務の外から来て、緩める手段がない。縛りたいチームは `requires: [deps_done]` や `by: [human]` を 1 行書けば足り、エンジンは制約の検査と照合だけで済む
- Epic と Iteration の操作も既定で自由にし、制限を config の `actor.human_only` に置くのは、チケットの遷移と同じく「誰に任せるか」がチームで違うため。Workflow はチケットの遷移の語彙なので、Workflow の外の操作はコマンド名で縛る
- Epic（目的の範囲）・Iteration（期間）・Plan（実行順）は役割が違うので別のエンティティにする。進捗を保存しないのは、チケットを動かすたびに Epic も書き換えて衝突させないため

## 採らなかった案

- **ワークフローごとに Status を定義し、category で抽象化する**：UI・CLI・照合が category を介して動く層が増える。名前の違いは `labels` で足り、段階の違いは 5 つで覆える
- **Status と工程の 2 軸**：遷移の組み合わせが積になる。上記
- **Core が固定の遷移表を持ち、Workflow は狭めるだけ**：当初の案。todo → in_progress の `deps_done` や abandoned の人限定のような一律の拒否が業務に合わず、YAML で緩める手段がなかった
- **手続きまで YAML に書く**：対話が硬直し、エンジンが増え、手順の変更のたびにスキーマが変わる
- **条件にユーザーのスクリプトを許す**：全員のマシンで走る。安全性と再現性が落ちる
- **受け入れ条件のチェックを遷移の条件にする**：照合は人のマージで走るので、止めるとマージ済みなのに done にならないチケットが残る。`lint` と `sync` の警告にとどめ、印はエージェントが PR を出す前に `ticket check` で付ける
- **`abandoned` を持たず削除で表す**：経緯と実績が消える
- **Epic をチケットの一種にする**（`type: epic` と `parent`）：claim・カンバン・照合に例外が入り、Status を固定した利点が薄れる
- **Epic に 5 つの Status を使う**：「作業中」「確認待ち」が Epic に意味を持たない
- **Epic や Iteration 側にチケットの一覧を持つ**：チケット側と二重の正本になり、食い違いと push の衝突が起きる
- **依存先が abandoned なら着手を拒否し続ける**：やめたチケットが依存元を永久に止める
- **ラベルで Epic を代用する**：目的の本文・進捗・閉じる操作を表せない
- **Milestone を MVP に含める**：Iteration と役割が重なり、データモデルが増えるだけ
