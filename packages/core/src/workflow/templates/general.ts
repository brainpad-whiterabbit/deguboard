import type { WorkflowDefinitionInput } from "../../model/workflow.js";

/** 汎用。照合はブランチの有無とマージだけ */
export const general: WorkflowDefinitionInput = {
  id: "general",
  name: "General",
  transitions: [],
  reconcile: [
    { when: ["branch_merged"], status: "done" },
    { when: ["branch_exists"], status: "in_progress" },
  ],
  fields: [],
  // Run の step の語彙。順や分岐は書かない（手順は dg guide が持つ。WF-5）
  steps: [
    // 計画を立てる親が、チケットを 1 枚ずつ調べて Plan の範囲・方針を書くまで、依頼文の前の調べ直しも（ADR-005）
    { id: "investigate", label: "Investigate" },
    { id: "implement", label: "Implement", actions: ["create_worktree", "create_branch"] },
    { id: "review", label: "Review" },
    // 見直しの指摘を受けた手直しは実装と分けて数える（ADR-005）
    { id: "fix", label: "Fix" },
  ],
};
