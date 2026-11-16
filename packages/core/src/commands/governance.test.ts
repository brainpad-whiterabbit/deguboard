// カンバンの管理の操作（Workflow の governance）と Core に固定の操作の判定（WF-7）

import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../test/helpers/git-fixture.js";
import {
  initializedFixture,
  reopenInitialized,
  runCleanups,
  writeWorkflowYaml,
} from "../../test/helpers/commands-context.js";
import { GOVERNANCE_OPERATIONS } from "../model/workflow.js";
import { CORE_FIXED, commandsRejectedForAgent, resolveWorkflow } from "../workflow/resolve.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { epicClose, epicCreate, epicReopen } from "./epic.js";
import { configSet, configUnset } from "./setup.js";
import {
  ticketClaim,
  ticketCreate,
  ticketDelete,
  ticketImport,
  ticketUnclaim,
  ticketUpdate,
} from "./ticket.js";
import { workflowSet, workflowShow } from "./workflow.js";

afterEach(runCleanups);

/** 人（eiki）と、別のユーザのエージェント（claude/agent）の文脈。索引は同じものを使う。agent の --approved-by human は claude になる */
async function humanAndAgent() {
  const f = await initializedFixture();
  const human = await reopenInitialized(f);
  const opened = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
  const agent = { ...human, actor: opened.actor };
  /** governance の値だけを書いた workflow.yaml を置く */
  const governance = (values: Record<string, string>) =>
    writeWorkflowYaml(human, [
      "governance:",
      ...Object.entries(values).map(([key, value]) => `  ${key}: ${value}`),
    ]);
  const subject = async () =>
    (await git(human.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim();
  return { f, human, agent, governance, subject };
}

const rejected = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code: string; message: string; detail?: string },
  );

describe("カンバンの管理の操作は governance の値で判定される", () => {
  it("delete：既定（human_only）はエージェントがチケットを消せず、値を替えると承認で・聞かずに消せる", async () => {
    const { human, agent, governance, subject } = await humanAndAgent();
    for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, human, { title });
    // human_only は承認者を渡しても通らない
    for (const input of [{ ticket: "t1" }, { ticket: "t1", approved_by: "human" }])
      expect(await rejected(runCommand(ticketDelete, agent, input))).toMatchObject({
        code: "TRANSITION_REJECTED",
        message: "The Workflow limits dg ticket delete to a person (governance.delete: human_only)",
      });
    expect((await runCommand(ticketDelete, human, { ticket: "t1" })).data.id).toBe("t1");

    await governance({ delete: "always_ask" });
    expect(await rejected(runCommand(ticketDelete, agent, { ticket: "t2" }))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for dg ticket delete (governance.delete: always_ask)",
    });
    await runCommand(ticketDelete, agent, { ticket: "t2", approved_by: "human" });
    expect(await subject()).toBe("Delete t2: B (approved by claude)");

    await governance({ delete: "anyone" });
    expect((await runCommand(ticketDelete, agent, { ticket: "t3" })).data.id).toBe("t3");
  });

  it("config：チームの設定の set・unset は既定（always_ask）で承認が要り、承認者が履歴に残る。個人の設定は判定しない", async () => {
    const { human, agent, governance, subject } = await humanAndAgent();
    const set = { key: "work.parallel", value: "2" };
    expect(await rejected(runCommand(configSet, agent, set))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for changing the team's setting work.parallel (governance.config: always_ask)",
    });
    expect(await rejected(runCommand(configUnset, agent, { key: "work.parallel" }))).toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    expect(human.store.teamConfig.work.parallel).not.toBe(2);
    const written = await runCommand(configSet, agent, { ...set, approved_by: "human" });
    expect(written.data.work.parallel).toBe(2);
    expect(await subject()).toBe("Change config work.parallel (approved by claude)");
    await runCommand(configUnset, agent, { key: "work.parallel", approved_by: "human" });
    expect(await subject()).toBe("Reset config work.parallel to the default (approved by claude)");
    // 人は聞かずに書ける。個人の設定（--local）はエージェントも聞かずに書ける
    await runCommand(configSet, human, set);
    await runCommand(configSet, agent, { ...set, value: "3", local: true });
    await runCommand(configUnset, agent, { key: "work.parallel", local: true });

    await governance({ config: "human_only" });
    expect(
      await rejected(runCommand(configSet, agent, { ...set, approved_by: "human" })),
    ).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow limits changing the team's setting work.parallel to a person (governance.config: human_only)",
    });
    await runCommand(configSet, agent, { ...set, value: "3", local: true });

    await governance({ config: "anyone" });
    expect((await runCommand(configSet, agent, { ...set, value: "4" })).data.work.parallel).toBe(4);
  });

  it("reassign：ほかのユーザの担当の付け替えと claim を外すのは既定（always_ask）で承認が要り、自分の担当と担当なしは聞かずに替えられる", async () => {
    const { human, agent, governance, subject } = await humanAndAgent();
    // t1・t2 は人（eiki）の担当、t3 は担当なし、t4 は人が claim 済み
    for (const title of ["A", "B", "C", "D"]) await runCommand(ticketCreate, human, { title });
    for (const ticket of ["t1", "t2"])
      await runCommand(ticketUpdate, human, { ticket, assignee: "human" });
    await runCommand(ticketClaim, human, { ticket: "t4", without_branch: true });

    const asks = (what: string) => ({
      code: "TRANSITION_REJECTED",
      message: `The Workflow asks for a person's approval for ${what} (governance.reassign: always_ask)`,
    });
    // 担当の付け替え（ticket update --assignee）と、担当を外す
    expect(
      await rejected(runCommand(ticketUpdate, agent, { ticket: "t1", assignee: "agent" })),
    ).toMatchObject(asks("changing the assignee of t1 from eiki"));
    expect(
      await rejected(runCommand(ticketUpdate, agent, { ticket: "t1", assignee: null })),
    ).toMatchObject(asks("changing the assignee of t1 from eiki"));
    // ほかのユーザに割り当てた todo の claim
    expect(
      await rejected(runCommand(ticketClaim, agent, { ticket: "t2", without_branch: true })),
    ).toMatchObject(asks("claiming t2, which is assigned to eiki"));
    // 他人の claim を外す（--force を付けても承認が要る）
    expect(
      await rejected(runCommand(ticketUnclaim, agent, { ticket: "t4", force: true })),
    ).toMatchObject(asks("removing the claim of eiki on t4"));
    expect(human.store.require("ticket", "t1").data.assignee).toBe("eiki");
    expect(human.store.require("ticket", "t4").data.status).toBe("in_progress");

    // 承認者を渡せば通り、履歴に残る
    await runCommand(ticketUpdate, agent, {
      ticket: "t1",
      assignee: "agent",
      approved_by: "human",
    });
    expect(await subject()).toBe("Update t1: A (approved by claude)");
    expect(human.store.require("ticket", "t1").data.assignee).toBe("claude/agent");
    await runCommand(ticketUnclaim, agent, { ticket: "t4", force: true, approved_by: "human" });
    expect(await subject()).toBe("Unclaim t4 (approved by claude)");
    // 自分の担当（t1 は今は claude/agent）と担当のないチケットは、聞かずに替えられる
    await runCommand(ticketUpdate, agent, { ticket: "t1", assignee: null });
    await runCommand(ticketUpdate, agent, { ticket: "t3", assignee: "agent" });
    // 人は聞かずに替えられる
    await runCommand(ticketUpdate, human, { ticket: "t3", assignee: "human" });

    await governance({ reassign: "human_only" });
    expect(
      await rejected(
        runCommand(ticketClaim, agent, {
          ticket: "t2",
          without_branch: true,
          approved_by: "human",
        }),
      ),
    ).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow limits claiming t2, which is assigned to eiki to a person (governance.reassign: human_only)",
    });

    await governance({ reassign: "anyone" });
    const claimed = await runCommand(ticketClaim, agent, { ticket: "t2", without_branch: true });
    expect(claimed.data.assignee).toBe("claude/agent");
    expect(claimed.warnings).toContain("Changed the assignee from eiki to claude/agent");
  });

  it("epic：Epic を閉じる・再開するのは既定（human_only）でエージェントに拒否され、値を替えると承認で・聞かずにできる", async () => {
    const { human, agent, governance, subject } = await humanAndAgent();
    await runCommand(epicCreate, human, { title: "E", summary: "目的" });
    expect(await rejected(runCommand(epicClose, agent, { epic: "e1" }))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "The Workflow limits dg epic close to a person (governance.epic: human_only)",
    });
    expect((await runCommand(epicClose, human, { epic: "e1" })).data.status).toBe("closed");
    expect(await rejected(runCommand(epicReopen, agent, { epic: "e1" }))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "The Workflow limits dg epic reopen to a person (governance.epic: human_only)",
    });

    await governance({ epic: "always_ask" });
    expect(await rejected(runCommand(epicReopen, agent, { epic: "e1" }))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for dg epic reopen (governance.epic: always_ask)",
    });
    await runCommand(epicReopen, agent, { epic: "e1", approved_by: "human" });
    expect(await subject()).toBe("Reopen e1: E (approved by claude)");
    await runCommand(epicClose, agent, { epic: "e1", approved_by: "human" });
    expect(await subject()).toBe("Close e1: E (approved by claude)");

    await governance({ epic: "anyone" });
    expect((await runCommand(epicReopen, agent, { epic: "e1" })).data.status).toBe("open");
  });

  it("create：起票（create・import）は既定（anyone）で誰でもでき、値を替えるとエージェントに拒否・承認、人に --override を求める", async () => {
    const { human, agent, governance, subject } = await humanAndAgent();
    expect((await runCommand(ticketCreate, agent, { title: "A" })).data.id).toBe("t1");

    await governance({ create: "human_only" });
    const limits = (command: string) => ({
      code: "TRANSITION_REJECTED",
      message: `The Workflow limits dg ticket ${command} to a person (governance.create: human_only)`,
    });
    expect(await rejected(runCommand(ticketCreate, agent, { title: "B" }))).toMatchObject(
      limits("create"),
    );
    expect(
      await rejected(runCommand(ticketImport, agent, { drafts: [{ title: "B" }] })),
    ).toMatchObject(limits("import"));
    expect((await runCommand(ticketCreate, human, { title: "B" })).data.id).toBe("t2");

    await governance({ create: "ask_unless_auto" });
    // ask_unless_auto は、--auto がなければ承認を求め、--auto の道を案内する（--auto の判定は flow-permission.test.ts）
    expect(await rejected(runCommand(ticketCreate, agent, { title: "C" }))).toMatchObject({
      code: "TRANSITION_REJECTED",
      detail: expect.stringContaining("run the command again with --auto instead"),
    });
    await runCommand(ticketCreate, agent, { title: "C", approved_by: "human" });
    expect(await subject()).toBe("File t3: C (approved by claude)");
    await runCommand(ticketImport, agent, { drafts: [{ title: "D" }], approved_by: "human" });
    expect(await subject()).toBe("Import 1 tickets: t4 (approved by claude)");

    await governance({ create: "agent_only" });
    expect(await rejected(runCommand(ticketCreate, human, { title: "E" }))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "The Workflow leaves dg ticket create to an agent (governance.create: agent_only)",
    });
    await runCommand(ticketCreate, human, { title: "E", override: "手で足す" });
    expect(await subject()).toBe("File t5: E (override by eiki: 手で足す)");
    expect((await runCommand(ticketCreate, agent, { title: "F" })).data.id).toBe("t6");
  });

  it("workflow.yaml に誤りがあって読めないときは、Core の既定の governance で判定する（NOT_FOUND で止めない）", async () => {
    const { human, agent, subject } = await humanAndAgent();
    await runCommand(epicCreate, human, { title: "E", summary: "目的" });
    // governance を緩めた値ごと読めなくする（未知の事実は誤り）。緩めた値は効かず、既定で判定する
    await writeWorkflowYaml(human, [
      "boundaries:",
      "  - { from: review, to: done, requires: [nope] }",
      "governance: { delete: anyone, epic: anyone, config: anyone }",
    ]);
    expect(human.store.workflow).toBeUndefined();

    // create は既定で anyone：人もエージェントも起票できる（create・import）
    expect((await runCommand(ticketCreate, human, { title: "A" })).data.id).toBe("t1");
    expect((await runCommand(ticketCreate, agent, { title: "B" })).data.id).toBe("t2");
    await runCommand(ticketImport, agent, { drafts: [{ title: "C" }] });
    expect(human.store.require("ticket", "t3").data.title).toBe("C");

    // delete・epic は既定で human_only：エージェントは拒否され、人はできる
    expect(await rejected(runCommand(ticketDelete, agent, { ticket: "t1" }))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "The Workflow limits dg ticket delete to a person (governance.delete: human_only)",
    });
    expect((await runCommand(ticketDelete, human, { ticket: "t1" })).data.id).toBe("t1");
    expect(await rejected(runCommand(epicClose, agent, { epic: "e1" }))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "The Workflow limits dg epic close to a person (governance.epic: human_only)",
    });
    expect((await runCommand(epicClose, human, { epic: "e1" })).data.status).toBe("closed");

    // config は既定で always_ask：エージェントは承認が要り、人は聞かずに書ける
    const set = { key: "work.parallel", value: "2" };
    expect(await rejected(runCommand(configSet, agent, set))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for changing the team's setting work.parallel (governance.config: always_ask)",
    });
    await runCommand(configSet, agent, { ...set, approved_by: "human" });
    expect(await subject()).toBe("Change config work.parallel (approved by claude)");
    await runCommand(configUnset, human, { key: "work.parallel" });
  });

  it("名前だけで操作が決まるコマンドのうち、エージェントに拒むものは flow と governance の値から決まる（ask が人のコマンドに回す）", () => {
    expect(commandsRejectedForAgent(resolveWorkflow({}))).toEqual([
      "iteration.close",
      "iteration.reopen",
      "ticket.delete",
      "epic.close",
      "epic.reopen",
    ]);
    expect(
      commandsRejectedForAgent(
        resolveWorkflow({
          flow: { release: "always_ask", plan: "human_only" },
          governance: { delete: "anyone", epic: "always_ask", create: "human_only" },
        }),
      ),
    ).toEqual(["plan.approve", "ticket.create", "ticket.import"]);
  });
});

describe("Core に固定の操作は workflow.yaml で緩められない", () => {
  /** governance のどの値も anyone にした、いちばん緩い workflow.yaml */
  const loosest = Object.fromEntries(GOVERNANCE_OPERATIONS.map((op) => [op, "anyone"]));

  it("段を下げる ticket update --gate は、エージェントの呼び出しが拒否される（上げるのと人の呼び出しは通る）", async () => {
    const { human, agent, governance } = await humanAndAgent();
    await runCommand(ticketCreate, human, { title: "A" });
    await governance(loosest);
    // 段のないチケットは high。low・free へ下げるのは、承認者を渡しても拒否される
    for (const input of [
      { ticket: "t1", gate: "low" as const },
      { ticket: "t1", gate: "free" as const, approved_by: "human" },
    ]) {
      const err = await rejected(runCommand(ticketUpdate, agent, input));
      expect(err).toMatchObject({
        code: "TRANSITION_REJECTED",
        message: `dg limits lowering the quality gate level of t1 from high to ${input.gate} to a person (fixed in Core, lower_gate: human_only)`,
      });
      expect(err!.detail).toContain("workflow.yaml cannot change this value");
    }
    expect(human.store.require("ticket", "t1").data.gate).toBeUndefined();
    // 人は下げられる。エージェントも上げる・同じ段にする・段を消して high に戻すのはできる
    await runCommand(ticketUpdate, human, { ticket: "t1", gate: "free" });
    expect(
      await rejected(runCommand(ticketUpdate, agent, { ticket: "t1", gate: "free" })),
    ).toBeUndefined();
    await runCommand(ticketUpdate, agent, { ticket: "t1", gate: "low" });
    await runCommand(ticketUpdate, agent, { ticket: "t1", gate: null });
    expect(human.store.require("ticket", "t1").data.gate).toBeUndefined();
  });

  it("workflow set は、エージェントにはいつも人の承認（--approved-by）を求め、承認者を履歴に残す", async () => {
    const { human, agent, governance, subject } = await humanAndAgent();
    await governance(loosest);
    const before = (await runCommand(workflowShow, human, {})).data.definition;
    const definition = { exceptions: { abandon: "anyone" } };
    const err = await rejected(runCommand(workflowSet, agent, { definition }));
    expect(err).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "dg asks for a person's approval for dg workflow set (fixed in Core, workflow_set: always_ask)",
    });
    expect(err!.detail).toContain("workflow.yaml cannot change this value");
    // 何も書いていない
    expect((await runCommand(workflowShow, human, {})).data.definition).toEqual(before);
    // エージェントの ID は承認者にならない（聞かずに進める流れでも、承認者なしでは書けない）
    expect(
      await rejected(runCommand(workflowSet, agent, { definition, approved_by: "claude/agent" })),
    ).toMatchObject({ code: "VALIDATION_FAILED" });

    const set = await runCommand(workflowSet, agent, { definition, approved_by: "human" });
    expect(set.data.changed).toEqual(["exceptions", "governance"]);
    expect(await subject()).toBe("Replace workflow.yaml (approved by claude)");
    // 人は聞かずに書ける
    await runCommand(workflowSet, human, { definition: {} });
    expect(await subject()).toBe("Replace workflow.yaml");
  });

  it("workflow show は Core に固定の操作と値を fixed に返す", async () => {
    const { agent } = await humanAndAgent();
    expect((await runCommand(workflowShow, agent, {})).data.fixed).toEqual({
      workflow_set: "always_ask",
      hooks_uninstall: "human_only",
      lower_gate: "human_only",
      merge_over_gate: "always_ask",
    });
    expect((await runCommand(workflowShow, agent, {})).data.fixed).toBe(CORE_FIXED);
  });
});
