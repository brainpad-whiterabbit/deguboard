# ADR-031 claim が Iteration への追加と開始、作業ブランチの worktree の作成まで行う

- ステータス：承認

## 要約

claim は排他を得た後に、`lint.require_iteration` が true なら Iteration への追加と planned の開始を同じ書き込みで行い、作業ブランチを base から切って worktree を作る。入れ先が決まらない・worktree を作れないときは claim を失敗させず、warnings で人への頼みを返す。チケットの Iteration を active にできないときだけは claim を拒否する。

## 背景

claim は `branch` を記録するだけでブランチも worktree も作らない。そのため the "Before and after claim" section of `dg guide work` が、Iteration の入れ先の選び方・`iteration start`・`git worktree add` を親のエージェントに文で打たせていた。[ADR-030](ADR-030-flow-and-guide-in-core.md) は決まった規則を guide の文からコードへ移すと決め、claim の前後の手はその最初の対象になった。

## 決定

- claim は、`lint.require_iteration` が true なら Iteration の空いたチケットを Iteration に入れ、チケットの Iteration が planned なら開始する。どちらも claim と同じ書き込みに入れ、claim の push で一緒に決まる
- claim は push で排他を得た後、作業ブランチを base から切って worktree を作り、場所を返す。作らない指定もできる
- 入れ先がない・active がなく planned が複数で決まらない（ADR-009）・worktree を作れないときは、claim を失敗させず warnings で人への頼みを返す
- チケットの Iteration を active にできないとき（planned でほかに active がある・closed）は、claim を拒否する。作業中のチケットの Iteration は active、という固定の規則（[ADR-009](ADR-009-epic-and-iteration.md)）で、`ticket move` の todo からの前進も同じ開始と拒否を行う
- worktree を作る手順は Core の git の層（`git/branch-worktree.ts`）に置き、claim はそれを呼ぶ

## 理由

- 入れ先の選び方と開始の要否は決まった規則で、LLM が文を読んで守ると確率的にずれる。claim の中に置けば毎回同じに守れ、親の手も減る（ADR-030）
- Iteration の追加と開始を claim と同じ書き込みにすれば、別の push の間に別のマシンの claim や開始が割り込まない
- worktree を push の後に作るのは、取れなかった claim でブランチと worktree を残さないため
- 入れ先と worktree は claim の排他とは別の都合なので、できなくても claim を失敗させない。Run を開けないときと同じ扱い
- Iteration を active にできないときを拒否にするのは、警告だけで claim させると、active でない Iteration で作業が進み、active を 1 つに限る判断（ADR-009）と食い違うため
- git の層は commands が依存してよいので、依存の向きを変えずに git の手順を 1 か所に置ける（`dg pr merge` が gh を git の層から呼ぶのと同じ形）

## 採らなかった案

- **worktree の作成を別のコマンドにする**：親が claim と別に打つ手が残り、打ち忘れが確率的に起きる
- **Iteration の追加と開始を claim の後の別の書き込みにする**：claim の push と別に決まり、間に割り込まれる
- **ほかに active があって planned を開始できないときも、警告だけで claim させる**：active でない Iteration のチケットが作業中になり、警告は読み飛ばされる
