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
};
