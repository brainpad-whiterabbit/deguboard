# 着手できるチケットを並べて進める（parallel）

Plan の `ready`（`plan show` の着手できるチケット）が複数あり、サブエージェントを起動できるなら、チケットごとに起動して同時に進めてよい。`dg` は順を示すだけで、起動と待ち合わせはこの手順で行う。進めるセッション（親）は進行・承認・`dg` の読み書きだけを行う。

- **上限**：同時に 3 件まで。人が数を指示したらそれに従う。検査が負荷で落ちるなら減らす
- **始める前**：開いた Plan と PR を見て、同じファイルを直すものがないか確かめる。互いに同じファイルを変えるチケットは並べず、`after` で順にすることを人に提案する
- **親**：Iteration に入れる・claim（`--no-run` を付ける。実装の Run はサブエージェントが開く）・worktree の作成（`dg guide work` の「流れ」の手順 1 の「Iteration に入れる」と手順 2・3）を 1 件ずつ行い、済んだらサブエージェントを起動する。返るたびに中身を確かめて `ticket check` と `ticket update --pr` を記録し、`dg guide review` の見直しと修正ループを回して、直さなかった軽い指摘を PR の本文に書き足し、PR を ready にし、work の手順 7 を行い、`plan show` を読み直して空いた枠で次を起動する。人のレビューの指摘（work の手順 8）は、同じか新しいサブエージェントに直させる。PR を出したチケット（マージ待ち）は枠に数えない
- **Iteration に入れる**（`lint.require_iteration` が true のときだけ。今の設定：`{{lint.require_iteration}}`）：親が claim の前に、`iteration` が空のチケットを work の手順 1 のとおり `iteration add <S> <id>` で入れる。入れ先がなければそのチケットは起動せず人に頼む
- **モデル**：サブエージェントは Plan の段階のモデル（`dg guide run` の「段階のモデル」。空なら親のモデル）で起動し、run start に `--model <モデル>` を付けさせる
- **サブエージェントに渡す**：チケットの ID・Plan の `details` の範囲と方針・ブランチと worktree のパス・規約の場所・チケットごとの一時ファイルの置き場所・work の手順 4〜6 の draft の PR を作るまでに従うこと（受け入れ条件は確かめて報告するだけで印は付けない。PR 番号の記録は親で、それが実装の Run を閉じる）。run start は自身に呼ばせる（`--agent` はサブエージェントも自分の Adapter の名前。Claude Code なら `claude-code`。役割名にすると使用量とモデル名を取り込めない）
- **サブエージェントがしない**：claim・unclaim・`iteration add`・Plan の操作・見直し役の起動・自分のもの以外の Run を閉じる・`gh pr ready`・マージ・`ticket check`・`ticket update --pr`・ほかのチケットの作業
- **サブエージェントが返す**：draft の PR の URL・Run の ID・確かめた受け入れ条件と付けられなかった項目（理由）・読み直した正本と直した箇所・検査の結果・人に伝えること。手直し（fix）で返すときは、直したコミットと、直さなかった軽い指摘と理由
- **1 件でほかを止めない**：`CLAIM_LOST` ならそのチケットを飛ばす。実装が失敗したら `ticket unclaim` で todo に戻し（開いたままの実装の Run は unclaim が `failure` で閉じる。返らなかったときも同じ）、worktree は残して、同じ流れでは claim し直さない。手直し・見直しの Run は `run list --running --ticket <id>` で確かめ、実行中なら親が閉じ（失敗として返れば `failure`、返らなければ `interrupted`）、unclaim せず `dg guide review` の「終わり方」に従う。失敗・マージ待ちを待つのは `after` でそれを待つチケットだけ
