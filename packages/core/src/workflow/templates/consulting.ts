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
};
