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
// dg hooks install・uninstall・check の判定と書き込み（CLI が写す）と、フックが入っているかだけを見る hookInstallStateOf
export {
  checkHooks,
  hookInstallStateOf,
  hookScope,
  installHooks,
  uninstallHooks,
  type HandlerStatus,
  type HookInstallState,
} from "./hook-settings.js";
// 起動ファイル経由で動いているか（フックとマージドライバが書く命令を決める）と、起動ファイルの場所（VS Code 拡張の launcher.ts と揃っているかをテストが見る）
export { isLauncherPath, launcherFrom } from "./launcher-env.js";
// Skill は入口が呼ぶものだけを公開する（dg skill install・VS Code 拡張の起動時の更新と足りない Skill の案内）。判定の部品は公開しない
export {
  buildSkills,
  findMissingSkills,
  ignoreSkills,
  installMissingSkills,
  refreshInstalledSkills,
  removeRetiredSkills,
  writeSkillFiles,
  type MissingSkills,
  type RefreshedSkills,
  type SkillFile,
} from "./skill-files.js";
export type {
  CommandClient,
  CommandFailure,
  StatusView,
  WebviewEvent,
  WebviewRequest,
  TerminalChoice,
  TerminalSendResult,
  WebviewResponse,
} from "./client.js";
export { WEBVIEW_CONTRACT, detailOfRoute, detailRouteOf } from "./client.js";
