---
description: deguboard のチケット・Epic・Iteration・Plan を点検し、dg sync・validate・lint の指摘と直す案を表で示して、承認を得てから直す。「チケットを点検して」「整合性を確認して」「Iteration を見直して」と頼まれたときや、計画を立てる前に使う。
argument-hint: "[Iteration|Epic|チケットの ID...]"
---

# 点検（check）

チケット・Epic・Iteration・Plan の食い違いを見つけ、承認を得てから直す。何を食い違いとみなすかは `dg validate`（読めないファイル・参照の不整合）と `dg lint`（本文の節・任意フィールド・Epic と Plan の状態・`lint.require_iteration` が true のときの Iteration の欠け。今の設定：`{{lint.require_iteration}}`）が判定する。この手順は判定を持たず、指摘を読んで直し方を決める。

## 対象を決める

- Iteration（`s3`）・Epic（`e3`）：その中のチケットと、その Iteration・Epic 自身の指摘を対象にする
- チケットの ID：そのチケットの指摘を対象にする
- 指定が空：Project 全体（`--project {{default_project}}`）を対象にする

## 点検の手順

1. **指摘を集める**：`dg --json --actor agent sync`・`dg --json --actor agent validate`・`dg --json --actor agent lint` を順に回す。`sync` の `warnings`、`validate` と `lint` の `issues`（`code`・`id`・`message`）を対象で絞る
2. **直す案を作る**：指摘ごとに、`ticket show`・`epic show`・`plan show` で中身を読んで直し方を決める。例：
   - 本文の節が欠けている・受け入れ条件が空：本文から受け入れ条件の案を作る（`ticket update --acceptance`）。概要は今の本文に `## 概要` を足した全文を `--body` で渡す（`--body` は本文を置き換える）
   - 閉じた Epic に終わっていないチケットが残る：別の Epic に移す・Epic から外す・abandoned にする、のどれかを案にする
   - チケットがすべて終わったのに Epic・Plan が開いている：閉じる（`epic close` / `plan close`）を案にする
   - Iteration に入っていない（`lint_iteration_missing`）：`dg guide work` の手順 1 のとおり Iteration を選んで `iteration add <S> <id>` で入れるを案にする。入れ先がない（閉じた Iteration には入れられない。done のチケットなど）なら、Iteration を作るか設定を変えるかを人に聞く
   - 同じ Project に active の Iteration が 2 つ以上（`lint_iteration_multiple_active`）：どれを閉じるかを人に聞く（閉じるのは人の指示で行う）
   - `sync` の警告（照合できない、未チェックの受け入れ条件が残ったまま done になった）：`dg guide done` の手順で確かめる案にする
3. **表で示して承認を得る**：次の表を示し、反映する行を `#` の複数選択で聞く（「反映しない」も入れる）。直し方が 1 つに決まらない行は案を並べ、選択肢の外の入力で受ける

   | #   | 対象 | 指摘（code） | 直す案 | コマンド |
   | --- | ---- | ------------ | ------ | -------- |

4. **直す**：承認された行だけを表の順に実行する。削除・abandoned・Epic や Iteration を閉じる・再開するのは、承認された行でも 1 件ずつもう一度確かめる
5. **確かめて伝える**：`lint` と `validate` を回し直し、直したもの・残した指摘（理由）・新しく出た指摘を伝える

指摘を集めて表を作るまでは承認を待たずに進める（書き込まないため）。`sync` の書き込みは照合だけなので待たない。

{{choices}}

## 次の手順を選ぶ

結果を伝えたら（指摘がなかったときも）、次の選択肢で聞く。

- **計画を立てる**（勧める）：対象の todo を `dg guide plan` の手順で計画する（Claude Code では `/dgplan <対象>`）
- **割り当てる**：Iteration に入っていない todo があれば `dg guide assign` の手順で割り当てる（`/dgassign`）
- **ここで止める**
