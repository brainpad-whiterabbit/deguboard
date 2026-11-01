import { describe, expect, it } from "vitest";
import { ACTORS } from "../model/workflow.js";
import { STATUSES } from "../model/common.js";
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
  it("既定ではどの Status 間の遷移も、誰でも条件なしで通る", () => {
    const wf = validateWorkflow(base, "x.yaml").workflow!;
    expect(wf.transitions).toEqual([]);
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to) continue;
        for (const actor of ACTORS) {
          expect(canTransition(wf, from, to, actor, {}), `${from} → ${to} by ${actor}`).toEqual({
            ok: true,
          });
        }
      }
    }
  });

  it("todo → in_progress に requires: [deps_done] を書けば、依存が終わるまで拒否される", () => {
    const wf = validateWorkflow(
      { ...base, transitions: [{ from: "todo", to: "in_progress", requires: ["deps_done"] }] },
      "x.yaml",
    ).workflow!;
    expect(canTransition(wf, "todo", "in_progress", "agent", { deps_done: false })).toMatchObject({
      ok: false,
      reason: "requires_unmet",
      unmet: ["deps_done"],
    });
    expect(canTransition(wf, "todo", "in_progress", "agent", {}).ok).toBe(false);
    expect(canTransition(wf, "todo", "in_progress", "agent", { deps_done: true }).ok).toBe(true);
    // 制約を書いていない遷移は影響を受けない
    expect(canTransition(wf, "todo", "done", "agent", {}).ok).toBe(true);
  });

  it("by で主体を絞り、by: [] で遷移を禁止できる", () => {
    const wf = validateWorkflow(
      {
        ...base,
        transitions: [
          { from: "in_progress", to: "abandoned", by: ["human"] },
          { from: "done", to: "todo", by: [] },
        ],
      },
      "x.yaml",
    ).workflow!;
    expect(canTransition(wf, "in_progress", "abandoned", "agent", {})).toMatchObject({
      ok: false,
      reason: "actor_not_allowed",
    });
    expect(canTransition(wf, "in_progress", "abandoned", "human", {}).ok).toBe(true);
    for (const actor of ACTORS) {
      expect(canTransition(wf, "done", "todo", actor, {})).toMatchObject({
        ok: false,
        reason: "actor_not_allowed",
      });
    }
  });

  it("1 つの遷移に by と requires を同時に書け、同じ遷移が重複すれば requires は和・by は積で合成する", () => {
    const wf = resolveWorkflow(
      validateWorkflow(
        {
          ...base,
          transitions: [
            { from: "review", to: "done", requires: ["branch_merged"], by: ["human", "reconcile"] },
            { from: "review", to: "done", requires: ["pr_merged"], by: ["human", "agent"] },
          ],
        },
        "x.yaml",
      ).definition!,
    );
    expect(wf.transitions).toEqual([
      { from: "review", to: "done", by: ["human"], requires: ["branch_merged", "pr_merged"] },
    ]);
    expect(canTransition(wf, "review", "done", "reconcile", { branch_merged: true })).toMatchObject(
      {
        ok: false,
        reason: "actor_not_allowed",
      },
    );
    expect(canTransition(wf, "review", "done", "human", { branch_merged: true })).toMatchObject({
      ok: false,
      reason: "requires_unmet",
      unmet: ["pr_merged"],
    });
    expect(
      canTransition(wf, "review", "done", "human", { branch_merged: true, pr_merged: true }).ok,
    ).toBe(true);
  });
});

describe("定義の検証（WF-3）", () => {
  it("未知の条件・同じ遷移の重複・同じ Status への遷移を指摘し、by はどの遷移にも書ける", () => {
    const { issues } = validateWorkflow(
      {
        ...base,
        transitions: [
          { from: "todo", to: "done" },
          { from: "review", to: "done", by: ["agent"] },
          { from: "todo", to: "in_progress", requires: ["tests_pass"] },
          { from: "review", to: "done", requires: ["branch_merged"] },
          { from: "todo", to: "todo" },
        ],
        reconcile: [{ when: ["!nope"], status: "done" }],
        labels: { review: "レビュー" },
      },
      "x.yaml",
    );
    expect(issues.map((i) => i.code).sort()).toEqual([
      "workflow_condition_unknown",
      "workflow_condition_unknown",
      "workflow_transition_duplicate",
      "workflow_transition_self",
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
      // 同梱テンプレートは遷移を縛らない
      expect(workflow?.transitions, t.id).toEqual([]);
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

  it("general では in_progress のままマージされても照合で done に進む（レビューを経ない作業）", () => {
    const general = validateWorkflow(WORKFLOW_TEMPLATES[2]!, "general.yaml").workflow!;
    expect(
      reconcileStatus(general, "in_progress", { branch_exists: false, branch_merged: true }),
    ).toMatchObject({
      kind: "advance",
      to: "done",
    });
    // consulting も遷移を縛らないので、review からマージの照合で done に進む
    const consulting = validateWorkflow(WORKFLOW_TEMPLATES[1]!, "consulting.yaml").workflow!;
    expect(reconcileStatus(consulting, "review", { branch_merged: true })).toMatchObject({
      kind: "advance",
      to: "done",
    });
  });

  it("squash マージ（pr_merged だけが真でブランチは消えた）でも review → done に進む", () => {
    expect(
      reconcileStatus(sd, "review", {
        branch_exists: false,
        branch_merged: false,
        pr_merged: true,
        pr_open: false,
      }),
    ).toMatchObject({
      kind: "advance",
      to: "done",
    });
  });

  it("in_progress から PR が開いていれば review に進み、draft なら進まない", () => {
    expect(
      reconcileStatus(sd, "in_progress", { branch_exists: true, pr_open: true, pr_draft: false }),
    ).toMatchObject({ kind: "advance", to: "review" });
    expect(
      reconcileStatus(sd, "in_progress", { branch_exists: true, pr_open: true }),
    ).toMatchObject({ kind: "none" });
  });

  it("制約がなくても照合は前進だけで、done・abandoned は動かさず、手前を指す規則では書き換えない", () => {
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
    // PR がまだないだけなら閉じた PR ではない
    expect(
      regressionWarnings(
        "review",
        { branch_exists: true, pr_open: false, pr_merged: false },
        { prMissing: true },
      ),
    ).toEqual([]);
    expect(regressionWarnings("done", { branch_exists: false })).toEqual([]);
  });

  it("前進でも Workflow が reconcile に許さなければ blocked になる", () => {
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
