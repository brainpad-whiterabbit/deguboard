// Workflow の形（カンバンに 1 つの workflow.yaml。requirements.md 5.8、ADR-003）。
// ここは YAML の形だけを検証し、意味（事実・境目・段階が既知か、重複）は workflow/validate.ts が検査する。
// どの項目も省け、省いた項目は Core の既定（workflow/resolve.ts）になる

import { z } from "zod";
import { statusSchema } from "./common.js";

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

/** 権限の値（境目の decide と exceptions・flow・governance の値）。形と検査だけで、判定にはまだ使わない */
export const DECISIONS = [
  "human_only",
  "always_ask",
  "ask_unless_auto",
  "anyone",
  "agent_only",
] as const;
export type Decision = (typeof DECISIONS)[number];
const decisionSchema = z.enum(DECISIONS);

/** 境目：前へ進む隣どうしの 3 つ。増やせない */
export const BOUNDARIES = [
  { from: "todo", to: "in_progress" },
  { from: "in_progress", to: "review" },
  { from: "review", to: "done" },
] as const;

/** 流れの外の動き。abandon はどこからでも abandoned へ、back は前の Status へ戻す、reopen は done を戻す */
export const EXCEPTION_MOVES = ["abandon", "back", "reopen"] as const;
export type ExceptionMove = (typeof EXCEPTION_MOVES)[number];

/** 権限の値を持つ流れの段階 */
export const FLOW_DECIDED_STAGES = [
  "assign",
  "check",
  "plan",
  "audit",
  "release",
  "retro",
] as const;
export type FlowDecidedStage = (typeof FLOW_DECIDED_STAGES)[number];
/** 同梱の流れの段階。独自の段階の after と skip に書ける（work は権限の値を持たない） */
export const FLOW_BUNDLED_STAGES = [
  "assign",
  "check",
  "plan",
  "work",
  "audit",
  "release",
  "retro",
] as const;
/** flow の中で段階の名前でない鍵 */
export const FLOW_SKIP_KEY = "skip";

/** カンバンの管理の操作 */
export const GOVERNANCE_OPERATIONS = ["delete", "config", "reassign", "epic", "create"] as const;
export type GovernanceOperation = (typeof GOVERNANCE_OPERATIONS)[number];

const FIELD_TYPES = ["string", "number", "boolean", "date", "enum"] as const;

// 条件は形だけ見る（未知の名前は validate.ts が WF-3 の指摘にする）
const conditionShape = z.string().regex(/^!?[a-z_]+$/, "A condition is a fact name or !fact-name");

/** 独自の段階。after は同梱の段階、guide は手順の文書のリポジトリの中のパス */
const customStageSchema = z.strictObject({
  decide: decisionSchema,
  after: z.enum(FLOW_BUNDLED_STAGES),
  guide: z.string().min(1),
});
export type CustomStageDefinition = z.output<typeof customStageSchema>;

// 最上位は looseObject：未知の項目は validate.ts が警告にする（新しい版の dg が足した項目で、古い版の遷移と照合を止めない）。
// 項目の中は strictObject と enum で、未知の鍵と値を誤りにする
export const workflowDefinitionSchema = z.looseObject({
  // 鍵が 5 つの Status かは validate.ts が見る（増やした Status を、形の誤りでなく名指しで指摘する）
  states: z.record(z.string(), z.strictObject({ label: z.string().min(1).optional() })).optional(),
  boundaries: z
    .array(
      z.strictObject({
        from: statusSchema,
        to: statusSchema,
        // 省略なら条件なし
        requires: z.array(conditionShape).default([]),
        // 省略ならその境目の Core の既定
        decide: decisionSchema.optional(),
      }),
    )
    .optional(),
  exceptions: z
    .strictObject({ abandon: decisionSchema, back: decisionSchema, reopen: decisionSchema })
    .partial()
    .optional(),
  // 省略なら Core の既定。書けば書いた列だけに上限が付く
  wip: z.partialRecord(statusSchema, z.int().positive()).optional(),
  // 段階の名前 → 権限の値（同梱の段階）か独自の段階。skip は流れから外す段階のリスト
  flow: z
    .record(z.string(), z.union([decisionSchema, customStageSchema, z.array(z.string())]))
    .optional(),
  governance: z
    .strictObject({
      delete: decisionSchema,
      config: decisionSchema,
      reassign: decisionSchema,
      epic: decisionSchema,
      create: decisionSchema,
    })
    .partial()
    .optional(),
  // 以下の 3 つは前の形のまま読む。transitions は境目の判定（boundaries・exceptions）、reconcile は Core の固定のきっかけ、
  // fields はチケットの任意フィールドの廃止に、それぞれ後の変更で置き換わる
  transitions: z
    .array(
      z.strictObject({
        from: statusSchema,
        to: statusSchema,
        requires: z.array(conditionShape).default([]),
        // 省略なら誰でも、[] ならその遷移を禁止
        by: z.array(z.enum(ACTORS)).optional(),
      }),
    )
    .default([]),
  // 省略なら Core の既定の規則（workflow/resolve.ts の DEFAULT_RECONCILE）
  reconcile: z
    .array(z.strictObject({ when: z.array(conditionShape).min(1), status: statusSchema }))
    .optional(),
  fields: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9_]*$/, "A field ID is lowercase letters, digits and _"),
        type: z.enum(FIELD_TYPES),
        label: z.string().optional(),
        options: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});
/** 読める項目の名前。ここにない最上位の鍵は未知の項目 */
export const WORKFLOW_ITEMS = Object.keys(workflowDefinitionSchema.shape);
export type WorkflowDefinition = z.output<typeof workflowDefinitionSchema>;
/** YAML に書く形（どの項目も省ける） */
export type WorkflowDefinitionInput = z.input<typeof workflowDefinitionSchema>;
export type FieldDefinition = WorkflowDefinition["fields"][number];
