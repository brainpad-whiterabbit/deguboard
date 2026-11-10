// 同梱する Workflow のテンプレート（WF-4）。dg init がすべて置き、dg workflow set --template で置き換えに使う

import type { WorkflowDefinitionInput } from "../../model/workflow.js";
import { general } from "./general.js";
import { softwareDevelopment } from "./software-development.js";

export const WORKFLOW_TEMPLATES: readonly WorkflowDefinitionInput[] = [
  softwareDevelopment,
  general,
];

export function findWorkflowTemplate(id: string): WorkflowDefinitionInput | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
