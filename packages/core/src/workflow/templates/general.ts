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
    { id: "investigate", label: "Investigate" },
    // agent の ticket claim が implement の Run を開く（RN-5）
    {
      id: "implement",
      label: "Implement",
      actions: ["create_worktree", "create_branch"],
      opens_on: "claim",
    },
    { id: "review", label: "Review" },
    // 見直しの指摘を受けた手直しは実装と分けて数える（ADR-005）。人のレビューの後の手直しはもう一度の claim が開く（RN-5）
    { id: "fix", label: "Fix", opens_on: "reclaim" },
  ],
};
