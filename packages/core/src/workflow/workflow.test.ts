import { describe, expect, it } from "vitest";
import { ACTORS, WORKFLOW_ITEMS } from "../model/workflow.js";
import { STATUSES } from "../model/common.js";
import { evaluateCondition, parseCondition } from "./conditions.js";
import { reconcileStatus, regressionWarnings } from "./reconcile.js";
import {
  canTransition,
  DEFAULT_WORKFLOW,
  defaultWorkflowFile,
  resolveWorkflow,
  writtenForm,
} from "./resolve.js";
import { validateWorkflow } from "./validate.js";

// どの項目も省いた定義
const base = {};
/** 定義の指摘の [code, severity] */
const found = (raw: unknown) =>
  validateWorkflow(raw, "workflow.yaml").issues.map((i) => [i.code, i.severity]);

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
      { transitions: [{ from: "todo", to: "in_progress", requires: ["deps_done"] }] },
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

describe("省いた項目の既定", () => {
  it("どの項目も省いた定義は指摘なしで読め、Core の既定になる", () => {
    const { issues, workflow } = validateWorkflow({}, "workflow.yaml");
    expect(issues).toEqual([]);
    expect(workflow).toEqual(DEFAULT_WORKFLOW);
    expect(workflow).toMatchObject({
      labels: {
        todo: "Todo",
        in_progress: "In Progress",
        review: "Review",
        done: "Done",
        abandoned: "Abandoned",
      },
      boundaries: [
        { from: "todo", to: "in_progress", requires: ["deps_done"], decide: "anyone" },
        { from: "in_progress", to: "review", requires: [], decide: "anyone" },
        { from: "review", to: "done", requires: ["pr_merged"], decide: "ask_unless_auto" },
      ],
      exceptions: { abandon: "human_only", back: "anyone", reopen: "human_only" },
      wip: { in_progress: 5, review: 3 },
      flow: {
        stages: {
          assign: "ask_unless_auto",
          check: "ask_unless_auto",
          plan: "ask_unless_auto",
          audit: "always_ask",
          release: "human_only",
          retro: "always_ask",
        },
        custom: [],
        skip: [],
      },
      governance: {
        delete: "human_only",
        config: "always_ask",
        reassign: "always_ask",
        epic: "human_only",
        create: "anyone",
      },
      transitions: [],
    });
    expect(workflow).not.toHaveProperty("fields");
  });

  it("前の版の fields（チケットの任意フィールド）は未知の項目として警告にとどめ、読まずにほかの項目を使う", () => {
    const { issues, workflow } = validateWorkflow(
      { states: { done: { label: "Shipped" } }, fields: [{ id: "estimate", type: "number" }] },
      "workflow.yaml",
    );
    expect(issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "workflow_item_unknown",
        message: "Unknown item fields. It is not read",
      }),
    ]);
    expect(workflow?.labels.done).toBe("Shipped");
    expect(workflow).not.toHaveProperty("fields");
  });

  it("6 つの項目のどれを 1 つだけ省いても、省いた項目は dg init が置く既定の workflow.yaml と同じ値になる", () => {
    const bundled = defaultWorkflowFile() as Record<string, unknown>;
    const items = ["states", "boundaries", "exceptions", "wip", "flow", "governance"];
    expect(Object.keys(bundled)).toEqual(items);
    // 同梱の既定そのものも Core の既定と同じ Workflow になる
    expect(validateWorkflow(bundled, "workflow.yaml")).toMatchObject({
      issues: [],
      workflow: DEFAULT_WORKFLOW,
    });
    for (const omitted of items) {
      const { [omitted]: _omitted, ...rest } = bundled;
      const { issues, workflow } = validateWorkflow(rest, "workflow.yaml");
      expect(issues, omitted).toEqual([]);
      expect(workflow, omitted).toEqual(DEFAULT_WORKFLOW);
    }
  });

  it("書いた鍵だけが替わり、同じ項目の書いていない鍵は既定のまま。wip は書いた列だけに上限が付く", () => {
    const { issues, workflow } = validateWorkflow(
      {
        states: { review: { label: "Client Review" } },
        boundaries: [{ from: "review", to: "done", requires: ["branch_merged"] }],
        exceptions: { abandon: "anyone" },
        wip: { review: 2 },
        flow: { release: "always_ask", skip: ["retro"] },
        governance: { create: "always_ask" },
      },
      "workflow.yaml",
    );
    expect(issues).toEqual([]);
    expect(workflow?.labels).toMatchObject({ review: "Client Review", todo: "Todo" });
    expect(workflow?.boundaries).toEqual([
      DEFAULT_WORKFLOW.boundaries[0],
      DEFAULT_WORKFLOW.boundaries[1],
      // decide を省いた境目は、その境目の既定の値
      { from: "review", to: "done", requires: ["branch_merged"], decide: "ask_unless_auto" },
    ]);
    expect(workflow?.exceptions).toEqual({
      abandon: "anyone",
      back: "anyone",
      reopen: "human_only",
    });
    expect(workflow?.wip).toEqual({ review: 2 });
    expect(workflow?.flow).toMatchObject({
      stages: { release: "always_ask", assign: "ask_unless_auto" },
      skip: ["retro"],
    });
    expect(workflow?.governance).toMatchObject({ create: "always_ask", delete: "human_only" });
  });

  it("補った Workflow を書く形に戻して読み直すと、同じ Workflow になる（workflow show の definition を workflow set に渡せる）", () => {
    const { workflow } = validateWorkflow(
      {
        states: { done: { label: "Shipped" } },
        flow: { "deploy-staging": { decide: "always_ask", after: "audit", guide: "docs/d.md" } },
        transitions: [{ from: "review", to: "done", by: ["human"] }],
        reconcile: [{ when: ["branch_merged"], status: "done" }],
      },
      "workflow.yaml",
    );
    const written = writtenForm(workflow!);
    expect(Object.keys(written)).toEqual(WORKFLOW_ITEMS);
    expect(validateWorkflow(written, "workflow.yaml")).toMatchObject({ issues: [], workflow });
  });
});

describe("定義の検証（WF-3）", () => {
  it("未知の条件・同じ遷移の重複・同じ Status への遷移を指摘し、by はどの遷移にも書ける", () => {
    const { issues } = validateWorkflow(
      {
        transitions: [
          { from: "todo", to: "done" },
          { from: "review", to: "done", by: ["agent"] },
          { from: "todo", to: "in_progress", requires: ["tests_pass"] },
          { from: "review", to: "done", requires: ["branch_merged"] },
          { from: "todo", to: "todo" },
        ],
        reconcile: [{ when: ["!nope"], status: "done" }],
        states: { review: { label: "レビュー" } },
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

  it("未知の項目は警告にとどめて残りを読む。前の形の id・name・labels・steps も未知の項目になる", () => {
    const { issues, workflow } = validateWorkflow(
      {
        id: "general",
        name: "General",
        labels: { review: "Old" },
        steps: [{ id: "implement" }],
        boundries: [],
        wip: { review: 1 },
      },
      "workflow.yaml",
    );
    expect(issues.map((i) => [i.code, i.severity, i.message])).toEqual(
      ["id", "name", "labels", "steps", "boundries"].map((key) => [
        "workflow_item_unknown",
        "warning",
        `Unknown item ${key}. It is not read`,
      ]),
    );
    // 前の形の labels は読まない（表示名は states の label）
    expect(workflow?.labels.review).toBe("Review");
    expect(workflow?.wip).toEqual({ review: 1 });
  });

  it("増やした Status は名指しでエラーになる", () => {
    const { issues } = validateWorkflow(
      { states: { qa: { label: "QA" }, review: { label: "R" } } },
      "workflow.yaml",
    );
    expect(issues.map((i) => [i.code, i.severity])).toEqual([["workflow_status_unknown", "error"]]);
    expect(issues[0]?.message).toContain("Status qa does not exist");
  });

  it("3 つの境目でない組・同じ境目の重複・未知の事実はエラーになる", () => {
    expect(
      found({
        boundaries: [
          { from: "todo", to: "review" },
          { from: "review", to: "in_progress" },
          { from: "todo", to: "in_progress", requires: ["tests_pass"] },
          { from: "todo", to: "in_progress" },
        ],
      }),
    ).toEqual([
      ["workflow_boundary_unknown", "error"],
      ["workflow_boundary_unknown", "error"],
      ["workflow_condition_unknown", "error"],
      ["workflow_boundary_duplicate", "error"],
    ]);
  });

  it("未知の値・項目の中の未知の鍵・形の違いは、形の誤りの 1 件になり Workflow を返さない", () => {
    for (const raw of [
      { boundaries: [{ from: "todo", to: "in_progress", decide: "everyone" }] },
      { boundaries: [{ from: "todo", to: "in_progress", trigger: "branch_exists" }] },
      { exceptions: { abandon: "nobody" } },
      { exceptions: { skip: "anyone" } },
      { exceptions: { abandon: { from: "todo", to: "abandoned" } } },
      { governance: { purge: "human_only" } },
      { governance: { delete: "sometimes" } },
      { wip: { in_progress: 0 } },
      { wip: { qa: 2 } },
      { states: { review: { name: "R" } } },
      { flow: { assign: "everyone" } },
      { flow: { deploy: { decide: "always_ask", after: "deploy-first", guide: "docs/d.md" } } },
      { flow: { deploy: { decide: "always_ask", after: "audit" } } },
      { states: [] },
    ]) {
      const { issues, workflow } = validateWorkflow(raw, "workflow.yaml");
      expect(workflow, JSON.stringify(raw)).toBeUndefined();
      expect(
        issues.map((i) => i.code),
        JSON.stringify(raw),
      ).toEqual(["workflow_schema"]);
    }
  });

  it("flow は同梱の段階の値・独自の段階（decide・after・guide）・skip を読み、未知の段階と skip の未知の名前をエラーにする", () => {
    const custom = { decide: "always_ask", after: "work", guide: "docs/flow/deploy.md" };
    const { issues, workflow } = validateWorkflow(
      {
        flow: { audit: "human_only", "deploy-staging": custom, skip: ["retro", "deploy-staging"] },
      },
      "workflow.yaml",
    );
    expect(issues).toEqual([]);
    expect(workflow?.flow.custom).toEqual([{ id: "deploy-staging", ...custom }]);
    expect(workflow?.flow.skip).toEqual(["retro", "deploy-staging"]);
    expect(workflow?.flow.stages.audit).toBe("human_only");

    // 独自の段階には decide・after・guide が要る（値だけでは同梱の段階の書き間違いと見分けられない）
    expect(found({ flow: { asign: "anyone" } })).toEqual([["workflow_flow_stage", "error"]]);
    // 同梱の段階に after・guide は書けない
    expect(found({ flow: { audit: custom } })).toEqual([["workflow_flow_stage", "error"]]);
    // work は権限の値を持たない
    expect(found({ flow: { work: "anyone" } })).toEqual([["workflow_flow_stage", "error"]]);
    expect(found({ flow: { Deploy_Staging: custom } })).toEqual([["workflow_flow_stage", "error"]]);
    expect(found({ flow: { skip: "retro" } })).toEqual([["workflow_schema", "error"]]);
    expect(found({ flow: { skip: ["nope"] } })).toEqual([["workflow_flow_skip", "error"]]);
    expect(found({ flow: { assign: ["retro"] } })).toEqual([["workflow_flow_stage", "error"]]);
  });
});

describe("照合", () => {
  // reconcile を省いた Workflow（Core の既定の規則）
  const sd = DEFAULT_WORKFLOW;

  it("不明な事実を偽と読み、branch_merged だけで review → done に進む", () => {
    expect(reconcileStatus(sd, "review", { branch_merged: true })).toMatchObject({
      kind: "advance",
      to: "done",
    });
    expect(reconcileStatus(sd, "review", { branch_exists: true })).toMatchObject({ kind: "none" });
  });

  it("in_progress のままマージされても照合で done に進む（レビューを経ない作業）", () => {
    expect(
      reconcileStatus(sd, "in_progress", { branch_exists: false, branch_merged: true }),
    ).toMatchObject({
      kind: "advance",
      to: "done",
    });
  });

  it("reconcile を書けば既定の規則の代わりにその規則だけで照合する", () => {
    const wf = validateWorkflow(
      { reconcile: [{ when: ["branch_exists"], status: "in_progress" }] },
      "x",
    ).workflow!;
    expect(reconcileStatus(wf, "todo", { branch_exists: true })).toMatchObject({
      kind: "advance",
      to: "in_progress",
    });
    expect(reconcileStatus(wf, "review", { pr_merged: true })).toEqual({ kind: "none" });
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
