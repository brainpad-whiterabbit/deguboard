# Run の記録と段階のモデル（run）

作業の記録（Run）と、Plan の段階ごとのモデルの選び方、閉じ損ねた Run の始末。`dg guide work` から読む補助の手順で、work・parallel・review・overview が参照する。

## Run を記録する

Run は 1 回の作業の記録で、使用量（トークン）が残る。実装の Run は agent の `ticket claim` が開く（Workflow の `steps` のうち `opens_on: claim` の step。なければ `implement`。ID は `data.run`。`dg guide work` の手順 2〜6）。PR の要らない作業も claim が開く。実装をサブエージェントに渡す親は `--no-run` で claim し、サブエージェントが `run start` で開く。見直しと手直しは別の Run を `run start` で開く（`dg guide review` の「Run の分け方」）。

- **step**（`run start` で開くとき）：チケットの Project の Workflow（`dg --json --actor agent project list` の `workflow`）を `dg --json --actor agent workflow show <workflow>` で読み、`data.definition.steps` から今の作業に合うものの `id` を選ぶ。`steps` がなければ `implement`・`review`・`fix`・`investigate` を使う
- **合う step がない**：`steps` に `fix` がなければ `review`、`review` もなければ実装の step で代わりに記録する（`review` がなければ見直し役も実装の step で記録する）。同梱のテンプレートが持つ `fix`・`review` が Workflow にない（init の前からある Workflow など）ときだけ、足すよう人に伝える。consulting のようにテンプレートにも `fix` がない Workflow では伝えず、代わりの step で記録するだけにする。足すのは `dg --json --actor agent workflow show <id>` の `data.definition` の `steps` に項目を足したファイルを `dg workflow set <id> --file <path>` で書く（`dg init` は既にある Workflow を書き換えない。`--template` は labels・transitions・fields・独自の steps を捨てて定義を丸ごと置き換えるので、手を加えた Workflow には使わない）
- **agent**：自分の Adapter の名前（`dg run start --help`。Claude Code なら `claude-code`）。`--agent` を省くと環境変数から判定する。判定できなければ `run start` は拒否され、`claim` は Run を開かずに警告するので、そのときは `--agent` を渡す（claim が開かなかった Run は `run start` で開く）
- **自分で呼ぶ**：Run は作業するエージェント自身が開いて（claim か run start）閉じる。親が claim で開いた Run の作業をサブエージェントに渡さない（理由は `dg guide review` の「Run の分け方」）
- 使用量は書かない。取れずに finish が警告しても止めない
- run start は単独で呼び、ほかのコマンドとつながない（ID が会話記録に出るのが遅れると、同じ会話で重ねた Run の応答を正しく分けられない）
- start が同じ agent の Run が開いたままと警告したら、自分の終わった Run なら閉じる（同じ会話で重ねた Run は、応答を後に始めた方にだけ数える）。並行するほかのエージェントの Run や、始めた覚えのない ID なら無視してよい
- 同じ step の Run が実行中で start が拒否されたら、下の「閉じ損ねた Run を閉じる」で閉じて始め直す。サブエージェントなら閉じずに親に返す（親が `interrupted` で閉じる）
- **結果**：実装の Run は draft の PR を作ったら `success`。自分の判断でやめる（検査が通らない、範囲がはっきりしない）なら `--result failure --error <理由>` で閉じる。`interrupted` は閉じ損ねた Run だけに使う
- **やり直しの理由**：`--retry-reason` の書き方は `dg guide review` の「Run の分け方」

## 段階のモデル

Plan の `details.<id>.tier`（省けば standard）を `config.yaml` の `models.*`（今の設定：light `{{models.light}}`・standard `{{models.standard}}`・heavy `{{models.heavy}}`。なし（空）なら親のモデル）でモデルに対応させる。モデルを選べない環境では、すべて親のモデルで進める。

- **実装**：段階のモデルが親と違うときだけ、親は `--no-run` で claim し、そのモデルのサブエージェントに `dg guide work` の手順 4〜6（run start から draft の PR を作って実装の Run を閉じるまで）を渡す。サブエージェントは `--model <モデル>` を付けて自分で run start する。渡すもの・しないこと・返すものと、返った後に親が行う `ticket check`・`ticket update --pr` は `dg guide parallel` と同じ。同じモデルなら、claim が開いた Run で親が実装する
- **調べもの**：実装の中でコードや記録を調べるサブエージェントは、段階によらず `models.light` で起動する（空なら親のモデル）
- **見直しと手直し**：見直し役は段階によらず親のモデル、修正ループは実装者と同じモデル（`dg guide review`）

## 閉じ損ねた Run を閉じる

finish を呼べずに残った Run は、`dg --json --actor agent run list --running --ticket <id>` で `step`・`agent` が合うものを探し、`run finish <Run の ID> --result interrupted --error <理由>` で閉じる。続けるなら同じ step の Run を始め直す。やめるなら、実装の Run は `ticket unclaim <id>`、手直し・見直しの Run は `dg guide review` の「終わり方」
