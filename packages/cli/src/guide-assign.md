---
description: deguboard のチケットを Iteration（スプリント）と Epic に割り当てる。Iteration を指定すると未割り当ての todo を入れるかどうか判断し、指定がなければ内容に合う Iteration・Epic（新設を含む）を提案する。早めに対応した方がよいものは進行中の Iteration に入れる。「スプリントに入れて」「Epic にまとめて」「割り振って」と頼まれたときに使う。
argument-hint: "[Iteration|Epic|チケットの ID...]"
---

# 割り当て（assign）

チケットを Iteration（期間の計画。`sprint` はエイリアス）と Epic（目的の束ね）に入れる。

## 対象を決める

- Iteration（`s3`）：未割り当ての todo を、その Iteration に入れるか入れないか 1 枚ずつ判断する
- Epic（`e3`）：Epic のないチケットのうち、目的が合うものを入れる案を作る
- チケットの ID：そのチケットに合う Iteration と Epic を提案する（なければ作ることを提案する）
- 指定が空：active の Iteration（なければ planned のもの）を勧めて確かめ、未割り当ての todo を対象にする

## Iteration

- 一覧：`dg --json --actor agent iteration list`（`status` は planned / active / closed）
- 作る：`dg --json --actor agent iteration create "<名前>" --goal "<目標>" --start 2026-11-01 --end 2026-11-14`
- 直す：`dg --json --actor agent iteration update <s3> --goal "<目標>"`。`--name`・`--start`・`--end` も、指定したものだけ変わる。閉じた Iteration も直せる
- 入れる：`dg --json --actor agent iteration add <s3> <t12> <t13>`。別の Iteration に入っていたチケットは移る。所属はチケットの `iteration` に記録され、並びは優先度と番号
- 外す：`dg --json --actor agent iteration remove <s3> <t12>`
- 開始：`dg --json --actor agent iteration start <s3>`（planned → active）。active は Project に 1 つで、ほかに active があれば開始も再開も拒否される。前のものを閉じるかは人に聞く
- 閉じる：`dg --json --actor agent iteration close <s3>`。done の件数と持ち越しの件数が記録され、持ち越したチケットは Iteration から外れる。人の指示で閉じる（制限は `dg guide overview`）
- 再開：`dg --json --actor agent iteration reopen <s3>`。active に戻り、件数は消える。持ち越したチケットは戻らないので `iteration add` で入れ直す。人の指示で行う

## Epic

- 一覧と進捗：`dg --json --actor agent epic list`（`progress.done / progress.total`。abandoned は数えない）
- 入れる：`dg --json --actor agent epic add <e3> <t12> <t13>`。同じ Project のチケットだけ。閉じた Epic には入れられない
- 外す：`dg --json --actor agent epic remove <e3> <t12>`
- 閉じる・再開する：`dg --json --actor agent epic close <e3>` / `epic reopen <e3>`。done・abandoned 以外が残っていれば拒否され、`--force` で閉じられる。人の指示で閉じる（制限は `dg guide overview`）

## 担当者

- 人かその AI に担当を付ける：`dg --json --actor agent ticket update <t12> --assignee human`（ユーザ本人）、`--assignee agent`（ユーザの AI）、`--assignee <ID>`（別のユーザ。`bob` や `bob/agent`）。外すのは `--assignee none`
- 担当は予定の印で、排他ではない。着手は claim で決まり、claim した主体が担当者になる
- チケットを起票するなら、`dg guide import` の「起票者と担当者」の扱い（`--created-by`）に従う

## 割り当てを提案するとき

1. Iteration の目標と期間、入っているチケットを `dg --json --actor agent iteration show <s3>` で読む
2. 未割り当ての todo（`dg --json --actor agent ticket list --status todo` のうち `iteration` がないもの）を集め、目標に合うものと依存の順を見て案を作る
3. 入れる・入れないの理由を 1 行ずつ添えた表を見せ、入れる行を複数選択で選んでもらってから `iteration add` する
4. 早めに対応した方がよいもの（不具合など）は進行中の Iteration に入れることを提案する

{{choices}}

## 次の手順を選ぶ

割り当てたら、次の選択肢で聞く。

- **点検する**：割り当てたチケットの本文や Epic の食い違いを `dg guide check` の手順で直す（Skill があれば `/dgcheck s3`）
- **計画を立てる**（勧める）：割り当てた Iteration のチケットを `dg guide plan` の手順で進める順に並べる（Skill があれば `/dgplan s3`）
- **ここで止める**
