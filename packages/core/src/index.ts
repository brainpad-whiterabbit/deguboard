export * from "./errors.js";
export * from "./model/index.js";
export * from "./workflow/index.js";
export * from "./storage/index.js";
export * from "./git/index.js";
export * from "./commands/index.js";
// actions はライブラリとして core の中で使い、公開は入口が Workflow の steps を検証する ACTION_NAMES だけにする（AG-6、ADR-007）
export { ACTION_NAMES } from "./actions/index.js";
export * from "./run/index.js";
// agents は Run の使用量と ask の中で使い、公開は dg skill install が書く先を引く skillDirsOf と agentSkillDirs、
// dg hooks install が書くフックを引く hooksOf と hookAgentNames だけにする（AG-5、ADR-007）
export { agentSkillDirs, hookAgentNames, hooksOf, skillDirsOf } from "./agents/index.js";
export type { AgentEnv, HookSupport, SkillDirs, SkillQuery } from "./agents/index.js";
// guide の本文と読み込みは Core に置く（ADR-030）。公開は dg guide（CLI）が写す読み込みと、節の本文を引く関数だけにする
export {
  fillPlaceholders,
  GUIDE_TOPICS,
  guideSectionText,
  readGuide,
  readGuideMeta,
} from "./guide/guide.js";
export type { GuideMeta, GuideTopic } from "./guide/guide.js";
