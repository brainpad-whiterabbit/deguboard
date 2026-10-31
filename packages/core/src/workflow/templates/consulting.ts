import type { WorkflowDefinitionInput } from "../../model/workflow.js";

/** コンサルティング。PR はなく、成果物のブランチがマージされると done */
export const consulting: WorkflowDefinitionInput = {
  id: "consulting",
  name: "Consulting",
  labels: { in_progress: "Working", review: "Client Review" },
  transitions: [{ from: "review", to: "done", by: ["human"] }],
  reconcile: [
    { when: ["branch_merged"], status: "done" },
    { when: ["branch_exists"], status: "in_progress" },
  ],
  fields: [
    { id: "client", type: "string", label: "Client" },
    { id: "deliverable", type: "string", label: "Deliverable" },
  ],
};
