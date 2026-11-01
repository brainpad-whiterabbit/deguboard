---
description: deguboard の承認済みの Plan のチケットを、着手できるものから claim して実装し、受け入れ条件を確かめて PR まで進める。PR の要らない作業は done まで進める。「p3 を進めて」「計画を再開して」「t12 を進めて」と頼まれたときに使う。Plan のない複数のチケットは dgplan で計画を立ててから使う。
argument-hint: "<Plan の ID|チケットの ID>"
---

# 作業（work）

1 枚のチケットを claim から PR まで進める（PR の要らない作業は下の同名の節）。状態は作業ブランチの Git 上の事実（ある・push 済み・PR・マージ）から `dg sync` が進める。

## 対象を決める

- Plan の ID（`p3`）：下の「Plan に従って進める」で、着手できるものから 1 枚ずつ進める
- チケットの ID：そのチケットを進める。開いた Plan に入っていれば（`ticket show` の `plan`）その Plan に従う
- 指定が空：`plan list --status open` の承認済みの Plan を勧めて確かめる。なければ `dg guide plan` で計画を立てることを勧める

## 流れ

1. 着手できるか確かめる：`dg --json --actor agent ticket show <id>`。`status` が todo で `deps_done` が true。todo でも `assignee` が別のユーザなら、その人の予定なので避ける（自分か自分のユーザのものなら着手してよい）
2. claim する：`dg --json --actor agent ticket claim <id> --branch <種類>/<内容>`（何が起きるかは `--help`）。`CLAIM_LOST`（誰かが先に claim した）なら別のチケットへ。`TRANSITION_REJECTED` なら Workflow の制約。`error.message` を読む
   - Iteration を始める：claim できたら、`ticket show` の `iteration` があり、`iteration show <S>` の `status` が planned のときだけ、人に聞かずに `dg --json --actor agent iteration start <S>` で active にする。active・closed や Iteration のないチケットでは何もしない。拒否されたら `iteration show` を読み直し、active なら何もせず、planned のままなら人に頼む。どちらでも作業は続ける
3. 作業ブランチと worktree を作る（リポジトリの規約に従う。既定の置き場所は `{{worktree.root}}`）

   ```sh
   git fetch {{git.remote}}
   git worktree add --no-track -b <ブランチ名> <worktree の場所> {{git.remote}}/{{git.base_branch}}
   ```

4. 実装の Run を始めて実装する（下の「Run を記録する」）：`dg --json --actor agent run start <id> <step> --agent <エージェント>`（software-development・general では `implement`）。返った Run の ID を控える。実装は本文の `## 受け入れ条件` を満たすことを目標にし、リポジトリの検査（lint・テスト）を通す
5. 受け入れ条件を 1 項目ずつ確かめる。`dg --json --actor agent ticket show <id>` の `acceptance` を読み、成果物やテストで満たしたと確認できた項目だけ `dg --json --actor agent ticket check <id> <番号...>` で付ける。確認できない項目は付けず、PR の本文と人への報告に理由を書く
6. コミットして push し、PR を draft で作る（`gh pr create --draft`）。PR の本文にチケットの ID（`t12`）と、付けられなかった受け入れ条件を書く。PR の番号をチケットに記録する：`dg --json --actor agent ticket update <id> --pr <番号>`。draft の PR を作ったら実装の Run を閉じる。続けて `dg guide review` のとおり、別のサブエージェントの見直しと上限付きの修正ループで品質ゲートを通し、`gh pr ready <PR>` で出す
7. `dg --json --actor agent sync` を回す。Workflow が PR の事実を見るなら（software-development）、draft でない PR が開いていれば review に進む（`gh` が要る）。見ないなら（general など）、PR を出したら自分で `dg --json --actor agent ticket move <id> review` に進める
8. 人のレビューの指摘は、`fix` の Run で同じブランチで直して push する（`dg guide review` の「Run の分け方」）。マージは人が行う。マージ後は `dg guide done`

## Run を記録する

Run は 1 回の作業の記録で、使用量（トークン）が残る。実装の Run は手順 4〜6、見直しと手直しは別の Run（`dg guide review` の「Run の分け方」）。PR の要らない作業も、作業の前後で始めて閉じる。

- **step**：チケットの Project の Workflow（`dg --json --actor agent project list` の `workflow`）を `dg --json --actor agent workflow show <workflow>` で読み、`data.definition.steps` から今の作業に合うものの `id` を選ぶ。`steps` がなければ `implement`・`review`・`fix`・`investigate` を使う。合う語がないとき（init の前からある Workflow に `fix` がないなど）は `dg guide review` の「Run の分け方」
- **agent**：自分の Adapter の名前（`dg run start --help`。Claude Code なら `claude-code`）
- **自分で呼ぶ**：run start と finish は作業するエージェント自身が呼ぶ（理由は `dg guide review` の「Run の分け方」）
- 使用量は書かない。取れずに finish が警告しても止めない
- 同じ step の Run が実行中で start が拒否されたら、下の「閉じ損ねた Run を閉じる」で閉じて始め直す。サブエージェントなら閉じずに親に返す（親が `interrupted` で閉じる）
- **結果**：実装の Run は draft の PR を作ったら `success`。自分の判断でやめる（検査が通らない、範囲がはっきりしない）なら `--result failure --error <理由>` で閉じる。`interrupted` は閉じ損ねた Run だけに使う
- **やり直しの理由**：`--retry-reason` の書き方は `dg guide review` の「Run の分け方」

## Plan に従って進める

承認済みの Plan（`dg guide plan`）があれば、その順と中身に従う。

- 着手する前に `dg --json --actor agent plan show <p>` を読む。`pending_approval` が true（承認待ち）なら着手せず、人に承認を求める
- 順は `items`（Plan の順）と `after`。`items[].waiting`（まだ終わっていない待ち先）が空のチケットだけに着手する。after は claim では検査されないので、自分で守る。着手できるものが複数あれば `items` の順で先のものから（同時に進めるなら下の「着手できるチケットを並べて進める」）
- 着手するチケットの `details.<id>.scope`（範囲）と `approach`（方針）を読み、その範囲と方針で実装する。範囲を広げる・方針を変えるなら、先に人に確かめる
- 1 枚終えたら（PR を出したら）`plan show` を読み直して次を選ぶ。Plan のチケットがすべて終わったら `dg guide done` の「Plan を閉じる」

## 着手できるチケットを並べて進める

Plan の `items[].waiting` が空のチケットが複数あり、サブエージェントを起動できるなら、チケットごとに起動して同時に進めてよい。`dg` は順を示すだけで、起動と待ち合わせはこの手順で行う。進めるセッション（親）は進行・承認・`dg` の読み書きだけを行う。

- **上限**：同時に 3 件まで。人が数を指示したらそれに従う。検査が負荷で落ちるなら減らす
- **始める前**：開いた Plan と PR を見て、同じファイルを直すものがないか確かめる。互いに同じファイルを変えるチケットは並べず、`after` で順にすることを人に提案する
- **親**：claim と worktree の作成（手順 2・3）を 1 件ずつ行い、済んだらサブエージェントを起動する。返るたびに中身を確かめて `ticket check` と `ticket update --pr` を記録し、`dg guide review` の見直しと修正ループを回して PR を ready にし、手順 7 を行い、`plan show` を読み直して空いた枠で次を起動する。人のレビューの指摘（手順 8）は、同じか新しいサブエージェントに直させる。PR を出したチケット（マージ待ち）は枠に数えない
- **サブエージェントに渡す**：チケットの ID・Plan の `details` の範囲と方針・ブランチと worktree のパス・規約の場所・チケットごとの一時ファイルの置き場所・手順 4〜6 の draft の PR を作って実装の Run を閉じるまでに従うこと（受け入れ条件は確かめて報告するだけで印は付けない。PR 番号の記録は親）。run start と finish は自身に呼ばせる
- **サブエージェントがしない**：claim・unclaim・Plan の操作・見直し役の起動・自分のもの以外の Run を閉じる・`gh pr ready`・マージ・`ticket check`・`ticket update --pr`・ほかのチケットの作業
- **サブエージェントが返す**：draft の PR の URL・閉じた Run の ID・確かめた受け入れ条件と付けられなかった項目（理由）・検査の結果・人に伝えること
- **1 件でほかを止めない**：`CLAIM_LOST` ならそのチケットを飛ばす。実装が失敗したら Run を閉じて `ticket unclaim` で todo に戻し、worktree は残して、同じ流れでは claim し直さない。Run は `run list --running --ticket <id>` で確かめ、実行中なら親が閉じる（失敗として返れば `failure`、返らなければ `interrupted`。見直し・手直しの Run も同じく閉じる（unclaim はしない））。失敗・マージ待ちを待つのは `after` でそれを待つチケットだけ

## PR の要らない作業

チケットのデータの整備・確認・調査など、リポジトリのファイルを変えない作業は、ブランチも PR も作らない。照合には頼らず、自分で done まで進める。

1. claim する：`dg --json --actor agent ticket claim <id> --without-branch`。planned の Iteration は上の手順 2 のとおり始める
2. Run を始めて作業し、終えたら閉じる（上の「Run を記録する」）。worktree は作らない。何をしたかと結果は、最後に人への報告に書く
3. 受け入れ条件を 1 項目ずつ確かめ、満たした項目だけ `ticket check` で付ける（上の手順 5 と同じ）
4. すべて付いたら `dg --json --actor agent ticket move <id> done`。付けられない項目が残ったら `ticket move <id> review` にして、残った項目と理由を人に報告する（done にするのは人）
5. 途中でリポジトリのファイルを変える必要が出たら、`ticket update <id> --branch <種類>/<内容>` で記録して上の流れに移る。逆にブランチが要らなくなったら `--branch none`

## 状態について

- 自分で `status` を進めるのは普段 in_progress → review まで。done は照合（マージ）で進む。照合で進まないときや人に指示されたときだけ `ticket move <id> done` で進める（制限は `dg guide overview`）
- 途中でやめるなら、Run を閉じてから（「Run を記録する」の「結果」）`dg --json --actor agent ticket unclaim <id>`（todo に戻る）。手直しは unclaim せず `dg guide review` の「終わり方」。review にあるなら人に差し戻しを頼む
- 作業中に別の作業が見つかったら、そのチケットに混ぜず `dg guide import` の手順で起票を提案する

## 閉じ損ねた Run を閉じる

finish を呼べずに残った Run は、`dg --json --actor agent run list --running --ticket <id>` で `step`・`agent` が合うものを探し、`run finish <Run の ID> --result interrupted --error <理由>` で閉じる。続けるなら同じ step の Run を始め直す。やめるなら、実装の Run は `ticket unclaim <id>`、手直しの Run は `dg guide review` の「終わり方」

## 任意フィールド

Workflow の `fields`（見積など）は `dg --json --actor agent ticket update <id> --field estimate=3`

{{choices}}

## 次の手順を選ぶ

PR を出したら（PR の要らない作業を終えたときも）、結果を伝えて次の選択肢で聞く。

- **次のチケットに進む**（勧める。Plan に着手できるチケットが残っていれば）：`plan show` を読み直し、この手順で次の 1 枚を進める
- **完了にする**：PR がマージされていれば、`dg guide done` の手順で片付ける（Claude Code では `/dgdone <ID>`）
- **ここで止める**：マージを待つ。マージ後に `/dgdone` で片付ける
