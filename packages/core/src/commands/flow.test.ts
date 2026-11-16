import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { composeGuide } from "../guide/guide.js";
import { findGuideSection, guideSections } from "../guide/sections.js";
import { configSchema } from "../model/config.js";
import type { Decision } from "../model/workflow.js";
import { DEFAULT_WORKFLOW, type CustomStage } from "../workflow/resolve.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { checkpoint, type CheckpointResult } from "./checkpoint.js";
import {
  FLOW_GUIDE,
  approvalOf,
  flowNext,
  flowStageOf,
  type FlowApproval,
  type FlowDecisions,
  type FlowFacts,
  type FlowNext,
  type FlowStageName,
} from "./flow.js";
import { flowLocalPath } from "./flow-records.js";
import { history } from "./history.js";
import { iterationAdd, iterationClose, iterationCreate, iterationReopen } from "./iteration.js";
import { planApprove, planClose, planCreate } from "./plan.js";
import { findCommand } from "./registry.js";
import { init } from "./setup.js";
import { ticketCheck, ticketCreate, ticketMove, ticketUpdate } from "./ticket.js";
import { workflowSet } from "./workflow.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** 流れの事実。既定は s1 の t1（in_progress）だけで、点検の関所は通っていて、候補も Plan もない */
const facts = (over: Partial<FlowFacts> = {}): FlowFacts => ({
  iteration: "s1",
  iterationClosed: false,
  targets: [{ id: "t1", status: "in_progress" }],
  releaseScope: [{ id: "t1", status: "in_progress" }],
  candidates: [],
  asked: [],
  checked: true,
  audited: false,
  releasePassed: false,
  passedStages: [],
  pendingPlans: [],
  approvedPlans: [],
  unplanned: [],
  noAssign: false,
  ...over,
});
const finished = (): Partial<FlowFacts> => ({
  targets: [
    { id: "t1", status: "done" },
    { id: "t2", status: "abandoned" },
  ],
  releaseScope: [
    { id: "t1", status: "done" },
    { id: "t2", status: "abandoned" },
  ],
});

describe("flowStageOf（流れの 8 つの規則）", () => {
  it("規則 1 割り当て：割り当ての関所の記録が見ていない候補があり、見直し済みでなく、--no-assign がない", () => {
    const f = facts({ candidates: ["t2"], checked: false });
    expect(flowStageOf(f)).toMatchObject({ name: "assign", rule: 1, tickets: ["t2"] });
    // どれか 1 つが欠ければ割り当てでなく点検
    expect(flowStageOf({ ...f, asked: ["t2"] }).name).toBe("check");
    expect(flowStageOf({ ...f, noAssign: true }).name).toBe("check");
    expect(flowStageOf({ ...f, audited: true }).name).toBe("check");
    expect(flowStageOf(facts({ checked: false })).name).toBe("check");
  });

  it("規則 1 割り当て：記録のあとに増えた候補だけを聞き直す（人が入れないと決めた候補は聞き直さない）", () => {
    const f = facts({ candidates: ["t2", "t3"], asked: ["t2"] });
    expect(flowStageOf(f)).toMatchObject({ name: "assign", rule: 1, tickets: ["t3"] });
  });

  it("規則 2 点検：今のチケットの事実で通った点検の記録がなければ、Plan や終わりの状態によらず点検", () => {
    expect(flowStageOf(facts({ ...finished(), checked: false }))).toMatchObject({
      name: "check",
      rule: 2,
    });
  });

  it("規則 3 計画：対象を含む承認待ちの Plan があれば、その Plan の承認を得る（承認済みの Plan より先）", () => {
    const f = facts({
      pendingPlans: [{ id: "p2", tickets: ["t1"] }],
      approvedPlans: [{ id: "p1", unfinished: ["t3"], finished: false }],
    });
    expect(flowStageOf(f)).toMatchObject({
      name: "plan",
      rule: 3,
      plan: "p2",
      tickets: ["t1"],
    });
  });

  it("規則 4 作業：承認済みの Plan に終わっていないチケットがあれば作業。終わったものだけの Plan は飛ばす", () => {
    const f = facts({
      approvedPlans: [
        { id: "p1", unfinished: [], finished: true },
        { id: "p3", unfinished: ["t1"], finished: false },
      ],
      unplanned: ["t4"],
    });
    expect(flowStageOf(f)).toMatchObject({
      name: "work",
      rule: 4,
      plan: "p3",
      tickets: ["t1"],
    });
  });

  it("規則 4 閉じる：承認済みの開いた Plan が終わっていれば（すべて done か abandoned）閉じる。作業の段階より後で、計画より先", () => {
    const f = facts({
      approvedPlans: [{ id: "p1", unfinished: [], finished: true }],
      unplanned: ["t4"],
    });
    expect(flowStageOf(f)).toMatchObject({
      name: "close",
      rule: 4,
      plan: "p1",
      tickets: [],
    });
    // 作業が残る Plan があれば、終わった Plan を閉じるより先に作業
    const both = facts({
      approvedPlans: [
        { id: "p1", unfinished: [], finished: true },
        { id: "p3", unfinished: ["t1"], finished: false },
      ],
    });
    expect(flowStageOf(both).name).toBe("work");
    // 閉じたあとは規則 5 の計画へ進む
    expect(flowStageOf({ ...f, approvedPlans: [] }).name).toBe("plan");
    // work を飛ばすと、閉じる手も返さない（閉じるのは作業の規則の一部）
    expect(flowStageOf(f, ["work"]).name).toBe("plan");
  });

  it("規則 5 計画：開いた Plan に入っていない todo があれば計画（Plan はまだない）", () => {
    expect(flowStageOf(facts({ unplanned: ["t4"] }))).toMatchObject({
      name: "plan",
      rule: 5,
      plan: null,
      tickets: ["t4"],
    });
  });

  it("規則 6 見直し：すべて done か abandoned で、見直し済みでない", () => {
    expect(flowStageOf(facts(finished()))).toMatchObject({ name: "audit", rule: 6 });
  });

  it("規則 7 リリース：すべて done か abandoned で、見直し済み（今 done のチケットをすべて見た見直しの記録がある）。リリースの関所を通った後も、閉じるまでリリースを返す", () => {
    const audited = facts({ ...finished(), audited: true });
    const before = flowStageOf(audited);
    expect(before).toMatchObject({ name: "release", rule: 7 });
    expect(before.reason).toContain("the release checkpoint is not passed yet");
    const after = flowStageOf({ ...audited, releasePassed: true });
    expect(after).toMatchObject({ name: "release", rule: 7 });
    expect(after.reason).toContain("the release checkpoint is passed");
  });

  it("規則 8 止まる：どれにも当たらない（PR のない in_progress だけなど）", () => {
    expect(flowStageOf(facts())).toMatchObject({ name: "stop", rule: 8, tickets: ["t1"] });
    // チケットのない Iteration は見直さない
    expect(flowStageOf(facts({ targets: [], releaseScope: [] })).name).toBe("stop");
  });

  it("Iteration が 1 つに決まらない流れ：割り当て（Iteration を決める）だけを返し、決まらなければ点検にも進まずに止まる", () => {
    const loose = facts({ iteration: null, releaseScope: [], candidates: ["t1"], checked: false });
    const assign = flowStageOf(loose);
    expect(assign).toMatchObject({ name: "assign", rule: 1, tickets: ["t1"] });
    expect(assign.reason).toContain("the flow needs one Iteration");
    // 入れないと決めた（割り当ての記録が見た）・--no-assign・割り当てを飛ばす：記録を書く Iteration がないので止まる
    for (const stage of [
      flowStageOf({ ...loose, asked: ["t1"] }),
      flowStageOf({ ...loose, noAssign: true }),
      flowStageOf(loose, ["assign"]),
    ]) {
      expect(stage).toMatchObject({ name: "stop", rule: 8, tickets: ["t1"] });
      expect(stage.reason).toContain("No single Iteration is determined");
    }
    // 対象がすべて終わっていれば、見直しもリリースもないと伝える
    const done = flowStageOf(facts({ ...finished(), iteration: null, releaseScope: [] }));
    expect(done).toMatchObject({ name: "stop", rule: 8 });
    expect(done.reason).toContain("no single Iteration is determined");
  });

  it("閉じた Iteration：見直しもリリースもせず、流れを終えたとして止まる（点検はする）", () => {
    const closed = facts({ ...finished(), iterationClosed: true, audited: true });
    const stage = flowStageOf(closed);
    expect(stage).toMatchObject({ name: "stop", rule: 8 });
    expect(stage.reason).toBe("s1 is closed, and the flow is finished");
    expect(flowStageOf({ ...closed, audited: false }).name).toBe("stop");
    expect(flowStageOf({ ...closed, checked: false }).name).toBe("check");
  });

  it("チケットの指定：対象が終わっても、Iteration のほかのチケットが残れば見直さない", () => {
    const f = facts({
      targets: [{ id: "t1", status: "done" }],
      releaseScope: [
        { id: "t1", status: "done" },
        { id: "t5", status: "in_progress" },
      ],
    });
    expect(flowStageOf(f).name).toBe("stop");
  });
});

describe("flow next のヘルプの文（summary）", () => {
  it("規則 7 の説明が release-<S> のチケットを数えないことを書き、文の区切りに空白が抜けない", () => {
    const rule7 = /7 release:[^/]*/.exec(flowNext.summary)?.[0] ?? "";
    expect(rule7).toContain("audited");
    expect(rule7).toContain("release-<S>");
    // 見直し済みの判定は、見直しの関所の記録と、見直しが見ない audit-<S>・release-<S> のチケットで説明する
    expect(flowNext.summary).toContain(
      "tickets labeled audit-<S> or release-<S> are not looked at",
    );
    // 文をつないだときに空白が抜けると「run.For」のように次の文に続く（t945）
    expect(flowNext.summary).not.toMatch(/[a-z)]\.[A-Z]/);
    expect(checkpoint.summary).not.toMatch(/[a-z)]\.[A-Z]/);
  });

  it("--resume を受けない（関所の記録が段階を決めるので、写して渡す値はない）", () => {
    expect(flowNext.input.safeParse({ targets: ["s1"] }).success).toBe(true);
    expect(Object.keys(flowNext.input.shape)).not.toContain("resume");
    expect(flowNext.summary).not.toContain("resume");
  });
});

describe("flowStageOf の flow.skip（飛ばした段階は返さない）", () => {
  it("割り当て・点検・計画・作業を飛ばすと、その規則を読まずに次の規則に進む", () => {
    const f = facts({ candidates: ["t2"], unplanned: ["t1"], checked: false });
    expect(flowStageOf(f, ["assign"]).name).toBe("check");
    expect(flowStageOf(f, ["assign", "check"]).name).toBe("plan");
    expect(flowStageOf({ ...f, checked: true, asked: ["t2"] }, ["plan"]).name).toBe("stop");
    const pending = facts({ pendingPlans: [{ id: "p1", tickets: ["t1"] }] });
    expect(flowStageOf(pending).name).toBe("plan");
    expect(flowStageOf(pending, ["plan"]).name).toBe("stop");
    const working = facts({ approvedPlans: [{ id: "p1", unfinished: ["t1"], finished: false }] });
    expect(flowStageOf(working).name).toBe("work");
    expect(flowStageOf(working, ["work"]).name).toBe("stop");
  });

  it("見直しを飛ばすと、すべて終わったときは見直しを返さずリリースを返す。リリースも飛ばすと止まる", () => {
    const done = facts(finished());
    expect(flowStageOf(done, ["audit"])).toMatchObject({
      name: "release",
      rule: 7,
    });
    expect(flowStageOf(done, ["audit", "release"])).toMatchObject({
      name: "stop",
      rule: 8,
      tickets: [],
    });
    // 飛ばさなければ、見直しの記録がないので見直し
    expect(flowStageOf(done).name).toBe("audit");
  });

  it("リリースを飛ばすと、見直しまでで止まる。見直しを終えた後にリリースを繰り返さない", () => {
    const done = facts(finished());
    expect(flowStageOf(done, ["release"]).name).toBe("audit");
    expect(flowStageOf({ ...done, audited: true }, ["release"]).name).toBe("stop");
  });

  it("飛ばさなければ今までどおり（既定の skip は空）", () => {
    const f = facts({ candidates: ["t2"] });
    expect(flowStageOf(f, [])).toEqual(flowStageOf(f));
  });
});

describe("flowStageOf の独自の段階（after の位置で返す）", () => {
  const stage = (id: string, after: CustomStage["after"]) => ({ id, after });
  /** 関所を通った段階を足した事実 */
  const passing = (f: FlowFacts, ...names: string[]): FlowFacts => ({
    ...f,
    passedStages: [...f.passedStages, ...names],
  });

  it("after の同梱の段階を終えたところで、次の同梱の段階の前に返す（assign・check・plan・work・audit）", () => {
    const custom = [
      stage("on-assign", "assign"),
      stage("on-check", "check"),
      stage("on-plan", "plan"),
      stage("on-work", "work"),
      stage("on-audit", "audit"),
    ];
    const of = (f: FlowFacts) => flowStageOf(f, [], custom).name;
    // 割り当ての候補が残るうちは割り当て。終えると、点検の前に assign のあとの段階
    const start = facts({ candidates: ["t2"], checked: false, unplanned: ["t1"] });
    expect(of(start)).toBe("assign");
    const assigned = { ...start, asked: ["t2"] };
    expect(flowStageOf(assigned, [], custom)).toEqual({
      name: "on-assign",
      rule: null,
      after: "assign",
      reason:
        "The stage on-assign of this board comes after assign, and its checkpoint is not passed",
      plan: null,
      tickets: [],
    });
    // 関所を通ると次へ：点検 → check のあとの段階 → 計画（Plan に入っていない todo が残るうちは plan のあとの段階を返さない）
    let f = passing(assigned, "on-assign");
    expect(of(f)).toBe("check");
    f = { ...f, checked: true };
    expect(of(f)).toBe("on-check");
    f = passing(f, "on-check");
    expect(of(f)).toBe("plan");
    f = { ...f, unplanned: [], pendingPlans: [{ id: "p1", tickets: ["t1"] }] };
    expect(of(f)).toBe("plan");
    // 承認されると、作業の前に plan のあとの段階
    f = {
      ...f,
      pendingPlans: [],
      approvedPlans: [{ id: "p1", unfinished: ["t1"], finished: false }],
    };
    expect(of(f)).toBe("on-plan");
    f = passing(f, "on-plan");
    expect(of(f)).toBe("work");
    // 作業が残るうちは work のあとの段階を返さない。すべて終えると、見直しの前に返す
    f = { ...f, ...finished(), approvedPlans: [] };
    expect(of(f)).toBe("on-work");
    f = passing(f, "on-work");
    expect(of(f)).toBe("audit");
    // 見直しを終えると、リリースの前に audit のあとの段階
    f = { ...f, audited: true };
    expect(of(f)).toBe("on-audit");
    expect(of(passing(f, "on-audit"))).toBe("release");
    // 独自の段階がなければ、同じ事実で今までどおり
    expect(flowStageOf(f).name).toBe("release");
  });

  it("同じ after の段階は書いた順に 1 つずつ返し、skip に書いた段階は返さない", () => {
    // 名前の順（a が先）でなく、書いた順（z-first が先）
    const custom = [stage("z-first", "work"), stage("b", "audit"), stage("a", "work")];
    const done = facts(finished());
    expect(flowStageOf(done, [], custom).name).toBe("z-first");
    expect(flowStageOf(passing(done, "z-first"), [], custom).name).toBe("a");
    expect(flowStageOf(passing(done, "z-first", "a"), [], custom).name).toBe("audit");
    expect(flowStageOf(done, ["z-first"], custom).name).toBe("a");
    // after の同梱の段階を飛ばしても、その位置で返す
    const worked = passing(done, "z-first", "a");
    expect(flowStageOf(worked, ["audit"], custom).name).toBe("b");
    expect(flowStageOf(passing(worked, "b"), ["audit"], custom).name).toBe("release");
  });

  it("release と retro のあとの段階は Iteration を閉じた後に返す。retro のあとは、振り返りの関所を通ってから", () => {
    const custom = [stage("announce", "release"), stage("follow-up", "retro")];
    const open = facts({ ...finished(), audited: true });
    // 閉じるまではリリースを返し続ける
    expect(flowStageOf(open, [], custom).name).toBe("release");
    const closed = { ...open, iterationClosed: true };
    expect(flowStageOf(closed, [], custom)).toMatchObject({ name: "announce", after: "release" });
    // 振り返りは流れの外なので、関所の記録がなければ止まる（振り返りを待つ）
    const announced = passing(closed, "announce");
    expect(flowStageOf(announced, [], custom).name).toBe("stop");
    expect(flowStageOf(passing(announced, "retro"), [], custom).name).toBe("follow-up");
    expect(flowStageOf(passing(announced, "retro", "follow-up"), [], custom).name).toBe("stop");
    // retro を飛ばす流れでは、振り返りを待たない
    expect(flowStageOf(announced, ["retro"], custom).name).toBe("follow-up");
    // release を飛ばす流れでは、すべて終えて見直しも終えたところで返す
    expect(flowStageOf(open, ["release"], custom).name).toBe("announce");
  });

  it("閉じた Iteration では、流れの途中（release より前）の段階を返さない", () => {
    const custom = [stage("on-assign", "assign"), stage("on-work", "work")];
    const closed = facts({ ...finished(), audited: true, iterationClosed: true });
    expect(flowStageOf(closed, [], custom)).toMatchObject({ name: "stop", rule: 8 });
  });
});

/** 既定の Workflow の値（flow と、マージを判定する review → done の境目の decide） */
const DEFAULT_DECISIONS: FlowDecisions = {
  flow: DEFAULT_WORKFLOW.flow.stages,
  merge: DEFAULT_WORKFLOW.boundaries.find((b) => b.to === "done")!.decide,
};
const STAGES = ["assign", "check", "plan", "work", "audit", "release"] as const;

describe("approvalOf（承認の要否は Workflow の値から決まる）", () => {
  it("--auto がなければ既定のどの段階も承認を求め、止まるときは求めない", () => {
    for (const stage of STAGES)
      expect(approvalOf(stage, { auto: false, ...DEFAULT_DECISIONS }), stage).toMatchObject({
        required: true,
        auto: null,
        auto_ok: false,
      });
    expect(approvalOf("stop", { auto: false, ...DEFAULT_DECISIONS })).toEqual({
      required: false,
      what: null,
      auto: null,
      auto_ok: false,
      value: null,
      agent: "allow",
    });
  });

  it("既定の値では --auto が ask_unless_auto の割り当て・点検の直す行・Plan・マージを聞かずに進め、always_ask の見直しと human_only のリリースは聞く", () => {
    const auto = (stage: Parameters<typeof approvalOf>[0]) =>
      approvalOf(stage, { auto: true, ...DEFAULT_DECISIONS });
    expect(auto("assign")).toEqual({
      required: false,
      what: null,
      auto: "Rows to add",
      auto_ok: true,
      value: "flow.assign: ask_unless_auto",
      agent: "allow",
    });
    expect(auto("plan")).toMatchObject({
      required: false,
      auto: "Approving the Plan (plan approve --auto)",
      auto_ok: true,
      value: "flow.plan: ask_unless_auto",
    });
    expect(auto("work")).toMatchObject({
      required: false,
      auto_ok: true,
      value: "boundaries review → done: ask_unless_auto",
    });
    // 点検の値が決めるのは直す行だけ。削除・abandoned・閉じるはいつも聞く場所に残る
    expect(auto("check")).toMatchObject({
      required: true,
      what: "Deletions, abandoned, and closing",
      auto: "Fix rows that have exactly one way to fix",
      auto_ok: true,
    });
    expect(auto("audit")).toMatchObject({
      required: true,
      what: "Findings table",
      auto_ok: false,
      value: "flow.audit: always_ask",
      agent: "approval",
    });
    const release = auto("release");
    expect(release).toMatchObject({
      required: true,
      auto: null,
      auto_ok: false,
      value: "flow.release: human_only",
      agent: "reject",
    });
    // 人だけになるのは dg が拒否するリリースの関所と Iteration を閉じる操作。リリースの PR のマージと公開は、人に聞いた後にエージェントが行う
    expect(release.what).toBe(
      "Passing the release checkpoint and closing the Iteration (only a person does them: an agent's calls of dg checkpoint release and dg iteration close are rejected, so ask a person to run them), and merging the release PR and publishing (ask a person before each one; when approved, the agent runs them)",
    );
  });

  it("flow.release が always_ask なら、リリースの段階は人だけの文にならず、マージ・公開・閉じるを人に聞く", () => {
    for (const auto of [false, true])
      expect(
        approvalOf("release", {
          auto,
          ...DEFAULT_DECISIONS,
          flow: { ...DEFAULT_DECISIONS.flow, release: "always_ask" },
        }),
      ).toEqual({
        required: true,
        what: "Merging the release PR, publishing, and closing",
        auto: null,
        auto_ok: false,
        value: "flow.release: always_ask",
        agent: "approval",
      });
  });

  it("値を変えると承認の要否が変わる：always_ask は --auto でも聞き、anyone は --auto がなくても聞かず、human_only は人に頼む", () => {
    const withValue = (
      stage: (typeof STAGES)[number],
      value: Decision,
      auto: boolean,
    ): FlowApproval =>
      approvalOf(stage, {
        auto,
        flow: { ...DEFAULT_DECISIONS.flow, [stage]: value },
        merge: stage === "work" ? value : DEFAULT_DECISIONS.merge,
      });
    for (const stage of ["assign", "plan", "work", "audit", "release"] as const) {
      expect(withValue(stage, "always_ask", true), stage).toMatchObject({
        required: true,
        auto_ok: false,
        agent: "approval",
      });
      // anyone は聞かずに進めるが、--auto が選んだのではないので auto_ok は false
      for (const auto of [false, true])
        expect(withValue(stage, "anyone", auto), stage).toMatchObject({
          required: false,
          auto: null,
          auto_ok: false,
          agent: "allow",
        });
      expect(withValue(stage, "ask_unless_auto", false), stage).toMatchObject({
        required: true,
        auto_ok: false,
        agent: "approval",
      });
      expect(withValue(stage, "ask_unless_auto", true), stage).toMatchObject({
        required: false,
        auto_ok: true,
      });
      expect(withValue(stage, "human_only", true), stage).toMatchObject({
        required: true,
        auto_ok: false,
        agent: "reject",
      });
    }
    // 点検は、直す行を聞かずに進める値でも、削除・abandoned・閉じるを聞く
    expect(withValue("check", "anyone", false)).toMatchObject({
      required: true,
      what: "Deletions, abandoned, and closing",
      auto_ok: false,
    });
    expect(withValue("check", "always_ask", true)).toMatchObject({
      required: true,
      what: "Rows to fix, and deletions, abandoned, and closing",
      auto_ok: false,
    });
  });
});

describe("FLOW_GUIDE（段階の節）", () => {
  type Part = { topic: string; sections: readonly string[] };
  // 段階が返す本文の節の組。also があれば、そのトピックの節が後ろに続く
  const partsOf = (ref: (typeof FLOW_GUIDE)[FlowStageName]): Part[] => [
    ref,
    ...(ref.also ? [ref.also] : []),
  ];
  const bodyOf = (topic: string) =>
    readFile(new URL(`../guide/guide-${topic}.md`, import.meta.url), "utf8");

  it("段階ごとに指す guide の節が core の guide-*.md にある", async () => {
    for (const [stage, ref] of Object.entries(FLOW_GUIDE))
      for (const part of partsOf(ref)) {
        const body = await bodyOf(part.topic);
        for (const section of part.sections)
          expect(findGuideSection(part.topic, body, section).heading, stage).toContain(section);
      }
  });

  // guide.text と同じ本文の 1 トピック分（config は既定値。guide.notes は空なので repoTop は読まない）
  const textOf = async (part: Part) =>
    (await composeGuide(part.topic, configSchema.parse({}), process.cwd(), part.sections)).text;

  it("返す本文が「」で指す同じトピックの節は、返す本文の中にある（参照が閉じている）", async () => {
    for (const [stage, ref] of Object.entries(FLOW_GUIDE))
      for (const part of partsOf(ref)) {
        const body = await bodyOf(part.topic);
        const all = guideSections(body);
        // 返す本文を節に分け直すと、指した節がその順に並ぶ
        const returned = guideSections(`# ${part.topic}\n\n${await textOf(part)}`);
        const wanted = part.sections.map((s) => findGuideSection(part.topic, body, s).name);
        expect(
          returned.map((s) => s.name),
          stage,
        ).toEqual(wanted);
        const names = new Set(returned.flatMap((s) => [s.heading, s.name]));
        for (const s of returned) {
          // 日本語は「」（`dg guide <topic>` の「…」の形も含む）、英語は "" の section（of の後ろにトピックがなければ同じトピック）
          const refs = [
            ...s.text.matchAll(/(?:`dg guide ([a-z]+)`\s*の)?「([^」]+)」/g),
            ...s.text.matchAll(/"([^"]+)"(?: \([^)]*\))? section(?: of `?dg guide ([a-z]+)`?)?/g),
          ].map((m) =>
            m[0].startsWith('"') ? { topic: m[2], name: m[1] } : { topic: m[1], name: m[2] },
          );
          for (const { topic, name } of refs) {
            // ほかのトピックの節は案内されたトピックとして読む（指す先があるかは check:docs が検査する）
            if (topic !== undefined && topic !== part.topic) continue;
            if (!all.some((x) => x.heading === name || x.name === name)) continue;
            expect(names.has(name!), `${stage}：節「${s.name}」が指す「${name}」`).toBe(true);
          }
        }
      }
  });

  it("見直しの段階の本文に、起票するチケットのラベル audit-<S> の付け方が入る", async () => {
    expect(await textOf(FLOW_GUIDE.audit)).toContain(
      "Attach the label `audit-<S>` (for example `audit-s3`)",
    );
  });
});

async function ready(): Promise<CommandContext> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  const actor = { kind: "human" as const, user: "eiki" };
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {});
  return openContext({ cwd: f.cloneA, actor });
}

const flow = async (ctx: CommandContext, input: Record<string, unknown>) => {
  const result = await runCommand(flowNext, ctx, { targets: ["s1"], ...input });
  return { ...(result.data as FlowNext), warnings: result.warnings };
};

/** s1 の関所を通す（文脈は人なので、段階の値によらず承認なしで通る） */
const pass = async (ctx: CommandContext, stage: string, input: Record<string, unknown> = {}) =>
  (await runCommand(checkpoint, ctx, { stage, targets: ["s1"], ...input }))
    .data as CheckpointResult;

describe("dg flow next", () => {
  it("関所の記録で割り当て・点検・見直しを終えたものとして段階を進め、同じ段階で事実が変わらなければ止まる", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "候補" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });

    const assign = await flow(ctx, {});
    expect(assign).toMatchObject({
      target: { iteration: "s1", tickets: ["t1"] },
      stage: { name: "assign", rule: 1, tickets: ["t2"] },
      guide: {
        topic: "assign",
        sections: ["When proposing an assignment", "Iteration"],
        command: 'dg guide assign --section "When proposing an assignment" --section Iteration',
      },
      commands: ["dg --json --actor agent iteration add s1 <tickets to add…> --approved-by human"],
      approval: { required: true, what: "Rows to add" },
    });
    // guide.text は段階の節の本文を順につないだもの（手順の節の見出しから始まり、config を埋めたもの）
    expect(assign.guide.text.startsWith("## When proposing an assignment")).toBe(true);
    expect(assign.guide.text).toContain("\n\n## Iteration\n");
    // 割り当ての関所を通すと（t2 は入れないと決めた）、割り当てを終えたものとして点検に進む
    expect(assign.checkpoint).toBe(
      "dg --json --actor agent checkpoint assign s1 --approved-by human",
    );
    await pass(ctx, "assign");
    const check = await flow(ctx, {});
    expect(check.stage).toMatchObject({ name: "check", rule: 2 });
    expect(check.commands).toEqual([
      "dg --json --actor agent sync",
      "dg --json --actor agent validate",
      "dg --json --actor agent lint",
    ]);
    expect(check.checkpoint).toBe(
      "dg --json --actor agent checkpoint check s1 --approved-by human",
    );
    await pass(ctx, "check");

    const plan5 = await flow(ctx, {});
    expect(plan5.stage).toMatchObject({ name: "plan", rule: 5, tickets: ["t1"] });
    expect(plan5.commands).toEqual(["dg --json --actor agent plan create t1"]);
    // 計画は関所を持たない（Plan の承認の記録が受け持つ）
    expect(plan5.checkpoint).toBeNull();

    await runCommand(planCreate, ctx, { tickets: ["t1"] });
    const plan3 = await flow(ctx, { auto: true });
    expect(plan3).toMatchObject({
      stage: { name: "plan", rule: 3, plan: "p1" },
      commands: [
        "dg --json --actor agent plan show p1",
        "dg --json --actor agent plan approve p1 --auto",
      ],
      approval: { required: false },
    });
    // 承認が得られず、事実が変わらないまま同じ段階が続けば止まる。止まると返したら覚えた段階を忘れるので、次の呼び出しは段階を求め直す
    const stopped = await flow(ctx, { auto: true });
    expect(stopped).toMatchObject({ stage: { name: "stop", rule: null }, repeated: "plan" });
    expect(stopped.ask_human).toContain("The stage plan repeats");
    // 計画は関所を持たないので、関所の案内は足さない
    expect(stopped.ask_human).not.toContain("checkpoint");
    expect((await flow(ctx, { auto: true })).stage.name).toBe("plan");
    // 引数を変えて始め直した呼び出しは、同じ段階でも続いたとみなさない
    expect((await flow(ctx, {})).repeated).toBeNull();

    await runCommand(planApprove, ctx, { plan: "p1" });
    const work = await flow(ctx, {});
    expect(work).toMatchObject({
      stage: { name: "work", rule: 4, plan: "p1", tickets: ["t1"] },
      commands: ["dg --json --actor agent plan show p1", "dg --json --actor agent next t1"],
      approval: {
        required: true,
        what: "Merging each PR (when approved, dg pr merge <id> --approved-by human)",
      },
      repeated: null,
    });
    expect(work.checkpoint).toBeNull();
    // 作業の段階の guide.text には、並列の手順（dg guide parallel の節）が入り、command で読み直せる
    expect(work.guide.text).toContain("## Advancing in parallel");
    expect(work.guide.command).toContain('&& dg guide parallel --section "Advancing in parallel"');
    // dgall の work の段は、work の選択肢で人に尋ねず、手順の終わりで flow next に戻る（guide-all の手順 4 と食い違わない）
    expect(work.guide.text).not.toContain("## Choosing the next step");
    expect(work.guide.text).not.toContain("Stop here");
    expect(work.guide.text).toContain("return to `flow next`");

    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done", override: "PR なし" });
    // 承認済みの Plan のチケットがすべて終わったので、見直しより先に Plan を閉じる（承認は求めない）
    const closing = await flow(ctx, {});
    expect(closing).toMatchObject({
      stage: { name: "close", rule: 4, plan: "p1" },
      commands: ["dg --json --actor agent plan close p1"],
      approval: { required: false },
    });
    await runCommand(planClose, ctx, { plan: "p1" });
    const audit = await flow(ctx, {});
    expect(audit.stage).toMatchObject({ name: "audit", rule: 6 });
    // 見直しの値は always_ask なので、関所は人の承認の後に呼ぶ
    expect(audit.checkpoint).toBe(
      "dg --json --actor agent checkpoint audit s1 --approved-by human",
    );
    await pass(ctx, "audit");
    const release = await flow(ctx, {});
    expect(release).toMatchObject({
      stage: { name: "release", rule: 7 },
      approval: {
        required: true,
        what: expect.stringContaining(
          "merging the release PR and publishing (ask a person before each one; when approved, the agent runs them)",
        ),
        value: "flow.release: human_only",
      },
      // リリースの値は human_only なので、関所は人が通す
      checkpoint:
        "Ask a person to run dg checkpoint release s1 (only a person can do it; an agent's call is rejected)",
    });
    // リリースの関所を通った後も、閉じるまでリリースを返す（関所は返さない）。記録が足されて事実が変わったので、続いても止めない
    await pass(ctx, "release");
    const releasing = await flow(ctx, {});
    expect(releasing).toMatchObject({
      stage: { name: "release", rule: 7 },
      checkpoint: null,
      repeated: null,
    });

    // リリースして閉じた後は、リリースを繰り返さずに止まる
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    const closed = await flow(ctx, {});
    expect(closed).toMatchObject({ stage: { name: "stop", rule: 8 }, repeated: null });
    expect(closed.ask_human).toContain("s1 is closed, and the flow is finished");
  });

  it("関所を呼び忘れると同じ段階を返し続け、止まる判定が止める。関所を通すと進む（点検・見直し）", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    // 点検の手順を行っても、関所を呼ばなければ記録が足されない：次の呼び出しは同じ点検で、事実も変わらないので止まる
    expect((await flow(ctx, {})).stage.name).toBe("check");
    const stopped = await flow(ctx, {});
    expect(stopped).toMatchObject({ stage: { name: "stop", rule: null }, repeated: "check" });
    expect(stopped.ask_human).toContain(
      "The check checkpoint is not passed (dg checkpoint check s1)",
    );
    // 止まった後に呼び直しても、点検を飛ばさない（安全側に倒れる）
    expect((await flow(ctx, {})).stage.name).toBe("check");
    expect((await flow(ctx, {})).repeated).toBe("check");
    // 関所を通すと、次の段階に進む
    await pass(ctx, "check");
    expect((await flow(ctx, {})).stage).toMatchObject({ name: "plan", rule: 5 });

    // 見直しも同じ：関所を呼ばなければ見直しを返し続けて止まり、リリースには進まない
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done", override: "PR なし" });
    expect((await flow(ctx, {})).stage.name).toBe("audit");
    expect(await flow(ctx, {})).toMatchObject({ stage: { name: "stop" }, repeated: "audit" });
    expect((await flow(ctx, {})).stage.name).toBe("audit");
    await pass(ctx, "audit");
    expect((await flow(ctx, {})).stage.name).toBe("release");
  });

  it("止まる判定は deguboard-local/flow/ に対象ごとに覚え、データには書かない", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    /** データのリポジトリの先端と、コミットしていない変更 */
    const data = async () =>
      (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout +
      (await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout;
    const before = await data();
    const first = await flow(ctx, {});
    const file = flowLocalPath(ctx.repo.localDir, "s1");
    expect(file).toBe(path.join(ctx.repo.localDir, "flow", "s1.json"));
    const remembered = JSON.parse(await readFile(file, "utf8")) as {
      last?: { stage: string; facts: string };
    };
    expect(remembered.last?.stage).toBe(first.stage.name);
    expect(remembered.last?.facts).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(remembered)).toEqual(["last"]);
    // 止まると返したら忘れる
    expect((await flow(ctx, {})).repeated).toBe("check");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
    // 別の対象（チケットの指定）は別のファイルに覚えるので、Iteration の指定の続きと混ざらない
    expect((await flow(ctx, { targets: ["t1"] })).repeated).toBeNull();
    expect(
      JSON.parse(await readFile(flowLocalPath(ctx.repo.localDir, "t1"), "utf8")),
    ).toMatchObject({ last: { stage: "check" } });
    // データのブランチにはコミットもまとめ待ちの変更も増えない
    expect(await data()).toBe(before);
  });

  it("点検の記録は、チケットの中身や出入りが変わると数えず、Status・受け入れ条件の印・段の変化では数えたまま", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A", acceptance: ["動く"] });
    await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    await pass(ctx, "assign");
    const stageName = async () => (await flow(ctx, {})).stage.name;
    expect(await stageName()).toBe("check");
    await pass(ctx, "check");
    expect(await stageName()).toBe("plan");
    // 流れが進むと変わるもの：着手（Status・担当）・受け入れ条件の印・段
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "in_progress" });
    await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1] });
    await runCommand(ticketUpdate, ctx, { ticket: "t1", gate: "high" });
    expect(await stageName()).not.toBe("check");
    // 題を直すと、前の点検は今のチケットを見ていない
    await runCommand(ticketUpdate, ctx, { ticket: "t1", title: "A（直した）" });
    expect(await stageName()).toBe("check");
    await pass(ctx, "check");
    expect(await stageName()).not.toBe("check");
    // Iteration にチケットが入ると、そのチケットはまだ点検していない
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t2"] });
    expect(await stageName()).toBe("check");
    // 記録は消さずに足す（数えなくなった記録も残る）
    await pass(ctx, "check");
    const names = ctx.store.require("iteration", "s1").data.checkpoints?.map((c) => c.name);
    expect(names).toEqual(["assign", "check", "check", "check"]);
  });

  it("割り当ての記録は見た候補を覚え、あとから増えた候補だけを聞き直す", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "入れない候補" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    expect((await flow(ctx, {})).stage).toMatchObject({ name: "assign", tickets: ["t2"] });
    const record = await pass(ctx, "assign");
    expect(record.checkpoint.basis).toEqual({ candidates: ["t2"] });
    expect((await flow(ctx, {})).stage.name).toBe("check");
    // 新しい候補が増えたら、その分だけを聞き直す
    await runCommand(ticketCreate, ctx, { title: "新しい候補" });
    expect((await flow(ctx, {})).stage).toMatchObject({ name: "assign", tickets: ["t3"] });
    await pass(ctx, "assign");
    expect((await flow(ctx, {})).stage.name).toBe("check");
  });

  it("見直しの記録は、あとからマージされたチケットがあると数えない。見直しの直し（audit-<S>）とリリースのチケット（release-<S>）は数に入れない", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    const done = (ticket: string) =>
      runCommand(ticketMove, ctx, { ticket, status: "done", override: "PR なし" });
    /** 点検の関所を通してから段階を求める（チケットの出入りで点検に戻るので） */
    const stageName = async () => {
      await pass(ctx, "check");
      return (await flow(ctx, {})).stage.name;
    };
    await done("t1");
    expect(await stageName()).toBe("audit");
    const audit = await pass(ctx, "audit");
    expect(audit.checkpoint.basis).toEqual({ done: ["t1"] });
    expect(await stageName()).toBe("release");
    // 見直しが起票した直し（audit-s1）がマージされても、見直しをやり直さない
    await runCommand(ticketCreate, ctx, { title: "直し", labels: ["audit-s1"], iteration: "s1" });
    await done("t2");
    expect(await stageName()).toBe("release");
    // リリースのチケット（release-s1）が残っていても終わっても、リリースのまま
    await runCommand(ticketCreate, ctx, {
      title: "版を上げる",
      labels: ["release-s1"],
      iteration: "s1",
    });
    expect(await stageName()).toBe("release");
    await done("t3");
    expect(await stageName()).toBe("release");
    // 見直しのあとに、ほかのチケットが入ってマージされたら、見直しをやり直す
    await runCommand(ticketCreate, ctx, { title: "追加", iteration: "s1" });
    await done("t4");
    expect(await stageName()).toBe("audit");
    await pass(ctx, "audit");
    expect(await stageName()).toBe("release");
  });

  it("iteration reopen より前の記録は数えない（記録は消さない）。再開のあとに通った関所は数える", async () => {
    const base = await ready();
    // 時刻を進めながら操作する（記録と再開の前後を、同じ秒に入れない）
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const ctx: CommandContext = { ...base, now: () => new Date((clock += 60_000)) };
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done", override: "PR なし" });
    for (const stage of ["check", "audit", "release"] as const) await pass(ctx, stage);
    expect(await flow(ctx, {})).toMatchObject({ stage: { name: "release" }, checkpoint: null });
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    await runCommand(iterationReopen, ctx, { iteration: "s1" });
    const reopened = ctx.store.require("iteration", "s1").data;
    // 記録は 3 つとも残り、どれも再開より前
    expect(reopened.checkpoints?.map((c) => c.name)).toEqual(["check", "audit", "release"]);
    expect(reopened.checkpoints!.every((c) => c.at < reopened.reopened_at!)).toBe(true);
    // 点検からやり直す。関所を通すたびに進み、リリースの関所ももう一度求める
    expect((await flow(ctx, {})).stage.name).toBe("check");
    await pass(ctx, "check");
    expect((await flow(ctx, {})).stage.name).toBe("audit");
    await pass(ctx, "audit");
    expect(await flow(ctx, {})).toMatchObject({
      stage: { name: "release" },
      checkpoint: expect.stringContaining("dg checkpoint release s1"),
    });
    await pass(ctx, "release");
    expect((await flow(ctx, {})).checkpoint).toBeNull();
    expect(ctx.store.require("iteration", "s1").data.checkpoints).toHaveLength(6);
  });

  it("Iteration のない流れは割り当てで Iteration を決める。入れないと決めた割り当ての記録だけをこのマシンに書き、Iteration が決まると記録は Iteration に書く", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    const loose = { targets: ["t2", "t1"] };
    const assign = await flow(ctx, loose);
    expect(assign).toMatchObject({
      target: { iteration: null, tickets: ["t2", "t1"] },
      stage: { name: "assign", rule: 1, tickets: ["t1", "t2"] },
      commands: ["dg --json --actor agent iteration add <S> <tickets to add…> --approved-by human"],
      checkpoint: "dg --json --actor agent checkpoint assign t1 t2 --approved-by human",
    });
    // Iteration が決まらないうちは、点検などの関所は通せない（記録を書く場所がない）
    await expect(runCommand(checkpoint, ctx, { stage: "check", ...loose })).rejects.toMatchObject({
      code: "REJECTED",
    });
    // 入れないと決めた：割り当ての記録はこのマシンにだけ書かれ、データには何も書かれない
    const head = async () => (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    const before = await head();
    const declined = (await runCommand(checkpoint, ctx, { stage: "assign", ...loose }))
      .data as CheckpointResult;
    expect(declined).toMatchObject({
      iteration: null,
      local: true,
      checkpoint: { name: "assign", by: "eiki", basis: { candidates: ["t1", "t2"] } },
    });
    expect(await head()).toBe(before);
    expect(ctx.store.require("iteration", "s1").data.checkpoints).toBeUndefined();
    const local = JSON.parse(await readFile(flowLocalPath(ctx.repo.localDir, "t1 t2"), "utf8")) as {
      assign: unknown[];
    };
    expect(local.assign).toEqual([declined.checkpoint]);
    // Iteration が決まらないので、点検には進まずに止まる（割り当ては聞き直さない）
    const stopped = await flow(ctx, loose);
    expect(stopped).toMatchObject({ stage: { name: "stop", rule: 8 }, repeated: null });
    expect(stopped.stage.reason).toContain("No single Iteration is determined");
    // 割り当てで Iteration を決めると、そこから先の記録はその Iteration に書かれる
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1", "t2"] });
    const check = await flow(ctx, loose);
    expect(check).toMatchObject({
      target: { iteration: "s1" },
      stage: { name: "check" },
      checkpoint: "dg --json --actor agent checkpoint check t1 t2 --approved-by human",
    });
    const passedCheck = (await runCommand(checkpoint, ctx, { stage: "check", ...loose }))
      .data as CheckpointResult;
    expect(passedCheck).toMatchObject({ iteration: "s1", local: false });
    expect(ctx.store.require("iteration", "s1").data.checkpoints?.map((c) => c.name)).toEqual([
      "check",
    ]);
    expect((await flow(ctx, loose)).stage.name).toBe("plan");
  });

  it("workflow.yaml の flow の値と skip に従い、--auto が聞かずに進める場面と返す段階を決める", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    await runCommand(ticketCreate, ctx, { title: "候補" });
    const add = "dg --json --actor agent iteration add s1 <tickets to add…>";
    // 既定（flow.assign は ask_unless_auto）：--auto なら聞かずに進め、コマンドに --auto が付く。なければ承認の後に --approved-by で呼ぶ
    expect(await flow(ctx, { auto: true })).toMatchObject({
      stage: { name: "assign" },
      commands: [`${add} --auto`],
      approval: { required: false, auto_ok: true, value: "flow.assign: ask_unless_auto" },
    });
    expect(await flow(ctx, {})).toMatchObject({
      commands: [`${add} --approved-by human`],
      approval: { required: true, what: "Rows to add", agent: "approval" },
    });
    // always_ask にすると、--auto でも聞いて止まる
    await runCommand(workflowSet, ctx, { definition: { flow: { assign: "always_ask" } } });
    expect(await flow(ctx, { auto: true })).toMatchObject({
      stage: { name: "assign" },
      commands: [`${add} --approved-by human`],
      approval: { required: true, what: "Rows to add", auto_ok: false },
    });
    // anyone にすると、--auto がなくても聞かず、コマンドに何も付かない
    await runCommand(workflowSet, ctx, { definition: { flow: { assign: "anyone" } } });
    expect(await flow(ctx, {})).toMatchObject({
      commands: [add],
      approval: { required: false, auto_ok: false, agent: "allow" },
    });
    // human_only にすると、人に頼む文を返す
    await runCommand(workflowSet, ctx, { definition: { flow: { assign: "human_only" } } });
    const human = await flow(ctx, { auto: true });
    expect(human.approval).toMatchObject({ required: true, agent: "reject" });
    expect(human.commands[0]).toMatch(/^Ask a person to run dg iteration add s1 /);
    // skip に入れた段階は返さず、次の規則へ進む
    await runCommand(workflowSet, ctx, { definition: { flow: { skip: ["assign"] } } });
    expect(await flow(ctx, { auto: true })).toMatchObject({ stage: { name: "check" } });
  });

  it("ラベル release-<S> のチケットだけが残れば、リリースを返し続け、点検にも計画にも見直しにも戻らない（Iteration とチケットの指定）", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done", override: "PR なし" });
    for (const stage of ["check", "audit"] as const) await pass(ctx, stage);
    expect((await flow(ctx, {})).stage.name).toBe("release");
    // リリースの手順が 2 つのチケットを起票しても（Iteration のチケットが増えても）、点検にも見直しにも戻らない
    await runCommand(ticketCreate, ctx, {
      title: "版を上げる PR",
      labels: ["release-s1"],
      iteration: "s1",
    });
    await runCommand(ticketCreate, ctx, {
      title: "タグと公開",
      labels: ["release-s1"],
      iteration: "s1",
    });
    const todo = await flow(ctx, {});
    expect(todo.stage).toMatchObject({ name: "release", rule: 7 });
    expect(todo.repeated).toBeNull();
    // 公開のチケットが in_progress の間も、リリースを返す
    await runCommand(ticketMove, ctx, { ticket: "t3", status: "in_progress" });
    const inProgress = await flow(ctx, {});
    expect(inProgress.stage).toMatchObject({ name: "release", rule: 7 });
    expect(inProgress.repeated).toBeNull();
    // チケットの指定でも同じ（記録は Iteration にあるので、対象の指定が違っても数える）
    expect((await flow(ctx, { targets: ["t1"] })).stage.name).toBe("release");
    // release-<S> でない todo が入れば、点検してから今までどおり計画する
    await runCommand(ticketCreate, ctx, { title: "B", iteration: "s1" });
    expect((await flow(ctx, {})).stage.name).toBe("check");
    await pass(ctx, "check");
    expect((await flow(ctx, {})).stage).toMatchObject({ name: "plan", rule: 5, tickets: ["t4"] });
  });

  it("チケットの指定では、その Iteration を <S> にし、記録はその Iteration のものを数える。並びが違っても同じ対象", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1", "t2"] });
    const byTicket = await flow(ctx, { targets: ["t1"] });
    expect(byTicket.target).toEqual({ iteration: "s1", tickets: ["t1"] });
    expect(byTicket.stage.name).toBe("check");
    expect(byTicket.warnings).toEqual([]);
    // Iteration の指定で通した点検の記録は、チケットの指定の流れでも数える（会話・人・マシンをまたいで続きから進む）
    await pass(ctx, "check");
    expect((await flow(ctx, { targets: ["t1"] })).stage.name).toBe("plan");
    // チケットの並びが違っても同じ対象。解決した ID を並べ替えた鍵で、止まる判定を覚える
    expect((await flow(ctx, { targets: ["t1", "t2"] })).repeated).toBeNull();
    expect((await flow(ctx, { targets: ["t2", "t1"] })).repeated).toBe("plan");
    await expect(flow(ctx, { targets: ["s1", "t1"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("--gate を渡すと、作業の段階で段の違うチケットにだけ next の前に段を付ける。段のないチケットは high とみなし、段を下げるときは人に頼む文を返す", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "段なし" });
    await runCommand(ticketCreate, ctx, { title: "free", gate: "free" });
    await runCommand(ticketCreate, ctx, { title: "low", gate: "low" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1", "t2", "t3"] });
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2", "t3"] });
    await runCommand(planApprove, ctx, { plan: "p1" });
    const checked = await flow(ctx, { gate: "free" });
    expect(checked.stage.name).toBe("check");
    // 点検の段階には段を付ける行を入れない
    expect(checked.commands.join(" ")).not.toContain("--gate");
    await pass(ctx, "check");
    const work = await flow(ctx, { gate: "free" });
    expect(work.stage.name).toBe("work");
    // 段を下げるのは Core の固定で人だけなので、エージェントが打つコマンドでなく、人に頼む文を返す
    const askPerson = (t: string) =>
      `Ask a person to run dg ticket update ${t} --gate free before the next of ${t}, and wait for it (only a person can lower the quality gate level; an agent's call is rejected)`;
    expect(work.commands).toEqual([
      "dg --json --actor agent plan show p1",
      askPerson("t1"),
      "dg --json --actor agent next t1",
      "dg --json --actor agent next t2",
      askPerson("t3"),
      "dg --json --actor agent next t3",
    ]);
    // 段を上げるのはエージェントが打てる。high は段のないチケットと同じ段なので入れない
    const high = await flow(ctx, { gate: "high" });
    expect(high.commands).toEqual([
      "dg --json --actor agent plan show p1",
      "dg --json --actor agent next t1",
      "dg --json --actor agent ticket update t2 --gate high",
      "dg --json --actor agent next t2",
      "dg --json --actor agent ticket update t3 --gate high",
      "dg --json --actor agent next t3",
    ]);
    // --gate がなければ今と同じ
    const plain = await flow(ctx, {});
    expect(plain.commands.join(" ")).not.toContain("--gate");
  });

  it("列が WIP の上限を超えると、dg next と同じ警告を出し、作業の段階で先の列を進める手を先に返す（WF-8。拒否はしない）", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    for (const title of ["A", "B"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1", "t2"] });
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2"] });
    await runCommand(planApprove, ctx, { plan: "p1" });
    await runCommand(workflowSet, ctx, { definition: { wip: { in_progress: 1 } } });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "in_progress" });
    const check = await flow(ctx, { no_assign: true });
    expect(check.stage.name).toBe("check");
    // 着手しない段階では、上限ちょうどの列は超えていない
    expect(check.warnings.some((w) => w.includes("WIP limit"))).toBe(false);
    await pass(ctx, "check");
    const work = await flow(ctx, { no_assign: true });
    expect(work.stage.name).toBe("work");
    expect(work.warnings).toContain(
      "The In Progress column (in_progress) is at its WIP limit (1 of 1, wip in workflow.yaml), so starting another ticket goes over it",
    );
    expect(work.commands).toEqual([
      "WIP limit (in_progress): rather than starting new work, first advance a ticket in a column further along (in_progress: t1) with dg --json --actor agent next <id>. Starting is not refused",
      "dg --json --actor agent plan show p1",
      "dg --json --actor agent next t1",
      "dg --json --actor agent next t2",
    ]);
  });

  it("作業の段階のチケットがどれも着手済みなら、in_progress が上限ちょうどでも警告も先の列を進める手も返さない", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    for (const title of ["A", "B"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1", "t2"] });
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2"] });
    await runCommand(planApprove, ctx, { plan: "p1" });
    await runCommand(workflowSet, ctx, { definition: { wip: { in_progress: 2 } } });
    for (const ticket of ["t1", "t2"]) {
      await runCommand(ticketMove, ctx, { ticket, status: "in_progress" });
    }
    await pass(ctx, "check");
    const work = await flow(ctx, { no_assign: true });
    expect(work.stage.name).toBe("work");
    expect(work.warnings.some((w) => w.includes("WIP limit"))).toBe(false);
    expect(work.commands).toEqual([
      "dg --json --actor agent plan show p1",
      "dg --json --actor agent next t1",
      "dg --json --actor agent next t2",
    ]);
  });

  it("独自の段階を after の位置（同じ位置は書いた順）で返し、手順の文書の本文・関所のコマンド・承認の要否を返す。関所を通すと次へ進む", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    await runCommand(workflowSet, ctx, {
      definition: {
        flow: {
          "verify-staging": {
            decide: "always_ask",
            after: "check",
            guide: "docs/flow/verify-staging.md",
          },
          notify: { decide: "ask_unless_auto", after: "check", guide: "docs/flow/missing.md" },
        },
      },
    });
    await mkdir(path.join(ctx.repo.topLevel, "docs/flow"), { recursive: true });
    await writeFile(
      path.join(ctx.repo.topLevel, "docs/flow/verify-staging.md"),
      "# Verify on staging\n\nDeploy {{git.base_branch}} and ask a person to look.\n",
    );
    // 点検を終えるまでは点検。終えると、計画の前に check のあとの段階を書いた順に返す
    expect((await flow(ctx, {})).stage.name).toBe("check");
    await pass(ctx, "check");
    const verify = await flow(ctx, { auto: true });
    expect(verify).toMatchObject({
      stage: { name: "verify-staging", rule: null, after: "check", plan: null, tickets: [] },
      repeated: null,
      // 手順の文書は書いたまま返す（config の値は埋めない）。読み直すのは path のファイル
      guide: {
        topic: "verify-staging",
        sections: [],
        text: "# Verify on staging\n\nDeploy {{git.base_branch}} and ask a person to look.",
        command: null,
        path: "docs/flow/verify-staging.md",
      },
      commands: [],
      // always_ask は --auto でも聞く
      checkpoint: "dg --json --actor agent checkpoint verify-staging s1 --approved-by human",
      approval: {
        required: true,
        what: "The decision of the verify-staging stage (its steps say what to ask)",
        auto_ok: false,
        value: "flow.verify-staging.decide: always_ask",
        agent: "approval",
      },
      ask_human: null,
      warnings: [],
    });
    // 関所を通さなければ同じ段階が続き、止まる判定が関所を名指しで止める
    const stopped = await flow(ctx, { auto: true });
    expect(stopped).toMatchObject({ stage: { name: "stop" }, repeated: "verify-staging" });
    expect(stopped.ask_human).toContain(
      "The verify-staging checkpoint is not passed (dg checkpoint verify-staging s1)",
    );
    expect((await flow(ctx, { auto: true })).stage.name).toBe("verify-staging");

    // 関所を通すと、同じ after の次の段階。文書が読めなければ、警告を出して段階は返す
    await pass(ctx, "verify-staging");
    const notify = await flow(ctx, { auto: true });
    expect(notify).toMatchObject({
      stage: { name: "notify", after: "check" },
      guide: { topic: "notify", text: "", command: null, path: "docs/flow/missing.md" },
      // ask_unless_auto は --auto なら聞かずに通す
      checkpoint: "dg --json --actor agent checkpoint notify s1 --auto",
      approval: { required: false, auto_ok: true, value: "flow.notify.decide: ask_unless_auto" },
      warnings: [
        "flow.notify.guide file docs/flow/missing.md cannot be read, so the stage is returned without its steps. Fix the path in workflow.yaml or add the file",
      ],
    });
    await pass(ctx, "notify");
    expect((await flow(ctx, {})).stage).toMatchObject({ name: "plan", rule: 5 });
    // 独自の段階の記録も、同梱の段階と同じ Iteration の checkpoints に足される
    expect(ctx.store.require("iteration", "s1").data.checkpoints?.map((c) => c.name)).toEqual([
      "check",
      "verify-staging",
      "notify",
    ]);
  });

  it("config の guide.notes は、独自の段階があっても同梱の段階の手順に補足を足す（独自の段階の文書には足さない）", async () => {
    const base = await ready();
    await runCommand(iterationCreate, base, { name: "S1" });
    await runCommand(ticketCreate, base, { title: "A" });
    await runCommand(iterationAdd, base, { iteration: "s1", tickets: ["t1"] });
    await runCommand(workflowSet, base, {
      definition: {
        flow: { verify: { decide: "anyone", after: "check", guide: "docs/verify.md" } },
      },
    });
    await mkdir(path.join(base.repo.topLevel, "docs"), { recursive: true });
    await writeFile(path.join(base.repo.topLevel, "docs/verify.md"), "Verify it.\n");
    await writeFile(path.join(base.repo.topLevel, "docs/check-notes.md"), "点検の補足\n");
    const ctx: CommandContext = {
      ...base,
      config: configSchema.parse({ guide: { notes: { check: "docs/check-notes.md" } } }),
    };
    // 同梱の段階：手順の節の見出しの直後に補足が入る
    const check = await flow(ctx, {});
    expect(check.stage.name).toBe("check");
    expect(check.guide.text.split("\n").slice(0, 3)).toEqual(["## Check steps", "", "点検の補足"]);
    expect(check.warnings).toEqual([]);
    // 独自の段階：文書の本文だけ
    await pass(ctx, "check");
    const verify = await flow(ctx, {});
    expect(verify.stage.name).toBe("verify");
    expect(verify.guide.text).toBe("Verify it.");
  });

  it("registry に flow.next として載り、読み取りだけ。関所は checkpoint として載る", () => {
    expect(findCommand("flow.next")).toMatchObject({ write: false, group: "flow" });
    expect(findCommand("checkpoint")).toMatchObject({ write: true, group: "checkpoint" });
  });

  it("関所の記録は dg history に出る（通った段階と、コミットの題の承認者）", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    await pass(ctx, "check");
    await pass(ctx, "audit");
    const log = (await runCommand(history, ctx, { iteration: "s1" })).data;
    const passedStages = log.events
      .filter((e) => e.kind === "iteration" && e.id === "s1")
      .flatMap((e) =>
        e.changes.filter((c) => c.field === "checkpoint").map((c) => [c.to, e.subject]),
      );
    expect(passedStages).toEqual([
      ["check", "Checkpoint check of s1"],
      ["audit", "Checkpoint audit of s1"],
    ]);
  });
});
