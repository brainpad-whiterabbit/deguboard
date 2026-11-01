# ADR-005 作業の実績

- ステータス：承認
- 更新日：2026-11-01

## 背景

チケットの分割の粒度やモデルの選び方を決めるのに、AI エージェントがどれだけのトークンと時間を使ったかの実績が欲しい。ただし AI の自己申告は正確でなく、会話記録は個人のデータでもある。何を、どこから、どこまで記録するかを決める。

## 決定

### 実測し、自己申告しない

- 使用量は Run 単位で記録する。1 つのチケットに複数の Run を紐づける
- 数は公式に提供される使用量の情報（今は会話記録の応答の `usage` と、Codex の `token_count` の累計）から取る。エージェントに数字を言わせて書かない
- 取れない指標は `null` にして警告する。架空の値で補完せず、推定した値には `estimated: true` を付ける
- Claude Code と Codex で取得方法が違う部分は Adapter が吸収する

### 記録するもの

- エージェント名、モデル名、開始・終了日時、実行時間、input / output / cache read / cache write のトークン数、結果、エラー、リトライ回数とその理由（`retry_reasons`。1 件 1 行の要約）、Run の step
- 集計の単位は Run・Ticket・Epic・Iteration・Project・Agent/Model・Step（実装と見直し・手直しを分けて見る）。集計値は保存せず、表示のたびに Run から求める
- Epic・Iteration・Project へは、Run の持つチケットの今の所属でたどる（持ち越したチケットの Run は今の Iteration に数える）。Run に所属を写すと、チケットを動かしたときに Run と食い違うため

### 推定費用は持たない

- 費用の単価は持たず、トークン数だけを記録する。費用が要るときは利用者が単価を掛ける

### 会話記録を読む許可はリポジトリの設定に置く

- 会話記録（`~/.claude/projects/**`・`~/.codex/sessions/**` など）を読むかどうかは `config.yaml` の `metrics.read_transcripts`（true / false）で決める。チームの方針として Git で共有する
- 個人が拒むときは環境変数 `DEGUBOARD_NO_TRANSCRIPTS=1` で、そのマシンでは読まない。空と `0` 以外の値はすべて拒否とみなす
- 許可がなければ、使用量は `null` のまま、日時・結果などの Run の記録だけを残す。読まなかったとき・取れなかったときは `run finish` が警告を返す

### 会話記録を Run に結び付ける

- `run finish` が Run の `agent` の値で Adapter を選び、会話記録から使用量を取る。Claude Code（`claude-code`）は `~/.claude/projects/`（`CLAUDE_CONFIG_DIR` があればその下）を、Codex（`codex`）は `~/.codex/sessions/YYYY/MM/DD/` の `rollout-*.jsonl`（`CODEX_HOME` があればその下）を読む
- 結び付けるのは、Run の ID を最初に含む会話記録のファイル（`dg run start` の出力を受け取ったエージェントの記録）。その中の、ID が出た後の `started_at`〜`finished_at` の応答の `usage` を、同じ応答の重複行を除いて足す。subagents/ の外のファイルにあるサブエージェントの行（`isSidechain`）は数えない。モデル名を渡されていなければ、いちばん多く応答したモデルを入れる
- Codex の記録は応答ごとの `usage` でなく session の累計（`event_msg` の `token_count` の `info.total_token_usage`）を持つので、ID が出る前の最後の累計と `finished_at` までの最後の累計の差を取る。Codex は応答のツールを実行し終えてから、その応答の `token_count` を書く（openai/codex の `codex-rs/core/src/session/turn.rs`、2026-10-31 の main で確認。本物の記録では未確認）。そのため `dg run start` を呼んだ応答は Run に入り、`dg run finish` を呼んだ応答は入らない。Claude Code（`dg run start` の後の応答から `dg run finish` を呼んだ応答まで）とは 1 応答ずれる。`dg run finish` を呼んだ応答の `token_count` は `run finish` が記録を読む時点でまだ書かれていないので揃えられず、数える応答の数は同じなのでそのままにする。`input_tokens` はキャッシュから読んだ分を含むので、`input` には `cached_input_tokens` を引いた値を、`cache_read` には `cached_input_tokens` を、`cache_write` には `cache_write_input_tokens` を入れる。これを書かない版の記録・累計が減った値は null にして警告する。モデル名は `turn_context` のいちばん多いモデル。`sessions/` の下の、`started_at` より後に書かれたファイルを探す。圧縮した記録（`.jsonl.zst`）は読まない
- Claude Code で探すのは環境変数 `CLAUDE_CODE_SESSION_ID` の session（サブエージェントを含む）。そこに Run がなければ、作業ツリーと主の作業ツリーと、主の作業ツリーの親までの上位に当たるディレクトリを探す。HOME とその上はほかのリポジトリの記録が混ざるので探さない。どちらも `started_at` より後に書かれたファイルだけ
- 作業ディレクトリと時刻だけで絞らないのは、サブエージェントが親と同じ session・同じ作業ディレクトリで並行して動き、区別できないため。Run の ID は開始の時刻と乱数からなるので、同じ時間帯のほかの記録に偶然現れることはまずない。親が始めた Run の作業をサブエージェントがした分は数えない

### 写すのは数だけ

- Git に入る記録には、使用量の数とモデル名だけを会話記録から写す。プロンプト・ツールの結果・ファイルの中身・コマンドの文字列・ファイルのパスは写さない
- 実行中の記録は `deguboard-local/runs/` に置き、Git 管理しない。Git に入れるのは Run 完了時の集計だけ（`run finish` が `runs/` に書き、実行中の記録を消す）
- Run はチケットの ID を持ち、チケットには Run の ID を書き足さない。チケットの Run は Run の側から引く

## 理由

- 自己申告は過小・過大になり、比べられない。公式の使用量なら後から測り直せる
- 単価はモデルや契約で変わり、更新し続ける必要がある。トークン数を残せば費用はいつでも計算できる
- 集計結果はどのみち共有リポジトリに入るので、「読むかどうか」もチームで決めるのが筋。個人の逃げ道は環境変数で足りる
- 数だけなら、チケットをまたいで比べられ、秘密情報が Git に入らない
- 集計値を保存せず、チケットに Run の ID を書き足さないのは、Run を足すたびに複数のファイルを書き換えて衝突させないため

## 採らなかった案

- **推定費用を記録する**：単価表の保守が要り、「推定」が独り歩きする
- **読む許可を利用者ごとにリポジトリの外に置く**：許可の有無がマシンごとに違い、チームで集計が揃わない。先行プロジェクトはこの形だったが、deguboard では共有の方針を優先する
- **OpenTelemetry で収集する**：collector が要り、チケットとの紐づけが別に要る
- **AI に振り返りを書かせて数字を残す**：正確でない
- **会話の中身を記録する**：個人データと秘密情報が Git に入る
