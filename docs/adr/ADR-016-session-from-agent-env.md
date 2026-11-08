# ADR-016 Run を開く操作のセッションは、フックの環境がなければエージェントが付ける環境から取る

- ステータス：承認
- 更新日：2026-11-08

## 背景

[ADR-012](ADR-012-hooks-open-runs.md) は、SessionStart のフックが主体とセッション ID・記録のパスを以後の Bash の環境（`DEGUBOARD_ACTOR`・`DEGUBOARD_SESSION`・`DEGUBOARD_TRANSCRIPT`）に入れ、その環境はサブエージェントの Bash にも届くとした。[ADR-015](ADR-015-interrupt-stale-session-runs.md) は、もう一度の claim が別のセッションで開いたままの前の手直しの Run を `interrupted` で閉じると決めたが、サブエージェントの Bash には `DEGUBOARD_SESSION` が届かないため、セッションが分からない claim では前の手直しを今までどおり `success` で閉じる制限を置いた。手直しはサブエージェント自身がもう一度の claim をするので（`dg guide review`）、2026-11-07 以降の手直しの Run は `session` がすべて null で、この制限のために落ちたセッションの手直しが中断として残らなかった。

2026-11-08 に Claude Code 2.1.319 で、サブエージェントの Bash の環境を確かめた。

- SessionStart のフックが `CLAUDE_ENV_FILE` に書いた変数（`DEGUBOARD_*`）は、親のセッションの Bash にだけ入り、サブエージェントの Bash には届かない
- Claude Code は、親とサブエージェントのどちらの Bash にも `CLAUDE_CODE_SESSION_ID` を付ける。サブエージェントでも値は親のセッションの ID で、フックの入力の `session_id` と、サブエージェントの記録のパス（`<session>/subagents/agent-<id>.jsonl`）の `<session>` に一致する

## 決定

### 主体とセッションはセッションの始まりに環境へ入れ、サブエージェントではエージェントが付ける環境で補う

[ADR-012](ADR-012-hooks-open-runs.md) の「主体とセッションはセッションの始まりに環境へ入れる」の節を、この決定で置き換える。

- SessionStart のフックが、`DEGUBOARD_ACTOR=agent` とセッション ID・記録のパスを `export` 付きで以後の Bash の環境に入れる（今のまま）。この環境は親のセッションの Bash にだけ届く
- Run を開く操作（`run start`・`ticket claim`）のセッション ID は、`--session`、なければ環境の `DEGUBOARD_SESSION`、なければ dg を呼んだエージェントの Adapter が環境から読むセッション ID の順で決める。Adapter は、環境変数から判定した agent（AG-5 の `detect`）のものを使う。読むのは、製品がサブエージェントの Bash にも親のセッションの ID で付けると確かめた変数だけで、Claude Code では `CLAUDE_CODE_SESSION_ID`。確かめた変数のない Adapter は読まない（今は Codex・Copilot）
- 記録のパスは今のまま `--transcript`、なければ `DEGUBOARD_TRANSCRIPT` で、サブエージェントでは渡らない。サブエージェントが自分で開いた Run は、終わりのフックが記録の場所を結び付ける（ADR-012 の移行の経路。結び付けは同じセッションの Run だけなので、セッションが入ることで手直しの Run も結び付く）
- サブエージェントの主体は今までどおり申告（`--actor agent` か `DEGUBOARD_ACTOR=agent`）で決める。この決定は主体の決め方を変えない

### 手直しのセッションの比べ方

[ADR-015](ADR-015-interrupt-stale-session-runs.md) の決定のうち、比べるセッションの項の「claim では `--session`（なければ環境の `DEGUBOARD_SESSION`）」の部分と、セッションが分からない claim を今までどおり `success` で閉じる項を、この決定で置き換える。

- もう一度の claim は、上の順で決めたセッションと前の手直しの Run の `session` を比べる。サブエージェントのもう一度の claim でも起動した親のセッションの ID で比べ、開く手直しの Run にもその ID を入れる。前の手直しの Run が別のセッション（null でなく、この claim のセッションと違う）のものなら `interrupted`、同じセッションなら今までどおり区切りとして `success` で閉じる
- どちらかのセッションが分からない（フックも Adapter の環境もない製品・環境、この決定より前に開いた `session` が null の Run）ときは、今までどおり区切りとして `success` で閉じる
- `run review-result` がセッションを比べないことは変えない（書く先は今までどおりチケットの実行中の見直しの Run と保留で決める）

## 理由

- 手直しの claim はサブエージェント自身が呼ぶので、claim の中で今のセッションが分からない限り、落ちたセッションの手直しを中断として記録できない。製品が親のセッションの ID をサブエージェントの Bash に付けるなら、それを読むのが最も手順が少なく、親の手順や頼む文を増やさない
- `DEGUBOARD_SESSION` を先にするのは、フックを入れた環境では今の値（フックの入力の `session_id`）と同じで、フックのない入口で `--session` を渡す今の使い方も変えないため
- Adapter が判定した agent のものだけを読むのは、別の製品の変数を推測で読まないため（AG-5 の `detect` と同じ考え）
- Run にセッションが入ると、Adapter が数える範囲をそのセッションの記録に絞れ（ADR-005）、終わりのフックがサブエージェントの開いた Run を結び付けられる

## 採らなかった案

- 起動のフック（PostToolUse・SubagentStop）が、サブエージェントの記録に結び付けた手直しの Run にセッションを書き足す：書き足すのはサブエージェントが返った後で、もう一度の claim が前の Run を閉じる時点の比べには間に合わない。落ちたセッションの Run はフックが来ないので、書き足されないまま残る
- 親が頼む文で claim に `--session` を渡させる：親が自分のセッションの ID を読んで文に書く手順が増え、守られ方が親の手順に依る。続きを頼むとき（SendMessage）に渡し忘れても気づけない
- PreToolUse のフックが `ticket claim` のコマンドを見て、チケットごとのセッションを `deguboard-local` に置き、claim がそれを読む：コマンドの字句の手がかりに頼り、拒まれた・失敗した呼び出しの残りを時間で捨てる規則が要る
