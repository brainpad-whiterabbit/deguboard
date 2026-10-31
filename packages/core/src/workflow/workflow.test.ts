import { describe, expect, it } from "vitest";
import { evaluateCondition, parseCondition } from "./conditions.js";
import { reconcileStatus, regressionWarnings } from "./reconcile.js";
import { canTransition, resolveWorkflow } from "./resolve.js";
import { WORKFLOW_TEMPLATES } from "./templates/index.js";
import { validateWorkflow } from "./validate.js";

const base = { id: "x", name: "X" };

describe("条件", () => {
  it("不明な事実は否定でも偽と読む", () => {
    expect(evaluateCondition("pr_draft", {})).toBe(false);
    expect(evaluateCondition("!pr_draft", {})).toBe(false);
    expect(evaluateCondition("!pr_draft", { pr_draft: false })).toBe(true);
    expect(parseCondition("!nope")).toBeUndefined();
  });
});

describe("遷移の検査", () => {
  it("todo → in_progress は依存が done でなければ拒否される", () => {
    const wf = validateWorkflow(base, "x.yaml").workflow!;
    expect(canTransition(wf, "todo", "in_progress", "agent", { deps_done: false }).ok).toBe(false);
    expect(canTransition(wf, "todo", "in_progress", "agent", {}).ok).toBe(false);
    expect(canTransition(wf, "todo", "in_progress", "agent", { deps_done: true }).ok).toBe(true);
  });

  it("表にない遷移と、人だけに許された遷移をエージェントが行うことは拒否される", () => {
    const wf = validateWorkflow(base, "x.yaml").workflow!;
    expect(canTransition(wf, "todo", "done", "human", {})).toMatchObject({
      ok: false,
      reason: "no_transition",
    });
    expect(canTransition(wf, "in_progress", "abandoned", "agent", {})).toMatchObject({
      ok: false,
      reason: "actor_not_allowed",
    });
    expect(canTransition(wf, "in_progress", "abandoned", "human", {}).ok).toBe(true);
  });

  it("Workflow は requires を足し、by を狭められる", () => {
    const wf = resolveWorkflow(
      validateWorkflow(
        {
          ...base,
          transitions: [{ from: "review", to: "done", requires: ["branch_merged"], by: ["human"] }],
        },
        "x.yaml",
      ).definition!,
    );
    expect(canTransition(wf, "review", "done", "reconcile", { branch_merged: true })).toMatchObject(
      {
        ok: false,
        reason: "actor_not_allowed",
      },
    );
    expect(canTransition(wf, "review", "done", "human", {})).toMatchObject({
      ok: false,
      reason: "requires_unmet",
    });
    expect(canTransition(wf, "review", "done", "human", { branch_merged: true }).ok).toBe(true);
  });
});

describe("定義の検証（WF-3）", () => {
  it("表にない遷移・by の拡大・未知の条件・存在しない Status を指摘する", () => {
    const { issues } = validateWorkflow(
      {
        ...base,
        transitions: [
          { from: "todo", to: "done" },
          { from: "review", to: "done", by: ["agent"] },
          { from: "todo", to: "in_progress", requires: ["tests_pass"] },
        ],
        reconcile: [{ when: ["!nope"], status: "done" }],
        labels: { review: "レビュー" },
      },
      "x.yaml",
    );
    expect(issues.map((i) => i.code).sort()).toEqual([
      "workflow_actor_widened",
      "workflow_condition_unknown",
      "workflow_condition_unknown",
      "workflow_transition_unknown",
    ]);
  });

  it("形が違えば 1 件のエラーになる", () => {
    const { issues, workflow } = validateWorkflow({ id: "x", labels: { nope: 1 } }, "x.yaml");
    expect(workflow).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("workflow_schema");
  });

  it("同梱テンプレート 3 つは検証を通る", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const { issues, workflow } = validateWorkflow(t, `${t.id}.yaml`);
      expect(issues, t.id).toEqual([]);
      expect(workflow?.labels.todo).toBe("Todo");
    }
  });
});

describe("照合", () => {
  const sd = validateWorkflow(WORKFLOW_TEMPLATES[0]!, "sd.yaml").workflow!;

  it("不明な事実を偽と読み、branch_merged だけで review → done に進む", () => {
    expect(reconcileStatus(sd, "review", { branch_merged: true })).toMatchObject({
      kind: "advance",
      to: "done",
    });
    expect(reconcileStatus(sd, "review", { branch_exists: true })).toMatchObject({ kind: "none" });
  });

  it("in_progress から PR が開いていれば review に進み、draft なら進まない", () => {
    expect(
      reconcileStatus(sd, "in_progress", { branch_exists: true, pr_open: true, pr_draft: false }),
    ).toMatchObject({ kind: "advance", to: "review" });
    expect(
      reconcileStatus(sd, "in_progress", { branch_exists: true, pr_open: true }),
    ).toMatchObject({ kind: "none" });
  });

  it("done・abandoned は動かさず、手前を指す規則では書き換えない", () => {
    expect(reconcileStatus(sd, "done", { branch_exists: true })).toEqual({ kind: "terminal" });
    expect(reconcileStatus(sd, "abandoned", { branch_merged: true })).toEqual({ kind: "terminal" });
    expect(reconcileStatus(sd, "review", { branch_exists: true, pr_open: false })).toEqual({
      kind: "none",
    });
  });

  it("消えたブランチと閉じた PR は警告だけ返す", () => {
    expect(regressionWarnings("in_progress", { branch_exists: false })).toHaveLength(1);
    expect(
      regressionWarnings("review", { branch_exists: true, pr_open: false, pr_merged: false }),
    ).toHaveLength(1);
    expect(regressionWarnings("review", { branch_exists: true })).toEqual([]);
    expect(regressionWarnings("done", { branch_exists: false })).toEqual([]);
  });

  it("前進でも遷移表が reconcile に許さなければ blocked になる", () => {
    const wf = validateWorkflow(
      {
        ...base,
        transitions: [{ from: "review", to: "done", by: ["human"] }],
        reconcile: [{ when: ["branch_merged"], status: "done" }],
      },
      "x",
    ).workflow!;
    expect(reconcileStatus(wf, "review", { branch_merged: true })).toMatchObject({
      kind: "blocked",
      to: "done",
    });
  });
});
