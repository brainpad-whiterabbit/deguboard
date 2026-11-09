---
description: deguboard の承認済みの Plan のチケットを、着手できるものから claim して実装し、受け入れ条件を確かめて PR まで進める。PR の要らない作業は done まで進める。「p3 を進めて」「計画を再開して」「t12 を進めて」と頼まれたときに使う。Plan のない複数のチケットは dgplan で計画を立ててから使う。
argument-hint: "<Plan の ID|チケットの ID>"
---

# 作業（work）

1 枚のチケットを PR を draft で出すまで進める。段階と手は `dg next` が求め、ここには各手のやり方だけを書く。

## 対象を決める

- Plan の ID（`p3`）：下の「Plan に従う」で、着手できるものから 1 枚ずつ進める
- チケットの ID：そのチケットを進める。開いた Plan に入っていれば（`ticket show` の `plan`）その Plan に従う
- 指定が空：`plan list --status open` の承認済みの Plan を勧めて確かめる。なければ `dg guide plan` で計画を立てることを勧める

## 流れ

1. `dg --json --actor agent next <id>` を呼び、`kind` の手を 1 つ行う。`commands` の順に行い、`brief` があればサブエージェントに貼る（後ろに一時ファイルの置き場所を足してよい）。`model` が空でなければ、そのモデルでサブエージェントを起動する（`null` は親のモデル）。印のない調べもののサブエージェントは `models.light`（空なら親のモデル）。終えたらもう一度 `next` を呼ぶ
2. `kind` ごとの親の手：
   - `implement`：`commands` の claim を行い、「claim の前後」に従う。作業ブランチの worktree は claim が作り、場所を `worktree` に返す（既定は `{{worktree.root}}/<ブランチ名>`）。文を渡し、返ったら「実装の結果を受け取る」。親が自分で実装するなら、claim の `--no-run` を外して下の「実装する」を行う（claim が実装の Run を開く）
   - `review`：見直し役を起動する（`dg guide review` の「見直す」）
   - `fix`：見直し役の指摘を、`dg guide review` の「指摘を直す」の手順で渡す
   - `ready`：`dg guide review` の「終わり方」で PR を出す。PR を見ない Workflow（general など。`sync` が review に進めない）では、PR を出したら続けて自分で `dg --json --actor agent ticket move <id> review` に進める
   - `wait_merge`・`wait_human`：`ask_human` を人に伝えて聞く（`wait_human` は `dg guide review` の「終わり方」）。人のレビューの指摘は `dg guide review` の「指摘を直す」。マージされたら `dg guide done`
   - `wait_deps`：待つ。Plan の `next` から、ほかのチケットを選ぶ
   - `done`：`dg guide done` の手順で片付ける

## claim の前後

- 担当者（`ticket show` の `assignee`）が別のユーザなら避ける
- claim は、`lint.require_iteration` が true なら（今の設定：`{{lint.require_iteration}}`）`iteration` が空のチケットを Iteration に入れ、planned の Iteration を開始し、作業ブランチの worktree を作る（選び方は `ticket claim --help`）。`warnings` に入れ先がない・開始できない・worktree を作れないが出たら、Iteration は人に頼み（入れずに進むと `lint_iteration_missing`）、worktree は `worktree` の場所に手で作る。作業は続ける
- `CLAIM_LOST` なら別のチケットへ。`BRANCH_IN_USE` なら `--branch` の名前を変えて claim し直す

## 実装する（draft の PR まで）

実装する役（親かサブエージェント）は、`next` の `plan` の範囲と方針の中で実装し、次を行う。文が `dg guide work` の「実装する」を指すのはこの節。

1. リポジトリの検査（書式・lint・テスト）を通す
2. 触れた節の正本（requirements・README・コードのコメント）を読み直し、この PR で変えた約束・手順・規約の文書を同じ PR で直す（`dg guide review` の「見る」と ADR-001 の「文書の見直し」）。要件は約束だけを直し、細部は足さない（細部の正本はヘルプ・コード・テスト）。ADR は判断と理由を書き換えないので、読み直して直す正本に入れない。判断を変えるときだけ新しい ADR を書き、古い ADR を置き換えにして一覧を直す（ADR-001 の「ADR を書く場面」）。この PR で古くなった ADR の細部は直さず、報告に書く（`dg guide audit` が起票する「ADR の細部を消す」の材料）。前からあるずれは直さず、報告に書く
3. `gh pr create --draft` で PR を作る。本文にチケット ID（`t12`）、付けられなかった受け入れ条件と理由、読み直した正本と直した箇所を書く
4. 受け入れ条件は、成果物やテストで満たしたと確かめた項目だけを報告する（印は親が付ける）

## 実装の結果を受け取る

返ったら、`ticket show` の `acceptance` と照らし、確かめた項目だけ `dg --json --actor agent ticket check <id> <番号...>` で付ける（付けられない項目は PR の本文と報告に理由）。PR 番号は `dg --json --actor agent ticket update <id> --pr <番号>` で記録する。記録したら `next` に戻る。

## Plan に従う

承認済みの Plan（`dg guide plan`）の順と中身に従う。

- 着手する前に `dg --json --actor agent plan show <p>`。`pending_approval` が true なら着手せず、人に承認を求める
- 次は `plan show` の `next`（Plan の順で先の、着手できる `ready`）。`waiting` は待ちの相手。after は claim では検査されないので、自分で守る（同時に進めるなら `dg guide parallel`）
- 範囲（`scope`）と方針（`approach`）は `next` の `plan` に出る。範囲を広げる・方針を変えるなら、先に人に確かめる
- 1 枚が PR まで進んだら `plan show` を読み直して次を選ぶ。Plan のチケットがすべて終わったら `dg guide done` の「Plan を閉じる」

## PR の要らない作業

リポジトリのファイルを変えない作業（データの整備・確認・調査など）は、ブランチも PR も作らず、照合に頼らず done まで進める（`next` は PR を前提にするので使わない）。

1. `dg --json --actor agent ticket claim <id> --without-branch`（claim が Run を開く）。`warnings` は「claim の前後」のとおり扱う
2. 受け入れ条件を 1 項目ずつ確かめ、満たした項目だけ `ticket check` で付ける
3. すべて付いたら `dg --json --actor agent ticket move <id> done`。付けられない項目が残ったら `ticket move <id> review` にして、残った項目と理由を人に報告する（done にするのは人）
4. 途中でリポジトリのファイルを変える必要が出たら、`ticket update <id> --branch <種類>/<内容>` で記録して上の流れに移る。ブランチが要らなくなったら `--branch none`

## 状態

- `status` を自分で進めるのは in_progress から review まで。done は照合（マージ）で進み、照合で進まないときや人に指示されたときだけ `ticket move <id> done`（制限は `dg guide overview`）
- 実装をやめるなら `dg --json --actor agent ticket unclaim <id>`（todo に戻る。Run の扱いは `dg guide run`）
- 作業中に別の作業が見つかったら、そのチケットに混ぜず `dg guide import` で起票を提案する

{{choices}}

## 次の手順を選ぶ

PR を出したら（PR の要らない作業を終えたときも）、結果を伝えて次の選択肢で聞く。

- **次のチケットに進む**（勧める。Plan に着手できるチケットが残っていれば）：`plan show` を読み直し、この手順で次の 1 枚を進める
- **完了にする**：PR がマージされていれば、`dg guide done` の手順で片付ける（Skill があれば `/dgdone <ID>`）
- **ここで止める**：マージを待つ（マージ後は `dg guide done`）
