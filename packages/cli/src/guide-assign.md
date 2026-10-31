# 割り当て（assign）

チケットを Iteration（期間の計画。`sprint` はエイリアス）と Epic（目的の束ね）に入れる。

## Iteration

- 一覧：`dg --json --actor agent iteration list`（`status` は planned / active / closed）
- 作る：`dg --json --actor agent iteration create "<名前>" --goal "<目標>" --start 2026-11-01 --end 2026-11-14`
- 入れる：`dg --json --actor agent iteration add <s3> <t12> <t13>`。別の Iteration に入っていたチケットは移る。所属はチケットの `iteration` に記録され、並びは優先度と番号
- 外す：`dg --json --actor agent iteration remove <s3> <t12>`
- 開始：`dg --json --actor agent iteration start <s3>`（planned → active）
- 閉じる：`dg --json --actor agent iteration close <s3>`。done の件数と持ち越しの件数が記録され、持ち越したチケットは Iteration から外れる。人の指示で閉じる（制限は `dg guide overview`）
- 再開：`dg --json --actor agent iteration reopen <s3>`。active に戻り、件数は消える。持ち越したチケットは戻らないので `iteration add` で入れ直す。人の指示で行う

## Epic

- 一覧と進捗：`dg --json --actor agent epic list`（`progress.done / progress.total`。abandoned は数えない）
- 入れる：`dg --json --actor agent epic add <e3> <t12> <t13>`。同じ Project のチケットだけ。閉じた Epic には入れられない
- 外す：`dg --json --actor agent epic remove <e3> <t12>`
- 閉じる・再開する：`dg --json --actor agent epic close <e3>` / `epic reopen <e3>`。done・abandoned 以外が残っていれば拒否され、`--force` で閉じられる。人の指示で閉じる（制限は `dg guide overview`）

## 担当者

- 人かその AI に担当を付ける：`dg --json --actor agent ticket update <t12> --assignee human`（ユーザ本人）、`--assignee agent`（ユーザの AI）、`--assignee <ID>`（別のユーザ。`bob` や `bob/agent`）。外すのは画面か人に頼む（CLI は `--assignee` に空を渡せない）
- 担当は予定の印で、排他ではない。着手は claim で決まり、claim した主体が担当者になる

## 割り当てを提案するとき

1. Iteration の目標と期間、入っているチケットを `dg --json --actor agent iteration show <s3>` で読む
2. 未割り当ての todo（`dg --json --actor agent ticket list --status todo` のうち `iteration` がないもの）を集め、目標に合うものと依存の順を見て案を作る
3. 入れる・入れないの理由を 1 行ずつ添えて人に見せ、承認を得てから `iteration add` する
4. 早めに対応した方がよいもの（不具合など）は進行中の Iteration に入れることを提案する
