# Run の記録（run）

Run は 1 回の作業の記録で、使用量（トークン）が残る。親が自分で作業するときの claim と PR の記録、止まった Run の始末だけを書く。

## 親が自分で進めるとき

- Run を開く claim は単独で呼び、ほかのコマンドとつながない（ID が会話記録に出るのが遅れると、同じ会話で重ねた Run の応答を正しく分けられない）
- 実装の Run は `ticket claim` が開く。step は Workflow の `opens_on: claim` のもの（なければ `implement`）。ID は `data.run`
- 実装の Run は `ticket update --pr <番号>` が `success` で閉じる（finished_at は PR の作成時刻）。`run finish` は要らない。PR の要らない作業は `ticket move` の done・review が閉じる
- やめるなら `ticket unclaim` が `failure` で閉じる。理由を残すなら先に `run finish <Run の ID> --result failure --error <理由>`
- 自分で手直しするなら、自分が claim 済みで PR のあるチケットを `ticket claim <id> --retry-reason <指摘 1 件の要約>` で claim する。指摘 1 件に 1 つ繰り返す。チケットは変わらず、手直しの Run（`opens_on: reclaim` のもの、なければ `fix`）が開く。次の見直しの Run の開始か `sync` が、最後の push の時刻で閉じる
- 理由は 1 行で、秘密・コマンドの文字列・パスは書かない

## 止まった Run

返らないまま開いている Run は `dg --json --actor agent run list --running --ticket <id>` で探し、`run finish <Run の ID> --result interrupted --error <理由>` で閉じる。その後の手は `dg next` に従う。
