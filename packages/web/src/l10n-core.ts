// 画面が引く core の文の訳の表（UI-11・t649）。鍵は core の文そのもの（可変の部分は {0}・{1}）で、値は表示言語ごとの訳。
// 表示言語の訳がない言語では core の文のまま出す（l10n.ts の trCore・trCoreMessage・configDescription）。
// CORE_LABELS の文は今は日本語なので、鍵の文に en の訳だけを持つ（英語化は e11 で進める）。CORE_MESSAGES は core のエラー・警告の英語の文を鍵に、ja に今の日本語の文を持つ（t651）。
// CONFIG_DESCRIPTIONS は設定の項目の文（説明・要約・空のときの動き・選択肢ごとの説明）の英語の文を鍵にし、値に ja の訳を持つ（英語の表示では鍵の英語の文をそのまま出す）。
// 鍵が core の候補の名前・エラーと警告の文・設定の項目の文に合うことと、訳の揃いは l10n.test.ts が確かめる。
// 画面のコードの文言（tr の鍵）の英訳は l10n-en.ts に置く

import type { Language } from "./l10n.js";

/** core の文を鍵に、表示言語ごとの訳を持つ表 */
export type CoreTextTable = Readonly<Record<string, Readonly<Partial<Record<Language, string>>>>>;

/**
 * core が返す決まった文（エージェントに頼むの候補の名前・Plan の承認の状態）の訳（trCore）。文の中の ID は {0} にした形を鍵にする。
 * 同じ文が頼むことによって意味の違うものは「頼むこと:文」の鍵で分ける
 */
export const CORE_LABELS: CoreTextTable = {
  "起票して {0} に入れる": { en: "Create tickets in {0}" },
  続きを起票する: { en: "Create follow-up tickets" },
  "起票して {0} に足す": { en: "Create tickets in {0}" },
  "不具合・続きを起票する": { en: "Create bug or follow-up tickets" },
  起票し直す: { en: "Recreate tickets" },
  起票する: { en: "Create tickets" },
  "Iteration を作る": { en: "Create Iteration" },
  "Epic を作る": { en: "Create Epic" },
  変える: { en: "Change" },
  分ける: { en: "Split" },
  "{0} から外す": { en: "Remove from {0}" },
  "Iteration・Epic": { en: "Iteration/Epic" },
  "名前・目標を変える": { en: "Change name and goal" },
  "題・概要を変える": { en: "Change title and summary" },
  持ち越しを割り当てる: { en: "Assign carried-over tickets" },
  "チケットを足す・外す": { en: "Add or remove tickets" },
  割り当てる: { en: "Assign" },
  組み直す: { en: "Replan" },
  計画を立てる: { en: "Plan" },
  承認する: { en: "Approve" },
  "Plan を進める": { en: "Run Plan" },
  進める: { en: "Work on" },
  最後まで進める: { en: "Run to completion" },
  確かめて片付ける: { en: "Verify and wrap up" },
  待ちを確かめる: { en: "Check what it's waiting on" },
  点検する: { en: "Check" },
  リリースする: { en: "Release" },
  検討する: { en: "Discuss" },
  "done を取り消す": { en: "Undo done" },
  様子を聞く: { en: "Ask for status" },
  振り返る: { en: "Retrospect" },
  自由に: { en: "Free-form" },
  "reopen:再開する": { en: "Reopen" },
  "resume:再開する": { en: "Resume" },
  "abandon:やめる": { en: "Abandon" },
  "close:閉じる": { en: "Close" },
  承認待ち: { en: "Awaiting approval" },
  承認済み: { en: "Approved" },
  閉じた: { en: "Closed" },
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
  // default_project
  "Project used when none is given": { ja: "省略時の Project" },
  // git.remote
  "Git remote that deguboard fetches from and pushes to": { ja: "同期先のリモート" },
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
  "Whether run finish and run refresh read conversation transcripts through the Adapter to fill in usage. Machines with DEGUBOARD_NO_TRANSCRIPTS never read them, even when true (MT-2)":
    {
      ja: "run finish・run refresh が Adapter で会話記録を読んで使用量を補うか。DEGUBOARD_NO_TRANSCRIPTS のマシンでは true でも読まない（MT-2）",
    },
  // notify.approvals
  "Whether the VS Code extension shows a notification when Plans awaiting approval or tickets in review increase (the count is always shown)":
    {
      ja: "承認待ちの Plan や review のチケットが増えたとき、VS Code 拡張が通知を出すか（件数の表示は常に出る）",
    },
  // actions.shell
  "Whether to allow the arbitrary shell Action (shell). Even when allowed, each run asks for confirmation (AG-7)":
    {
      ja: "任意のシェルの Action（shell）を許すか。許しても実行のたびに確認する（AG-7）",
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
  // auto.merge
  "Whether dg guide all --auto merges PRs that pass the quality gate (dg gate --for merge) automatically. By default a person merges":
    {
      ja: "dg guide all --auto で、品質ゲート（dg gate --for merge）を満たした PR を自動でマージするか。既定は人がマージする",
    },
  // auto.decisions
  "Decisions --auto chooses without asking (assign: assignment / check: the fix line when only one fix fits / plan: Plan approval / audit: the review findings table / accept: confirming acceptance criteria after reconciling). Decisions a person makes cannot be added; PR merging is set by auto.merge":
    {
      ja: "--auto で聞かずに選ぶ判断（assign: 割り当て・check: 直し方が 1 つに決まる直す行・plan: Plan の承認・audit: 見直しの指摘の表・accept: 照合の後の受け入れ条件の確認）。人が決める判断は入れられず、PR のマージは auto.merge",
    },
  // flow.skip
  "Stages that dg flow next never returns (assign, check, plan, work, audit, release). A skipped stage's rule is not read; the flow moves to the next rule":
    {
      ja: "dg flow next が返さない段階（assign・check・plan・work・audit・release）。飛ばした段階の規則は読まず、次の規則に進む",
    },
  // merge.method
  "Merge method dg pr merge uses when --method is omitted (squash, merge, or rebase)": {
    ja: "dg pr merge が --method を省いたときのマージの方法（squash・merge・rebase）",
  },
  // merge.delete_branch
  "Whether dg pr merge also deletes the remote and local work branch when --delete-branch is omitted":
    {
      ja: "dg pr merge が --delete-branch を省いたとき、リモートとローカルの作業ブランチも消すか",
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
  // actor.human_only
  "Command names rejected for agents (such as epic.close). Empty by default, allowing everything. Ticket transitions are restricted with the Workflow's by":
    {
      ja: "agent からは拒否するコマンド名（epic.close など）。既定は空で、すべて許す。チケットの遷移は Workflow の by で縛る",
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

  // --- 要約（summary）。説明と同じ文の項目（default_project・git.*）は上の行が兼ねる ---
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
  // auto.merge
  "Merge PRs that pass the quality gate automatically with --auto": {
    ja: "--auto で、品質ゲートを満たした PR を自動でマージする",
  },
  // auto.decisions
  "Decisions --auto chooses without asking": { ja: "--auto で聞かずに選ぶ判断" },
  // flow.skip
  "Stages that dg flow next skips": { ja: "dg flow next が飛ばす段階" },
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
  // actor.human_only
  "Command names rejected for agents": { ja: "agent からは拒否するコマンド名" },
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
  // 既定が空でない文字列の項目（default_project・git.*・worktree.root・priority.*）
  "Returns to the default (in personal settings, to the team's value)": {
    ja: "既定に戻る（個人の設定ではチームの値に戻る）",
  },
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
  // auto.decisions
  "--auto chooses nothing without asking": { ja: "--auto でも聞かずに選ぶ判断はない" },
  // flow.skip
  "No stage is skipped": { ja: "どの段階も飛ばさない" },
  // review.heavy_categories
  "The reviewer's severity is kept": { ja: "見直し役の severity のまま" },
  // models.*
  "The parent's model": { ja: "親のモデル" },
  // actor.human_only
  "Every command is allowed. Ticket transitions are still restricted with the Workflow's by": {
    ja: "すべてのコマンドを許す。チケットの遷移は Workflow の by で縛る",
  },
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
  // auto.decisions（assign・check・plan・audit・accept）。assign は flow.skip と同じ文
  Assignment: { ja: "割り当て" },
  "The fix line when only one fix fits": { ja: "直し方が 1 つに決まる直す行" },
  "Plan approval": { ja: "Plan の承認" },
  "The review findings table": { ja: "見直しの指摘の表" },
  "Confirming acceptance criteria after reconciling": {
    ja: "照合の後の受け入れ条件の確認",
  },
  // flow.skip（assign・check・plan・work・audit・release）
  Check: { ja: "点検" },
  Planning: { ja: "計画" },
  Work: { ja: "作業" },
  Audit: { ja: "リリース前の見直し" },
  Release: { ja: "リリース" },
  // merge.method（squash・merge・rebase）
  "Squash the PR's commits into one commit": { ja: "PR のコミットを 1 つにまとめる" },
  "Make a merge commit": { ja: "マージコミットを作る" },
  "Rebase the PR's commits onto the base branch": {
    ja: "PR のコミットを base のブランチに積み直す",
  },
};

/**
 * core が返すエラー・警告の決まった文の訳（trCoreMessage）。鍵は core の文の可変の部分（ID・項目名・値）を {0}・{1} にした形。
 * 設定の保存の拒否・Plan と Run の警告・読めないファイルの理由を置く。表にない文は core の文のまま出す。
 * 鍵の {0} 以外の部分が core のソースにあることは l10n.test.ts が確かめる（core の文言が変われば気づく）
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
  "actor.human_only has unknown commands: {0}": {
    ja: "actor.human_only にないコマンドがある: {0}",
  },
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
  "Tickets {0} not found, so the Epic, Iteration and Project of those Runs are unknown": {
    ja: "チケット {0} が見つからないので、その Run の Epic・Iteration・Project は分からない",
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
};
