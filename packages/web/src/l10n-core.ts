// 画面が引く core の文の訳の表（UI-11・t649）。鍵は core の文そのもの（可変の部分は {0}・{1}）で、値は表示言語ごとの訳。
// 表示言語の訳がない言語では core の文のまま出す（l10n.ts の trCore・trCoreMessage・configDescription）。
// CORE_LABELS は core の頼むの候補の名前と Plan の承認の状態の英語の文を鍵に、ja に日本語の訳を持つ。候補の名前は dg ask・ask-menu が CLI・MCP にも返す dg の出力なので、
// ADR-001 の「言語」の節（dg が出す文は英語で持つ）に当たり、画面の定型の文として表示言語で出すのは web の役目にする（t834）。CORE_MESSAGES は core のエラー・警告と dg serve の HTTP のエラーの英語の文を鍵に、ja に日本語の訳を持つ（t651・t948）。
// CONFIG_DESCRIPTIONS は設定の項目の文（説明・要約・空のときの動き・選択肢ごとの説明）の英語の文を鍵にし、値に ja の訳を持つ（英語の表示では鍵の英語の文をそのまま出す）。
// DEFAULT_VALUES は dg の既定の値（core が持つ文）を鍵に、既定のままの値を出すときの訳を持つ（l10n.ts の shownDefault）。
// 鍵が core の候補の名前・Plan の承認の状態・エラーと警告の文・設定の項目の文・既定の値に合うことと、訳の揃いは l10n.test.ts が確かめる。
// 画面のコードの文言（tr の鍵）の英訳は l10n-en.ts に置く

import type { Language } from "./l10n.js";

/** core の文を鍵に、表示言語ごとの訳を持つ表 */
export type CoreTextTable = Readonly<Record<string, Readonly<Partial<Record<Language, string>>>>>;

/**
 * core が返す決まった文（エージェントに頼むの候補の名前・Plan の承認の状態）の訳（trCore）。鍵は core の英語の文で、文の中の ID は {0} にした形にする。
 * 鍵と core の候補の名前が過不足なく揃うことは l10n.test.ts が確かめる
 */
export const CORE_LABELS: CoreTextTable = {
  "Create tickets in {0}": { ja: "起票して {0} に入れる" },
  "Create follow-up tickets": { ja: "続きを起票する" },
  "Create tickets for {0}": { ja: "起票して {0} に足す" },
  "Create bug or follow-up tickets": { ja: "不具合・続きを起票する" },
  "Recreate tickets": { ja: "起票し直す" },
  "Create tickets": { ja: "起票する" },
  "Create Iteration": { ja: "Iteration を作る" },
  "Create Epic": { ja: "Epic を作る" },
  Change: { ja: "変える" },
  Split: { ja: "分ける" },
  "Remove from {0}": { ja: "{0} から外す" },
  "Iteration/Epic": { ja: "Iteration・Epic" },
  "Change name and goal": { ja: "名前・目標を変える" },
  "Change title and summary": { ja: "題・概要を変える" },
  "Assign carried-over tickets": { ja: "持ち越しを割り当てる" },
  "Add or remove tickets": { ja: "チケットを足す・外す" },
  Assign: { ja: "割り当てる" },
  Replan: { ja: "組み直す" },
  Plan: { ja: "計画を立てる" },
  Approve: { ja: "承認する" },
  "Run Plan": { ja: "Plan を進める" },
  "Work on": { ja: "進める" },
  "Run to completion": { ja: "最後まで進める" },
  "Verify and wrap up": { ja: "確かめて片付ける" },
  "Check what it's waiting on": { ja: "待ちを確かめる" },
  Check: { ja: "点検する" },
  Release: { ja: "リリースする" },
  Discuss: { ja: "検討する" },
  "Undo done": { ja: "done を取り消す" },
  "Ask for status": { ja: "様子を聞く" },
  Explain: { ja: "説明する" },
  Retrospect: { ja: "振り返る" },
  "Explain or change settings": { ja: "設定を説明・変更する" },
  "Free-form": { ja: "自由に" },
  Reopen: { ja: "再開する" },
  Resume: { ja: "再開する" },
  Abandon: { ja: "やめる" },
  Close: { ja: "閉じる" },
  "Awaiting approval": { ja: "承認待ち" },
  Approved: { ja: "承認済み" },
  Closed: { ja: "閉じた" },
};

/** 設定の guide.notes.* の項目が共通に持つ説明（core の鍵の英語の文） */
const GUIDE_NOTES_TEXT =
  "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.";

/**
 * 設定画面の項目の文の訳（configDescription）。鍵は core の英語の文で、ja に日本語の訳を持つ。
 * 前半は詳しい説明（core の configSchema の describe。項目の要約が説明と同じ文の項目は、この 1 行が要約の訳も兼ねる）、
 * 後半は設定画面が短く出すための文（要約 summary・空のときの動き empty・選択肢ごとの説明 option_descriptions）。例（example）は値なので訳さない。
 * core の文と過不足なく揃うこと（文を書き換えたら鍵も直す）は l10n.test.ts が確かめる
 */
export const CONFIG_DESCRIPTIONS: CoreTextTable = {
  // git.remote
  "Git remote of the code (work branches and pull requests). The kanban data also syncs with it unless git.data_remote is set":
    {
      ja: "コードのリモート（作業ブランチと PR）。git.data_remote を設定しなければ、カンバンのデータもここと同期する",
    },
  // git.data_remote
  "Git remote that the kanban data (the deguboard branch) is fetched from and pushed to, when the data is kept in a repository other than the code's. A remote name, not a URL (dg init --data-remote <URL> adds the remote). Empty uses git.remote. When the named remote is not in a clone, commands that push stop and tell how to add it. A change to the team's value is committed and pushed to the current data remote right away, so that clones still using it learn of the move. For how to move the data to another repository, see dg guide overview":
    {
      ja: "カンバンのデータ（deguboard ブランチ）を fetch・push するリモート。データをコードとは別のリポジトリに置くときに書く。URL でなくリモートの名前（dg init --data-remote <URL> がリモートを足す）。空なら git.remote を使う。名指ししたリモートがクローンにないと、push するコマンドは止まって足し方を示す。チームの値の変更は、すぐコミットして今のデータのリモートへ push する（そのリモートを使うクローンに移ったことを知らせるため）。別のリポジトリへ移す手順は dg guide overview",
    },
  // git.data_branch
  "Branch of the data remote that holds this repository's kanban. Only this branch is fetched, integrated, and pushed, so several repositories can keep separate kanbans in one dedicated data repository, each under its own branch (deguboard-<name> is recommended). A name with / is rejected. Everyone who can read the data repository can read every kanban in it. A new clone passes it to dg init --data-branch (the config is inside the data). A change to the team's value is committed and pushed to the current branch right away, so that clones still using it learn of the move. For how to move the data, see dg guide overview":
    {
      ja: "データのリモートで、このリポジトリのカンバンを置くブランチ。このブランチだけを fetch・取り込み・push するので、1 つの専用のデータのリポジトリに、リポジトリごとのブランチで別々のカンバンを置ける（deguboard-<名前> を勧める）。/ を含む名前は拒む。データのリポジトリを読める人は、そこのどのカンバンも読める。新しいクローンは dg init --data-branch で渡す（config はデータの中にある）。チームの値の変更は、すぐコミットして今のブランチへ push する（そのブランチを使うクローンに移ったことを知らせるため）。移す手順は dg guide overview",
    },
  // git.base_branch
  "Base for work branches and for deciding what is merged": {
    ja: "作業ブランチの元と「マージ済み」の判定の基準",
  },
  // worktree.root
  "Where work worktrees go. A path relative to the repository": {
    ja: "作業 worktree の置き場所。リポジトリからの相対パス",
  },
  // worktree.setup
  "Argument array of the setup command run first in a work worktree that claim created (e.g. [mise, run, setup]). Empty runs nothing. If it fails, claim still succeeds and the warnings give the failure and the command to run by hand":
    {
      ja: "claim が作った作業 worktree で最初に回す準備のコマンドの引数配列（例 [mise, run, setup]）。空なら何も回さない。失敗しても claim は成功し、warnings に失敗と手で回すコマンドを出す",
    },
  // commit.mode
  "each: commit on every write / batch: leave changes in the working tree; dg commit, dg sync, and immediate operations commit them together / manual: only dg commit and immediate operations":
    {
      ja: "each: 書き込みのたびにコミット / batch: 作業ツリーに残し、dg commit・dg sync・即時の操作がまとめてコミット / manual: dg commit と即時の操作だけ",
    },
  // push.mode
  "auto: push on every commit / manual: dg sync pushes (immediate operations push even in manual)":
    {
      ja: "auto: コミットのたびに push / manual: dg sync が push する（即時の操作は manual でも push する）",
    },
  // metrics.read_transcripts
  "Whether run finish and run refresh read conversation transcripts through the Adapter to fill in usage. Machines with DEGUBOARD_NO_TRANSCRIPTS never read them, even when true":
    {
      ja: "run finish・run refresh が Adapter で会話記録を読んで使用量を補うか。DEGUBOARD_NO_TRANSCRIPTS のマシンでは true でも読まない",
    },
  // notify.approvals
  "Whether the VS Code extension shows a notification when Plans awaiting approval or tickets in review increase (the count is always shown)":
    {
      ja: "承認待ちの Plan や review のチケットが増えたとき、VS Code 拡張が通知を出すか（件数の表示は常に出る）",
    },
  // actions.shell
  "Whether to allow the arbitrary shell Action (shell). Even when allowed, each run asks for confirmation":
    {
      ja: "任意のシェルの Action（shell）を許すか。許しても実行のたびに確認する",
    },
  // actions.test
  "Argument array of the command that the test Action (run_tests) and the quality gate's check (dg gate, dg pr ready, dg pr merge) run (e.g. [mise, run, check]). When empty, run_tests is rejected and the gate's check does not judge (the repo's own checks are confirmed instead)":
    {
      ja: "テスト実行の Action（run_tests）と、品質ゲート（dg gate・dg pr ready・dg pr merge）の検査が呼ぶコマンドの引数配列（例 [mise, run, check]）。空なら run_tests は拒否し、品質ゲートの検査は判定しない（リポジトリの規約の検査で確かめる）",
    },
  // actions.light_test
  "Argument array of the lighter check the quality gate's check runs instead of actions.test when every file changed since the last commit whose actions.test passed (the diff against base when there is none) falls under actions.light_paths (e.g. [mise, run, check:light]). When this or actions.light_paths is empty, actions.test always runs. When actions.test is empty, the lighter check does not run either":
    {
      ja: "前回 actions.test が通ったコミットから変わったファイル（前回がなければ base との差分）がすべて actions.light_paths に入るとき、品質ゲートの検査が actions.test の代わりに回す軽い検査のコマンドの引数配列（例 [mise, run, check:light]）。空なら、または actions.light_paths が空なら、いつも actions.test を回す。actions.test が空なら軽い検査も回さない",
    },
  // actions.light_paths
  "Globs of files the lighter check (actions.light_test) is enough for (relative to the repository top; * and ? do not cross /, ** crosses directories; e.g. docs/**). If even one file changed since the last commit whose actions.test passed (or against base, when there is none) falls outside, actions.test runs":
    {
      ja: "軽い検査（actions.light_test）で済ませるファイルの glob（リポジトリの最上位からの相対パス。* と ? は / をまたがず、** は階層をまたぐ。例 docs/**）。前回 actions.test が通ったコミットから変わったファイル（前回がなければ base との差分）に 1 つでも外のファイルがあれば actions.test を回す",
    },
  // work.parallel
  "Most tickets of a Plan advanced at the same time with a subagent each (dg guide parallel). An integer from 1 to 10":
    {
      ja: "Plan のチケットを、1 件ずつサブエージェントで同時に進める数の上限（dg guide parallel）。1〜10 の整数",
    },
  // merge.method
  "Merge method dg pr merge uses when --method is omitted (squash, merge, or rebase)": {
    ja: "dg pr merge が --method を省いたときのマージの方法（squash・merge・rebase）",
  },
  // merge.delete_branch
  "Whether dg pr merge also deletes the remote and local work branch when --delete-branch is omitted, and whether dg sync deletes the worktree and work branch that remain when it moves a ticket to done":
    {
      ja: "dg pr merge が --delete-branch を省いたとき、リモートとローカルの作業ブランチも消すか。dg sync がチケットを done にしたとき、残った worktree と作業ブランチを消すか",
    },
  // review.heavy_categories
  "Review finding categories (run review-result --findings-file) treated as heavy regardless of severity. Empty by default, so the reviewer's severity is kept":
    {
      ja: "見直しの指摘（run review-result --findings-file）のうち、severity によらず重いとみなす category。既定は空で、見直し役の severity のまま",
    },
  // lint.require_iteration
  "Whether dg lint flags tickets that moved past todo or abandoned without being in an Iteration (except done tickets in closed Epics). dg guide work asks to add the ticket to an Iteration before claim":
    {
      ja: "dg lint が、Iteration に入らずに todo・abandoned 以外に進んだチケットを指摘するか（閉じた Epic の done は除く）。dg guide work は claim の前に Iteration に入れるよう案内する",
    },
  // models.light
  "Model for Plan tier light (docs, settings, and wording only) and for research within implementation. When empty, the parent's model":
    {
      ja: "Plan の段階 light（文書・設定・文言だけ）と、実装の中の調べものに使うモデル。空なら親のモデル",
    },
  // models.standard
  "Model for Plan tier standard (anything that is not light or heavy). When empty, the parent's model":
    {
      ja: "Plan の段階 standard（light・heavy に当たらないもの）に使うモデル。空なら親のモデル",
    },
  // models.heavy
  "Model for Plan tier heavy (design decisions, data shapes, multiple packages, bugs of unknown cause). When empty, the parent's model":
    {
      ja: "Plan の段階 heavy（設計の判断・データの形・複数パッケージ・原因の分からない不具合）に使うモデル。空なら親のモデル",
    },
  // models.<agent>.light（どの agent も同じ説明）
  "Model for Plan tier light when the agent in this key calls dg next (it overrides models.light for that agent). When empty, models.light":
    {
      ja: "この鍵の agent が dg next を呼んだときに、Plan の段階 light に使うモデル（その agent では models.light より優先する）。空なら models.light",
    },
  // models.<agent>.standard
  "Model for Plan tier standard when the agent in this key calls dg next (it overrides models.standard for that agent). When empty, models.standard":
    {
      ja: "この鍵の agent が dg next を呼んだときに、Plan の段階 standard に使うモデル（その agent では models.standard より優先する）。空なら models.standard",
    },
  // models.<agent>.heavy
  "Model for Plan tier heavy when the agent in this key calls dg next (it overrides models.heavy for that agent). When empty, models.heavy":
    {
      ja: "この鍵の agent が dg next を呼んだときに、Plan の段階 heavy に使うモデル（その agent では models.heavy より優先する）。空なら models.heavy",
    },
  // priority.high
  "Criteria for priority high. Used when creating and reviewing tickets, and by the priority marks and selection hints on screen":
    {
      ja: "優先度 high の判断基準。起票・見直しと画面の優先度の印・選択の説明が使う",
    },
  // priority.medium
  "Criteria for priority medium (the default). Used when creating and reviewing tickets, and by the priority marks and selection hints on screen":
    {
      ja: "優先度 medium（既定）の判断基準。起票・見直しと画面の優先度の印・選択の説明が使う",
    },
  // priority.low
  "Criteria for priority low. Used when creating and reviewing tickets, and by the priority marks and selection hints on screen":
    {
      ja: "優先度 low の判断基準。起票・見直しと画面の優先度の印・選択の説明が使う",
    },
  // guide.notes.*（どの項目も同じ説明）
  [GUIDE_NOTES_TEXT]: {
    ja: "guide の題名の直後（節を出すときは節の見出しの直後）に差し込む文書のパス。リポジトリの最上位からの相対パスで、リポジトリの外は読まない。空なら差し込まない。見出し（#）を含む文書は差し込まない",
  },

  // --- 要約（summary）。説明と同じ文の項目（git.base_branch）は上の行が兼ねる ---
  // git.remote
  "Git remote of the code (work branches and pull requests)": {
    ja: "コードのリモート（作業ブランチと PR）",
  },
  // git.data_remote
  "Git remote that the kanban data is fetched from and pushed to": {
    ja: "カンバンのデータを fetch・push するリモート",
  },
  // git.data_branch
  "Branch of the data remote that holds this repository's kanban": {
    ja: "データのリモートで、このリポジトリのカンバンを置くブランチ",
  },
  // worktree.root
  "Where work worktrees go": { ja: "作業 worktree の置き場所" },
  // worktree.setup
  "Setup command run first in a new work worktree": {
    ja: "新しい作業 worktree で最初に回す準備のコマンド",
  },
  // commit.mode
  "When ticket writes are committed": { ja: "チケットの書き込みをいつコミットするか" },
  // push.mode
  "When commits are pushed": { ja: "コミットをいつ push するか" },
  // metrics.read_transcripts
  "Read conversation transcripts to fill in usage": { ja: "会話記録を読んで使用量を補う" },
  // notify.approvals
  "Notify in VS Code when Plans awaiting approval or tickets in review increase": {
    ja: "承認待ちの Plan や review のチケットが増えたら VS Code で通知する",
  },
  // actions.shell
  "Allow the arbitrary shell Action": { ja: "任意のシェルの Action を許す" },
  // actions.test
  "Command run by the quality gate's check and the test Action": {
    ja: "品質ゲートの検査とテストの Action が回すコマンド",
  },
  // actions.light_test
  "Lighter check run instead of actions.test when only light paths changed": {
    ja: "変更が軽いパスだけのとき、actions.test の代わりに回す検査",
  },
  // actions.light_paths
  "Globs of files the lighter check is enough for": {
    ja: "軽い検査で済ませてよいファイルの glob",
  },
  // work.parallel
  "Most tickets of a Plan advanced at the same time (1 to 10)": {
    ja: "Plan のチケットを同時に進める数の上限（1〜10）",
  },
  // merge.method
  "Merge method dg pr merge uses by default": { ja: "dg pr merge の既定のマージの方法" },
  // merge.delete_branch
  "Delete the work branch when dg pr merge merges": {
    ja: "dg pr merge でマージしたら作業ブランチも消す",
  },
  // review.heavy_categories
  "Review finding categories always treated as heavy": {
    ja: "いつも重いとみなす見直しの指摘の category",
  },
  // lint.require_iteration
  "Have dg lint flag tickets worked on outside an Iteration": {
    ja: "Iteration に入らずに進んだチケットを dg lint が指摘する",
  },
  // models.light
  "Model for Plan tier light and for research": {
    ja: "Plan の段階 light と調べものに使うモデル",
  },
  // models.standard
  "Model for Plan tier standard": { ja: "Plan の段階 standard に使うモデル" },
  // models.heavy
  "Model for Plan tier heavy": { ja: "Plan の段階 heavy に使うモデル" },
  // models.<agent>.*
  "Model for Plan tier light when this agent calls dg next": {
    ja: "この agent が dg next を呼んだときに、Plan の段階 light に使うモデル",
  },
  "Model for Plan tier standard when this agent calls dg next": {
    ja: "この agent が dg next を呼んだときに、Plan の段階 standard に使うモデル",
  },
  "Model for Plan tier heavy when this agent calls dg next": {
    ja: "この agent が dg next を呼んだときに、Plan の段階 heavy に使うモデル",
  },
  // priority.high
  "Criteria for priority high": { ja: "優先度 high の判断基準" },
  // priority.medium
  "Criteria for priority medium (the default)": { ja: "優先度 medium（既定）の判断基準" },
  // priority.low
  "Criteria for priority low": { ja: "優先度 low の判断基準" },
  // guide.notes.*（どの項目も同じ要約）
  "Document inserted just after the guide title. A path relative to the repository root": {
    ja: "guide の題名の直後に差し込む文書。リポジトリの最上位からの相対パス",
  },

  // --- 空のときの動き（empty） ---
  // 既定が空でない文字列の項目（git.*・worktree.root・priority.*）
  "Returns to the default (in personal settings, to the team's value)": {
    ja: "既定に戻る（個人の設定ではチームの値に戻る）",
  },
  // git.data_remote
  "Uses git.remote": { ja: "git.remote を使う" },
  // worktree.setup
  "Runs nothing": { ja: "何も回さない" },
  // actions.test
  "The gate's check does not judge, and run_tests is rejected": {
    ja: "品質ゲートの検査を判定しない（run_tests も拒否する）",
  },
  // actions.light_test・actions.light_paths
  "The lighter check is not used (actions.test runs)": {
    ja: "軽い検査を使わない（actions.test を回す）",
  },
  // review.heavy_categories
  "The reviewer's severity is kept": { ja: "見直し役の severity のまま" },
  // models.*
  "The parent's model": { ja: "親のモデル" },
  // models.<agent>.*
  "models.light is used": { ja: "models.light を使う" },
  "models.standard is used": { ja: "models.standard を使う" },
  "models.heavy is used": { ja: "models.heavy を使う" },
  // guide.notes.*
  "Inserts nothing": { ja: "差し込まない" },

  // --- 選択肢ごとの説明（option_descriptions） ---
  // commit.mode（each・batch・manual）
  "Commit on every write": { ja: "書き込みのたびにコミットする" },
  "Leave changes in the working tree; dg commit, dg sync, and immediate operations commit them together":
    { ja: "作業ツリーに残し、dg commit・dg sync・即時の操作でまとめてコミットする" },
  "Commit only on dg commit and immediate operations": {
    ja: "dg commit と即時の操作のときだけコミットする",
  },
  // push.mode（auto・manual）
  "Push on every commit": { ja: "コミットのたびに push する" },
  "dg sync pushes (immediate operations push even in manual)": {
    ja: "dg sync が push する（即時の操作は manual でも push する）",
  },
  // merge.method（squash・merge・rebase）
  "Squash the PR's commits into one commit": { ja: "PR のコミットを 1 つにまとめる" },
  "Make a merge commit": { ja: "マージコミットを作る" },
  "Rebase the PR's commits onto the base branch": {
    ja: "PR のコミットを base のブランチに積み直す",
  },
};

/**
 * core が返すエラー・警告の決まった文の訳（trCoreMessage）。鍵は core の文の可変の部分（ID・項目名・値）を {0}・{1} にした形。
 * 設定の保存の拒否・Plan と Run の警告・dg が Run を閉じた理由・読めないファイルの理由と、dg serve の HTTP のエラーの文（server）を置く。表にない文は core の文のまま出す。
 * 鍵の {0} 以外の部分が core か server のソースにあることと、server の JSON のエラーの文がどれも鍵にあることは l10n.test.ts が確かめる（文言が変われば気づく）
 */
export const CORE_MESSAGES: CoreTextTable = {
  // 設定の保存の拒否（config.set・config.unset）
  "key is empty": { ja: "key が空" },
  "{0} cannot be set in personal settings": { ja: "{0} は個人の設定に書けない" },
  "This item is team-only. Drop --local and change the team's config.yaml": {
    ja: "チーム専用の項目。--local を外してチームの config.yaml を変える",
  },
  "Not in the schema. Items you can override: {0}": {
    ja: "スキーマにない項目。上書きできる項目：{0}",
  },
  "Invalid value for {0}": { ja: "{0} の値が正しくない" },
  "A value is required. Options: {0}": { ja: "値を省けない。選択肢：{0}" },
  "The config update does not match the schema": { ja: "config の更新がスキーマに合わない" },
  "Items that cannot be set in personal settings": { ja: "個人の設定に書けない項目" },
  // 本文の保存の拒否（ticket.update の base）
  "The body of {0} changed after it was read. Nothing was written. Read it again, then apply the change again":
    {
      ja: "{0} の本文は読んだ後に変わった。何も書いていない。読み直してから、変更をもう一度入れる",
    },
  // Plan の警告（plan.show）
  "{0} not found (deleted)": { ja: "{0} が見つからない（削除された）" },
  // Run の警告（run.list・metrics.show）
  "deguboard-local/{0}: {1}": { ja: "deguboard-local/{0}: {1}" },
  "Tickets {0} not found, so the Epic and Iteration of those Runs are unknown": {
    ja: "チケット {0} が見つからないので、その Run の Epic・Iteration は分からない",
  },
  // dg とフックが Run を閉じるときに書く error（run.ts。Run の結果の理由として出す。前の版が日本語で書いた error は表になく、そのまま出る）
  "Left open in another session (closed as left over from a session that ended)": {
    ja: "別のセッションで開いたままだった（落ちたセッションの残りとみなして閉じた）",
  },
  "No PR when the sub-agent ended": { ja: "サブエージェントが終わったとき PR がない" },
  "Still open when the session ended": { ja: "セッションが終わったとき開いたままだった" },
  "Returned to todo by ticket unclaim": { ja: "ticket unclaim で todo に戻した" },
  "Went back to todo during reconcile": { ja: "照合のとき todo に戻っていた" },
  "Became claimed by another actor during reconcile": {
    ja: "照合のとき、ほかの主体が claim していた",
  },
  "The reviewer ended without recording a result (write it with dg run review-result)": {
    ja: "見直し役が結果を記録せずに終わった（dg run review-result で書く）",
  },
  // 読めないファイルの理由（readDoc）
  "Cannot read the file": { ja: "ファイルを読めない" },
  "Cannot parse JSON": { ja: "JSON を読めない" },
  "Not a JSON object": { ja: "JSON のオブジェクトでない" },
  "Missing frontmatter (---) at the start": { ja: "先頭に frontmatter（---）がない" },
  "Missing the closing --- of the frontmatter": { ja: "frontmatter を閉じる --- がない" },
  "Cannot parse YAML": { ja: "YAML を読めない" },
  "Does not match the schema": { ja: "スキーマに合わない" },
  "The ID {0} in the file name differs from the id {1} inside": {
    ja: "ファイル名の ID {0} と中の id {1} が違う",
  },
  // dg serve の HTTP のエラー（packages/server/src/app.ts・static.ts。画面は client/http.ts の ClientError で出す）
  "Refused a request for the host name {0}. dg serve accepts only localhost, an IP address, or the name given with --host":
    {
      ja: "ホスト名 {0} への要求を断った。dg serve が受け入れるのは localhost・IP アドレス・--host で指定した名前だけ",
    },
  "Refused a request from the origin {0}. dg serve accepts only requests from its own origin": {
    ja: "オリジン {0} からの要求を断った。dg serve が受け入れるのは自分のオリジンからの要求だけ",
  },
  "Refused a POST with the content type {0}. Send application/json": {
    ja: "Content-Type が {0} の POST を断った。application/json で送る",
  },
  "Refused a request whose URL cannot be read: {0}": {
    ja: "URL を読めない要求を断った: {0}",
  },
  "The request body is not JSON": { ja: "要求の本文が JSON ではない" },
  "No API at {0}": { ja: "{0} という API はない" },
  "The request body is too large": { ja: "要求の本文が大きすぎる" },
};

/**
 * dg の既定の値の訳（shownDefault・shownDefaultText・storedDefault。UI-11）。鍵は core が持つ既定の文そのもので、値は表示言語ごとの訳。
 * 画面は値が既定と同じときか、既定そのものを添えるとき（「既定は …」）だけここを引くので、書き換えた値は鍵と同じ文でない限り訳さず、訳のない言語では既定の文のまま出す。
 * 既定の値を訳して出す項目は、ここに鍵を足すだけでよい（判定と引き方は l10n.ts の 1 か所）。
 * 優先度の判断基準（config の priority.*）と振り返りの既定の観点（retro.perspectives）の名前と問いは core が英語で持つので、日本語の訳を置く
 * （名前と問いの両方が既定のままの観点だけを訳す。判定は l10n.ts の isDefaultPerspective）。
 * Run の step の表示名と Status の既定の表示名は core が英語で持つので日本語の訳を置く（判定は l10n.ts の shownWorkflow）。
 * 鍵が core の既定の文にあることは l10n.test.ts が確かめる
 */
export const DEFAULT_VALUES: CoreTextTable = {
  // priority.high
  "User-visible bugs, documents that mislead users, exploitable vulnerabilities, license omissions, failing checks, and anything blocking other tickets":
    {
      ja: "利用者に見える不具合・利用者を誤らせる文書・悪用できる脆弱性・ライセンスの漏れ・検査が通らない・ほかのチケットを止めている",
    },
  // priority.medium
  "New features and improvements, missing or unstable tests, inconsistencies in internal docs, convention violations that do no harm yet, and dependencies that are far out of date":
    {
      ja: "機能の追加と改善・テストの抜けと不安定なテスト・内部の文書の食い違い・今は害のない規約違反・大きく古い依存",
    },
  // priority.low
  "Unused code and dependencies, duplicated settings, inconsistent wording, and investigation and study that are not urgent":
    {
      ja: "使われていないコードと依存・設定の重複・言い回しの揺れ・急がない調査と検討",
    },
  // retro.perspectives.outcome（名前・問い）
  Outcome: { ja: "成果" },
  "Was the goal met? What was finished, dropped, and carried over?": {
    ja: "目標は達成できたか。終えたもの・やめたもの・持ち越したものは何か",
  },
  // retro.perspectives.review
  "Review effectiveness": { ja: "見直しの効き目" },
  "Did the review find defects before the merge and converge in few rounds?": {
    ja: "見直しは不具合をマージの前に見つけ、少ない回数で収束したか",
  },
  // retro.perspectives.spec
  "Spec quality": { ja: "仕様の質" },
  "Did the tickets (acceptance criteria and scope) draw out a deliverable that passes without rework?":
    {
      ja: "チケット（受け入れ条件と範囲）は、作り直しなしで通る成果を引き出せたか",
    },
  // retro.perspectives.slicing
  Slicing: { ja: "分け方" },
  "Was the work divided into sizes and boundaries that can advance side by side without colliding?":
    {
      ja: "作業は、互いにぶつからずに並べて進められる大きさと境目に分けられたか",
    },
  // retro.perspectives.stability
  "Agent stability": { ja: "エージェントの安定" },
  "Did the agents' work finish stably, without failures, interruptions, or retries?": {
    ja: "エージェントの働きは、失敗・中断・やり直しなく安定して終わったか",
  },
  // retro.perspectives.cost
  Cost: { ja: "コスト" },
  "Where were time and tokens spent, and were they worth the outcome?": {
    ja: "時間とトークンはどこに使われ、成果に見合っていたか",
  },
  // retro.perspectives.improvement
  "Improvement tracking": { ja: "改善の追跡" },
  "Was the Try of the previous retrospective finished, and did the numbers it aimed at move?": {
    ja: "前の振り返りの Try は終わり、ねらった数字は動いたか",
  },
  // Run の step の表示名（core の RUN_STEPS）
  Investigate: { ja: "調査" },
  Implement: { ja: "実装" },
  Review: { ja: "見直し" },
  Fix: { ja: "手直し" },
  Merge: { ja: "マージ" },
  // Status の既定の表示名（core の DEFAULT_LABELS）。Review は step の表示名と同じ鍵なので、同じ「見直し」で出る
  Todo: { ja: "未着手" },
  "In Progress": { ja: "作業中" },
  Done: { ja: "完了" },
  Abandoned: { ja: "中止" },
};
