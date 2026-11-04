# Run の記録と段階のモデル（run）

作業の記録（Run）と、Plan の段階ごとのモデルの選び方、閉じ損ねた Run の始末。`dg guide work` から読む補助の手順で、work・parallel・review・overview が参照する。

## Run を記録する

Run は 1 回の作業の記録で、使用量（トークン）が残る。実装の Run は `dg guide work` の手順 4〜6、見直しと手直しは別の Run（`dg guide review` の「Run の分け方」）。PR の要らない作業も、作業の前後で始めて閉じる。

- **step**：チケットの Project の Workflow（`dg --json --actor agent project list` の `workflow`）を `dg --json --actor agent workflow show <workflow>` で読み、`data.definition.steps` から今の作業に合うものの `id` を選ぶ。`steps` がなければ `implement`・`review`・`fix`・`investigate` を使う。合う語がないとき（init の前からある Workflow や consulting に `fix` がないなど）は `dg guide review` の「Run の分け方」の「合う step がない」（代わりの step と、人に伝えるかどうか）
- **agent**：自分の Adapter の名前（`dg run start --help`。Claude Code なら `claude-code`）
- **自分で呼ぶ**：run start と finish は作業するエージェント自身が呼ぶ（理由は `dg guide review` の「Run の分け方」）
- 使用量は書かない。取れずに finish が警告しても止めない
- 同じ step の Run が実行中で start が拒否されたら、下の「閉じ損ねた Run を閉じる」で閉じて始め直す。サブエージェントなら閉じずに親に返す（親が `interrupted` で閉じる）
- **結果**：実装の Run は draft の PR を作ったら `success`。自分の判断でやめる（検査が通らない、範囲がはっきりしない）なら `--result failure --error <理由>` で閉じる。`interrupted` は閉じ損ねた Run だけに使う
- **やり直しの理由**：`--retry-reason` の書き方は `dg guide review` の「Run の分け方」

## 段階のモデル

Plan の `details.<id>.tier`（省けば standard）を `config.yaml` の `models.*`（今の設定：light `{{models.light}}`・standard `{{models.standard}}`・heavy `{{models.heavy}}`。なし（空）なら親のモデル）でモデルに対応させる。モデルを選べない環境では、すべて親のモデルで進める。

- **実装**：段階のモデルが親と違うときだけ、そのモデルのサブエージェントに `dg guide work` の手順 4〜6（run start から draft の PR を作って実装の Run を閉じるまで）を渡す。サブエージェントは `--model <モデル>` を付けて自分で run start する。渡すもの・しないこと・返すものと、返った後に親が行う `ticket check`・`ticket update --pr` は `dg guide parallel` と同じ。同じモデルなら今までどおり親が run start して実装する
- **調べもの**：実装の中でコードや記録を調べるサブエージェントは、段階によらず `models.light` で起動する（空なら親のモデル）
- **見直しと手直し**：見直し役は段階によらず親のモデル、修正ループは実装者と同じモデル（`dg guide review`）

## 閉じ損ねた Run を閉じる

finish を呼べずに残った Run は、`dg --json --actor agent run list --running --ticket <id>` で `step`・`agent` が合うものを探し、`run finish <Run の ID> --result interrupted --error <理由>` で閉じる。続けるなら同じ step の Run を始め直す。やめるなら、実装の Run は `ticket unclaim <id>`、手直し・見直しの Run は `dg guide review` の「終わり方」
