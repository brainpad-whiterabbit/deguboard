# 計画（plan）

複数のチケットを、どの順で進めるかを決める。計画は Plan（`p3`）に記録する。Plan は進める順（`after`）とチケットごとの範囲と方針（`details` の `scope`・`approach`）を持つ。承認待ちで作り、人の承認を受けて `plan approve` で承認済みにする。

## 流れ

1. 対象を集める：`dg --json --actor agent ticket list --project {{default_project}}`（Epic で絞るなら `--epic e3`、Iteration なら `--iteration s3`）
2. 依存を確かめる：各チケットの `depends_on` と、`dg --json --actor agent ticket show <id>` の `dependents`（自分に依存しているもの）
3. 着手できるものを出す：`dg --json --actor agent ticket list --ready`。todo で依存先がすべて done か abandoned のもの（`deps_done`）。担当者の有無は見ないので、`assignee` が別のユーザのものは避ける（自分のものだけなら `--assignee agent`）
4. 順序の案を作る。依存が先、優先度が高いものが先。並行できるもの（互いに依存しないもの）はまとめて示す
5. 承認待ちの Plan に記録する（下の「Plan の作り方」）。結果の `data.id` が Plan の ID
6. 人に見せて承認を得る。`dg --json --actor agent plan show <p>` の `items`（Plan の順）・`after`・`details` を示す。直すよう言われたら、`plan close <p>` で閉じて作り直す（Plan は作った後に書き換えられない）
7. 人が承認したら `dg --json --actor agent plan approve <p>` で承認を記録する（`approved_by` は操作した主体）。人の承認を得ないまま approve しない。承認待ちの Plan のチケットには着手しない
8. 承認済みの Plan に従い、`dg guide work` の手順で 1 枚ずつ進める。Plan を一覧するコマンドはないので、Plan の ID は人への報告に書いておく

## Plan の作り方

```sh
dg --json --actor agent plan create t12 t13 t14 t15 \
  --after t13=t12 --after t14=t12 --after t15=t13,t14 \
  --scope t13="一覧と詳細の API。認証は含めない" \
  --approach t13="core のコマンド定義を足し、HTTP は写すだけ"
```

- 並べた順が実行順の目安。`--after t15=t13,t14` は「t15 を t13・t14 の後に進める」で、計画の中だけの待ち（チケットの `depends_on` とは別）。並行できるものは互いに after を書かない
- `--scope`・`--approach` はチケットごとに 1 文で書く。着手するときに `plan show` の `details` で読み返す
- done・abandoned のチケットと、別の開いた Plan に入っているチケットは入れられない（`REJECTED`）。別の Plan に入っていれば、その Plan を閉じてよいか人に確かめる
- 依存が足りなければ `dg --json --actor agent ticket update <id> --depends-on t12,t13` で直す。`--depends-on` は一覧を**置き換える**ので、残す依存も全部指定する（`--label` も同じ）。循環は拒否される
- 計画の途中で新しい作業が見つかったら、勝手に進めず `dg guide create` の手順で起票を提案する

## 承認について

既定ではエージェントも `plan approve` を実行できる（人に限るなら `config.yaml` の `actor.human_only` に `plan.approve` を入れる。`dg guide overview`）。実行できても承認は人の判断なので、人が会話で承認したときだけ行う。拒否されたら（`TRANSITION_REJECTED`）人に `dg plan approve <p>` を頼む。

## 進め方の原則

- 1 度に claim するのは、自分が今すぐ進める 1 枚だけ。先に全部 claim しない（他の人やエージェントが着手できなくなる）
- 依存先が done でも abandoned でもないチケットには着手しない。Workflow が todo → in_progress に `requires: [deps_done]` を書いていれば claim は拒否される（`TRANSITION_REJECTED`）。書いていなくても `--ready` に出るまで待つか、依存先を先に進める
- Plan の `after` は claim では検査されない。`plan show` の `items[].waiting`（まだ終わっていない待ち先）が空になるまで待つ
