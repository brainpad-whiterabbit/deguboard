// コマンド定義の入口。一覧は registry.ts、プロセス内の CommandClient は local.ts

export * from "./registry.js";
export * from "./define.js";
export * from "./context.js";
export * from "./filters.js";
export * from "./setup.js";
export * from "./ticket.js";
export * from "./iteration.js";
export * from "./epic.js";
export * from "./plan.js";
export * from "./history.js";
export * from "./metrics.js";
export * from "./retro.js";
export * from "./workflow.js";
export * from "./run.js";
export * from "./ask.js";
export * from "./local.js";
export { hookArgv } from "./hook-argv.js";
// 照合と別のセッションの残りが Run を閉じるときに error に書く文（画面の訳の表がこの文を鍵にする）。決める関数は公開しない
export {
  RECONCILE_TAKEN_ERROR,
  RECONCILE_TODO_ERROR,
  STALE_SESSION_ERROR,
} from "./run-close-judge.js";
// dg hooks install・uninstall・check の判定と書き込み（CLI が写す）。入口が呼ぶものだけを公開する
export {
  checkHooks,
  hookScope,
  installHooks,
  uninstallHooks,
  type HandlerStatus,
} from "./hook-settings.js";
// dg setup check の判定（CLI が写し、VS Code 拡張も呼ぶ）と、チェックリストの dg init の 1 行。入口が使うものだけを公開する
export {
  checkSetup,
  initCommandLine,
  type BoardState,
  type SetupCheckItem,
  type SetupCheckResult,
} from "./setup-check.js";
// 起動ファイル経由で動いているか（フックとマージドライバが書く命令を決める）と、起動ファイルの場所（VS Code 拡張の launcher.ts と揃っているかをテストが見る）
export { isLauncherPath, launcherFrom } from "./launcher-env.js";
// Skill は入口が呼ぶものだけを公開する（dg skill install・uninstall の判定と書き込みと警告（CLI が写す）・VS Code 拡張の起動時の更新と足りない Skill の案内）。判定の部品は公開しない
export {
  buildSkills,
  findMissingSkills,
  installMissingSkills,
  installSkill,
  refreshInstalledSkills,
  skillInstallWarnings,
  skillUninstallWarnings,
  uninstallSkill,
  type MissingSkills,
  type RefreshedSkills,
  type SkillFile,
  type SkillInstallResult,
  type SkillUninstallResult,
} from "./skill-files.js";
// dg uninstall の判定と消す処理（CLI が写す。VS Code 拡張は dryRun の結果を読む）
export {
  uninstall,
  type UninstallBlocker,
  type UninstallItem,
  type UninstallKept,
  type UninstallResult,
} from "./uninstall.js";
export type {
  CommandClient,
  CommandFailure,
  SetupAction,
  SetupBoardSource,
  SetupView,
  SetupViewItem,
  StatusView,
  WebviewEvent,
  WebviewRequest,
  TerminalChoice,
  TerminalSendResult,
  UninstallPreview,
  WebviewResponse,
} from "./client.js";
export {
  SETUP_ACTIONS,
  WEBVIEW_CONTRACT,
  detailOfRoute,
  detailRouteOf,
  setupViewOf,
  uninstallRouteOf,
} from "./client.js";
