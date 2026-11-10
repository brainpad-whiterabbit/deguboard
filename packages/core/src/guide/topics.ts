// guide のトピックの一覧。guide の読み込み（guide.ts）と config の guide.notes（model/config.ts）がここを読む。
// model が guide の読み込み（fs・yaml）に依存しないよう、一覧だけを依存のないこのファイルに置く

/**
 * 流れの順に並べる。change・discuss・status は流れの外で、change は人が頼んだ 1 つの書き換え（直す・閉じる・再開・やめる・done の取り消し）を受け、
 * discuss は人と論点を決めてから、その結論の反映を import・change に任せる。status は進んでいる作業の様子を読むだけで、データを書き換えない。
 * frontmatter に description を持つトピックは dg<トピック> の Skill として配る（AG-2）。overview・run・parallel・review は Skill を持たず、ほかのトピックから読む
 */
export const GUIDE_TOPICS = [
  "overview",
  "import",
  "assign",
  "check",
  "plan",
  "work",
  "run",
  "parallel",
  "review",
  "audit",
  "release",
  "done",
  "change",
  "discuss",
  "status",
  "all",
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];
