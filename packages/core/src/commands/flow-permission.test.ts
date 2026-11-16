// 流れの段階の操作（Workflow の flow の assign・plan・release）の判定と、聞かずに進める流れ（--auto）の判定（WF-9・EX-7）

import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../test/helpers/git-fixture.js";
import {
  initializedFixture,
  reopenInitialized,
  runCleanups,
  writeWorkflowYaml,
} from "../../test/helpers/commands-context.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { epicAdd, epicCreate, epicRemove } from "./epic.js";
import {
  iterationAdd,
  iterationClose,
  iterationCreate,
  iterationRemove,
  iterationReopen,
} from "./iteration.js";
import { planApprove, planCreate } from "./plan.js";
import { configSet } from "./setup.js";
import { ticketCreate, ticketMove, ticketUpdate } from "./ticket.js";
import { workflowSet } from "./workflow.js";

afterEach(runCleanups);

/**
 * 人（eiki）と、別のユーザのエージェント（claude/agent）の文脈。索引は同じものを使う。agent の --approved-by human は claude になる。
 * Iteration s1・Epic e1 と、チケット t1〜t3 がある
 */
async function humanAndAgent() {
  const f = await initializedFixture();
  const human = await reopenInitialized(f);
  const opened = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
  const agent = { ...human, actor: opened.actor };
  await runCommand(iterationCreate, human, { name: "S1" });
  await runCommand(epicCreate, human, { title: "E", summary: "目的" });
  for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, human, { title });
  /** 書いた項目だけの workflow.yaml を置く（flow: { assign: always_ask } のように 1 行ずつ） */
  const workflow = (...lines: string[]) => writeWorkflowYaml(human, lines);
  const subject = async () =>
    (await git(human.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim();
  const iterationOf = (id: string) => human.store.require("ticket", id).data.iteration;
  const epicOf = (id: string) => human.store.require("ticket", id).data.epic;
  return { f, human, agent, workflow, subject, iterationOf, epicOf };
}

const rejected = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code: string; message: string; detail?: string },
  );

const asks = (what: string, value: string) => ({
  code: "TRANSITION_REJECTED",
  message: `The Workflow asks for a person's approval for ${what} (${value})`,
});
const limits = (what: string, value: string) => ({
  code: "TRANSITION_REJECTED",
  message: `The Workflow limits ${what} to a person (${value})`,
});
const notAutoPlace = (what: string, value: string) => ({
  code: "TRANSITION_REJECTED",
  message: `--auto goes ahead without asking only where the value is ask_unless_auto, and ${what} is not such a place (${value})`,
});

describe("流れの段階の操作は flow の値で判定される", () => {
  it("assign：Iteration・Epic への出し入れは既定（ask_unless_auto）でエージェントに承認が要り、承認者が履歴に残る。人は聞かずにできる", async () => {
    const { human, agent, subject, iterationOf, epicOf } = await humanAndAgent();
    const value = "flow.assign: ask_unless_auto";
    expect(
      await rejected(runCommand(iterationAdd, agent, { iteration: "s1", tickets: ["t1"] })),
    ).toMatchObject(asks("dg iteration add", value));
    expect(
      await rejected(runCommand(epicAdd, agent, { epic: "e1", tickets: ["t1"] })),
    ).toMatchObject(asks("dg epic add", value));
    expect(iterationOf("t1")).toBeUndefined();
    expect(epicOf("t1")).toBeUndefined();

    await runCommand(iterationAdd, agent, {
      iteration: "s1",
      tickets: ["t1"],
      approved_by: "human",
    });
    expect(await subject()).toBe("Add t1 to s1 (approved by claude)");
    await runCommand(epicAdd, agent, { epic: "e1", tickets: ["t1"], approved_by: "human" });
    expect(await subject()).toBe("Add t1 to e1 (approved by claude)");
    expect([iterationOf("t1"), epicOf("t1")]).toEqual(["s1", "e1"]);

    // 出すのも同じ値で判定する
    expect(
      await rejected(runCommand(iterationRemove, agent, { iteration: "s1", tickets: ["t1"] })),
    ).toMatchObject(asks("dg iteration remove", value));
    expect(
      await rejected(runCommand(epicRemove, agent, { epic: "e1", tickets: ["t1"] })),
    ).toMatchObject(asks("dg epic remove", value));
    await runCommand(iterationRemove, agent, {
      iteration: "s1",
      tickets: ["t1"],
      approved_by: "human",
    });
    expect(await subject()).toBe("Remove t1 from s1 (approved by claude)");
    await runCommand(epicRemove, agent, { epic: "e1", tickets: ["t1"], approved_by: "human" });
    expect([iterationOf("t1"), epicOf("t1")]).toEqual([undefined, undefined]);

    // 人は聞かずにできる
    await runCommand(iterationAdd, human, { iteration: "s1", tickets: ["t2"] });
    await runCommand(epicAdd, human, { epic: "e1", tickets: ["t2"] });
    expect([iterationOf("t2"), epicOf("t2")]).toEqual(["s1", "e1"]);
  });

  it("assign：ticket update の --iteration・--epic も、値が変わるときだけ同じ値で判定する", async () => {
    const { human, agent, subject, iterationOf, epicOf } = await humanAndAgent();
    const value = "flow.assign: ask_unless_auto";
    expect(
      await rejected(runCommand(ticketUpdate, agent, { ticket: "t1", iteration: "s1" })),
    ).toMatchObject(asks("moving t1 into or out of an Iteration", value));
    expect(
      await rejected(runCommand(ticketUpdate, agent, { ticket: "t1", epic: "e1" })),
    ).toMatchObject(asks("moving t1 into or out of an Epic", value));
    await runCommand(ticketUpdate, agent, {
      ticket: "t1",
      iteration: "s1",
      epic: "e1",
      approved_by: "human",
    });
    expect(await subject()).toBe("Update t1: A (approved by claude)");
    expect([iterationOf("t1"), epicOf("t1")]).toEqual(["s1", "e1"]);
    // 今と同じ値は出し入れでないので、判定しない
    await runCommand(ticketUpdate, agent, {
      ticket: "t1",
      iteration: "s1",
      epic: "e1",
      title: "A2",
    });
    // 外すのは出し入れ
    expect(
      await rejected(runCommand(ticketUpdate, agent, { ticket: "t1", iteration: null })),
    ).toMatchObject(asks("moving t1 into or out of an Iteration", value));
    await runCommand(ticketUpdate, human, { ticket: "t1", iteration: null, epic: null });
    expect([iterationOf("t1"), epicOf("t1")]).toEqual([undefined, undefined]);
  });

  it("assign：値を替えると、聞かずに・人だけが出し入れできる", async () => {
    const { human, agent, workflow, iterationOf } = await humanAndAgent();
    await workflow("flow: { assign: anyone }");
    await runCommand(iterationAdd, agent, { iteration: "s1", tickets: ["t1"] });
    await runCommand(epicAdd, agent, { epic: "e1", tickets: ["t1"] });
    await runCommand(ticketUpdate, agent, { ticket: "t2", iteration: "s1" });
    expect([iterationOf("t1"), iterationOf("t2")]).toEqual(["s1", "s1"]);

    await workflow("flow: { assign: human_only }");
    const value = "flow.assign: human_only";
    // human_only は承認者を渡しても通らない
    expect(
      await rejected(
        runCommand(iterationAdd, agent, { iteration: "s1", tickets: ["t3"], approved_by: "human" }),
      ),
    ).toMatchObject(limits("dg iteration add", value));
    expect(
      await rejected(runCommand(epicRemove, agent, { epic: "e1", tickets: ["t1"] })),
    ).toMatchObject(limits("dg epic remove", value));
    expect(
      await rejected(runCommand(ticketUpdate, agent, { ticket: "t3", iteration: "s1" })),
    ).toMatchObject(limits("moving t3 into or out of an Iteration", value));
    await runCommand(iterationAdd, human, { iteration: "s1", tickets: ["t3"] });
    expect(iterationOf("t3")).toBe("s1");
  });

  it("plan：plan approve は既定（ask_unless_auto）でエージェントに承認が要り、承認した人を approved_by と履歴に残す。値を替えると聞かずに・人だけが承認できる", async () => {
    const { human, agent, workflow, subject } = await humanAndAgent();
    for (const t of ["t1", "t2", "t3"]) await runCommand(planCreate, human, { tickets: [t] });
    expect(await rejected(runCommand(planApprove, agent, { plan: "p1" }))).toMatchObject(
      asks("dg plan approve", "flow.plan: ask_unless_auto"),
    );
    expect(human.store.require("plan", "p1").data.pending_approval).toBe(true);
    const approved = await runCommand(planApprove, agent, { plan: "p1", approved_by: "human" });
    expect(approved.data).toMatchObject({ pending_approval: false, approved_by: "claude" });
    expect(await subject()).toBe("Approve p1 (approved by claude)");

    await workflow("flow: { plan: human_only }");
    expect(
      await rejected(runCommand(planApprove, agent, { plan: "p2", approved_by: "human" })),
    ).toMatchObject(limits("dg plan approve", "flow.plan: human_only"));
    // 人が自分で承認すると、承認者は自分
    expect((await runCommand(planApprove, human, { plan: "p2" })).data.approved_by).toBe("eiki");

    // 承認の要らない値では、呼んだエージェントを承認者に記録する
    await workflow("flow: { plan: anyone }");
    expect((await runCommand(planApprove, agent, { plan: "p3" })).data.approved_by).toBe(
      "claude/agent",
    );
  });

  it("release：iteration close・reopen は既定（human_only）でエージェントを拒否し、値を替えると承認で・聞かずにできる", async () => {
    const { human, agent, workflow, subject } = await humanAndAgent();
    const statusOf = () => human.store.require("iteration", "s1").data.status;
    const value = "flow.release: human_only";
    // human_only は承認者を渡しても通らない
    for (const input of [{ iteration: "s1" }, { iteration: "s1", approved_by: "human" }])
      expect(await rejected(runCommand(iterationClose, agent, input))).toMatchObject(
        limits("dg iteration close", value),
      );
    expect(statusOf()).toBe("planned");
    await runCommand(iterationClose, human, { iteration: "s1" });
    expect(
      await rejected(runCommand(iterationReopen, agent, { iteration: "s1", approved_by: "human" })),
    ).toMatchObject(limits("dg iteration reopen", value));
    expect(statusOf()).toBe("closed");

    await workflow("flow: { release: always_ask }");
    expect(await rejected(runCommand(iterationReopen, agent, { iteration: "s1" }))).toMatchObject(
      asks("dg iteration reopen", "flow.release: always_ask"),
    );
    await runCommand(iterationReopen, agent, { iteration: "s1", approved_by: "human" });
    expect(await subject()).toBe("Reopen s1: S1 (approved by claude)");
    expect(await rejected(runCommand(iterationClose, agent, { iteration: "s1" }))).toMatchObject(
      asks("dg iteration close", "flow.release: always_ask"),
    );
    await runCommand(iterationClose, agent, { iteration: "s1", approved_by: "human" });
    expect(await subject()).toBe("Close s1: S1 (approved by claude)");

    await workflow("flow: { release: anyone }");
    await runCommand(iterationReopen, agent, { iteration: "s1" });
    await runCommand(iterationClose, agent, { iteration: "s1" });
    expect(statusOf()).toBe("closed");
  });
});

describe("--auto は ask_unless_auto の場面だけを聞かずに進め、承認者にエージェントを記録する", () => {
  it("flow：既定の assign と plan は --auto で聞かずに進み、承認者（履歴と approved_by）は進めたエージェント", async () => {
    const { human, agent, subject, iterationOf, epicOf } = await humanAndAgent();
    await runCommand(iterationAdd, agent, { iteration: "s1", tickets: ["t1"], auto: true });
    expect(await subject()).toBe("Add t1 to s1 (approved by claude/agent with --auto)");
    await runCommand(epicAdd, agent, { epic: "e1", tickets: ["t1"], auto: true });
    expect(await subject()).toBe("Add t1 to e1 (approved by claude/agent with --auto)");
    await runCommand(ticketUpdate, agent, { ticket: "t2", iteration: "s1", auto: true });
    expect(await subject()).toBe("Update t2: B (approved by claude/agent with --auto)");
    expect([iterationOf("t1"), epicOf("t1"), iterationOf("t2")]).toEqual(["s1", "e1", "s1"]);
    await runCommand(iterationRemove, agent, { iteration: "s1", tickets: ["t2"], auto: true });
    await runCommand(epicRemove, agent, { epic: "e1", tickets: ["t1"], auto: true });

    await runCommand(planCreate, human, { tickets: ["t1"] });
    const approved = await runCommand(planApprove, agent, { plan: "p1", auto: true });
    expect(approved.data).toMatchObject({ pending_approval: false, approved_by: "claude/agent" });
    expect(await subject()).toBe("Approve p1 (approved by claude/agent with --auto)");
  });

  it("flow：ask_unless_auto でない値（always_ask・human_only・anyone）の --auto は拒否され、何も書かない", async () => {
    const { human, agent, workflow, iterationOf } = await humanAndAgent();
    await runCommand(planCreate, human, { tickets: ["t1"] });
    const add = { iteration: "s1", tickets: ["t1"], auto: true };

    // 既定の release は human_only：--auto でも閉じられない
    expect(
      await rejected(runCommand(iterationClose, agent, { iteration: "s1", auto: true })),
    ).toMatchObject({
      ...notAutoPlace("dg iteration close", "flow.release: human_only"),
      detail: "Ask a person to run the command (without --actor agent)",
    });
    expect(human.store.require("iteration", "s1").data.status).toBe("planned");

    await workflow("flow: { assign: always_ask, plan: always_ask }");
    const asked = await rejected(runCommand(iterationAdd, agent, add));
    expect(asked).toMatchObject(notAutoPlace("dg iteration add", "flow.assign: always_ask"));
    expect(asked!.detail).toContain("--auto never skips this approval");
    expect(
      await rejected(runCommand(planApprove, agent, { plan: "p1", auto: true })),
    ).toMatchObject(notAutoPlace("dg plan approve", "flow.plan: always_ask"));
    // always_ask の承認の案内は --auto を勧めない
    const plain = await rejected(runCommand(planApprove, agent, { plan: "p1" }));
    expect(plain!.detail).not.toContain("--auto");

    // 聞かない値に付けた --auto も拒否する（聞かずに進めるのを ask_unless_auto の場面に限る）
    await workflow("flow: { assign: anyone }");
    expect(await rejected(runCommand(iterationAdd, agent, add))).toMatchObject({
      ...notAutoPlace("dg iteration add", "flow.assign: anyone"),
      detail: "No approval is asked here, so run the command again without --auto",
    });
    expect(iterationOf("t1")).toBeUndefined();
    expect(human.store.require("plan", "p1").data.pending_approval).toBe(true);
  });

  it("境目と governance：ask_unless_auto の場面（既定の review → done、governance の値）は --auto で進み、ほかの値と何も判定しない呼び出しの --auto は拒否される", async () => {
    const { human, agent, workflow, subject } = await humanAndAgent();
    // PR の要らない作業（ブランチなし）を review まで進める。review → done は既定で ask_unless_auto
    await runCommand(ticketMove, human, { ticket: "t1", status: "in_progress" });
    await runCommand(ticketMove, human, { ticket: "t1", status: "review" });
    const done = await runCommand(ticketMove, agent, { ticket: "t1", status: "done", auto: true });
    expect(done.data.status).toBe("done");
    expect(await subject()).toBe(
      "Move t1 from review to done (approved by claude/agent with --auto)",
    );
    // 例外の動き（reopen は always_ask）と、聞かない境目（todo → in_progress は anyone）の --auto は拒否される
    expect(
      await rejected(runCommand(ticketMove, agent, { ticket: "t1", status: "review", auto: true })),
    ).toMatchObject(notAutoPlace("moving t1 from done to review", "exceptions.reopen: always_ask"));
    expect(
      await rejected(
        runCommand(ticketMove, agent, { ticket: "t2", status: "in_progress", auto: true }),
      ),
    ).toMatchObject(
      notAutoPlace("moving t2 from todo to in_progress", "boundaries todo → in_progress: anyone"),
    );

    // governance：既定の config は always_ask で --auto は効かず、ask_unless_auto にすると効く
    const set = { key: "work.parallel", value: "2", auto: true };
    expect(await rejected(runCommand(configSet, agent, set))).toMatchObject(
      notAutoPlace("changing the team's setting work.parallel", "governance.config: always_ask"),
    );
    await workflow("governance: { config: ask_unless_auto }");
    expect((await runCommand(configSet, agent, set)).data.work.parallel).toBe(2);
    expect(await subject()).toBe(
      "Change config work.parallel (approved by claude/agent with --auto)",
    );

    // 何も判定しない呼び出し（個人の設定・題だけの編集）に付けた --auto は拒否される
    expect(await rejected(runCommand(configSet, agent, { ...set, local: true }))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "--auto goes ahead without asking only where the value is ask_unless_auto, and changing a personal setting asks for no approval",
    });
    expect(
      await rejected(runCommand(ticketUpdate, agent, { ticket: "t2", title: "B2", auto: true })),
    ).toMatchObject({ code: "TRANSITION_REJECTED" });
    expect(human.store.require("ticket", "t2").data.title).toBe("B");
  });

  it("Core に固定の承認は --auto で越えられない：workflow set は --auto を受けず、段を下げるのは拒否される", async () => {
    const { human, agent } = await humanAndAgent();
    // workflow set は --auto の入力を持たない（渡しても、人の承認がなければ拒否される）
    expect(Object.keys(workflowSet.input.shape)).not.toContain("auto");
    expect(
      await rejected(
        runCommand(workflowSet, agent, { definition: { flow: { release: "anyone" } }, auto: true }),
      ),
    ).toMatchObject({ code: "TRANSITION_REJECTED" });
    expect(human.store.workflow?.resolved.flow.stages.release).toBe("human_only");
    expect(
      await rejected(runCommand(ticketUpdate, agent, { ticket: "t1", gate: "low", auto: true })),
    ).toMatchObject(
      notAutoPlace(
        "lowering the quality gate level of t1 from high to low",
        "fixed in Core, lower_gate: human_only",
      ),
    );
  });

  it("--auto はエージェントのもので、人の承認（--approved-by）や人の強制（--override）とは一緒に渡せない", async () => {
    const { human, agent, iterationOf } = await humanAndAgent();
    const add = { iteration: "s1", tickets: ["t1"], auto: true };
    expect(await rejected(runCommand(iterationAdd, human, add))).toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "--auto is for an agent in a flow that goes ahead without asking, and a person does not need it",
    });
    expect(
      await rejected(runCommand(iterationAdd, agent, { ...add, approved_by: "human" })),
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "--auto cannot be combined with --approved-by or --override",
    });
    expect(iterationOf("t1")).toBeUndefined();
  });
});
