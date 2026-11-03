import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import {
  ASK_ACTIONS,
  ASK_TEXT_PREAMBLE,
  ask,
  askActions,
  askHumanChecks,
  buildAsk,
  type AskSubject,
  type AskView,
  type PlanState,
} from "./ask.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { epicCreate } from "./epic.js";
import { iterationAdd, iterationCreate, iterationStart } from "./iteration.js";
import { planCreate } from "./plan.js";
import { commands } from "./registry.js";
import { runStart } from "./run.js";
import { configSet, init } from "./setup.js";
import { ticketCreate, ticketMove, ticketUpdate } from "./ticket.js";
import { workflowSet } from "./workflow.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const ticket = (over: Partial<Extract<AskSubject, { kind: "ticket" }>> = {}): AskSubject => ({
  kind: "ticket",
  id: "t265",
  title: "右の列を細くする",
  status: "todo",
  iteration: "s10",
  iteration_status: "active",
  deps_done: true,
  running: false,
  ...over,
});
const iteration = (status: string, complete = false): AskSubject => ({
  kind: "iteration",
  id: "s10",
  title: "チケット詳細の改善",
  status,
  complete,
});
const epic = (status: string): AskSubject => ({
  kind: "epic",
  id: "e9",
  title: "溜まりを閉じる",
  status,
});

describe("依頼文の組み立て", () => {
  it("Skill 形式は 1 行目が Skill の呼び出しで、対象は ID とタイトル（と Status・Iteration）だけを並べ、指示を添える", () => {
    const view = buildAsk({
      subjects: [ticket({ status: "review" })],
      note: "  スクリーンショットも見て  ",
    });
    expect(view).toMatchObject({ action: "done", skill: "/dgdone", kind: "prompt" });
    expect(view.text).toBe(
      [
        "/dgdone t265",
        "PR のマージを照合し、残った受け入れ条件を確かめて片付けてください。",
        "",
        "対象:",
        "- t265「右の列を細くする」（review, s10）",
        "",
        "指示:",
        "スクリーンショットも見て",
      ].join("\n"),
    );
    expect(view.targets[0]!.line).toBe("t265「右の列を細くする」（review, s10）");
    // Iteration のないチケットは「Iteration なし」と書く
    expect(buildAsk({ subjects: [ticket({ iteration: null })] }).text).toContain(
      "- t265「右の列を細くする」（todo, Iteration なし）",
    );
  });

  it("文章だけの形式は 1 行目の Skill の代わりに dg の呼び方（--json --actor agent）を添える", () => {
    const view = buildAsk({ subjects: [ticket({ status: "review" })], format: "text" });
    const lines = view.text.split("\n");
    expect(lines[0]).toBe(ASK_TEXT_PREAMBLE);
    expect(lines[0]).toContain("--json --actor agent");
    expect(view.text).not.toContain("/dgdone");
  });

  it("起票・Iteration を作る・Epic を作るの依頼文には --created-by human を付ける指示が入り、1 行目に ID を並べない", () => {
    for (const action of ["create", "create_iteration", "create_epic"] as const) {
      const view = buildAsk({ subjects: [], action });
      expect(view.text).toContain("--created-by human");
      expect(view.text.split("\n")[0]).toBe(action === "create" ? "/dgimport" : "/dgassign");
    }
    const into = buildAsk({ subjects: [iteration("active")], action: "create" });
    expect(into.label).toBe("起票して s10 に入れる");
    expect(into.text.split("\n").slice(0, 2)).toEqual([
      "/dgimport",
      "次の内容をチケットにして s10 に入れてください。人の指示による起票なので --created-by human を付けてください。",
    ]);
  });

  it("閉じる・再開・done の取り消し・やめるの依頼文には「人の指示」と書き添える", () => {
    const cases: Array<[AskSubject, AskView["action"]]> = [
      [iteration("active"), "close"],
      [epic("open"), "close"],
      [iteration("closed"), "reopen"],
      [epic("closed"), "reopen"],
      [ticket({ status: "done" }), "undo_done"],
      [ticket(), "abandon"],
    ];
    for (const [subject, action] of cases) {
      const view = buildAsk({ subjects: [subject], action });
      expect(view.kind).toBe("prompt");
      expect(view.text).toContain("（人の指示）");
    }
  });

  it("頼むことの操作が actor.human_only に入っていれば、依頼文の代わりに人が打つ dg のコマンドを返す", () => {
    const humanOnly = ["iteration.close", "iteration.create", "ticket.move"];
    const close = buildAsk({ subjects: [iteration("active")], action: "close", humanOnly });
    expect(close).toMatchObject({
      kind: "command",
      human_only: ["iteration.close"],
      text: "dg iteration close s10",
    });
    const create = buildAsk({ subjects: [], action: "create_iteration", humanOnly });
    expect(create.text).toBe('dg iteration create "<名前>"');
    const abandon = buildAsk({
      subjects: [ticket(), ticket({ id: "t266" })],
      action: "abandon",
      humanOnly,
    });
    expect(abandon.text).toBe("dg ticket move t265 abandoned\ndg ticket move t266 abandoned");
    const approve = buildAsk({
      subjects: [
        { kind: "plan", id: "p21", status: "pending_approval", tickets: ["t1"], complete: false },
      ],
      action: "approve",
      humanOnly: ["plan.approve"],
    });
    expect(approve).toMatchObject({
      kind: "command",
      human_only: ["plan.approve"],
      text: "dg plan approve p21",
    });
    // 入っていない操作は依頼文のまま
    expect(buildAsk({ subjects: [epic("open")], action: "close", humanOnly }).kind).toBe("prompt");
    // Skill の手順に任せる頼むことは、拒否されたらエージェントが人に頼むので依頼文のまま
    expect(buildAsk({ subjects: [ticket()], action: "work", humanOnly }).kind).toBe("prompt");
  });

  it("やめる・done の取り消しは、Workflow の by に agent が入っていない遷移なら人が打つコマンドを返し、入っていれば依頼文のまま", () => {
    // todo → abandoned が人に限られる
    const abandon = buildAsk({
      subjects: [ticket({ agent_denied: ["abandoned"] }), ticket({ id: "t266" })],
      action: "abandon",
    });
    expect(abandon).toMatchObject({
      kind: "command",
      human_only: [],
      workflow_by: ["t265: todo → abandoned"],
      text: "dg ticket move t265 abandoned\ndg ticket move t266 abandoned",
    });
    // 戻す先がすべて人に限られる done は、取り消しを人に回す
    const done = (agent_denied: string[]) =>
      buildAsk({ subjects: [ticket({ status: "done", agent_denied })], action: "undo_done" });
    expect(done(["todo", "in_progress", "review"])).toMatchObject({
      kind: "command",
      workflow_by: ["t265: done → todo・in_progress・review"],
      text: 'dg ticket move t265 "<戻す Status>"',
    });
    // agent も行える遷移は依頼文のまま（戻す先が 1 つでも行えればエージェントに頼む）
    expect(done(["todo", "in_progress"])).toMatchObject({ kind: "prompt", workflow_by: [] });
    expect(done([]).kind).toBe("prompt");
    expect(
      buildAsk({ subjects: [ticket({ agent_denied: ["done"] })], action: "abandon" }).kind,
    ).toBe("prompt");
  });

  it("Skill を使わない頼むことは、Skill 形式でも 1 行目に dg の呼び方を添える", () => {
    const view = buildAsk({ subjects: [iteration("active")], action: "close" });
    expect(view.skill).toBeNull();
    expect(view.text.split("\n")[0]).toBe(ASK_TEXT_PREAMBLE);
  });

  it("対象も指示もない自由な依頼は使い方の誤り", () => {
    expect(() => buildAsk({ subjects: [], action: "free" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(buildAsk({ subjects: [], action: "free", note: "様子を見て" }).text).toBe(
      `${ASK_TEXT_PREAMBLE}\n\n指示:\n様子を見て`,
    );
  });

  it("候補にない頼むことは使い方の誤りで、候補を添える", () => {
    expect(() => buildAsk({ subjects: [ticket({ status: "review" })], action: "all" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT", detail: expect.stringContaining("done（") }),
    );
  });
});

describe("人に回すかを決める操作の名前", () => {
  it("すべての頼むことの human の check は、registry にあるコマンドの名前（打ち間違えると人に回らないまま依頼文を返す）", () => {
    const plan = (status: PlanState, complete = false): AskSubject => ({
      kind: "plan",
      id: "p33",
      status,
      tickets: ["t307"],
      complete,
    });
    // 頼むことがどれも候補に出るよう、対象の種類と状態を並べる
    const samples: AskSubject[][] = [
      [],
      [ticket({ status: "review" })],
      [ticket({ status: "done" })],
      [ticket({ status: "abandoned" })],
      [ticket({ status: "in_progress" })],
      [ticket({ iteration: null, iteration_status: null })],
      [ticket({ iteration_status: "closed" })],
      [ticket(), ticket({ id: "t266" })],
      [ticket({ iteration_status: "active" })],
      [ticket({ deps_done: false })],
      [iteration("closed")],
      [iteration("active", true)],
      [iteration("active")],
      [iteration("planned")],
      [epic("closed")],
      [epic("active")],
      [plan("closed")],
      [plan("pending_approval")],
      [plan("approved", true)],
      [plan("approved")],
      [ticket(), epic("active")],
    ];
    const names = new Set(commands.map((c) => c.name));
    const seen = new Set<string>();
    const checked = new Set<string>();
    const unknown: string[] = [];
    for (const s of samples)
      for (const action of askActions(s)) {
        seen.add(action);
        for (const name of askHumanChecks(action, s)) {
          checked.add(name);
          if (!names.has(name)) unknown.push(`${action}: ${name}`);
        }
      }
    expect([...ASK_ACTIONS].filter((a) => !seen.has(a))).toEqual([]);
    expect(checked).toContain("ticket.move");
    expect(unknown).toEqual([]);
  });
});

describe("頼むことの候補", () => {
  it("チケットの状態からおすすめを先頭にする（review は片付ける、止まった in_progress は再開する、着手可の todo は進める、closed の Iteration に残った todo は割り当てる）", () => {
    const first = (s: AskSubject[]) => askActions(s)[0];
    expect(first([ticket({ status: "review" })])).toBe("done");
    expect(first([ticket({ status: "in_progress" })])).toBe("resume");
    expect(first([ticket({ status: "in_progress", running: true })])).toBe("status");
    // active の Iteration（カンバン）の着手可の todo は進める
    expect(first([ticket()])).toBe("work");
    // planned の Iteration（バックログ）の着手可の todo は、まず計画を立てる
    expect(first([ticket({ iteration_status: "planned" })])).toBe("plan");
    expect(askActions([ticket({ iteration_status: "planned" })])).toContain("work");
    // closed の Iteration に残った todo は、着手可でも依存が残っていても、複数でもまず割り当てる
    expect(first([ticket({ iteration_status: "closed" })])).toBe("assign");
    expect(first([ticket({ iteration_status: "closed", deps_done: false })])).toBe("assign");
    expect(first([ticket(), ticket({ id: "t266", iteration_status: "closed" })])).toBe("assign");
    expect(askActions([ticket({ iteration_status: "closed" })])).toContain("plan");
    expect(first([ticket({ deps_done: false })])).toBe("check");
    expect(first([ticket({ iteration: null })])).toBe("assign");
    expect(first([ticket({ status: "done" })])).toBe("create");
    expect(first([ticket({ status: "abandoned" })])).toBe("create");
    // 実行中の Run があるものには、同じ Skill を重ねて呼ばない
    expect(askActions([ticket({ status: "in_progress", running: true })])).not.toContain("resume");
    // 複数の todo は計画から
    expect(first([ticket(), ticket({ id: "t266" })])).toBe("plan");
  });

  it("Iteration・Epic・Plan と対象なしの候補。おすすめは recommended で示す", () => {
    const first = (s: AskSubject[]) => askActions(s)[0];
    expect(first([iteration("planned")])).toBe("plan");
    expect(first([iteration("active")])).toBe("plan");
    expect(first([iteration("active", true)])).toBe("release");
    expect(first([iteration("closed")])).toBe("retro");
    expect(first([epic("open")])).toBe("create");
    expect(first([epic("closed")])).toBe("create");
    const plan = (status: "pending_approval" | "approved" | "closed", complete = false) =>
      [{ kind: "plan", id: "p21", status, tickets: ["t263"], complete }] as AskSubject[];
    expect(first(plan("pending_approval"))).toBe("approve");
    expect(first(plan("approved"))).toBe("work");
    expect(first(plan("approved", true))).toBe("done");
    expect(askActions([])).toEqual(["create", "create_iteration", "create_epic", "check", "free"]);
    const view = buildAsk({ subjects: [iteration("active")] });
    expect(view.candidates.map((c) => c.recommended)).toEqual(
      view.candidates.map((_, n) => n === 0),
    );
    expect(view.candidates.at(-1)).toMatchObject({ action: "free", skill: null });
  });

  it("止まったものの再開は、1 行目に実行中の Run のないチケットだけを並べる", () => {
    const view = buildAsk({
      subjects: [
        ticket({ id: "t263", status: "in_progress", running: true }),
        ticket({ id: "t264", status: "in_progress" }),
      ],
    });
    expect(view.action).toBe("resume");
    expect(view.text.split("\n")[0]).toBe("/dgwork t264");
    expect(view.text).toContain("t263 は Run が実行中なので触らないでください");
  });
});

const actor = { kind: "human" as const, user: "eiki" };

async function initialized(): Promise<{ cwd: string; ctx: CommandContext }> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {});
  return { cwd: f.cloneA, ctx: await openContext({ cwd: f.cloneA, actor }) };
}

describe("ask", () => {
  it("store から対象の状態を引いて候補を決め、本文を依頼文に入れない", async () => {
    const { ctx } = await initialized();
    await runCommand(ticketCreate, ctx, { title: "A", body: "## 概要\n\n本文の秘密\n" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(ticketUpdate, ctx, { ticket: "t2", depends_on: ["t1"] });
    await runCommand(iterationCreate, ctx, { name: "Sprint 1" });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1", "t2"] });
    await runCommand(epicCreate, ctx, { title: "E" });

    const run = async (input: Record<string, unknown>) => (await runCommand(ask, ctx, input)).data;
    const t1 = await run({ targets: ["t1"] });
    expect(t1.action).toBe("work");
    expect(t1.text).toBe(
      "/dgwork t1\n次のチケットを進めてください。\n\n対象:\n- t1「A」（todo, s1）",
    );
    expect(t1.text).not.toContain("本文の秘密");
    // 依存先が終わっていない todo は待ちを確かめる
    expect((await run({ targets: ["t2"] })).label).toBe("待ちを確かめる");
    expect((await run({ targets: ["s1"] })).targets[0]).toMatchObject({
      kind: "iteration",
      line: "Iteration s1「Sprint 1」（active）",
    });
    expect((await run({ targets: ["e1"] })).label).toBe("起票して e1 に足す");
    // planned の Iteration に入った着手可の todo は計画から
    await runCommand(ticketCreate, ctx, { title: "C" });
    await runCommand(iterationCreate, ctx, { name: "Sprint 2" });
    await runCommand(iterationAdd, ctx, { iteration: "s2", tickets: ["t3"] });
    const t3 = await run({ targets: ["t3"] });
    expect(t3.targets[0]).toMatchObject({ iteration_status: "planned" });
    expect(t3.action).toBe("plan");

    // 止まった in_progress は再開、実行中の Run があれば様子を聞く
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "in_progress" });
    expect((await run({ targets: ["t1"] })).action).toBe("resume");
    await runCommand(runStart, ctx, { ticket: "t1", step: "implement", agent: "claude-code" });
    expect((await run({ targets: ["t1"] })).action).toBe("status");

    // Plan は承認待ちなら承認する
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2"] });
    expect((await run({ targets: ["p1"] })).targets[0]!.line).toBe("Plan p1（承認待ち、t1 t2）");

    // 番号だけの ID は種類が決まらないので使い方の誤り、ないものは NOT_FOUND
    await expect(runCommand(ask, ctx, { targets: ["1"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(runCommand(ask, ctx, { targets: ["t9"] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("config の actor.human_only を見て、人が打つコマンドを返す", async () => {
    const { cwd, ctx } = await initialized();
    await runCommand(iterationCreate, ctx, { name: "Sprint 1" });
    await runCommand(configSet, ctx, { key: "actor.human_only", value: "iteration.close" });
    // 文脈ごとに config を持つので開き直す
    const human = await openContext({ cwd, actor });
    const view = (await runCommand(ask, human, { targets: ["s1"], action: "close" })).data;
    expect(view).toMatchObject({
      kind: "command",
      human_only: ["iteration.close"],
      text: "dg iteration close s1",
    });
  });

  it("チケットの Workflow の by を見て、人に限る遷移は人が打つコマンドを、agent を含む遷移は依頼文を返す", async () => {
    const { ctx } = await initialized();
    await runCommand(workflowSet, ctx, {
      workflow: "general",
      definition: {
        id: "general",
        name: "General",
        transitions: [
          { from: "todo", to: "abandoned", by: ["human"] },
          { from: "done", to: "todo", by: ["human"] },
          { from: "done", to: "in_progress", by: ["human"] },
          { from: "done", to: "review", by: ["human"] },
        ],
      },
    });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "done" });
    const run = async (input: Record<string, unknown>) => (await runCommand(ask, ctx, input)).data;

    const abandon = await run({ targets: ["t1"], action: "abandon" });
    expect(abandon.targets[0]).toMatchObject({ agent_denied: ["abandoned"] });
    expect(abandon).toMatchObject({
      kind: "command",
      human_only: [],
      workflow_by: ["t1: todo → abandoned"],
      text: "dg ticket move t1 abandoned",
    });
    expect(await run({ targets: ["t2"], action: "undo_done" })).toMatchObject({
      kind: "command",
      workflow_by: ["t2: done → todo・in_progress・review"],
      text: 'dg ticket move t2 "<戻す Status>"',
    });

    // agent を含む遷移に変えると、依頼文に戻る
    await runCommand(workflowSet, ctx, {
      workflow: "general",
      definition: {
        id: "general",
        name: "General",
        transitions: [
          { from: "todo", to: "abandoned", by: ["human", "agent"] },
          { from: "done", to: "todo", by: ["human"] },
          { from: "done", to: "review", by: ["agent"] },
        ],
      },
    });
    expect(await run({ targets: ["t1"], action: "abandon" })).toMatchObject({
      kind: "prompt",
      workflow_by: [],
    });
    expect((await run({ targets: ["t2"], action: "undo_done" })).kind).toBe("prompt");
  });
});
