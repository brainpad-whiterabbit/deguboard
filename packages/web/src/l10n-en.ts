// 画面の文言の英語の訳（l10n.ts）。鍵は日本語の文で、日本語ではこの表を使わない。
// ソースの鍵と EN が過不足なく揃うことと、CORE_EN が core の候補の名前を、CONFIG_DESCRIPTIONS_EN が設定の全項目の説明を訳すこと、
// CORE_MESSAGES_EN の鍵が core のソースの文に合うことは l10n.test.ts が確かめる

/** 画面のコードの tr・trNode・msg の鍵の訳。鍵を置いたファイルの順 */
export const EN: Readonly<Record<string, string>> = {
  // app.tsx
  カンバン: "Board",
  バックログ: "Backlog",
  履歴: "History",
  画面: "Views",
  "（アーカイブ）": " (archived)",
  エージェントに頼む: "Ask Agent",
  設定: "Settings",
  "読み込み中…": "Loading…",
  なし: "None",
  閉じる: "Close",
  // client/http.ts
  "サーバーに届かない。dg serve が動いているか確かめる":
    "Cannot reach the server. Check that dg serve is running",
  "応答が JSON ではない（{0}）": "Response is not JSON ({0})",
  // components/ask-composer.tsx
  "✓ コピーしました。エージェントの入力欄に貼ってください":
    "✓ Copied. Paste it into the agent's input",
  コピーできない: "Could not copy",
  送れない: "Could not send",
  頼むこと: "Request",
  "Skill を使わない": "No Skill",
  おすすめ: "Recommended",
  "閉じる（Esc）": "Close (Esc)",
  "{0} を外す": "Remove {0}",
  指示: "Instructions",
  頼むことを書く: "Describe the request",
  "指示を足す（なくてもよい）": "Add instructions (optional)",
  送り先: "Send to",
  送り先のターミナル: "Target terminal",
  "依頼文を入れるターミナル（開いているものから選ぶ。起動はしない）":
    "Terminal to receive the request (choose an open one; none is started)",
  "選んだターミナルの入力に依頼文を入れる（Enter は押さない）":
    "Put the request into the selected terminal's input (Enter is not pressed)",
  送る: "Send",
  全文: "Full text",
  "Skill の呼び出しか、Skill を使わない文章だけか。既定は dg の Skill がリポジトリか ~/.claude/skills にあれば Skill、なければ文章":
    "Invoke a Skill, or plain text without a Skill. Defaults to Skill if the dg Skills are in the repository or ~/.claude/skills, otherwise text",
  "形式：文章": "Format: Text",
  "形式：Skill": "Format: Skill",
  "{0}コピー": "{0}Copy",
  "{0}なので、人が打つコマンドをコピーする": "{0}, so copy the commands for a person to run",
  "{0} は人に限った操作（actor.human_only）": "{0} is limited to people (actor.human_only)",
  "・": ", ",
  "{0} は Workflow が人に限った遷移（by）":
    "{0} is a transition the Workflow limits to people (by)",
  "、": ", ",
  // components/ask-menu.tsx
  "行にマウスを載せると出る吹き出しで、エージェントに頼めます":
    "Hover over a row to show a bubble for asking an agent",
  "選んだ {0} 件": "{0} selected",
  "エージェントに頼む（{0}）": "Ask Agent ({0})",
  "エージェントに頼む（Shift+F10）": "Ask Agent (Shift+F10)",
  選んだ行: "Selected rows",
  "{0} 件を選択": "{0} selected",
  選んだ行をまとめてエージェントに頼む: "Ask an agent about the selected rows together",
  頼む: "Ask",
  "選択を外す（Esc）": "Clear selection (Esc)",
  選択を外す: "Clear selection",
  案内を閉じる: "Dismiss tip",
  "閉じる（もう出さない）": "Close (don't show again)",
  // components/assignee-mark.tsx
  "Run なし": "No runs",
  // components/chips.tsx
  "あと {0} 個出す": "Show {0} more",
  "ほか {0}": "{0} more",
  畳む: "Collapse",
  // components/copyable-code.tsx
  コピーした: "Copied",
  // components/date-time.tsx
  今日: "Today",
  昨日: "Yesterday",
  "{0}（{1}）": "{0} ({1})",
  "{0} に閉じた": "Closed {0}",
  閉じた日は不明: "Closed date unknown",
  // components/filter-toggle.tsx
  "絞り込み（絞っている）": "Filter (active)",
  絞り込み: "Filter",
  // components/history-rows.tsx
  "行 {0}": "Row {0}",
  "Iteration なし": "No Iteration",
  "PR なし": "No PR",
  "ラベル{0}{1}": "Labels{0}{1}",
  " ・ ": " · ",
  "ほか {0} 件": "{0} more",
  // components/inline-edit.tsx
  "{0}を変える": "Change {0}",
  押して変える: "Click to change",
  // components/iteration-next.tsx
  "全件が終わっています。リリースできます": "All tickets are finished. Ready to release",
  "終了日を過ぎ、未完了が {0} 件あります。持ち越しを相談できます":
    "Past the end date with {0} unfinished. You can discuss carrying them over",
  "ほかに active がなければ、最初のチケットを着手（claim）すると active になります":
    "If no other Iteration is active, claiming the first ticket makes this active",
  "持ち越し {0} 件": "{0} carried over",
  "：{0}": ": {0}",
  "{0}済み": "{0}",
  完了: "Done",
  中止: "Abandoned",
  "（持ち越し先はコミットすると出ます）": " (destinations appear after committing)",
  "エージェントに頼む依頼文をコピーする（書き込みはしない）":
    "Copy a request for an agent (writes nothing)",
  依頼文をコピー: "Copy request",
  // components/iteration-parts.tsx
  "残り {0} 日": "{0}d left",
  今日まで: "Ends today",
  "{0} 日超過": "{0}d overdue",
  期間: "Period",
  目標: "Goal",
  進捗: "Progress",
  "完了 {0} ・ 持ち越し {1}": "Done {0} · Carried over {1}",
  // components/iteration-plans.tsx
  "{0} の詳細を開く": "Open details of {0}",
  // components/onboarding.tsx
  "1. 初期化する": "1. Initialize the repository",
  "このリポジトリにチケットを置く場所を作ります。ターミナルで実行します。":
    "Create a place for tickets in this repository. Run it in a terminal.",
  "2. チケットを起こす": "2. Create a ticket",
  "やりたいことを 1 件のチケットにします。": "Turn what you want to do into a ticket.",
  'dg ticket create "最初のチケット"': 'dg ticket create "First ticket"',
  "3. エージェントに頼む": "3. Ask an agent",
  "Skill を入れると、エージェントが手順を読んでチケットを進めます。":
    "With the Skills installed, agents read the steps and work on tickets.",
  "deguboard を始める": "Get Started with deguboard",
  "このリポジトリはまだ deguboard を使っていません。{0} が PATH にあれば、次の順で始められます。コピーしてターミナルで実行してください。":
    "This repository does not use deguboard yet. If {0} is on your PATH, start with the steps below. Copy each command and run it in a terminal.",
  "{0} をコピー": "Copy {0}",
  "1 を済ませると、開き直さなくてもいつもの画面に変わります。":
    "After step 1, the usual view appears without reopening.",
  // components/parts.tsx
  上に並ぶ: "listed first",
  既定の並び: "default order",
  下に並ぶ: "listed last",
  "優先度 {0}（{1}）": "Priority {0} ({1})",
  チケットはない: "No tickets",
  "完了 ": "Done ",
  " ・ 進行中 {0}": " · In progress {0}",
  "Run が実行中": "A run is in progress",
  "着手済み（実行中の Run なし）": "Claimed (no run in progress)",
  該当するチケットはない: "No matching tickets",
  タイトル: "Title",
  優先度: "Priority",
  ラベル: "Labels",
  // components/plan-band.tsx
  実行計画: "Plans",
  "実行計画 {0}": "Plans {0}",
  "閉じた計画 {0}": "Closed plans {0}",
  "Plan の帯 {0}": "Plan band {0}",
  "{0} の依存グラフ": "Dependency graph of {0}",
  "承認 {0}": "Approved by {0}",
  作業中: "Working",
  人の承認を待っている: "Awaiting human approval",
  次: "Next",
  待ち: "Waiting",
  "{0}{1}待ち終わり": "{0}{1}wait done",
  "{0}{1}待ち中": "{0}{1}waiting",
  "depends_on 待ち終わり": "depends_on wait done",
  "depends_on 待ち中": "depends_on waiting",
  // components/plan-graph.ts
  進行中: "Active",
  承認待ち: "Awaiting approval",
  承認済み: "Approved",
  閉じた: "Closed",
  // components/row-end.tsx
  "{0}{1} 待ち": "Waiting on {0}{1}",
  "このマシンで Run が実行中": "A run is in progress on this machine",
  実行中: "Running",
  "開いた Plan に入っていない": "Not in an open Plan",
  "{0} は人の承認を待っている": "{0} is awaiting human approval",
  着手可: "Ready",
  "{0} を待っている": "Waiting on {0}",
  // components/run-parts.tsx
  成功: "Success",
  失敗: "Failure",
  中断: "Interrupted",
  未完了: "Unfinished",
  "{0}：{1}": "{0}: {1}",
  "{0}時間 {1}分": "{0}h {1}m",
  "{0}分 {1}秒": "{0}m {1}s",
  "{0}秒": "{0}s",
  // components/ticket-fields.tsx
  未設定: "Not set",
  // components/ticket-props-panel.tsx（属性の名前）
  カンマ区切り: "Comma-separated",
  依存先: "Depends on",
  依存元: "Dependents",
  担当: "Assignee",
  "eiki か eiki/agent": "eiki or eiki/agent",
  ブランチ: "Branch",
  起票者: "Created by",
  作成: "Created",
  更新: "Updated",
  // components/ticket-props-panel.tsx
  計画: "Planning",
  つながり: "Relations",
  作業: "Work",
  記録: "Records",
  "＋足す": "+ Add",
  値を入れる属性: "Attribute to set",
  属性を選ぶ: "Choose an attribute",
  // components/ticket-props.tsx
  ブランチ名をコピー: "Copy branch name",
  不明: "Unknown",
  // components/ticket-runs.tsx
  "Run はない": "No runs",
  結果: "Result",
  トークン: "Tokens",
  終了: "Ended",
  "（推定を含む）": " (includes estimates)",
  "{0} 件": "{0} items",
  "トークン（入力 / 出力）{0}": "Tokens (input / output){0}",
  "。値が取れなかった Run が {0} 件あり、合計に入れていない":
    ". {0} runs had no value and are not in the total",
  "再試行 {0}": "Retries {0}",
  "入力 {0} / 出力 {1} / cache read {2} / cache write{3}{4}{5}":
    "Input {0} / Output {1} / cache read {2} / cache write{3}{4}{5}",
  // components/timeline.tsx
  "{0} {1} に入れた": "Added to {0} {1}",
  "{0} {1} から外した": "Removed from {0} {1}",
  "担当: {0}": "Assignee: {0}",
  担当を外した: "Assignee removed",
  "PR を外した": "Removed PR",
  消した: "Removed",
  起票: "Created",
  経過: "Timeline",
  "履歴が浅い clone なので、これより前の経過は欠けている":
    "This is a shallow clone, so earlier history is missing",
  "経過はない（まだコミットされていない）": "No timeline yet (not committed)",
  // components/worktree-row.tsx
  "worktree のパスをコピー": "Copy worktree path",
  // host.tsx
  "navigator.clipboard が使えない": "navigator.clipboard is not available",
  // markdown.tsx
  "済 {0} / 全 {1}": "{0} of {1} done",
  "（本文なし）": "(No description)",
  "受け入れ条件 {0}": "Acceptance criterion {0}",
  未済に戻す: "Mark as not done",
  済みにする: "Mark as done",
  // pages/backlog.tsx
  "担当 自分": "Assignee: me",
  "優先度 {0}": "Priority {0}",
  "ラベル {0}": "Label {0}",
  "担当 {0}": "Assignee {0}",
  担当なし: "Assignee: none",
  自分: "Mine",
  "自分か自分の agent の担当": "me or my agent as assignee",
  "優先度 high": "Priority high",
  すべて: "All",
  "優先度{0}": "Priority{0}",
  "ラベル{0}": "Label{0}",
  "担当{0}": "Assignee{0}",
  絞り込みを消す: "Clear filters",
  "番号・タイトル・ラベルで検索": "Search by ID, title, or label",
  検索: "Search",
  "Status・優先度・ラベル・担当で絞り込む": "Filter by status, priority, label, or assignee",
  "全 {0} 件のうち {1} 件": "{1} of {0} items",
  "{0} / {1} 件": "{0} / {1} items",
  "{0} の絞り込みを外す": "Remove filter {0}",
  "{0} で絞る": "Filter by {0}",
  詳細: "Details",
  "区画の見出し {0}": "Section heading {0}",
  "Epic で絞る": "Filter by Epic",
  "Epic をあと {0} 本出す": "Show {0} more Epics",
  "Epic を畳む": "Collapse Epics",
  絞り込みを外す: "Remove filter",
  "Epic のないチケットで絞る": "Filter by tickets without an Epic",
  "Epic なし{0}": "No Epic{0}",
  "{0} {1} で絞る": "Filter by {0} {1}",
  "Epic なし": "No Epic",
  // pages/board.tsx
  "開いた Iteration（planned・active）はない": "No open Iterations (planned or active)",
  "チケットは {0} で見る": "See tickets in {0}",
  "planned・active のすべて": "All planned and active",
  "開いた Iteration はない": "No open Iterations",
  "Iteration の見出し {0}": "Iteration heading {0}",
  "Epic・担当で絞り込む": "Filter by Epic or assignee",
  "すべて（planned と active の Iteration）": "All (planned and active Iterations)",
  "すべて{0}{1}": "All{0}{1}",
  "\n期間 {0} 〜 {1}": "\nPeriod {0} – {1}",
  "\n目標 {0}": "\nGoal {0}",
  "{0} {1}（{2}）{3}{4}": "{0} {1} ({2}){3}{4}",
  "Epic {0} の絞り込みを外す": "Remove filter Epic {0}",
  "担当 {0} の絞り込みを外す": "Remove filter assignee {0}",
  "状態の節 {0}": "Status section {0}",
  // pages/config.tsx
  "コミットと push": "Commit and Push",
  エージェント: "Agents",
  計測: "Metrics",
  通知: "Notifications",
  チケット: "Tickets",
  その他: "Other",
  コミットの仕方: "Commit mode",
  "push の仕方": "Push mode",
  "シェルの Action を許す": "Allow shell Actions",
  テストのコマンド: "Test command",
  "PR を自動でマージする": "Merge PRs automatically",
  "--auto で自動で選ぶ判断": "Decisions --auto chooses automatically",
  流れから外す段階: "Stages to leave out of the flow",
  マージの方法: "Merge method",
  マージしたら作業ブランチを消す: "Delete the work branch after merging",
  "Iteration に入れてから進める": "Require an Iteration before starting",
  重いとみなす見直しの指摘の種類: "Review finding categories treated as heavy",
  "段階 light のモデル": "Model for tier light",
  "段階 standard のモデル": "Model for tier standard",
  "段階 heavy のモデル": "Model for tier heavy",
  人だけに許すコマンド: "Commands limited to people",
  会話記録から使用量を読む: "Read usage from transcripts",
  承認待ちが増えたら通知する: "Notify when approvals are waiting",
  同期先のリモート: "Remote to sync with",
  基準のブランチ: "Base branch",
  "worktree の置き場所": "Worktree location",
  "既定の Project": "Default Project",
  "優先度 high の判断基準": "Criteria for priority high",
  "優先度 medium の判断基準": "Criteria for priority medium",
  "優先度 low の判断基準": "Criteria for priority low",
  ガイドの差し込み: "Guide notes",
  "差し込む文書（概要）": "Document inserted into overview",
  "差し込む文書（起票）": "Document inserted into import",
  "差し込む文書（割り当て）": "Document inserted into assign",
  "差し込む文書（点検）": "Document inserted into check",
  "差し込む文書（計画）": "Document inserted into plan",
  "差し込む文書（作業）": "Document inserted into work",
  "差し込む文書（Run）": "Document inserted into run",
  "差し込む文書（並べて進める）": "Document inserted into parallel",
  "差し込む文書（見直しと品質ゲート）": "Document inserted into review and quality gate",
  "差し込む文書（見直し）": "Document inserted into audit",
  "差し込む文書（リリース）": "Document inserted into release",
  "差し込む文書（完了）": "Document inserted into done",
  "差し込む文書（一気通し）": "Document inserted into all",
  同期先が変わる: "changes where data is synced",
  マージ済みの判定の基準が変わる: "changes the base for detecting merges",
  作業場所が変わる: "changes where work happens",
  "テストとして確認なしで実行するコマンドが変わる（シェルを許すのと同じ）":
    "changes the command run as tests without confirmation (same as allowing a shell)",
  エージェントが任意のシェルを実行できるかが変わる:
    "changes whether agents can run any shell command",
  エージェントに許す操作が変わる: "changes what agents are allowed to do",
  "エージェントが PR を自動でマージするかが変わる":
    "changes whether agents merge PRs automatically",
  エージェントが聞かずに選ぶ判断が変わる: "changes which decisions agents make without asking",
  空: "Empty",
  "{0} を {1} にした": "Set {0} to {1}",
  "（{0}）": " ({0})",
  "{0} の自分の値を外した（チームの {1} を使う）":
    "Removed your value for {0} (using the team's {1})",
  "{0} を自分だけ {1} にした": "Set {0} to {1} for yourself only",
  "保存できない: {0}{1}": "Could not save: {0}{1}",
  "保存したが、読み直せない: {0}{1}": "Saved, but could not reload: {0}{1}",
  前の画面に戻る: "Back to the previous view",
  設定の書き先: "Where settings are saved",
  チーム: "Team",
  "自分で上書きしている項目 {0} 件": "{0} settings overridden by you",
  チーム全員に効く設定: "Settings shared by the whole team",
  "deguboard ブランチの {0} に保存し、push すると同じリポジトリを使う全員に効く。自分だけ変えたい項目は「自分」のタブで上書きする":
    'Saved to {0} on the deguboard branch. Once pushed, it applies to everyone using this repository. To change a setting only for yourself, override it on the "Mine" tab',
  自分だけに効く設定: "Settings that apply only to you",
  "Git に入らない {0} に保存し、コミットも push もしない。上書きできる項目だけを出し、使わない項目はチームの値が効く":
    "Saved to {0}, which is not in Git, and never committed or pushed. Only settings you can override are shown; the rest use the team's values",
  "設定を検索（名前・キー・説明）": "Search settings (name, key, description)",
  設定を検索: "Search settings",
  "保存した: {0}": "Saved: {0}",
  "設定を読めない: {0}": "Could not read settings: {0}",
  該当する設定がない: "No matching settings",
  "既定は {0}": "Default: {0}",
  変更あり: "Modified",
  "自分の値で上書きしている。押すと「自分」のタブで開く":
    'You override this with your own value. Click to open it on the "Mine" tab',
  "自分：{0}": "Mine: {0}",
  "保存中…": "Saving…",
  "既定の {0} に戻す": "Reset to default {0}",
  既定に戻す: "Reset to Default",
  "（既定）": " (default)",
  有効: "On",
  無効: "Off",
  項目: "Items",
  項目を足す: "Add item",
  足す: "Add",
  "チーム：{0}": "Team: {0}",
  自分の値を使う: "Use my own value",
  チームの値を使っている: "Using the team's value",
  "{0} の保存の確認": "Confirm saving {0}",
  "{0} を {1} にする。{2}。チーム全員に効く。保存する？":
    "Set {0} to {1}. This {2}. It applies to the whole team. Save?",
  "{0} を空にし、既定の {1} に戻す。{2}。チーム全員に効く。保存する？":
    "Clear {0} and go back to the default {1}. This {2}. It applies to the whole team. Save?",
  "{0} の自分の値を外し、チームの {1} に戻す。{2}。自分だけに効く。保存する？":
    "Remove your value for {0} and go back to the team's {1}. This {2}. It applies only to you. Save?",
  "{0} を {1} にする。{2}。自分だけに効く。保存する？":
    "Set {0} to {1}. This {2}. It applies only to you. Save?",
  保存する: "Save",
  やめる: "Cancel",
  // pages/epics.tsx
  "タイトル {0}": "Title {0}",
  "この Epic でカンバンを見る": "View this Epic on the board",
  // pages/history.tsx
  "中止 {0}": "Abandoned {0}",
  "持ち越し {0}": "Carried over {0}",
  見方: "View by",
  チケットを探す: "Find tickets",
  "閉じた Epic はない": "No closed Epics",
  "閉じた Iteration はない": "No closed Iterations",
  "当たる Epic はない": "No matching Epics",
  "当たる Iteration はない": "No matching Iterations",
  "すべて {0} 件": "All {0} items",
  "当たった {0} / {1} 件": "Matched {0} / {1} items",
  当たったものだけ: "Matches only",
  すべて見る: "Show all",
  目標なし: "No goal",
  完了と持ち越しは閉じたときに記録した件数: "Done and carried-over counts were recorded at closing",
  終わったチケットはない: "No finished tickets",
  "今は{0}{1}": "Now in{0}{1}",
  "今は Iteration なし": "Now in no Iteration",
  "完了と中止は今の Epic のチケットから数えた件数":
    "Done and abandoned counts come from the Epic's current tickets",
  "{0} ・ ": "{0} · ",
  終わったチケットなし: "No finished tickets",
  チケットなし: "No tickets",
  "履歴が浅いか欠けているので、終えた日の分からないチケットは更新日（updated_at）で並べている（日付に ~ を付けた）":
    "History is shallow or incomplete, so tickets with an unknown finish date are sorted by updated_at (dates marked with ~)",
  "終えた時刻を読み込み中…（それまでは更新日の順）":
    "Loading finish times… (sorted by update date until then)",
  当たるチケットはない: "No matching tickets",
  履歴から分からないので更新日: "Update date (not found in history)",
  終えた日時: "Finished at",
  // pages/iterations.tsx
  "この Iteration でカンバンを見る": "View this Iteration on the board",
  // pages/plans.tsx
  " 実行計画": " Plan",
  進み: "Progress",
  承認: "Approval",
  承認の記録はない: "No approval recorded",
  "{0} 待ち": "Waiting on {0}",
  依存グラフ: "Dependency graph",
  範囲: "Scope",
  進め方: "Approach",
  // pages/ticket.tsx
  "Workflow {0} を読めない": "Could not read Workflow {0}",
  保存: "Save",
  取り消し: "Cancel",
  タイトルと本文を編集: "Edit title and description",
  編集: "Edit",
  "依存先が終わっていない：{0}": "Dependencies not finished: {0}",
  本文: "Description",
  // send-target.ts
  "選んでいたターミナルが閉じたので、{0} に切り替えました":
    "The selected terminal was closed, so switched to {0}",
  "✓ {0} の入力に送りました。内容を確かめて Enter を押してください":
    "✓ Sent to {0}'s input. Check it and press Enter",
  "。クリップボードを通して貼り付けました": ". Pasted via the clipboard",
  "✓ {0} に送りました（貼り付けの確認が出たら選んでください）{1}。内容を確かめて Enter を押してください":
    "✓ Sent to {0} (choose an option if a paste confirmation appears){1}. Check it and press Enter",
  // store.tsx
  "StoreProvider の中で使う": "Use inside StoreProvider",
  // types.ts
  予定: "Planned",
};

/**
 * core が返す決まった文（エージェントに頼むの候補の名前・Plan の承認の状態）の訳（trCore）。文の中の ID は {0} にした形を鍵にする。
 * 同じ文が頼むことによって意味の違うものは「頼むこと:文」の鍵で分ける
 */
export const CORE_EN: Readonly<Record<string, string>> = {
  "起票して {0} に入れる": "Create tickets in {0}",
  続きを起票する: "Create follow-up tickets",
  "起票して {0} に足す": "Create tickets in {0}",
  "不具合・続きを起票する": "Create bug or follow-up tickets",
  起票し直す: "Recreate tickets",
  起票する: "Create tickets",
  "Iteration を作る": "Create Iteration",
  "Epic を作る": "Create Epic",
  直す: "Fix",
  分ける: "Split",
  "{0} から外す": "Remove from {0}",
  "Iteration・Epic": "Iteration/Epic",
  "名前・目標・期間を直す": "Edit name, goal, and period",
  "題・概要を直す": "Edit title and summary",
  持ち越しを割り当てる: "Assign carried-over tickets",
  "チケットを足す・外す": "Add or remove tickets",
  割り当てる: "Assign",
  組み直す: "Replan",
  計画を立てる: "Plan",
  承認する: "Approve",
  "Plan を進める": "Run Plan",
  進める: "Work on",
  最後まで進める: "Run to completion",
  確かめて片付ける: "Verify and wrap up",
  待ちを確かめる: "Check what it's waiting on",
  点検する: "Check",
  リリースする: "Release",
  持ち越しを相談する: "Discuss carrying over",
  "done を取り消す": "Undo done",
  様子を聞く: "Ask for status",
  振り返る: "Retrospect",
  自由に: "Free-form",
  "reopen:再開する": "Reopen",
  "resume:再開する": "Resume",
  "abandon:やめる": "Abandon",
  "close:閉じる": "Close",
  承認待ち: "Awaiting approval",
  承認済み: "Approved",
  閉じた: "Closed",
};

/**
 * 数が 1 のときの英語の形（単数）。鍵は EN と同じで、arg は数を入れる引数の番号。
 * tr・trNode は、英語でその引数が 1 のときにこちらを使う（日本語は数で形を変えない）
 */
export const EN_ONE: Readonly<Record<string, { arg: number; text: string }>> = {
  "{0} 件": { arg: 0, text: "{0} item" },
  "自分で上書きしている項目 {0} 件": { arg: 0, text: "{0} setting overridden by you" },
  "{0} / {1} 件": { arg: 1, text: "{0} / {1} item" },
  "全 {0} 件のうち {1} 件": { arg: 0, text: "{1} of {0} item" },
  "すべて {0} 件": { arg: 0, text: "All {0} item" },
  "当たった {0} / {1} 件": { arg: 1, text: "Matched {0} / {1} item" },
  "。値が取れなかった Run が {0} 件あり、合計に入れていない": {
    arg: 0,
    text: ". {0} run had no value and is not in the total",
  },
  "Epic をあと {0} 本出す": { arg: 0, text: "Show {0} more Epic" },
  "終了日を過ぎ、未完了が {0} 件あります。持ち越しを相談できます": {
    arg: 0,
    text: "Past the end date with {0} unfinished. You can discuss carrying it over",
  },
};

/**
 * 優先度の判断基準の既定のままの値の訳（core の config の既定。UI-11）。書き換えた値は訳さない。
 * 日本語の既定と意味を揃える（dg guide import の優先度の判断基準と同じ内容）。l10n.test.ts が 3 つの値の揃いを確かめる
 */
export const PRIORITY_CRITERIA_EN: Readonly<Record<"high" | "medium" | "low", string>> = {
  high: "User-visible bugs, documents that mislead users, exploitable vulnerabilities, license omissions, failing checks, and anything blocking other tickets",
  medium:
    "New features and improvements, missing or unstable tests, inconsistencies in internal docs, convention violations that do no harm yet, and dependencies that are far out of date",
  low: "Unused code and dependencies, duplicated settings, inconsistent wording, and investigation and study that are not urgent",
};

/**
 * 設定画面の項目の説明（core の configSchema の describe）の訳。鍵は項目のキー（config.show の fields の key）。
 * core の項目と過不足なく揃うことと、core の説明が変わったら訳を見直すよう知らせることは l10n.test.ts が確かめる
 */
export const CONFIG_DESCRIPTIONS_EN: Readonly<Record<string, string>> = {
  default_project: "Project used when none is given",
  "git.remote": "Git remote that deguboard fetches from and pushes to",
  "git.base_branch": "Base for work branches and for deciding what is merged",
  "worktree.root": "Where work worktrees go. A path relative to the repository",
  "commit.mode":
    "each: commit on every write / batch: leave changes in the working tree; dg commit, dg sync, and immediate operations commit them together / manual: only dg commit and immediate operations",
  "push.mode":
    "auto: push on every commit / manual: dg sync pushes (immediate operations push even in manual)",
  "metrics.read_transcripts":
    "Whether run finish and run refresh read conversation transcripts through the Adapter to fill in usage. Machines with DEGUBOARD_NO_TRANSCRIPTS never read them, even when true (MT-2)",
  "notify.approvals":
    "Whether the VS Code extension shows a notification when Plans awaiting approval or tickets in review increase (the count is always shown)",
  "actions.shell":
    "Whether to allow the arbitrary shell Action (shell). Even when allowed, each run asks for confirmation (AG-7)",
  "actions.test":
    "Argument array of the command the test Action (run_tests) runs (e.g. [mise, run, check]). When empty, run_tests is rejected",
  "auto.merge":
    "Whether dg guide all --auto merges PRs that pass the quality gate (dg gate --for merge) automatically. By default a person merges",
  "auto.decisions":
    "Decisions --auto chooses without asking (assign: assignment / check: the fix line when only one fix fits / plan: Plan approval / audit: the review findings table / accept: confirming acceptance criteria after reconciling). Decisions a person makes cannot be added; PR merging is set by auto.merge",
  "flow.skip":
    "Stages that dg flow next never returns (assign, check, plan, work, audit, release). A skipped stage's rule is not read; the flow moves to the next rule",
  "merge.method":
    "Merge method dg pr merge uses when --method is omitted (squash, merge, or rebase)",
  "merge.delete_branch":
    "Whether dg pr merge also deletes the remote and local work branch when --delete-branch is omitted",
  "review.heavy_categories":
    "Review finding categories (run review-result --findings-file) treated as heavy regardless of severity. Empty by default, so the reviewer's severity is kept",
  "lint.require_iteration":
    "Whether dg lint flags tickets that moved past todo or abandoned without being in an Iteration (except done tickets in closed Epics). dg guide work asks to add the ticket to an Iteration before claim",
  "models.light":
    "Model for Plan tier light (docs, settings, and wording only) and for research within implementation. When empty, the parent's model",
  "models.standard":
    "Model for Plan tier standard (anything that is not light or heavy). When empty, the parent's model",
  "models.heavy":
    "Model for Plan tier heavy (design decisions, data shapes, multiple packages, bugs of unknown cause). When empty, the parent's model",
  "actor.human_only":
    "Command names rejected for agents (such as epic.close). Empty by default, allowing everything. Ticket transitions are restricted with the Workflow's by",
  "priority.high":
    "Criteria for priority high. Used when creating and reviewing tickets, and by the priority marks and selection hints on screen",
  "priority.medium":
    "Criteria for priority medium (the default). Used when creating and reviewing tickets, and by the priority marks and selection hints on screen",
  "priority.low":
    "Criteria for priority low. Used when creating and reviewing tickets, and by the priority marks and selection hints on screen",
  "guide.notes.overview":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.import":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.assign":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.check":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.plan":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.work":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.run":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.parallel":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.review":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.audit":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.release":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.done":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  "guide.notes.all":
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
};

/**
 * core が返すエラー・警告の決まった文の訳（trCoreMessage）。鍵は core の文の可変の部分（ID・項目名・値）を {0}・{1} にした形。
 * 設定の保存の拒否・Plan と Run の警告・読めないファイルの理由を置く。表にない文は core の文のまま出す。
 * 鍵の {0} 以外の部分が core のソースにあることは l10n.test.ts が確かめる（core の文言が変われば気づく）
 */
export const CORE_MESSAGES_EN: Readonly<Record<string, string>> = {
  // 設定の保存の拒否（config.set・config.unset）
  "key が空": "key is empty",
  "{0} は個人の設定に書けない": "{0} cannot be set in personal settings",
  "チーム専用の項目。--local を外してチームの config.yaml を変える":
    "This item is team-only. Drop --local and change the team's config.yaml",
  "スキーマにない項目。上書きできる項目：{0}": "Not in the schema. Items you can override: {0}",
  "{0} の値が正しくない": "Invalid value for {0}",
  "値を省けない。選択肢：{0}": "A value is required. Options: {0}",
  "actor.human_only にないコマンドがある: {0}": "actor.human_only has unknown commands: {0}",
  "config の更新がスキーマに合わない": "The config update does not match the schema",
  個人の設定に書けない項目: "Items that cannot be set in personal settings",
  // Plan の警告（plan.show）
  "{0} が見つからない（削除された）": "{0} not found (deleted)",
  // Run の警告（run.list・metrics.show）
  "deguboard-local/{0}: {1}": "deguboard-local/{0}: {1}",
  "チケット {0} が見つからないので、その Run の Epic・Iteration・Project は分からない":
    "Ticket(s) {0} not found, so the Epic, Iteration, and Project of their Runs are unknown",
  // 読めないファイルの理由（readDoc）
  ファイルを読めない: "Cannot read the file",
  "JSON を読めない": "Cannot parse JSON",
  "JSON のオブジェクトでない": "Not a JSON object",
  "先頭に frontmatter（---）がない": "No frontmatter (---) at the top",
  "frontmatter を閉じる --- がない": "No closing --- for the frontmatter",
  "YAML を読めない": "Cannot parse YAML",
  スキーマに合わない: "Does not match the schema",
  "ファイル名の ID {0} と中の id {1} が違う":
    "The ID {0} in the file name differs from the id {1} inside",
};
