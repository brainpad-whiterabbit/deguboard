---
description: deguboard のマージ済みのチケットを照合して done を確かめ、残った受け入れ条件を確かめ、作業ブランチと worktree を片付けて、終わった Plan を閉じる。「t12 を完了にして」「マージしたので片付けて」「Plan を閉じて」と頼まれたときに使う。
argument-hint: "[チケットの ID...|Plan の ID|Iteration]"
---

# 完了（done）

PR がマージされたあとの後始末（PR の要らない作業は `dg guide work` の中で done まで進むので、ここは読まない）。done にするのは照合か人で、エージェントは確認と記録を行う。受け入れ条件の印は普段 `dg guide work` の段階で付いている。

## 対象を決める

- チケットの ID：そのチケットを片付ける
- Plan の ID（`p3`）：その Plan のチケットのうち、PR がマージされたものを片付ける
- Iteration（`s3`）：その Iteration の review・in_progress のチケットを照合して片付ける
- 指定が空：`sync` が done に進めたチケット（`reconciled`）と、自分が担当の review のチケットを対象にする

## 流れ

1. `dg --json --actor agent sync` を回す。PR のマージ（または作業ブランチが `{{git.base_branch}}` に入ったこと）を照合してチケットが done になる。`reconciled` に `{ id, from, to, when }` が出る（`when` は根拠になった事実）
2. `dg --json --actor agent ticket show <id>` で `status` が done になったことを確かめる。なっていなければ `sync` の `warnings` を読む。事実が足りない（`gh` がない、ブランチがまだ push されていない）か、Workflow がその遷移の `by` に reconcile を含めていない。後者は人に確かめて `ticket move <id> done` で進める
   - ブランチ名で見つけた PR が `branch_at`（ないチケットは `created_at`）より前にマージされていれば、前の作業の PR とみなして照合に使わず `warnings` に出す。その PR がこのチケットのものなら `ticket update <id> --pr <番号>` で記録して `sync` を回し直す
   - branch を記録し忘れたままマージした作業に後から branch を記録しようとすると、`BRANCH_IN_USE` で拒否されることがある（残ったブランチの先端が base の真の祖先のとき。ff・merge コミットでのマージ）。記録はせず、マージを人に確かめて `ticket move <id> done` で進める。squash マージなら記録でき、その後は上の項の警告になる
3. 残った受け入れ条件を確かめる。`sync` の `warnings`（`受け入れ条件 2, 3 が未チェックのまま done になった`）と `ticket show --json` の `acceptance` で未チェックの項目を見て、マージされた成果物で満たしたと確認できたものだけ `dg --json --actor agent ticket check <id> <番号...>` で付ける（deguboard が自動で付けることはない）。確認できない項目はそのまま残し、人に伝える
4. 作業ブランチと worktree を片付ける（リポジトリの規約に従う）
5. Plan に従っていたなら、`dg --json --actor agent plan show <p>` の `progress` を読む。チケットがすべて done か abandoned なら下の「Plan を閉じる」
6. 人に報告する：何が done になったか、残った受け入れ条件、次に着手できるもの（Plan があれば `plan show` の `ready`、なければ `dg --json --actor agent ticket list --ready`）

## Plan を閉じる

- Plan のチケットがすべて終わったら（done か abandoned）`dg --json --actor agent plan close <p>` で閉じる。進捗は Plan に書かないので、閉じるのはこの 1 回だけ
- 終わらないまま計画を立て直すとき（順や範囲が変わった、チケットを足す・外す）も、`plan close <p>` で閉じてから `dg guide plan` の手順で作り直し、改めて人の承認を得る。残ったチケットがあれば `warnings` に出るが閉じられる。閉じるまで、残ったチケットは新しい Plan に入れられない
- 閉じた Plan は承認も閉じ直しもできない

## 終わらなかったとき

- 作業をやめるなら `dg --json --actor agent ticket unclaim <id>`（in_progress のときだけ。todo に戻す）。開いたままの実装・手直しの Run は unclaim が `failure` で閉じる。手直し・見直しの Run は unclaim せず、`dg guide review` の「終わり方」に従う。チケット自体をやめる（abandoned）のは人に確かめてから `ticket move <id> abandoned`
- 要件が変わって別のチケットにすべきなら、`dg guide import` の手順で新しく起票を提案し、元のチケットの扱いは人に確かめる

## Iteration と Epic

- Iteration と Epic を閉じる・再開するのは人の指示で行う（`dg guide assign`）。閉じられそうなら（残りがすべて done か abandoned）人に知らせる
- Epic の進捗は `dg --json --actor agent epic show <e3>` の `progress` で都度求まる。保存はされない

{{choices}}

## 次の手順を選ぶ

片付けたら、結果を伝えて次の選択肢で聞く。

- **Plan を進める**（勧める。Plan に残りがあれば）：`dg guide work` の手順で続ける（Skill があれば `/dgwork p3`）
- **計画を立てる**：Plan が終わり、着手できるチケット（`ticket list --ready`）があれば `dg guide plan` の手順で次の Plan を作る（Skill があれば `/dgplan next <N>`）
- **ここで止める**
