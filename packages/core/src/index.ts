export * from "./errors.js";
export * from "./model/index.js";
export * from "./workflow/index.js";
export * from "./storage/index.js";
export * from "./git/index.js";
export * from "./commands/index.js";
// actions はライブラリとして core の中で使い、公開しない（AG-6）
export * from "./run/index.js";
// agents は Run の使用量と ask の中で使い、公開は Skill の有無を見る先を cli のテストが引く agentSkillDirs と、
// 速い経路のフックの読み方が同じものかを cli のテストが比べる hooksOf だけにする
// （AG-5。dg skill install が書く先と dg hooks install が書くフックは core の commands/skill-files.ts・hook-settings.ts が引く）
export { agentSkillDirs, hooksOf } from "./agents/index.js";
export type { AgentEnv, SkillDirs, SkillQuery } from "./agents/index.js";
// guide の本文と読み込みは Core に置く（CL-5）。公開は本文を組む composeGuide と、dg guide（CLI）が写す読み込みだけにする
export {
  composeGuide,
  fillPlaceholders,
  readGuide,
  readGuideMeta,
  readGuideNotes,
} from "./guide/guide.js";
export type { GuideMeta, GuideNotes, GuideText } from "./guide/guide.js";
export { GUIDE_TOPICS, type GuideTopic } from "./guide/topics.js";
// 束ねた CLI（VS Code 拡張に同梱する dg.mjs）の入口が、import.meta.url から引けない場所を置く
export { bundleLayout, setBundleLayout, type BundleLayout } from "./bundle-layout.js";
// シェルに渡す引数を囲む処理は 1 つにし、VS Code 拡張がターミナルに入れる 1 行もこれで囲む
export { shellQuote } from "./shell-quote.js";
