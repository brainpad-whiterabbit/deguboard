import { describe, expect, it } from "vitest";
import { ACTORS, BOUNDARIES, DECISIONS, WORKFLOW_ITEMS } from "../model/workflow.js";
import { STATUSES, type Status } from "../model/common.js";
import { evaluateCondition, judgeDecision, judgeDecisions, parseCondition } from "./conditions.js";
import { reconcileStatus, regressionWarnings } from "./reconcile.js";
import {
  crossedBoundaries,
  DEFAULT_WORKFLOW,
  defaultWorkflowFile,
  exceptionMoveOf,
  movePermissions,
  operationPolicy,
  writtenForm,
  type ResolvedWorkflow,
} from "./resolve.js";
import { validateWorkflow } from "./validate.js";

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

describe("権限の 5 つの値の判定（WF-1）", () => {
  it("値ごとに、人・エージェント（普段）・エージェント（聞かずに進める流れ）の結果が表のとおりになる", () => {
    const table = DECISIONS.map((d) => [
      d,
      judgeDecision(d, "human"),
      judgeDecision(d, "agent"),
      judgeDecision(d, "agent", true),
    ]);
    expect(table).toEqual([
      ["human_only", "allow", "reject", "reject"],
      ["always_ask", "allow", "approval", "approval"],
      ["ask_unless_auto", "allow", "approval", "allow"],
      ["anyone", "allow", "allow", "allow"],
      ["agent_only", "override", "allow", "allow"],
    ]);
  });

  it("照合はエージェントと同じ側に数え、聞かずに進める流れは人の結果を変えない", () => {
    for (const d of DECISIONS) {
      expect(judgeDecision(d, "reconcile"), d).toBe(judgeDecision(d, "agent"));
      expect(judgeDecision(d, "reconcile", true), d).toBe(judgeDecision(d, "agent", true));
      expect(judgeDecision(d, "human", true), d).toBe(judgeDecision(d, "human"));
    }
  });

  it("いくつかの値は、同じ主体に当てた厳しいほうの結果になる", () => {
    expect(judgeDecisions([], "agent")).toBe("allow");
    expect(judgeDecisions(["anyone", "always_ask"], "agent")).toBe("approval");
    expect(judgeDecisions(["always_ask", "human_only", "anyone"], "agent")).toBe("reject");
    expect(judgeDecisions(["anyone", "agent_only"], "human")).toBe("override");
    expect(judgeDecisions(["human_only", "agent_only"], "agent")).toBe("reject");
    expect(judgeDecisions(["ask_unless_auto", "always_ask"], "agent", true)).toBe("approval");
  });
});

describe("操作に当てる方針（operationPolicy）", () => {
  const move = (wf: ResolvedWorkflow, from: Status, to: Status) =>
    operationPolicy(wf, { command: "ticket.move", move: { from, to } });

  it("Status の動きは、abandoned へは abandon、終わった Status からは reopen、ほかの前へ進まない動きは back で、前へ進む動きは例外に当たらない", () => {
    const names = STATUSES.flatMap((from) =>
      STATUSES.filter((to) => to !== from).map((to) => [from, to, exceptionMoveOf(from, to)]),
    );
    expect(names).toEqual([
      ["todo", "in_progress", undefined],
      ["todo", "review", undefined],
      ["todo", "done", undefined],
      ["todo", "abandoned", "abandon"],
      ["in_progress", "todo", "back"],
      ["in_progress", "review", undefined],
      ["in_progress", "done", undefined],
      ["in_progress", "abandoned", "abandon"],
      ["review", "todo", "back"],
      ["review", "in_progress", "back"],
      ["review", "done", undefined],
      ["review", "abandoned", "abandon"],
      ["done", "todo", "reopen"],
      ["done", "in_progress", "reopen"],
      ["done", "review", "reopen"],
      ["done", "abandoned", "abandon"],
      ["abandoned", "todo", "reopen"],
      ["abandoned", "in_progress", "reopen"],
      ["abandoned", "review", "reopen"],
      ["abandoned", "done", "reopen"],
    ]);
    expect(exceptionMoveOf("review", "review")).toBeUndefined();
  });

  it("例外の動きは exceptions の値で、条件なしで決まる", () => {
    const wf = validateWorkflow(
      { exceptions: { abandon: "always_ask", back: "agent_only", reopen: "anyone" } },
      "x.yaml",
    ).workflow!;
    expect(move(wf, "review", "abandoned")).toEqual({
      source: "exceptions",
      name: "exceptions.abandon",
      decisions: ["always_ask"],
      requires: [],
    });
    expect(move(wf, "review", "todo")).toMatchObject({
      name: "exceptions.back",
      decisions: ["agent_only"],
    });
    expect(move(wf, "done", "review")).toMatchObject({
      name: "exceptions.reopen",
      decisions: ["anyone"],
    });
  });

  it("隣へ進む動きは、その境目の requires と decide で決まる", () => {
    expect(move(DEFAULT_WORKFLOW, "todo", "in_progress")).toEqual({
      source: "boundaries",
      name: "boundaries todo → in_progress",
      decisions: ["anyone"],
      requires: ["deps_done"],
    });
    expect(move(DEFAULT_WORKFLOW, "review", "done")).toMatchObject({
      decisions: ["ask_unless_auto"],
      requires: ["pr_merged"],
    });
  });

  it("境目を飛ばす動きは、間の境目をすべて越える：条件は和になり、値は並んで厳しいほうが効く", () => {
    const wf = validateWorkflow(
      {
        boundaries: [
          { from: "todo", to: "in_progress", requires: ["deps_done"], decide: "anyone" },
          { from: "in_progress", to: "review", requires: ["branch_pushed"], decide: "human_only" },
          {
            from: "review",
            to: "done",
            requires: ["pr_merged", "deps_done"],
            decide: "always_ask",
          },
        ],
      },
      "x.yaml",
    ).workflow!;
    expect(crossedBoundaries(wf, "in_progress", "done").map((b) => b.to)).toEqual([
      "review",
      "done",
    ]);
    expect(crossedBoundaries(wf, "review", "todo")).toEqual([]);
    const skipped = move(wf, "todo", "done");
    expect(skipped).toEqual({
      source: "boundaries",
      name: "boundaries todo → in_progress, in_progress → review, review → done",
      decisions: ["anyone", "human_only", "always_ask"],
      requires: ["deps_done", "branch_pushed", "pr_merged"],
    });
    // todo → in_progress だけなら聞かずにできるエージェントも、飛ばすと human_only の境目で拒否される
    expect(judgeDecisions(move(wf, "todo", "in_progress").decisions, "agent")).toBe("allow");
    expect(judgeDecisions(skipped.decisions, "agent")).toBe("reject");
    // in_progress を越えない動き（review → done）には、手前の human_only は効かない
    expect(judgeDecisions(move(wf, "review", "done").decisions, "agent")).toBe("approval");
  });

  it("Status を変えない操作は、どれにも当たらず誰でもできる（Core の固定・flow・governance に当たる操作はまだない）", () => {
    for (const command of ["ticket.create", "ticket.update", "iteration.close", "workflow.set"]) {
      const policy = operationPolicy(DEFAULT_WORKFLOW, { command });
      expect(policy, command).toEqual({
        source: "none",
        name: "none",
        decisions: ["anyone"],
        requires: [],
      });
      for (const actor of ACTORS)
        expect(judgeDecisions(policy.decisions, actor), `${command} ${actor}`).toBe("allow");
    }
  });

  it("exceptions は boundaries より先に見る：どの動きも、例外に当たれば境目の値を使わない", () => {
    const wf = validateWorkflow(
      {
        boundaries: BOUNDARIES.map((b) => ({
          ...b,
          requires: ["pr_merged"],
          decide: "human_only",
        })),
        exceptions: { abandon: "anyone", back: "anyone", reopen: "anyone" },
      },
      "x.yaml",
    ).workflow!;
    for (const m of movePermissions(wf)) {
      const exception = exceptionMoveOf(m.from, m.to);
      expect(m.policy, `${m.from} → ${m.to}`).toMatch(
        exception ? new RegExp(`^exceptions\\.${exception}$`) : /^boundaries /,
      );
      expect([m.from, m.to, m.agent, m.requires.length > 0]).toEqual([
        m.from,
        m.to,
        exception ? "allow" : "reject",
        !exception,
      ]);
    }
  });

  it("既定の Workflow の動きごとの権限（dg workflow show の moves）", () => {
    const rows = movePermissions(DEFAULT_WORKFLOW).map((m) => [
      `${m.from} → ${m.to}`,
      m.human,
      m.agent,
      m.requires.join(","),
    ]);
    expect(rows).toEqual([
      ["todo → in_progress", "allow", "allow", "deps_done"],
      ["todo → review", "allow", "allow", "deps_done"],
      ["todo → done", "allow", "approval", "deps_done,pr_merged"],
      ["todo → abandoned", "allow", "reject", ""],
      ["in_progress → todo", "allow", "allow", ""],
      ["in_progress → review", "allow", "allow", ""],
      ["in_progress → done", "allow", "approval", "pr_merged"],
      ["in_progress → abandoned", "allow", "reject", ""],
      ["review → todo", "allow", "allow", ""],
      ["review → in_progress", "allow", "allow", ""],
      ["review → done", "allow", "approval", "pr_merged"],
      ["review → abandoned", "allow", "reject", ""],
      ["done → todo", "allow", "reject", ""],
      ["done → in_progress", "allow", "reject", ""],
      ["done → review", "allow", "reject", ""],
      ["done → abandoned", "allow", "reject", ""],
      ["abandoned → todo", "allow", "reject", ""],
      ["abandoned → in_progress", "allow", "reject", ""],
      ["abandoned → review", "allow", "reject", ""],
      ["abandoned → done", "allow", "reject", ""],
    ]);
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
    });
    expect(workflow).not.toHaveProperty("fields");
    expect(workflow).not.toHaveProperty("transitions");
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
        boundaries: [{ from: "review", to: "done", decide: "human_only" }],
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
  it("reconcile の未知の条件を指摘する", () => {
    const { issues } = validateWorkflow(
      {
        reconcile: [{ when: ["!nope"], status: "done" }],
        states: { review: { label: "レビュー" } },
      },
      "x.yaml",
    );
    expect(issues.map((i) => i.code)).toEqual(["workflow_condition_unknown"]);
  });

  it("前の版の transitions は読まず、boundaries と exceptions に書くよう警告する。ほかの項目と既定の境目は使う", () => {
    const { issues, workflow } = validateWorkflow(
      {
        transitions: [{ from: "todo", to: "in_progress", requires: ["deps_done"], by: ["human"] }],
        wip: { review: 1 },
      },
      "workflow.yaml",
    );
    expect(issues.map((i) => [i.code, i.severity])).toEqual([["workflow_item_unknown", "warning"]]);
    expect(issues[0]?.message).toContain("transitions is no longer read");
    expect(issues[0]?.message).toContain("boundaries");
    expect(workflow).not.toHaveProperty("transitions");
    expect(workflow?.wip).toEqual({ review: 1 });
    expect(workflow?.boundaries).toEqual(DEFAULT_WORKFLOW.boundaries);
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

  it("照合は境目の requires・decide を見ずに、規則だけで前進する", () => {
    const wf = validateWorkflow(
      {
        boundaries: [{ from: "review", to: "done", requires: ["pr_merged"], decide: "human_only" }],
        reconcile: [{ when: ["branch_merged"], status: "done" }],
      },
      "x",
    ).workflow!;
    expect(reconcileStatus(wf, "review", { branch_merged: true })).toMatchObject({
      kind: "advance",
      to: "done",
    });
  });
});
