// 画面が引く core の文の訳の表（UI-11・t649）。鍵は core の文そのもの（可変の部分は {0}・{1}）で、値は表示言語ごとの訳。
// 表示言語の訳がない言語では core の文のまま出す（l10n.ts の trCore・trCoreMessage・configDescription）。
// CORE_LABELS と CORE_MESSAGES の文は今は日本語なので、鍵の文に ja の訳は持たず en の訳だけを持つ（英語化は e11 で進める）。
// CONFIG_DESCRIPTIONS は設定の項目の説明の英語の文を鍵にし、値に ja の訳を持つ（英語の表示では鍵の英語の文をそのまま出す）。
// 鍵が core の候補の名前・エラーと警告の文・設定の項目の説明に合うことと、訳の揃いは l10n.test.ts が確かめる。
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
  直す: { en: "Fix" },
  分ける: { en: "Split" },
  "{0} から外す": { en: "Remove from {0}" },
  "Iteration・Epic": { en: "Iteration/Epic" },
  "名前・目標・期間を直す": { en: "Edit name, goal, and period" },
  "題・概要を直す": { en: "Edit title and summary" },
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
  持ち越しを相談する: { en: "Discuss carrying over" },
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
 * 設定画面の項目の説明（core の configSchema の describe）の訳（configDescription）。鍵は core の説明の英語の文で、ja に今の日本語の説明を持つ。
 * core の説明と過不足なく揃うこと（説明を書き換えたら鍵も直す）は l10n.test.ts が確かめる
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
  "Argument array of the lighter check the quality gate's check runs instead of actions.test when every file in the work branch's diff against base falls under actions.light_paths (e.g. [mise, run, check:light]). When this or actions.light_paths is empty, actions.test always runs. When actions.test is empty, the lighter check does not run either":
    {
      ja: "作業ブランチの base との差分のファイルがすべて actions.light_paths に入るとき、品質ゲートの検査が actions.test の代わりに回す軽い検査のコマンドの引数配列（例 [mise, run, check:light]）。空なら、または actions.light_paths が空なら、いつも actions.test を回す。actions.test が空なら軽い検査も回さない",
    },
  // actions.light_paths
  "Globs of files the lighter check (actions.light_test) is enough for (relative to the repository top; * and ? do not cross /, ** crosses directories; e.g. docs/**). If even one file in the diff falls outside, actions.test runs":
    {
      ja: "軽い検査（actions.light_test）で済ませるファイルの glob（リポジトリの最上位からの相対パス。* と ? は / をまたがず、** は階層をまたぐ。例 docs/**）。差分に 1 つでも外のファイルがあれば actions.test を回す",
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
};

/**
 * core が返すエラー・警告の決まった文の訳（trCoreMessage）。鍵は core の文の可変の部分（ID・項目名・値）を {0}・{1} にした形。
 * 設定の保存の拒否・Plan と Run の警告・読めないファイルの理由を置く。表にない文は core の文のまま出す。
 * 鍵の {0} 以外の部分が core のソースにあることは l10n.test.ts が確かめる（core の文言が変われば気づく）
 */
export const CORE_MESSAGES: CoreTextTable = {
  // 設定の保存の拒否（config.set・config.unset）
  "key が空": { en: "key is empty" },
  "{0} は個人の設定に書けない": { en: "{0} cannot be set in personal settings" },
  "チーム専用の項目。--local を外してチームの config.yaml を変える": {
    en: "This item is team-only. Drop --local and change the team's config.yaml",
  },
  "スキーマにない項目。上書きできる項目：{0}": {
    en: "Not in the schema. Items you can override: {0}",
  },
  "{0} の値が正しくない": { en: "Invalid value for {0}" },
  "値を省けない。選択肢：{0}": { en: "A value is required. Options: {0}" },
  "actor.human_only にないコマンドがある: {0}": {
    en: "actor.human_only has unknown commands: {0}",
  },
  "config の更新がスキーマに合わない": { en: "The config update does not match the schema" },
  個人の設定に書けない項目: { en: "Items that cannot be set in personal settings" },
  // Plan の警告（plan.show）
  "{0} が見つからない（削除された）": { en: "{0} not found (deleted)" },
  // Run の警告（run.list・metrics.show）
  "deguboard-local/{0}: {1}": { en: "deguboard-local/{0}: {1}" },
  "チケット {0} が見つからないので、その Run の Epic・Iteration・Project は分からない": {
    en: "Ticket(s) {0} not found, so the Epic, Iteration, and Project of their Runs are unknown",
  },
  // 読めないファイルの理由（readDoc）
  ファイルを読めない: { en: "Cannot read the file" },
  "JSON を読めない": { en: "Cannot parse JSON" },
  "JSON のオブジェクトでない": { en: "Not a JSON object" },
  "先頭に frontmatter（---）がない": { en: "No frontmatter (---) at the top" },
  "frontmatter を閉じる --- がない": { en: "No closing --- for the frontmatter" },
  "YAML を読めない": { en: "Cannot parse YAML" },
  スキーマに合わない: { en: "Does not match the schema" },
  "ファイル名の ID {0} と中の id {1} が違う": {
    en: "The ID {0} in the file name differs from the id {1} inside",
  },
};
