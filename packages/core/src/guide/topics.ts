// guide のトピックの一覧。guide の読み込み（guide.ts）と config の guide.notes（model/config.ts）がここを読む。
// model が guide の読み込み（fs・yaml）に依存しないよう、一覧だけを依存のないこのファイルに置く

/** 流れの順に並べる。frontmatter に description を持つトピックは dg<トピック> の Skill として配る（AG-2）。overview・run・parallel・review は Skill を持たず、ほかのトピックから読む */
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
  "all",
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];
