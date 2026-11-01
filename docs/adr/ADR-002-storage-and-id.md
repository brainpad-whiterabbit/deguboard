# ADR-002 チケットの保存と ID

- ステータス：承認
- 更新日：2026-11-01

## 背景

チケット・プロジェクト・イテレーション・計画・ワークフロー定義・Run の集計を、専用サーバーや DB なしに Git で管理し、人と AI エージェントの両方が読み書きできる形で置きたい。作業は Git worktree で並列に進むので、どの worktree からも同じチケットの状態を見られる必要がある。複数のエージェントが同時に起票するので、ID の衝突も避けたい。

## 決定

### 置き場所：orphan ブランチ `deguboard`

- データは orphan ブランチ `deguboard` に置き、`<git-common-dir>/deguboard/` に専用の worktree として checkout する。すべての読み書きはここで行う
- 作業ブランチや作業 worktree にはデータを置かない。状態の更新は常に共有の deguboard worktree で行う
- ブランチは保護せず、`dg` が直接 commit・push する
- Git 管理外のもの（ローカルロック・実行中の詳細ログ・マージドライバの属性ファイル）は `<git-common-dir>/deguboard-local/` に置く。索引はファイルにせずメモリ上に持つ（[ADR-007](ADR-007-architecture.md)）

### 形式：1 件 1 ファイル

| データ     | 置き場所               | 形式                       |
| ---------- | ---------------------- | -------------------------- |
| Project    | `projects/<slug>.yaml` | YAML                       |
| Ticket     | `tickets/t12.md`       | Markdown＋YAML frontmatter |
| Epic       | `epics/e3.md`          | Markdown＋YAML frontmatter |
| Iteration  | `iterations/s3.yaml`   | YAML                       |
| Plan       | `plans/p7.yaml`        | YAML                       |
| Workflow   | `workflows/<id>.yaml`  | YAML                       |
| Run の集計 | `runs/<id>.json`       | JSON                       |
| 設定       | `config.yaml`          | YAML                       |

- チケットと Epic の本文（概要・受け入れ条件・目的）は Markdown、属性は frontmatter。Iteration・Workflow・config は人が読む YAML、Run は機械が書く JSON
- 削除したチケットは `tickets/deleted/` に墓標として残し、番号を再利用しない
- 書き込みは一時ファイルへ書いてから rename する（原子的）。読み込みはスキーマ（Zod）で検証し、読めないファイルは止めずに報告する

### ID：連番をそのまま ID とファイル名にする

- ID は `t12`・`e3`・`s3`・`p7` のような接頭辞＋連番。ファイル名は ID そのまま（`t12.md`）で、ゼロ埋めしない。title の slug はファイル名に入れない
- ファイル名の辞書順は番号順にならない（`t100.md` が `t2.md` より前に並ぶ）。CLI と UI は番号で並べるので影響しない。シェルで番号順に見たいときは `ls -v` を使う
- 番号はリポジトリ全体で一意（プロジェクトをまたいでも `t12` は 1 つ）。採番は「既存と墓標の最大 + 1」
- **作成は fetch → 採番 → commit → push を 1 単位**にする。push が拒否されたら取り込み直して採番し直し、最大 3 回まで再 push する。同じパスの add/add で衝突を検出できる
- オフラインで push できないときは `provisional: true` を付けてローカルに commit する。次の `dg sync` で衝突があれば、番号・ファイル名・未 push のコミット内の参照（他チケットの `depends_on`、Plan）を振り直してから push する
- 作業ブランチ名と PR は claim（push 成功が条件。[ADR-004](ADR-004-agents-and-state.md)）の後に作るので、仮番号がブランチ名に入ることはない
- `dg ticket import` の複数件も同じ 1 単位で採番する
- Run の ID は採番せず `r`＋開始日時（UTC）＋4 桁の乱数にする（`r20261031-041500-3fa2`）。辞書順が開始の順で、実行中の記録も `deguboard-local/runs/` に同じ名前で置く

### 同期の競合：frontmatter をフィールド単位でマージする

- 取り込みは rebase で行い、`tickets/*.md`・`tickets/deleted/*.md`・`epics/*.md` に git のマージドライバ `deguboard` を当てる。ドライバの実体は `dg` の隠しコマンド `merge-driver`（ロジックは core の `git/merge.ts`）
- フィールドごとに 3-way で決める。片側だけ変えた値を採り、両側が同じ値なら採る。`updated_at` は両側が変えても新しい方を採る。両側が違う値に変えたフィールドは競合。配列（`labels`・`depends_on`）は 1 つの値として比べる
- 本文は片側だけ変えたらその本文、両側が変えたら行単位でマージし、同じ行がぶつかれば競合。frontmatter が読めないときと base がないとき（仮番号の add/add）は行単位のマージに任せ、振り直し（DT-5）の検出を変えない
- 競合ならドライバが非 0 で終わり、従来どおり rebase を中止してローカルのコミットを残し、`dg sync` が報告する
- 登録：`dg init` と `dg sync`（取り込みの前）が、git config の `merge.deguboard.driver` に「いま動いている node の絶対パス＋この `dg` の `bin/dg.js` の絶対パス＋`merge-driver %O %A %B %P`」を書き、deguboard ブランチに `.gitattributes` をコミットする。`.gitattributes` がまだリモートにない間も効くよう、rebase には `deguboard-local/attributes` を `core.attributesFile` で渡す
- VS Code 拡張は自分の `dg` を持たないので登録せず、CLI（`dg serve` を含む）が登録した config をそのまま使う。ドライバが動かなければ（パスが消えたなど）競合として報告され、次の CLI の `dg sync` で登録し直す

### 複数 Project

- 1 リポジトリに複数の Project を置ける。Project は `projects/<slug>.yaml`（名前・説明・既定の Workflow・状態）
- Ticket・Epic・Iteration は `project` フィールドで所属を表す。ディレクトリはプロジェクトごとに分けず flat に置く
- `dg init` は `default` プロジェクトを 1 つ作る。`config.yaml` の `default_project` が省略時の値

### 呼称

- 製品名は deguboard、CLI は `dg`、ブランチ名は `deguboard`、環境変数の接頭辞は `DEGUBOARD_`
- 作業の最小単位は ticket と呼ぶ（CLI は `dg ticket`）。期間の単位は iteration（`dg iteration`。`sprint` はエイリアス）。目的で束ねる単位は epic（`dg epic`）

## 理由

- 作業ツリー直下に置くと、`git worktree add` した各ブランチにデータのスナップショットが入り、worktree 内で更新すると feature ブランチにチケットの変更が混ざって乖離する。保護ブランチには状態変更を直接 push できない。orphan ブランチなら、どの worktree からも `git rev-parse --git-common-dir` で同じ場所を見られ、コードの PR にチケットの差分が混ざらない
- 1 件 1 ファイルなら競合が 1 件に閉じる。全件 1 ファイルは競合が集中する
- 連番は人にもエージェントにも読みやすい。衝突は「作成 = push の CAS」で解決でき、残る窓はオフライン作成だけなので、仮番号で補えば足りる
- ゼロ埋めしないのは、ID とファイル名が同じ文字列になり、桁数の上限を決めずに済むから。AI が起票すると週に数百件増えるので、4 桁は数か月、5 桁でも数年で足りなくなる。並び順は CLI と UI が番号で担う
- 番号を全体で一意にすれば、プロジェクトごとにディレクトリを分ける必要がなく、プロジェクト間の移動がファイルの改名にならない
- 墓標を残せば、削除後に同じ番号が再利用されて古い参照が別のチケットを指すことがない
- Run は並行して始まり、実行中はコミットしないので、連番の CAS が使えない

- フィールド単位でマージすれば、同じチケットの別々の属性を 2 人（やエージェント）が変えても止まらない。行単位では `updated_at` の行が毎回ぶつかり、ほぼすべての同時更新が競合になる
- ドライバを PATH の `dg` で登録しないのは、`npx`・`mise run`・`node_modules/.bin` 経由で動かす環境では PATH に `dg` がないから。絶対パスは古くなりうるが、init と sync のたびに書き直すので直る

## 採らなかった案

- **作業ツリー直下の `.deguboard/`**：worktree ごとに乖離する。上記
- **ハッシュ短縮 ID を正にし、表示用の連番を別に持つ**：衝突に強いが ID が 2 種類になり、人が呼ぶ名とファイル内の ID が食い違う。CAS で連番の衝突を解決できるので要らない
- **作成時は仮名のファイルで、同期時に連番へ改名**：毎回改名と参照の書き換えが入る。オフラインのときだけこの考え方を使う
- **プロジェクトごとの orphan ブランチ**：同期と排他が倍になる
- **プロジェクトごとのディレクトリと独自採番**：`webapp-12` のような複合 ID が要り、依存の参照が長くなる
- **ファイル名を 4〜6 桁でゼロ埋めする**：辞書順が番号順になるが、桁数の上限が要り、超えた瞬間に並びが崩れる。ID とファイル名も食い違う
- **SQLite などの DB**：Git で diff・マージ・履歴を扱えなくなる
- **`merge=union` や行単位のマージのまま**：union は同じフィールドの行を 2 本残して YAML を壊す。行単位は上記のとおり `updated_at` で毎回止まる
- **ドライバを `dg merge-driver` と PATH で登録する**：PATH に `dg` がない環境で動かない
- **`.gitattributes` を `<git-common-dir>/info/attributes` に置く**：作業ブランチの worktree にも効いてしまう
