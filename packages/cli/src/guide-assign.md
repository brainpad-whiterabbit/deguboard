# 割り当て（assign）

チケットを Iteration（期間の計画。`sprint` はエイリアス）と Epic（目的の束ね）に入れる。

## Iteration

- 一覧：`dg --json iteration list`（`status` は planned / active / closed）
- 作る：`dg --json --actor agent iteration create "<名前>" --goal "<目標>" --start 2026-11-01 --end 2026-11-14`
- 入れる：`dg --json --actor agent iteration add <s3> <t12> <t13>`。別の Iteration に入っていたチケットは移る。所属はチケットの `iteration` に記録され、並びは優先度と番号
- 外す：`dg --json --actor agent iteration remove <s3> <t12>`
- 開始：`dg --json --actor agent iteration start <s3>`（planned → active）
- 閉じる：`dg --json iteration close <s3>` は人が行う。done の件数と持ち越しの件数が記録され、持ち越したチケットは Iteration から外れる

## Epic

- 一覧と進捗：`dg --json epic list`（`progress.done / progress.total`。abandoned は数えない）
- 入れる：`dg --json --actor agent epic add <e3> <t12> <t13>`。同じ Project のチケットだけ。閉じた Epic には入れられない
- 外す：`dg --json --actor agent epic remove <e3> <t12>`
- 閉じる・再開するのは人だけ（`epic close` / `epic reopen`）。done・abandoned 以外が残っていれば拒否され、人が `--force` で閉じる

## 割り当てを提案するとき

1. Iteration の目標と期間、入っているチケットを `iteration show <s3>` で読む
2. 未割り当ての todo を `ticket list --status todo` で集め、目標に合うものと依存の順を見て案を作る
3. 入れる・入れないの理由を 1 行ずつ添えて人に見せ、承認を得てから `iteration add` する
4. 早めに対応した方がよいもの（不具合など）は進行中の Iteration に入れることを提案する
