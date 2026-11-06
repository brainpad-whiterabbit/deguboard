import type { WorkflowDefinitionInput } from "../../model/workflow.js";

/**
 * コンサルティング。PR はなく、成果物のブランチがマージされると done。
 * 成果物の承認を人に限るなら review → done に `by: [human]` を足す
 */
export const consulting: WorkflowDefinitionInput = {
  id: "consulting",
  name: "Consulting",
  labels: { in_progress: "Working", review: "Client Review" },
  transitions: [],
  reconcile: [
    { when: ["branch_merged"], status: "done" },
    { when: ["branch_exists"], status: "in_progress" },
  ],
  fields: [
    { id: "client", type: "string", label: "Client" },
    { id: "deliverable", type: "string", label: "Deliverable" },
  ],
  // Run の step の語彙。順や分岐は書かない（手順は dg guide が持つ。WF-5）
  steps: [
    { id: "research", label: "Research" },
    { id: "analyze", label: "Analyze" },
    // 成果物を書く step。agent の ticket claim がこの Run を開く（RN-5。implement はないので付けないと開けない）
    {
      id: "draft",
      label: "Draft",
      actions: ["create_worktree", "create_branch"],
      opens_on: "claim",
    },
    { id: "review", label: "Review" },
  ],
};
