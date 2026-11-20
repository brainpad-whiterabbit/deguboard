// 振る舞いのテストが頼る Workflow の値（t1145）。Core の既定（src/workflow/resolve.ts）を変えても、既定を確かめるテストのほかは
// 落ちないように、雛形のカンバン（commands-context.ts の initialized）と、Workflow を引数に取る関数のテストはこの値を使う。
// 既定そのものを確かめるテストだけが DEFAULT_WORKFLOW・defaultWorkflowFile を読む

import {
  workflowDefinitionSchema,
  type WorkflowDefinitionInput,
} from "../../src/model/workflow.js";
import { resolveWorkflow, type ResolvedWorkflow } from "../../src/workflow/resolve.js";
import { parseYamlValue } from "../../src/storage/yaml.js";

/** テストの土台の workflow.yaml。どの項目も値を書く（省いた項目が Core の既定に落ちないように） */
export const TEST_WORKFLOW_FILE = {
  states: {
    todo: { label: "Todo" },
    in_progress: { label: "In Progress" },
    review: { label: "Review" },
    done: { label: "Done" },
    abandoned: { label: "Abandoned" },
  },
  boundaries: [
    { from: "todo", to: "in_progress", requires: ["deps_done"], decide: "ask_unless_auto" },
    { from: "in_progress", to: "review", requires: [], decide: "anyone" },
    { from: "review", to: "done", requires: ["pr_merged"], decide: "ask_unless_auto" },
  ],
  exceptions: { abandon: "always_ask", back: "anyone", reopen: "always_ask" },
  wip: { in_progress: 5, review: 3 },
  flow: {
    assign: "always_ask",
    check: "ask_unless_auto",
    plan: "ask_unless_auto",
    audit: "always_ask",
    release: "always_ask",
    retro: "always_ask",
    skip: [],
  },
  governance: {
    delete: "human_only",
    config: "always_ask",
    reassign: "always_ask",
    epic: "always_ask",
    create: "always_ask",
    labels: "always_ask",
  },
} satisfies WorkflowDefinitionInput;

/** TEST_WORKFLOW_FILE を読んだ Workflow（Workflow を引数に取る関数のテストに渡す） */
export const TEST_WORKFLOW: ResolvedWorkflow = resolveWorkflow(
  workflowDefinitionSchema.parse(TEST_WORKFLOW_FILE),
);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * テストが書いた定義を、土台の値に重ねた定義にする（workflow set に渡す・workflow.yaml に置く）。重ね方は Core が省いた値を補うのと同じ
 * （states・exceptions・flow・governance は書いた鍵だけ、boundaries は from と to が合う境目だけ、wip は項目ごと替える。
 * states の中の label のように、もう 1 段深い鍵は重ねない）。
 * テストが書いていない値が Core の既定に落ちないようにするためで、書いた値（誤った値・知らない鍵も）はそのまま残す
 */
export function overTestWorkflow(value: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = TEST_WORKFLOW_FILE;
  const out: Record<string, unknown> = { ...base };
  for (const [key, written] of Object.entries(value)) {
    if (key === "boundaries" && Array.isArray(written)) {
      const rest = [...(written as unknown[])];
      const merged = TEST_WORKFLOW_FILE.boundaries.map((b) => {
        const at = rest.findIndex((w) => isRecord(w) && w["from"] === b.from && w["to"] === b.to);
        // 書いた境目は requires ごと替わり（省けば条件なし）、decide だけが省くと土台の値になる
        return at < 0
          ? b
          : { decide: b.decide, ...(rest.splice(at, 1)[0] as Record<string, unknown>) };
      });
      out[key] = [...merged, ...rest];
    } else if (key !== "wip" && key !== "boundaries" && isRecord(written) && isRecord(base[key]))
      out[key] = { ...(base[key] as Record<string, unknown>), ...written };
    else out[key] = written;
  }
  return out;
}

/** workflow.yaml の行を overTestWorkflow で重ねる。YAML として読めない行と、項目の並びでない行は undefined（書いたままを置く） */
export function linesOverTestWorkflow(
  lines: readonly string[],
): Record<string, unknown> | undefined {
  const { value, errors } = parseYamlValue(lines.join("\n"));
  return errors.length > 0 || !isRecord(value) ? undefined : overTestWorkflow(value);
}
