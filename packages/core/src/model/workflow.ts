// Workflow 定義の形（workflows/<id>.yaml。requirements.md 5.8）。
// ここは YAML の形だけを検証し、意味（遷移表にあるか、条件が既知か）は workflow/validate.ts が検査する。

import { z } from "zod";
import { slugSchema, statusSchema } from "./common.js";

/** 条件に書ける組み込みの事実（WF-2） */
export const FACT_NAMES = [
  "deps_done",
  "branch_exists",
  "branch_pushed",
  "branch_merged",
  "pr_open",
  "pr_draft",
  "pr_merged",
] as const;
export type FactName = (typeof FACT_NAMES)[number];
export type Condition = FactName | `!${FactName}`;

/** 遷移を行える主体 */
export const ACTORS = ["human", "agent", "reconcile"] as const;
export type Actor = (typeof ACTORS)[number];

export const FIELD_TYPES = ["string", "number", "boolean", "date", "enum"] as const;

// 条件は形だけ見る（未知の名前は validate.ts が WF-3 の指摘にする）
const conditionShape = z.string().regex(/^!?[a-z_]+$/, "条件は事実の名前か !事実の名前");

export const workflowDefinitionSchema = z.looseObject({
  id: slugSchema,
  name: z.string().min(1),
  labels: z.partialRecord(statusSchema, z.string()).optional(),
  transitions: z
    .array(
      z.looseObject({
        from: statusSchema,
        to: statusSchema,
        requires: z.array(conditionShape).default([]),
        by: z.array(z.enum(ACTORS)).optional(),
      }),
    )
    .default([]),
  reconcile: z
    .array(z.looseObject({ when: z.array(conditionShape).min(1), status: statusSchema }))
    .default([]),
  fields: z
    .array(
      z.looseObject({
        id: z.string().regex(/^[a-z][a-z0-9_]*$/, "フィールド ID は小文字の英数字と _"),
        type: z.enum(FIELD_TYPES),
        label: z.string().optional(),
        options: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});
export type WorkflowDefinition = z.output<typeof workflowDefinitionSchema>;
export type FieldDefinition = WorkflowDefinition["fields"][number];
