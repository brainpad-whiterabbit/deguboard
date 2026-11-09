# ADR-031 claim が Iteration への追加と開始、作業ブランチの worktree の作成まで行う

- ステータス：承認
- 更新日：2026-11-09

## 背景

[ADR-007](ADR-007-architecture.md) の「Action の呼び方」は、worktree・ブランチの操作を guide の手順と同じ形にし、claim は `branch` を記録するだけでブランチも worktree も作らないと決めた。そのため `dg guide work` の「claim の前後」が、Iteration の入れ先の選び方（active → start が最も早い planned → ID の小さい順）・`iteration start`・`git worktree add` を親のエージェントに文で打たせていた。[ADR-030](ADR-030-flow-and-guide-in-core.md) は決まった規則を guide の文からコードへ移すと決め、claim の前後の手はその最初の対象になった。

## 決定

ADR-007 の「Action の呼び方」の「worktree・ブランチの操作は guide の手順と同じ形にする。claim は `branch` を記録するだけで、ブランチも worktree も作らない（ST-3）」の項を置き換える。

- claim は、`lint.require_iteration` が true なら Iteration の空いたチケットを Iteration に入れ、チケットの Iteration が planned なら開始する。どちらも claim と同じ書き込みに入れ、claim の push で一緒に決まる
- claim は push で排他を得た後、作業ブランチを base から切って worktree を作り、場所を返す。作らない指定もできる
- どれもできないとき（入れ先がない・ほかの active がある・`actor.human_only`・worktree を作れない）は、claim を失敗させず warnings で人への頼みを返す
- worktree を作る手順は Core の git の層に置き、claim と `create_worktree` の Action が同じものを使う。commands は actions に依存しない（ADR-007・AG-6）ことは変えない

## 理由

- 入れ先の選び方と開始の要否は決まった規則で、LLM が文を読んで守ると確率的にずれる。claim の中に置けば毎回同じに守れ、親の手も減る（ADR-030）
- Iteration の追加と開始を claim と同じ書き込みにすれば、別の push の間に別のマシンの claim や開始が割り込まない
- worktree を push の後に作るのは、取れなかった claim でブランチと worktree を残さないため
- これらは claim の排他とは別の都合なので、できなくても claim を失敗させない。Run を開けないときと同じ扱い
- git の層は actions も commands も依存してよいので、依存の向きを変えずに 1 つの手順を共有できる（`dg pr merge` が gh を git の層から呼ぶのと同じ形）

## 採らなかった案

- **claim が actions の `create_worktree` を呼ぶ**：commands が actions に依存し、AG-6 と ADR-007 の依存の向きを変えることになる
- **worktree の作成を別のコマンドにする**：親が claim と別に打つ手が残り、打ち忘れが確率的に起きる
- **Iteration の追加と開始を claim の後の別の書き込みにする**：claim の push と別に決まり、間に割り込まれる
