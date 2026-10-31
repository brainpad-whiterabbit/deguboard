// 読めないファイルや定義の誤りの報告単位。止めずに集め、dg validate と画面で出す（DT-1）

export type IssueSeverity = "error" | "warning";

export interface Issue {
  severity: IssueSeverity;
  /** 機械が読む種類（schema_error など） */
  code: string;
  /** worktree からの相対パス */
  path: string;
  /** 関係する ID（分かるとき） */
  id?: string;
  message: string;
  detail?: string;
}

export function formatIssue(issue: Issue): string {
  const head = `${issue.severity === "error" ? "エラー" : "警告"} ${issue.path}${issue.id ? ` (${issue.id})` : ""}: ${issue.message}`;
  return issue.detail ? `${head}\n${indent(issue.detail)}` : head;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}
