# 計画（plan）

複数のチケットを、どの順で進めるかを決める。Plan のコマンド（`dg plan`）は Phase 2 で入る。今は依存とチケットの一覧で計画を表し、承認は会話で得る。

## 流れ

1. 対象を集める：`dg --json --actor agent ticket list --project {{default_project}}`（Epic で絞るなら `--epic e3`、Iteration なら `--iteration s3`）
2. 依存を確かめる：各チケットの `depends_on` と、`dg --json ticket show <id>` の `dependents`（自分に依存しているもの）
3. 着手できるものを出す：`dg --json ticket list --ready`。todo で claim がなく、依存先がすべて done のもの
4. 順序の案を作る。依存が先、優先度が高いものが先。並行できるもの（互いに依存しないもの）はまとめて示す
5. 人に見せて承認を得る。承認された順序に従って `dg guide work` の手順で 1 枚ずつ進める

## 順序の案の書き方

```
1. t12 スキーマを決める（依存なし）
2. t13 API を実装する（t12 の後）／ t14 画面の雛形（t12 の後。t13 と並行可）
3. t15 結合（t13・t14 の後）
```

- 依存が足りなければ `dg --json --actor agent ticket update <id> --depends-on t12,t13` で足す（循環は拒否される）
- 計画の途中で新しい作業が見つかったら、勝手に進めず `dg guide create` の手順で起票を提案する

## 進め方の原則

- 1 度に claim するのは、自分が今すぐ進める 1 枚だけ。先に全部 claim しない（他の人やエージェントが着手できなくなる）
- 依存先が done でないチケットは claim できない。`--ready` に出るまで待つか、依存先を先に進める
