// 日時の文字列。依存を持たない（PreToolUse の速い経路が zod を読まずに使う。t768）

/** 現在時刻を ISO 8601（UTC、ミリ秒なし）で返す */
export function toIsoDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
