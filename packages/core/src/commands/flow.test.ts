import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import { findGuideSection } from "../guide/sections.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import {
  FLOW_GUIDE,
  approvalOf,
  decodeResume,
  encodeResume,
  flowNext,
  flowStageOf,
  memoryAfter,
  type FlowFacts,
  type FlowMemory,
  type FlowNext,
} from "./flow.js";
import { iterationAdd, iterationClose, iterationCreate } from "./iteration.js";
import { planApprove, planCreate } from "./plan.js";
import { findCommand } from "./registry.js";
import { init } from "./setup.js";
import { ticketCreate, ticketMove } from "./ticket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const none: FlowMemory = { assigned: false, checked: false, audited: false };
const checked: FlowMemory = { assigned: true, checked: true, audited: false };

/** 流れの事実。既定は s1 の t1（in_progress）だけで、候補も Plan もない */
const facts = (over: Partial<FlowFacts> = {}): FlowFacts => ({
  iteration: "s1",
  iterationClosed: false,
  targets: [{ id: "t1", status: "in_progress" }],
  releaseScope: [{ id: "t1", status: "in_progress" }],
  candidates: [],
  auditLabeled: false,
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

describe("flowStageOf（guide-all の 8 規則）", () => {
  it("規則 1 割り当て：割り当てを終えておらず、見直し済みでなく、候補があり、--no-assign がない", () => {
    const f = facts({ candidates: ["t2"] });
    expect(flowStageOf(f, none)).toMatchObject({ name: "assign", rule: 1, tickets: ["t2"] });
    // どれか 1 つが欠ければ割り当てでなく点検
    expect(flowStageOf(f, { ...none, assigned: true }).name).toBe("check");
    expect(flowStageOf({ ...f, noAssign: true }, none).name).toBe("check");
    expect(flowStageOf({ ...f, auditLabeled: true }, none).name).toBe("check");
    expect(flowStageOf(f, { ...none, audited: true }).name).toBe("check");
    expect(flowStageOf(facts(), none).name).toBe("check");
  });

  it("規則 2 点検：この実行でまだ点検していなければ、Plan や終わりの状態によらず点検", () => {
    expect(flowStageOf(facts(finished()), { ...none, assigned: true })).toMatchObject({
      name: "check",
      rule: 2,
    });
  });

  it("規則 3 計画：対象を含む承認待ちの Plan があれば、その Plan の承認を得る（承認済みの Plan より先）", () => {
    const f = facts({
      pendingPlans: [{ id: "p2", tickets: ["t1"] }],
      approvedPlans: [{ id: "p1", unfinished: ["t3"] }],
    });
    expect(flowStageOf(f, checked)).toMatchObject({
      name: "plan",
      rule: 3,
      plan: "p2",
      tickets: ["t1"],
    });
  });

  it("規則 4 作業：承認済みの Plan に終わっていないチケットがあれば作業。終わったものだけの Plan は飛ばす", () => {
    const f = facts({
      approvedPlans: [
        { id: "p1", unfinished: [] },
        { id: "p3", unfinished: ["t1"] },
      ],
      unplanned: ["t4"],
    });
    expect(flowStageOf(f, checked)).toMatchObject({
      name: "work",
      rule: 4,
      plan: "p3",
      tickets: ["t1"],
    });
  });

  it("規則 5 計画：開いた Plan に入っていない todo があれば計画（Plan はまだない）", () => {
    expect(flowStageOf(facts({ unplanned: ["t4"] }), checked)).toMatchObject({
      name: "plan",
      rule: 5,
      plan: null,
      tickets: ["t4"],
    });
  });

  it("規則 6 見直し：すべて done か abandoned で、見直し済みでない", () => {
    expect(flowStageOf(facts(finished()), checked)).toMatchObject({ name: "audit", rule: 6 });
  });

  it("規則 7 リリース：すべて done か abandoned で、見直し済み（ラベル audit-<S> か、この実行で見直しを終えた）", () => {
    expect(flowStageOf(facts({ ...finished(), auditLabeled: true }), checked)).toMatchObject({
      name: "release",
      rule: 7,
    });
    expect(flowStageOf(facts(finished()), { ...checked, audited: true }).name).toBe("release");
  });

  it("規則 8 止まる：どれにも当たらない（PR のない in_progress だけなど）。Iteration が決まらなければ見直しもリリースもしない", () => {
    expect(flowStageOf(facts(), checked)).toMatchObject({ name: "stop", rule: 8, tickets: ["t1"] });
    const noIteration = flowStageOf(
      facts({ ...finished(), iteration: null, releaseScope: [] }),
      checked,
    );
    expect(noIteration).toMatchObject({ name: "stop", rule: 8 });
    expect(noIteration.reason).toContain("Iteration が 1 つに決まらない");
    // チケットのない Iteration は見直さない
    expect(flowStageOf(facts({ targets: [], releaseScope: [] }), checked).name).toBe("stop");
  });

  it("閉じた Iteration：見直しもリリースもせず、流れを終えたとして止まる（点検はする）", () => {
    const closed = facts({ ...finished(), iterationClosed: true });
    const stage = flowStageOf(closed, { ...checked, audited: true });
    expect(stage).toMatchObject({ name: "stop", rule: 8 });
    expect(stage.reason).toBe("s1 は閉じていて、流れを終えた");
    expect(flowStageOf({ ...closed, auditLabeled: true }, checked).name).toBe("stop");
    expect(flowStageOf(closed, { ...none, assigned: true }).name).toBe("check");
  });

  it("チケットの指定：対象が終わっても、Iteration のほかのチケットが残れば見直さない", () => {
    const f = facts({
      targets: [{ id: "t1", status: "done" }],
      releaseScope: [
        { id: "t1", status: "done" },
        { id: "t5", status: "in_progress" },
      ],
    });
    expect(flowStageOf(f, checked).name).toBe("stop");
  });
});

describe("resume", () => {
  it("前の段階が割り当て・点検・見直しなら終えたものに足し、ほかの段階は足さない", () => {
    const prev = (stage: "assign" | "check" | "audit" | "plan") =>
      decodeResume(encodeResume({ target: "s1", stage, facts: "x", memory: none }));
    expect(memoryAfter(undefined)).toEqual(none);
    expect(memoryAfter(prev("assign"))).toEqual({ ...none, assigned: true });
    expect(memoryAfter(prev("check"))).toEqual({ ...none, checked: true });
    expect(memoryAfter(prev("audit"))).toEqual({ ...none, audited: true });
    expect(memoryAfter(prev("plan"))).toEqual(none);
  });

  it("読めない値と形の違う値は undefined（割り当てと点検からやり直す）", () => {
    expect(decodeResume("not-a-resume")).toBeUndefined();
    expect(decodeResume(Buffer.from('{"v":2}').toString("base64url"))).toBeUndefined();
  });
});

describe("approvalOf（承認の要否）", () => {
  it("--auto がなければどの段階も承認を求め、止まるときは求めない", () => {
    for (const stage of ["assign", "check", "plan", "work", "audit", "release"] as const)
      expect(approvalOf(stage, { auto: false, autoMerge: true }), stage).toMatchObject({
        required: true,
        auto: null,
      });
    expect(approvalOf("stop", { auto: false, autoMerge: false }).required).toBe(false);
  });

  it("--auto は割り当て・Plan・見直しの表を聞かずに選び、点検の削除や閉じる・リリースは聞く。マージは auto.merge のときだけ", () => {
    const auto = (stage: Parameters<typeof approvalOf>[0], autoMerge = false) =>
      approvalOf(stage, { auto: true, autoMerge });
    expect(auto("assign").required).toBe(false);
    expect(auto("plan")).toMatchObject({ required: false, auto: "Plan の承認（plan approve）" });
    expect(auto("audit").required).toBe(false);
    expect(auto("check")).toMatchObject({ required: true, what: "削除・abandoned・閉じる" });
    expect(auto("release").required).toBe(true);
    expect(auto("work").required).toBe(true);
    expect(auto("work", true).required).toBe(false);
  });
});

describe("FLOW_GUIDE（段階の節）", () => {
  it("段階ごとに指す guide の節が core の guide-*.md にある", async () => {
    for (const [stage, ref] of Object.entries(FLOW_GUIDE)) {
      const body = await readFile(
        new URL(`../guide/guide-${ref.topic}.md`, import.meta.url),
        "utf8",
      );
      expect(findGuideSection(ref.topic, body, ref.section).heading, stage).toContain(ref.section);
    }
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

describe("dg flow next", () => {
  it("resume を写して渡すと割り当てと点検を飛ばして段階を進め、同じ段階で事実が変わらなければ止まる", async () => {
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
        section: "Iteration",
        command: "dg guide assign --section Iteration",
      },
      commands: ["dg --json --actor agent iteration add s1 <入れるチケット…>"],
      approval: { required: true, what: "入れる行" },
    });
    // guide.text は段階の節の本文（見出しから始まり、config を埋めたもの）
    expect(assign.guide.text.startsWith("## Iteration")).toBe(true);
    const check = await flow(ctx, { resume: assign.resume });
    expect(check.stage).toMatchObject({ name: "check", rule: 2 });
    expect(check.memory).toEqual({ ...none, assigned: true });
    // resume がなければ割り当てからやり直す
    expect((await flow(ctx, {})).stage.name).toBe("assign");

    const plan5 = await flow(ctx, { resume: check.resume });
    expect(plan5.stage).toMatchObject({ name: "plan", rule: 5, tickets: ["t1"] });
    expect(plan5.commands).toEqual(["dg --json --actor agent plan create t1"]);

    await runCommand(planCreate, ctx, { tickets: ["t1"] });
    const plan3 = await flow(ctx, { resume: plan5.resume, auto: true });
    expect(plan3).toMatchObject({
      stage: { name: "plan", rule: 3, plan: "p1" },
      commands: ["dg --json --actor agent plan show p1", "dg --json --actor agent plan approve p1"],
      approval: { required: false },
    });
    // 承認が得られず、事実が変わらないまま同じ段階が続けば止まる。もう一度呼んでも止まったまま
    const stopped = await flow(ctx, { resume: plan3.resume });
    expect(stopped).toMatchObject({ stage: { name: "stop", rule: null }, repeated: "plan" });
    expect(stopped.ask_human).toContain("段階 plan が続き");
    expect((await flow(ctx, { resume: stopped.resume })).stage.name).toBe("stop");

    await runCommand(planApprove, ctx, { plan: "p1" });
    const work = await flow(ctx, { resume: stopped.resume });
    expect(work).toMatchObject({
      stage: { name: "work", rule: 4, plan: "p1", tickets: ["t1"] },
      commands: ["dg --json --actor agent plan show p1", "dg --json --actor agent next t1"],
      approval: { required: true, what: "PR ごとのマージ（dg guide done）" },
      repeated: null,
    });
    expect(work.memory).toEqual({ ...none, assigned: true, checked: true });

    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    const audit = await flow(ctx, { resume: work.resume });
    expect(audit.stage).toMatchObject({ name: "audit", rule: 6 });
    const release = await flow(ctx, { resume: audit.resume });
    expect(release).toMatchObject({
      stage: { name: "release", rule: 7 },
      approval: { required: true, what: "リリースの PR のマージ・公開・閉じる" },
    });
    // resume を失えば、割り当てと点検からやり直す（見直しを終えた事実も失う）
    expect((await flow(ctx, {})).stage.name).toBe("assign");

    // リリースして閉じた後は、resume を渡してもリリースを繰り返さずに止まる。新しく呼んでも点検の後に止まる
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    const closed = await flow(ctx, { resume: release.resume });
    expect(closed).toMatchObject({ stage: { name: "stop", rule: 8 }, repeated: null });
    expect(closed.ask_human).toContain("s1 は閉じていて、流れを終えた");
    // 閉じた Iteration には割り当てないので、候補（t2）があっても点検から
    const fresh = await flow(ctx, {});
    expect(fresh.stage.name).toBe("check");
    expect((await flow(ctx, { resume: fresh.resume })).stage.name).toBe("stop");
  });

  it("ラベル audit-<S> のチケットがあれば見直し済みで、候補があっても割り当てない", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "候補" });
    await runCommand(ticketCreate, ctx, { title: "見直し", labels: ["audit-s1"] });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    const first = await flow(ctx, {});
    expect(first.stage.name).toBe("check");
    expect((await flow(ctx, { resume: first.resume })).stage.name).toBe("release");
  });

  it("チケットの指定では、その Iteration を <S> にし、別の対象の resume は使わずに警告する", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    const s1 = await flow(ctx, {});
    const byTicket = await flow(ctx, { targets: ["t1"], resume: s1.resume });
    expect(byTicket.target).toEqual({ iteration: "s1", tickets: ["t1"] });
    expect(byTicket.stage.name).toBe("check");
    expect(byTicket.warnings).toEqual([
      "resume は別の対象（s1）のものなので、割り当てと点検からやり直す",
    ]);
    expect((await flow(ctx, { resume: "garbage" })).warnings).toEqual([
      "resume を読めないので、割り当てと点検からやり直す",
    ]);
    // チケットの並びが違っても同じ対象。解決した ID を並べ替えて比べる
    await runCommand(ticketCreate, ctx, { title: "B" });
    const t12 = await flow(ctx, { targets: ["t1", "t2"] });
    const t21 = await flow(ctx, { targets: ["t2", "t1"], resume: t12.resume });
    expect(t21.warnings).toEqual([]);
    expect(t21.memory).not.toEqual(none);
    await expect(flow(ctx, { targets: ["s1", "t1"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("registry に flow.next として載り、読み取りだけ", () => {
    expect(findCommand("flow.next")).toMatchObject({ write: false, group: "flow" });
  });
});
