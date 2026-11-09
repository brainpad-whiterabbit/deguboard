---
description: deguboard の Iteration かチケットを、割り当て → 点検 → 計画 → 作業 → 見直し → リリース（か片付け）の段階で続けて進める。承認の場所は各段階の手順のとおりに残し、段階の間は止まらずに進む。途中で止まった流れは、同じ引数で再開できる。--no-assign で割り当ての段階を飛ばす。--auto で、勧める選択肢がある戻せる判断を自動で選ぶ。「s3 を最後まで進めて」「割り当てからリリースまでやって」と頼まれたときに使う。
argument-hint: "<Iteration|チケットの ID...> [--no-assign] [--auto]"
---

# 一気通し（all）

Iteration かチケットを、割り当てからリリースまでの流れで続けて進める。今の段階と次の手は `dg flow next` が求めるので、ここには返った手の行い方だけを書く。

## 対象を決める

- Iteration（`s3`）：その Iteration のチケットと、そこに入れる候補（Iteration に入っていない todo）。候補を扱うのは割り当ての段階だけ
- チケットの ID（1 つ以上）か Plan の ID（`p7`）：その対象を扱う。見直しとリリースは、対象のチケットの Iteration のチケットがすべて終わったときだけ、その Iteration を対象に行う。Iteration に入っていなければ見直しとリリースはしない
- 指定が空：`dg guide release` の「対象を決める」と同じ
- `--no-assign`：割り当ての段階を飛ばす。点検で Iteration に入れる案が出ても反映せず、終わりの報告に残す
- `--auto`：下の「`--auto` で自動で選ぶ」。`--no-assign` と一緒に指定できる

以下の `<S>` は対象の Iteration。聞かずに始め、閉じるのは人の指示で行う。

## 段階

段階の順と今の段階は `dg flow next` が決める。承認を求める場所は次のとおりで、各段階の手順もそこで承認を得る。

| 段階     | 承認を求める場所                     |
| -------- | ------------------------------------ |
| 割り当て | 入れる行                             |
| 点検     | 直す行、削除・abandoned・閉じる      |
| 計画     | Plan                                 |
| 作業     | PR ごとのマージ（`dg guide done`）   |
| 見直し   | 指摘の表                             |
| リリース | リリースの PR のマージ・公開・閉じる |

## 流れの進め方

1. 始めるときと、段階の手を終えるたびに `dg --json --actor agent flow next <対象…>` を呼ぶ（`--auto`・`--no-assign` は指定があれば付ける）。返りの `stage.name` が今の段階（`assign`・`check`・`plan`・`work`・`audit`・`release`・`stop`）、`commands` が呼ぶ dg のコマンド（順に）、`guide.text` が段階の手のやり方、`approval` が承認の要否と場所
2. `stage` の手を行う。`commands` を順に行い、`guide.text` のとおりに進める（読み直すときは `guide.command`）。
   - `work` は `dg guide parallel` のとおり、件数によらずチケットごとにサブエージェントに任せる。親は進行・承認・`dg` の読み書きだけを行う
   - `release` で、リポジトリの規約にリリースの手順がなければ `dg guide done` の手順で片付ける
3. `approval.required` が true の場面は、`approval.what` を人に聞く。選択肢には「ここで止める」を入れる。`--auto` のときの扱いは下の「`--auto` で自動で選ぶ」
4. 段階の手を終えたら（承認を得た・直した・行い終えた）、その返りの `resume` をそのまま `--resume` に写して、1 に戻る（`dg --json --actor agent flow next <対象…> --resume <resume>`）。値は組み立てない。割り当て・点検・見直しの手の途中で止めたとき（承認が得られなかった、見直しの指摘の表で止めた）は、その `resume` を写さずに止まる。再開するときは、その前に写した `resume` を渡すか、`--resume` なしで同じ対象と指定で呼ぶ。途中で止めた手の `resume` を写すと、その段階を終えたものとして飛ばす
5. `stage.name` が `stop`、または `repeated` が null でないとき（同じ段階が続き、事実が変わらない）は、`ask_human` と状態を示して止まる

## 段階の間の進み方

- **段階の間は止まらない**：`approval.required` の場面以外では聞かず、次の `flow next` へ進む
- **マージは人が行う**：PR を出したら、マージを待つ間も次の手を進め、手がなければ止まる。マージの承認は `approval` のとおり
- **失敗の扱い**：実装が失敗したチケットは `dg guide parallel` のとおり todo に戻し、それを待たないチケットを進める。見直し・手直しが failure で返った・返らないチケットは todo に戻さず、`dg guide review` の「終わり方」に従う

## `--auto` で自動で選ぶ

`--auto` のときは、聞かずに進めるのは次の 2 つだけで、`approval.what` に残るものは聞く。選んだものと判断の材料はその場で短く示す。

- `approval.auto` に書いたもの（勧める選択肢で進める。どの判断が入るかは config の `auto.decisions`（今の設定：`{{auto.decisions}}`）と `auto.merge` が決める）
- `auto.decisions` に `accept` があるときの、照合の後の受け入れ条件の確認（`dg guide done` の手順 3）

マージと人が決める判断は、次のとおりに扱う。

- PR のマージは、`auto.merge`（今の設定：`{{auto.merge}}`）が true のときだけ、`dg guide review` の「品質ゲート」を満たす PR を `dg --json --actor agent pr merge <id>` で行う。方法とブランチを消すかは `--method`・`--delete-branch` を省いて config の `merge.method`・`merge.delete_branch`（今の設定：`{{merge.method}}`・`{{merge.delete_branch}}`）に任せる。満たさなければ、満たさなかった条件を示して承認を求めて止まる
- **人が決める判断は config によらず聞いて止まる**：リリースの PR のマージと公開（タグ・配布先）、チケットの削除・abandoned・done の取り消し、Epic・Iteration・Plan を閉じる・再開する。`auto.merge` が false のときのマージ。Plan の待ち（`after`）と範囲を変えること、`--force` の付く操作。勧めるものがない判断と、選択肢にできない答え

## 結果を伝える

流れの終わりに、段階ごとの結果を伝える（割り当て・点検で直した行・承認した Plan・出した PR とマージ・起票したチケット・リリースした版と Iteration の状態・反映しなかった割り当ての案・残ったチケット）。`--auto` のときは、自動で選んだ判断と、自動でマージした PR の条件の確かめの結果も伝える。

{{choices}}

## 次の手順を選ぶ

止まったときは、止まった理由に合わせて次の選択肢で聞く。Iteration が閉じて流れを終えたとき（`flow next` の理由がそれ）は聞かずに結果を伝える。

- **再開する**（マージを待って止まったとき勧める）：マージの後に `dg guide all` を読み直し、同じ対象と指定（`--auto` など）で `flow next` を呼んで続ける（Skill があれば `/dgall <S>`）
- **ここで止める**
