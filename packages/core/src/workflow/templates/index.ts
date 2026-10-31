// 同梱する Workflow のテンプレート（WF-4）。dg init --template でコピーする

import type { WorkflowDefinitionInput } from "../../model/workflow.js";
import { consulting } from "./consulting.js";
import { general } from "./general.js";
import { softwareDevelopment } from "./software-development.js";

export const WORKFLOW_TEMPLATES: readonly WorkflowDefinitionInput[] = [
  softwareDevelopment,
  consulting,
  general,
];

export function findWorkflowTemplate(id: string): WorkflowDefinitionInput | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
