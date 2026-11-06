// Workflow 定義の形（workflows/<id>.yaml。requirements.md 5.8）。
// ここは YAML の形だけを検証し、意味（条件や Action が既知か、同じ遷移や step の重複）は workflow/validate.ts が検査する。

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

const FIELD_TYPES = ["string", "number", "boolean", "date", "enum"] as const;

// 条件は形だけ見る（未知の名前は validate.ts が WF-3 の指摘にする）
const conditionShape = z.string().regex(/^!?[a-z_]+$/, "条件は事実の名前か !事実の名前");

/** step の名前。Run の step（空白・改行を含まない 1 語）に書ける小文字の語 */
const stepIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/, "step は小文字の英数字と _ と -");

/**
 * step の Run を開くチケットの操作（RN-5）。claim は todo のチケットの claim（実装）、
 * reclaim は自分が claim 済みで PR のあるチケットのもう一度の claim（見直しの修正ループと人のレビューの後の手直し）
 */
export const STEP_OPENERS = ["claim", "reclaim"] as const;
export type StepOpener = (typeof STEP_OPENERS)[number];

// Action は名前（文字列）だけで持つ。登録済みかは actions の一覧を外から渡して validate.ts が見る（ADR-007）
const actionNameShape = z.string().regex(/^[a-z][a-z0-9_]*$/, "Action の名前は snake_case");

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
        // 省略なら誰でも、[] ならその遷移を禁止
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
  // 省略なら Run の step を縛らない（steps のない既存の YAML。DT-2）。手続き（順や分岐）は書かない（WF-5）
  steps: z
    .array(
      z.looseObject({
        id: stepIdSchema,
        label: z.string().optional(),
        /** この step で使える Action の名前。Action を実行する主体は、ここにない Action を実行しない */
        actions: z.array(actionNameShape).default([]),
        /** 人の承認が要る step か。Action を実行する主体が runAction の前に確認を取る。今は記録だけで強制しない（ADR-003） */
        approval: z.boolean().default(false),
        /** この step の Run を開くチケットの操作（RN-5）。claim なら agent の ticket claim、reclaim ならもう一度の claim が開く。同じ操作は 1 つの step にだけ付ける（validate.ts） */
        opens_on: z.enum(STEP_OPENERS).optional(),
      }),
    )
    .min(1, "steps を書くなら 1 つ以上。縛らないなら steps ごと省く")
    .optional(),
});
export type WorkflowDefinition = z.output<typeof workflowDefinitionSchema>;
/** YAML や テンプレートに書く形（既定値を省ける） */
export type WorkflowDefinitionInput = z.input<typeof workflowDefinitionSchema>;
export type FieldDefinition = WorkflowDefinition["fields"][number];
export type StepDefinition = NonNullable<WorkflowDefinition["steps"]>[number];
