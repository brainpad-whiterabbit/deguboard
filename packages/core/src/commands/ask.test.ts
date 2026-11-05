import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import {
  ASK_ACTIONS,
  type AskAction,
  ASK_DG_USAGE,
  DG_PATH_NOTE,
  askGuideLine,
  ask,
  askCandidates,
  askHumanChecks,
  askMenu,
  askMenuKey,
  parseAskMenuKey,
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

/** 候補の頼むことだけを順に並べる */
const askActions = (s: AskSubject[], within?: string) =>
  askCandidates(s, within).map((c) => c.action);

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
  epic: null,
  deps_done: true,
  running: false,
  ...over,
});
const iteration = (status: string, complete = false, overdue = false): AskSubject => ({
  kind: "iteration",
  id: "s10",
  title: "チケット詳細の改善",
  status,
  complete,
  overdue,
});
const epic = (status: string): AskSubject => ({
  kind: "epic",
  id: "e9",
  title: "溜まりを閉じる",
  status,
});

describe("依頼文の組み立て", () => {
  it("Skill 形式は Skill の呼び出しと指示だけで、題・説明の文・対象の一覧を入れない", () => {
    const view = buildAsk({
      subjects: [ticket({ status: "review" })],
      note: "  スクリーンショットも見て  ",
    });
    expect(view).toMatchObject({ action: "done", skill: "/dgdone", kind: "prompt" });
    expect(view.text).toBe("/dgdone t265\nスクリーンショットも見て");
    // 指示がなければ呼び出しの 1 行だけ。複数の対象は 1 行目に並べる
    expect(buildAsk({ subjects: [ticket(), ticket({ id: "t266" })], action: "plan" }).text).toBe(
      "/dgplan t265 t266",
    );
    // 題と Status・Iteration は画面の札のツールチップ（line）にだけ出す
    expect(view.text).not.toContain("右の列を細くする");
    expect(view.targets[0]!.line).toBe("t265「右の列を細くする」（review, s10）");
    expect(buildAsk({ subjects: [ticket({ iteration: null })] }).targets[0]!.line).toBe(
      "t265「右の列を細くする」（todo, Iteration なし）",
    );
  });

  it("文章だけの形式は、対象の ID を含む頼む 1 文・dg の呼び方（--json --actor agent）・指示の 3 行になる", () => {
    const view = buildAsk({
      subjects: [ticket({ status: "review" })],
      format: "text",
      note: "急がない",
    });
    expect(view.text).toBe(
      [
        "t265 の PR のマージを照合し、残った受け入れ条件を確かめて片付けてください。",
        ASK_DG_USAGE,
        askGuideLine("/dgdone"),
        "急がない",
      ].join("\n"),
    );
    expect(ASK_DG_USAGE).toContain("--json --actor agent");
    // PATH に dg がないときの置き換えの案内も、文章の形式に入る
    expect(ASK_DG_USAGE).toContain(DG_PATH_NOTE);
    expect(view.text).toContain("mise run dg --");
    expect(view.text).not.toContain("/dgdone");
    expect(view.text).not.toContain("右の列を細くする");
    // 複数の対象は頼む 1 文に並べる
    expect(
      buildAsk({
        subjects: [ticket(), ticket({ id: "t266" })],
        action: "plan",
        format: "text",
      }).text.split("\n")[0],
    ).toBe("t265・t266 を進める Plan を立て、承認を待ってください。");
  });

  it("文章だけの形式は、Skill を持つ頼むことごとにその段階の guide を読む一文を最後の指示の前に添え、Skill を持たないものには添えない", () => {
    const topics: [AskAction, string][] = [
      ["create", "import"],
      ["create_iteration", "assign"],
      ["plan", "plan"],
      ["work", "work"],
      ["done", "done"],
      ["all", "all"],
      ["release", "release"],
      ["check", "check"],
    ];
    for (const [action, topic] of topics) {
      const subjects = action.startsWith("create")
        ? []
        : action === "release" || action === "all"
          ? [iteration("active")]
          : [ticket({ status: action === "done" ? "review" : "todo" })];
      const view = buildAsk({ subjects, action, format: "text", note: "指示" });
      const lines = view.text.split("\n");
      expect(view.skill).not.toBeNull();
      expect(lines.at(-2)).toBe(
        `手順は \`dg guide ${topic}\` を読み、そのとおりに進めてください。`,
      );
      expect(lines.at(-1)).toBe("指示");
    }
    // Skill を持たない頼むことは変わらない（guide の一文なし）
    const none = buildAsk({ subjects: [iteration("active")], action: "close", format: "text" });
    expect(none.skill).toBeNull();
    expect(none.text).not.toContain("dg guide");
  });

  it("起票・作成は 1 行目に ID を並べず、行き先は次の行の短い頼みごとに書き、文章だけの形には --created-by human を添える", () => {
    for (const action of ["create", "create_iteration", "create_epic"] as const) {
      const view = buildAsk({ subjects: [], action });
      expect(view.text.split("\n")[0]).toBe(action === "create" ? "/dgimport" : "/dgassign");
      expect(buildAsk({ subjects: [], action, format: "text" }).text).toContain(
        "--created-by human",
      );
    }
    // 対象のない起票は呼び出しだけ。Iteration・Epic を作るは呼び出しだけでは決まらないので頼みごとを添える
    expect(buildAsk({ subjects: [], action: "create" }).text).toBe("/dgimport");
    expect(buildAsk({ subjects: [], action: "create_iteration" }).text).toBe(
      "/dgassign\nIteration を作って",
    );
    const into = buildAsk({ subjects: [iteration("active")], action: "create", note: "見出し" });
    expect(into.label).toBe("起票して s10 に入れる");
    expect(into.text).toBe("/dgimport\n起票して s10 に入れて\n見出し");
    expect(
      buildAsk({ subjects: [iteration("active")], action: "create", format: "text" }).text.split(
        "\n",
      )[0],
    ).toBe(
      "指示の内容をチケットにして s10 に入れてください（人の指示なので --created-by human を付ける）。",
    );
    // 分けるは直すと同じ呼び出しになるので、分けることを添える
    expect(buildAsk({ subjects: [ticket()], action: "fix" }).text).toBe("/dgimport t265");
    const split = buildAsk({ subjects: [ticket()], action: "split", note: "画面と CLI で" });
    expect(split.text).toBe("/dgimport t265\nt265 を分けて\n画面と CLI で");
    expect(buildAsk({ subjects: [ticket()], action: "split", format: "text" }).text).toContain(
      "--created-by human",
    );
  });

  it("同じ呼び出しになる頼むことは、頼みごとの 1 行で区別する（組み直すと承認する・持ち越しとふつうの割り当て）", () => {
    const pending: AskSubject = {
      kind: "plan",
      id: "p3",
      status: "pending_approval",
      tickets: ["t1"],
      complete: false,
    };
    expect(buildAsk({ subjects: [pending], action: "approve" }).text).toBe("/dgplan p3");
    expect(buildAsk({ subjects: [pending], action: "plan" }).text).toBe(
      "/dgplan p3\np3 を組み直して",
    );
    // Plan でない対象の計画は呼び出しだけ
    expect(buildAsk({ subjects: [ticket()], action: "plan" }).text).toBe("/dgplan t265");
    expect(buildAsk({ subjects: [iteration("closed")], action: "assign" }).text).toBe(
      "/dgassign s10\ns10 の持ち越しを割り当てて",
    );
    expect(buildAsk({ subjects: [iteration("active")], action: "assign" }).text).toBe(
      "/dgassign s10",
    );
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
      expect(view.text).toContain("（人の指示");
    }
  });

  it("終了日を過ぎて未完了がある active の Iteration は持ち越しの相談（carry）がおすすめで、close を使わない。human_only に iteration.close があってもコマンドにならない", () => {
    const overdue: AskSubject = iteration("active", false, true);
    expect(askActions([overdue])[0]).toBe("carry");
    // 期限内・全件終了・閉じたものには出さない
    for (const s of [iteration("active"), iteration("active", true), iteration("closed")])
      expect(askActions([s])).not.toContain("carry");
    const view = buildAsk({
      subjects: [overdue],
      action: "carry",
      humanOnly: ["iteration.close", "iteration.update"],
    });
    expect(view.kind).toBe("prompt");
    expect(view.human_only).toEqual([]);
    expect(view.text).toContain("持ち越すか続けるか");
    expect(view.text).toContain("書き換えない");
    // 閉じる依頼（人の指示で閉じる）の文にならない
    expect(view.text).not.toContain("閉じてください");
    expect(view.text).not.toContain("dg iteration close");
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
    // Epic の直すは題・概要を直すので、人に回すコマンドも題と本文を直す
    const edit = buildAsk({
      subjects: [epic("open")],
      action: "edit",
      humanOnly: ["epic.update"],
    });
    expect(edit).toMatchObject({ kind: "command", label: "題・概要を直す" });
    expect(edit.text).toBe(`dg epic update ${epic("open").id} --title "<題>" --body "<概要>"`);
    // Iteration の直すは名前・目標・期間を直すので、人に回すコマンドも名前・目標・期間を直す
    const editIt = buildAsk({
      subjects: [iteration("active")],
      action: "edit",
      humanOnly: ["iteration.update"],
    });
    expect(editIt).toMatchObject({ kind: "command", label: "名前・目標・期間を直す" });
    expect(editIt.text).toBe(
      'dg iteration update s10 --name "<名前>" --goal "<目標>" --start "<開始日>" --end "<終了日>"',
    );
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

  it("Skill を使わない頼むことは、Skill 形式でも頼む 1 文と dg の呼び方の形になる", () => {
    const view = buildAsk({ subjects: [iteration("active")], action: "close" });
    expect(view.skill).toBeNull();
    expect(view.text).toBe(
      [
        "s10 を閉じてください（人の指示。終わっていないチケットがあれば閉じる前に知らせる）。",
        ASK_DG_USAGE,
      ].join("\n"),
    );
  });

  it("対象も指示もない自由な依頼は使い方の誤り", () => {
    expect(() => buildAsk({ subjects: [], action: "free" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    // 対象のない自由な依頼は、頼む 1 文がなく dg の呼び方と指示だけ
    expect(buildAsk({ subjects: [], action: "free", note: "様子を見て" }).text).toBe(
      `${ASK_DG_USAGE}\n様子を見て`,
    );
  });

  it("候補にない頼むことは使い方の誤りで、候補を添える", () => {
    expect(() => buildAsk({ subjects: [ticket({ status: "review" })], action: "all" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT", detail: expect.stringContaining("done（") }),
    );
  });
});

describe("人に回すかを決める操作の名前", () => {
  it("すべての頼むことを候補に出して human の check を残らず集め、どれも registry にあるコマンドの名前か確かめる（打ち間違えると人に回らないまま依頼文を返す）", () => {
    const plan = (status: PlanState, complete = false): AskSubject => ({
      kind: "plan",
      id: "p33",
      status,
      tickets: ["t307"],
      complete,
    });
    // 頼むことがどれも候補に出るよう、対象の種類と状態（と外すのための within）を並べる
    const samples: Array<[AskSubject[], string?]> = [
      [[]],
      [[ticket({ status: "review" })]],
      [[ticket({ status: "done" })]],
      [[ticket({ status: "abandoned" })]],
      [[ticket({ status: "in_progress" })]],
      [[ticket({ iteration: null, iteration_status: null })]],
      [[ticket({ iteration_status: "closed" })]],
      [[ticket(), ticket({ id: "t266" })]],
      [[ticket({ iteration_status: "active" })]],
      [[ticket({ deps_done: false })]],
      [[iteration("closed")]],
      [[iteration("active", true)]],
      [[iteration("active")]],
      [[iteration("active", false, true)]],
      [[iteration("planned")]],
      [[epic("closed")]],
      [[epic("open")]],
      [[plan("closed")]],
      [[plan("pending_approval")]],
      [[plan("approved", true)]],
      [[plan("approved")]],
      [[ticket(), epic("open")]],
      [[ticket()], "s10"],
      [[ticket({ epic: "e9" })], "e9"],
    ];
    const names = new Set(commands.map((c) => c.name));
    const seen = new Set<string>();
    const checked = new Set<string>();
    const unknown: string[] = [];
    for (const [s, within] of samples)
      for (const action of askActions(s, within)) {
        seen.add(action);
        for (const name of askHumanChecks(action, s, within)) {
          checked.add(name);
          if (!names.has(name)) unknown.push(`${action}: ${name}`);
        }
      }
    expect([...ASK_ACTIONS].filter((a) => !seen.has(a))).toEqual([]);
    expect(unknown).toEqual([]);
    // 人に回しうる操作をすべて集めたか（対象の状態の並べ方の誤りで、照らさない名前が出ないように）
    expect([...checked].sort()).toEqual([
      "epic.add",
      "epic.close",
      "epic.create",
      "epic.remove",
      "epic.reopen",
      "epic.update",
      "iteration.add",
      "iteration.close",
      "iteration.create",
      "iteration.remove",
      "iteration.reopen",
      "iteration.update",
      "plan.approve",
      "ticket.create",
      "ticket.import",
      "ticket.move",
    ]);
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

  it("詳細の中の行（within）なら、入っている Iteration・Epic から外すを直すの後に足す。入っていない・終わったチケットには足さない", () => {
    expect(askActions([ticket()], "s10")).toEqual([
      "work",
      "plan",
      "fix",
      "remove",
      "split",
      "check",
      "abandon",
      "free",
    ]);
    // 直すのない候補（in_progress で実行中）では自由にの前
    expect(askActions([ticket({ status: "in_progress", running: true })], "s10")).toEqual([
      "status",
      "fix",
      "remove",
      "free",
    ]);
    expect(askActions([ticket({ epic: "e9" })], "e9")).toContain("remove");
    expect(askActions([ticket()], "s11")).not.toContain("remove");
    expect(askActions([ticket()], "e9")).not.toContain("remove");
    expect(askActions([ticket({ status: "done" })], "s10")).not.toContain("remove");
    expect(askActions([iteration("active")], "s10")).not.toContain("remove");

    const view = buildAsk({ subjects: [ticket()], action: "remove", within: "s10" });
    expect(view.label).toBe("s10 から外す");
    expect(view.text).toBe("/dgassign t265\ns10 から外して");
    const human = buildAsk({
      subjects: [ticket({ epic: "e9" })],
      action: "remove",
      within: "e9",
      humanOnly: ["epic.remove"],
    });
    expect(human).toMatchObject({ kind: "command", text: "dg epic remove e9 t265" });
    // within がなければ外すは候補にない
    expect(() => buildAsk({ subjects: [ticket()], action: "remove" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("止まったものの再開は、1 行目に実行中の Run のないチケットだけを並べる", () => {
    const view = buildAsk({
      subjects: [
        ticket({ id: "t263", status: "in_progress", running: true }),
        ticket({ id: "t264", status: "in_progress" }),
      ],
    });
    expect(view.action).toBe("resume");
    expect(view.text).toBe("/dgwork t264");
    // 文章だけの形では、実行中のものに触らないよう添える
    expect(buildAsk({ subjects: view.targets, format: "text" }).text.split("\n")[0]).toBe(
      "止まっている t264 の作業を再開してください（t263 は Run が実行中なので触らない）。",
    );
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
    const t1 = await run({ targets: ["t1"], format: "skill" });
    expect(t1.action).toBe("work");
    expect(t1.text).toBe("/dgwork t1");
    expect(t1.text).not.toContain("本文の秘密");
    // 依存先が終わっていない todo は待ちを確かめる
    expect((await run({ targets: ["t2"] })).label).toBe("待ちを確かめる");
    expect((await run({ targets: ["s1"] })).targets[0]).toMatchObject({
      kind: "iteration",
      line: "Iteration s1「Sprint 1」（active）",
      sub: "active",
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
    expect((await run({ targets: ["p1"] })).targets[0]).toMatchObject({
      line: "Plan p1（承認待ち、t1 t2）",
      sub: "承認待ち",
    });

    // 番号だけの ID は種類が決まらないので使い方の誤り、ないものは NOT_FOUND
    await expect(runCommand(ask, ctx, { targets: ["1"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(runCommand(ask, ctx, { targets: ["t9"] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("形式を省けば、dg の Skill がリポジトリか HOME の .claude/skills にあるときだけ Skill、なければ文章の形にし、渡した形式はそのまま使う", async () => {
    const { cwd } = await initialized();
    const home = await mkdtemp(join(tmpdir(), "dg-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const ctx = await openContext({ cwd, actor, env: { HOME: home } });
    await runCommand(ticketCreate, ctx, { title: "A" });
    const run = async (input: Record<string, unknown>) =>
      (await runCommand(ask, ctx, { targets: ["t1"], action: "fix", ...input })).data;
    const skill = async (base: string, name: string) => {
      await mkdir(join(base, ".claude", "skills", name), { recursive: true });
      await writeFile(join(base, ".claude", "skills", name, "SKILL.md"), "---\nname: x\n---\n");
    };
    const textForm = (await run({ format: "text" })).text;

    // どちらにもなければ文章の形。dg の Skill でない名前の Skill は数えない
    await skill(home, "kfplan");
    expect(await run({})).toMatchObject({ format: "text", text: textForm });
    // 人が選んだ形式は、Skill がなくてもそのまま
    expect((await run({ format: "skill" })).text).toBe("/dgimport t1");

    // HOME（~/.claude/skills）にあれば Skill の形。頼むことの Skill と別の dg の Skill でもよい
    await skill(home, "dgplan");
    expect(await run({})).toMatchObject({ format: "skill", text: "/dgimport t1" });
    expect((await run({ format: "text" })).text).toBe(textForm);

    // リポジトリ（<リポジトリ>/.claude/skills）にあっても Skill の形
    await rm(join(home, ".claude"), { recursive: true });
    expect((await run({})).format).toBe("text");
    await skill(cwd, "dgwork");
    expect(await run({})).toMatchObject({ format: "skill", text: "/dgimport t1" });
  });

  it("within は Iteration・Epic を引いて確かめ、ask-menu の組は @ を付けた場所を受ける", async () => {
    const { ctx } = await initialized();
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationCreate, ctx, { name: "Sprint 1" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    const view = (await runCommand(ask, ctx, { targets: ["t1"], within: "s1" })).data;
    expect(view.candidates.map((c) => c.label)).toContain("s1 から外す");
    await expect(runCommand(ask, ctx, { targets: ["t1"], within: "t1" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(runCommand(ask, ctx, { targets: ["t1"], within: "s9" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const menus = (await runCommand(askMenu, ctx, { sets: ["@s1 t1", "t1"] })).data;
    expect(menus.map((m) => m.key)).toEqual(["t1 @s1", "t1"]);
    expect(menus[0]!.candidates.map((c) => c.action)).toContain("remove");
    expect(menus[1]!.candidates.map((c) => c.action)).not.toContain("remove");
  });

  it("ask-menu の組の鍵は ID を空白でつなぎ @ を付けた場所を後ろに置き、分けると元に戻る", () => {
    expect(askMenuKey([])).toBe("");
    expect(askMenuKey(["t1", "t2"], "s3")).toBe("t1 t2 @s3");
    expect(parseAskMenuKey("t1 t2 @s3")).toEqual({ refs: ["t1", "t2"], within: "s3" });
    // 場所を重ねたら後のもの、空白が重なっても分ける
    expect(parseAskMenuKey(" @e1  t1 @s3 ")).toEqual({ refs: ["t1"], within: "s3" });
    expect(parseAskMenuKey("")).toEqual({ refs: [], within: undefined });
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
