import { afterEach, describe, expect, it } from "vitest";
import { createFixture, type Fixture } from "../../test/helpers/git-fixture.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import {
  carriedOverFrom,
  iterationAdd,
  iterationClose,
  iterationCreate,
  iterationShow,
  iterationStart,
  iterationUpdate,
} from "./iteration.js";
import { commit, init } from "./setup.js";
import { planCreate } from "./plan.js";
import { ticketCreate, ticketMove } from "./ticket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function ready(now?: () => Date): Promise<CommandContext> {
  const f: Fixture = await createFixture();
  cleanups.push(f.cleanup);
  const actor = { kind: "human" as const, user: "eiki" };
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {});
  return openContext({ cwd: f.cloneA, actor, ...(now ? { now } : {}) });
}

const next = async (ctx: CommandContext, id = "s1") =>
  (await runCommand(iterationShow, ctx, { iteration: id })).data.next;

describe("iteration.show の next（UI-5 の次の操作）", () => {
  it("planned は案内だけで、頼むことはない", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    expect(await next(ctx)).toEqual({ kind: "planned", ask: null });
  });

  it("active：全件が done か abandoned なら ready（release）、チケットがなければ案内なし", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1", end: "2999-01-01" });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    expect(await next(ctx)).toBeNull();
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    // 期限内の未完了は案内しない
    expect(await next(ctx)).toBeNull();
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "abandoned" });
    expect(await next(ctx)).toEqual({ kind: "ready", ask: "release" });
  });

  it("active：終了日を過ぎて未完了があれば overdue（件数と carry）。終了日の当日は過ぎていない（時計を固定）", async () => {
    // 2024-06-15 12:00（手元の暦）に固定する。実時計や日付の変わる瞬間に依存しない
    const ctx = await ready(() => new Date(2024, 5, 15, 12, 0, 0));
    await runCommand(iterationCreate, ctx, { name: "S1", end: "2024-06-14" });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1", "t2"] });
    expect(await next(ctx)).toEqual({ kind: "overdue", unfinished: 2, ask: "carry" });
    await runCommand(iterationUpdate, ctx, { iteration: "s1", end: "2024-06-15" });
    expect(await next(ctx)).toBeNull();
    await runCommand(iterationUpdate, ctx, { iteration: "s1", end: "2024-06-16" });
    expect(await next(ctx)).toBeNull();
  });

  it("closed：履歴から持ち越し先を返し、Iteration のないものがあれば assign。コミット前の分は moved に入らない", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(iterationCreate, ctx, { name: "S2" });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1", "t2"] });
    await runCommand(commit, ctx, {});
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    // batch でまだコミットしていないので、履歴に持ち越しの出入りがない
    expect(await next(ctx)).toEqual({ kind: "closed", carried: 2, moved: [], ask: null });
    await runCommand(commit, ctx, {});
    await runCommand(iterationAdd, ctx, { iteration: "s2", tickets: ["t1"] });
    await runCommand(commit, ctx, {});
    expect(await next(ctx)).toEqual({
      kind: "closed",
      carried: 2,
      moved: [
        { id: "t1", iteration: "s2", status: "todo" },
        { id: "t2", iteration: null, status: "todo" },
      ],
      ask: "assign",
    });
  });
});

describe("closed の持ち越しの割り当て", () => {
  it("持ち越したあとに done になって Iteration のないものだけなら、ask は null", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    await runCommand(commit, ctx, {});
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    await runCommand(commit, ctx, {});
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "abandoned" });
    await runCommand(commit, ctx, {});
    expect(await next(ctx)).toEqual({
      kind: "closed",
      carried: 1,
      moved: [{ id: "t1", iteration: null, status: "abandoned" }],
      ask: null,
    });
  });
});

describe("carriedOverFrom", () => {
  it("その Iteration から外れたチケットを番号の順に返し、今も入っているものは除く", () => {
    const ev = (id: string, from: string | null, to: string | null) =>
      ({
        kind: "ticket",
        id,
        changes: [{ field: "iteration", from, to }],
      }) as never;
    const events = [
      ev("t10", "s1", null),
      ev("t2", "s1", "s2"),
      ev("t3", "s1", null),
      ev("t4", null, "s1"),
    ];
    const tickets = [{ id: "t3", iteration: "s1" }] as never;
    expect(carriedOverFrom("s1", events, tickets)).toEqual(["t2", "t10"]);
  });
});

describe("iteration.show の plans（UI-5 の Plan の節）", () => {
  it("中のチケットを含む Plan を状態と進捗つきで出し、含まない Plan と Plan がないときは出さない", async () => {
    const ctx = await ready();
    await runCommand(iterationCreate, ctx, { name: "S1" });
    for (const title of ["A", "B", "C", "D"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1", "t2"] });
    const plans = async () =>
      (await runCommand(iterationShow, ctx, { iteration: "s1" })).data.plans;
    expect(await plans()).toEqual([]);
    // t1 と外の t3 を含む Plan は出る（進捗は Plan 全体）。t4 だけの Plan は出ない
    await runCommand(planCreate, ctx, { tickets: ["t1", "t3"] });
    await runCommand(planCreate, ctx, { tickets: ["t4"] });
    const got = await plans();
    expect(got.map((p) => [p.id, p.status, p.progress.done, p.progress.total])).toEqual([
      ["p1", "pending", 0, 2],
    ]);
  });
});
