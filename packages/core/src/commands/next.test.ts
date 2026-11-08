import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import type { Run, RunReview } from "../model/run.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { next, nextOf, stageOf, type NextStep, type StageFacts } from "./next.js";
import { findCommand } from "./registry.js";
import { init } from "./setup.js";
import { ticketCreate, ticketShow, ticketUpdate, type TicketDetail } from "./ticket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

let seq = 0;
/** 閉じた（finished を渡せば）か実行中の Run。at は開始の時刻の分（2026-11-07T10:<at>:00Z） */
function run(step: string, at: number, over: Partial<Run> = {}): Run {
  const t = `2026-11-07T10:${String(at).padStart(2, "0")}:00Z`;
  return {
    id: `r20261107-10${String(at).padStart(2, "0")}00-${(seq++).toString(16).padStart(4, "0")}` as Run["id"],
    ticket: "t1",
    step,
    agent: "claude-code",
    model: null,
    started_at: t,
    finished_at: `2026-11-07T10:${String(at).padStart(2, "0")}:30Z`,
    result: "success",
    error: null,
    retries: 0,
    retry_reasons: [],
    usage: { input: null, output: null, cache_read: null, cache_write: null },
    tools: null,
    session: null,
    review: null,
    waiting_since: null,
    settling_since: null,
    ...over,
  };
}
const review = (at: number, r: RunReview | null, over: Partial<Run> = {}) =>
  run("review", at, { review: r, ...over });
const passed: RunReview = { heavy: 0, light: 1, passed: true };
const heavy: RunReview = { heavy: 2, light: 0, passed: false };

type TicketFacts = StageFacts["ticket"];
/** 段階の事実。ticket は既定（in_progress・PR #7・feat/t1）に重ねる。pr: undefined で PR を外す */
const facts = (
  over: Omit<Partial<StageFacts>, "ticket"> & {
    ticket?: { [K in keyof TicketFacts]?: TicketFacts[K] | undefined };
  } = {},
): StageFacts =>
  ({
    waiting: [],
    runs: [],
    implementStep: "implement",
    fixStep: "fix",
    pushedAt: "2026-11-07T10:05:00Z",
    ...over,
    ticket: {
      id: "t1",
      status: "in_progress",
      pr: 7,
      branch: "feat/t1",
      branch_at: "2026-11-07T10:00:00Z",
      ...over.ticket,
    },
  }) as StageFacts;

describe("作業の段階（stageOf。EX-3）", () => {
  it("todo は待ちがなければ todo、Plan の待ちか依存先があれば blocked。done・abandoned は merged・closed", () => {
    expect(stageOf(facts({ ticket: { status: "todo", pr: undefined } })).name).toBe("todo");
    expect(
      stageOf(facts({ ticket: { status: "todo", pr: undefined }, waiting: ["t2"] })),
    ).toMatchObject({ name: "blocked", reason: expect.stringContaining("t2") });
    expect(stageOf(facts({ ticket: { status: "done" } })).name).toBe("merged");
    expect(stageOf(facts({ ticket: { status: "abandoned" } })).name).toBe("closed");
  });

  it("PR がなければ claimed、PR があって見直しがなければ implemented、最後の push より前の見直ししかなければ fixed", () => {
    expect(stageOf(facts({ ticket: { pr: undefined } })).name).toBe("claimed");
    expect(stageOf(facts()).name).toBe("implemented");
    expect(stageOf(facts({ runs: [review(1, heavy)] }))).toMatchObject({
      name: "fixed",
      reviews: 1,
      fixes: 1,
    });
  });

  it("最後の push より後の見直しが実行中なら reviewing、重い指摘があれば reviewed、通れば draft のうちは reviewed・出したら ready", () => {
    expect(
      stageOf(facts({ runs: [review(6, null, { finished_at: null, result: null })] })).name,
    ).toBe("reviewing");
    expect(stageOf(facts({ runs: [review(6, heavy)] }))).toMatchObject({
      name: "reviewed",
      fixes: 1,
    });
    expect(stageOf(facts({ runs: [review(6, passed)] })).name).toBe("reviewed");
    expect(stageOf(facts({ ticket: { status: "review" }, runs: [review(6, passed)] })).name).toBe(
      "ready",
    );
    // 結果のない見直しや failure で閉じた見直しは見直し直す
    expect(stageOf(facts({ runs: [review(6, null)] })).name).toBe("fixed");
  });

  it("重い指摘が出た見直しが上限（2 回）を超えたら waiting_human", () => {
    const runs = [review(1, heavy), review(2, heavy), review(6, heavy)];
    expect(stageOf(facts({ runs }))).toMatchObject({ name: "waiting_human", fixes: 3 });
    expect(stageOf(facts({ runs: runs.slice(1) })).name).toBe("reviewed");
  });

  it("止まって待っている印の付いた実行中の Run があれば、ほかの事実によらず waiting_human", () => {
    const waiting = run("implement", 1, {
      finished_at: null,
      result: null,
      waiting_since: "2026-11-07T10:02:00Z",
    });
    expect(stageOf(facts({ ticket: { pr: undefined }, runs: [waiting] }))).toMatchObject({
      name: "waiting_human",
      reason: expect.stringContaining("止まって待っている"),
    });
  });

  it("ブランチを記録する前の見直しは数えない（使い回したブランチの前の作業）", () => {
    expect(
      stageOf(facts({ ticket: { branch_at: "2026-11-07T10:03:00Z" }, runs: [review(1, heavy)] })),
    ).toMatchObject({ name: "implemented", reviews: 0 });
  });
});

describe("dg next と ticket show の stage（EX-3）", () => {
  async function prepared() {
    const f = await createFixture();
    cleanups.push(f.cleanup);
    const actor = { kind: "agent" as const, user: "eiki" };
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {
      template: "software-development",
    });
    const ctx = await openContext({ cwd: f.cloneA, actor });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    return ctx;
  }

  it("着手できるチケットは implement、依存先が終わっていなければ wait_deps を返し、ticket show も同じ段階を出す", async () => {
    const ctx = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t2", depends_on: ["t1"] });
    const t1 = (await runCommand(next, ctx, { ticket: "t1" })).data as NextStep;
    expect(t1).toMatchObject({
      kind: "implement",
      step: "implement",
      stage: { name: "todo" },
      running_run: null,
      ask_human: null,
    });
    expect(t1.commands[0]).toContain("dg --json --actor agent ticket claim t1");
    const t2 = (await runCommand(next, ctx, { ticket: "t2" })).data as NextStep;
    expect(t2).toMatchObject({ kind: "wait_deps", stage: { name: "blocked" } });
    const shown = (await runCommand(ticketShow, ctx, { ticket: "t2" })).data as TicketDetail;
    expect(shown.stage).toEqual(t2.stage);
  });

  it("段階から手を選ぶ：見直しが通れば ready、重い指摘なら fix（印を付けず直す者が reclaim）、上限を超えたら通っても wait_human、出した PR は wait_merge", async () => {
    const ctx = await prepared();
    const kind = (f: StageFacts) => nextOf(ctx, f);
    const ready = kind(facts({ runs: [review(6, passed)] }));
    expect(ready).toMatchObject({ kind: "ready", stage: { review_passed: true } });
    expect(ready.commands).toEqual([
      "dg --json --actor agent gate t1 --for ready",
      "gh pr ready 7",
      "dg --json --actor agent sync",
    ]);
    const fix = kind(facts({ runs: [review(6, heavy)] }));
    expect(fix).toMatchObject({ kind: "fix", step: "fix" });
    expect(fix.commands.join(" ")).toContain("ticket claim t1 --retry-reason");
    expect(fix.commands.join(" ")).not.toContain("deguboard: ticket=");
    const over = kind(
      facts({ runs: [review(1, heavy), review(2, heavy), review(3, heavy), review(6, passed)] }),
    );
    expect(over).toMatchObject({ kind: "wait_human", stage: { name: "waiting_human", fixes: 3 } });
    expect(over.ask_human).toContain("gh pr ready");
    expect(kind(facts({ ticket: { status: "review" }, runs: [review(6, passed)] }))).toMatchObject({
      kind: "wait_merge",
    });
    // 実装を委譲する親は --no-run で claim し、印で頼む
    const impl = kind(facts({ ticket: { status: "todo", pr: undefined } }));
    expect(impl.commands[0]).toBe(
      "dg --json --actor agent ticket claim t1 --branch <種類>/<内容> --no-run",
    );
    expect(impl.commands[1]).toContain("deguboard: ticket=t1 step=implement");
    // 実行中の見直し・実装があれば、新しく起動させず終わりを待つ
    const reviewing = kind(facts({ runs: [review(6, null, { finished_at: null, result: null })] }));
    expect(reviewing).toMatchObject({ kind: "review", running_run: expect.any(String) });
    expect(reviewing.commands).toEqual([expect.stringContaining("終わりを待つ")]);
    const implementing = kind(
      facts({
        ticket: { pr: undefined },
        runs: [run("implement", 1, { finished_at: null, result: null })],
      }),
    );
    expect(implementing.commands).toEqual([expect.stringContaining("終わりを待つ")]);
    // 手直しが failure・interrupted で閉じたら人を待つ
    expect(
      kind(facts({ runs: [review(6, heavy), run("fix", 7, { result: "interrupted" })] })),
    ).toMatchObject({
      kind: "wait_human",
      stage: { reason: expect.stringContaining("interrupted") },
    });
    expect(
      kind(facts({ runs: [review(6, heavy), run("fix", 7, { result: "failure" })] })),
    ).toMatchObject({
      kind: "wait_human",
    });
    // 失敗の後に人が続けると決めて開き直した手直しを push したら、開いたままでも見直しに戻る
    const reopened = kind(
      facts({
        pushedAt: "2026-11-07T10:20:00Z",
        runs: [
          review(6, heavy),
          run("fix", 7, { result: "failure" }),
          run("fix", 10, { finished_at: null, result: null }),
        ],
      }),
    );
    expect(reopened).toMatchObject({ kind: "review", stage: { name: "fixed" }, running_run: null });
    expect(reopened.commands[0]).toContain("deguboard: ticket=t1 step=review");
    // 手直しが実行中で、push がまだ（最後の push が見直しより前）なら、fix の手は終わりを待つ
    const fixing = kind(
      facts({ runs: [review(6, heavy), run("fix", 7, { finished_at: null, result: null })] }),
    );
    expect(fixing).toMatchObject({ kind: "fix", running_run: expect.any(String) });
    expect(fixing.commands).toEqual([expect.stringContaining("終わりを待つ")]);
    // 最後の push が読めないときは最後の見直しを今の見直しとみなし、開いたままの手直しを待つ
    const noPush = kind(
      facts({
        pushedAt: undefined,
        runs: [review(6, heavy), run("fix", 7, { finished_at: null, result: null })],
      }),
    );
    expect(noPush.commands).toEqual([expect.stringContaining("終わりを待つ")]);
    // 見直しの手（fixed）で、開始より後に push がない手直しは待つ。push のあとの手直しは待たず見直しを返す
    const reviewWaits = kind(
      facts({
        pushedAt: "2026-11-07T10:08:00Z",
        runs: [
          review(6, heavy),
          run("fix", 7, { result: "failure" }),
          run("fix", 10, { finished_at: null, result: null }),
        ],
      }),
    );
    expect(reviewWaits).toMatchObject({ kind: "review", running_run: expect.any(String) });
    expect(reviewWaits.commands).toEqual([expect.stringContaining("終わりを待つ")]);
    const reviewPushed = kind(
      facts({
        pushedAt: "2026-11-07T10:08:00Z",
        runs: [review(6, heavy), run("fix", 7, { finished_at: null, result: null })],
      }),
    );
    expect(reviewPushed).toMatchObject({
      kind: "review",
      stage: { name: "fixed" },
      running_run: null,
    });
    expect(reviewPushed.commands[0]).toContain("deguboard: ticket=t1 step=review");
    // 最後の見直しより前に始まった開いたままの手直しは、待たずに直す claim を返す（その claim が閉じる）
    const stale = kind(
      facts({
        pushedAt: "2026-11-07T10:08:00Z",
        runs: [
          review(6, heavy),
          run("fix", 7, { finished_at: null, result: null }),
          review(9, heavy),
        ],
      }),
    );
    expect(stale).toMatchObject({ kind: "fix", running_run: null });
    expect(stale.commands.join(" ")).toContain("ticket claim t1 --retry-reason");
    // 上限を超えた後は push があっても人を待つ
    expect(
      kind(
        facts({
          pushedAt: "2026-11-07T10:30:00Z",
          runs: [review(1, heavy), review(2, heavy), review(6, heavy)],
        }),
      ),
    ).toMatchObject({ kind: "wait_human" });
    // 止まって待っている Run は、続きを送る先として running_run に出す
    const waiting = run("review", 6, {
      finished_at: null,
      result: null,
      waiting_since: "2026-11-07T10:07:00Z",
    });
    expect(kind(facts({ runs: [waiting] }))).toMatchObject({
      kind: "wait_human",
      step: "review",
      running_run: waiting.id,
    });
  });

  it("実行中の Run で置き換えるのは実装・見直し・手直し・ready の手だけ。使い回したブランチの前に始まった Run は数えない", async () => {
    const ctx = await prepared();
    const kind = (f: StageFacts) => nextOf(ctx, f);
    const openFix = run("fix", 7, { finished_at: null, result: null });
    // 完了（done）・依存待ち（wait_deps）・マージ待ち（wait_merge）は、実行中の Run があっても待たない
    expect(
      kind(
        facts({
          ticket: { status: "done" },
          runs: [run("implement", 1, { finished_at: null, result: null })],
        }),
      ),
    ).toMatchObject({ kind: "done", commands: [] });
    expect(
      kind(
        facts({
          ticket: { status: "todo", pr: undefined },
          waiting: ["t2"],
          runs: [run("implement", 1, { finished_at: null, result: null })],
        }),
      ),
    ).toMatchObject({ kind: "wait_deps", commands: [] });
    const merge = kind(
      facts({
        ticket: { status: "review" },
        runs: [review(6, passed), openFix],
        pushedAt: "2026-11-07T10:05:00Z",
      }),
    );
    expect(merge).toMatchObject({ kind: "wait_merge" });
    expect(merge.commands).toEqual([expect.stringContaining("gate t1 --for merge")]);
    // branch_at より前に始まった実装の Run は、このブランチの作業ではないので待たない
    const stale = kind(
      facts({
        ticket: { pr: undefined, branch_at: "2026-11-07T10:03:00Z" },
        runs: [run("implement", 1, { finished_at: null, result: null })],
      }),
    );
    expect(stale).toMatchObject({ kind: "implement", running_run: null });
    expect(stale.commands[0]).toContain("deguboard: ticket=t1 step=implement");
  });

  it("CLI・HTTP・MCP が写す一覧に next があり、読み取りだけ（write: false）", () => {
    expect(findCommand("next")).toMatchObject({ write: false, needs: "store" });
  });
});
