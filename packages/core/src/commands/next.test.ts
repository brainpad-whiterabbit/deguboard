import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import type { Run, RunReview } from "../model/run.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { next, nextOf, stageOf, type NextStep, type StageFacts } from "./next.js";
import { planApprove, planCreate } from "./plan.js";
import { findCommand } from "./registry.js";
import { configSet, init } from "./setup.js";
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

  it("承認待ちの Plan に入った todo は、待ちがなくても awaiting_approval で、どの Plan かを理由に書く（PL-5）", () => {
    expect(
      stageOf(facts({ ticket: { status: "todo", pr: undefined }, pendingPlan: "p1" })),
    ).toMatchObject({ name: "awaiting_approval", reason: expect.stringContaining("p1") });
    // 承認済みの Plan（pendingPlan が null）と Plan の外は、今と同じく todo
    expect(
      stageOf(facts({ ticket: { status: "todo", pr: undefined }, pendingPlan: null })).name,
    ).toBe("todo");
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

  it("見直した SHA があればリモートの先端の SHA と比べ、なければ今までどおり開始と先端のコミットの時刻で比べる（t763）", () => {
    const tip = "a".repeat(40);
    const other = "b".repeat(40);
    // 先端のコミットの時刻より後に始めた見直しでも、別の SHA を見直したなら今の見直しでない（見直しの前に作って後で push したコミット）
    expect(
      stageOf(facts({ pushedSha: tip, runs: [review(6, passed, { head: other })] })).name,
    ).toBe("fixed");
    // 先端のコミットの時刻より前に始めた見直しでも、先端の SHA を見直したなら今の見直し（push の前に見直して後で push した）
    expect(stageOf(facts({ pushedSha: tip, runs: [review(1, passed, { head: tip })] })).name).toBe(
      "reviewed",
    );
    // SHA のない見直しは時刻で比べる
    expect(stageOf(facts({ pushedSha: tip, runs: [review(1, passed)] })).name).toBe("fixed");
    expect(stageOf(facts({ pushedSha: tip, runs: [review(6, passed)] })).name).toBe("reviewed");
    // dg gate と同じく、先端を見直した見直しのうち最後のものを見る（後で push していないコミットを見直しても、先端の見直しが今の見直し）
    expect(
      stageOf(
        facts({
          pushedSha: tip,
          runs: [review(6, passed, { head: tip }), review(7, heavy, { head: other })],
        }),
      ).name,
    ).toBe("reviewed");
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
      reason: expect.stringContaining("has stopped and is waiting"),
    });
  });

  it("段が low・free で PR があれば見直しを飛ばす：draft は通った reviewed、出したら ready。段がなければ今と同じ", () => {
    for (const gate of ["low", "free"] as const) {
      // 見直しがなくても、重い指摘の見直しがあっても、見直しの往復に入らない
      for (const runs of [[], [review(6, heavy)]]) {
        expect(stageOf(facts({ ticket: { gate }, runs }))).toMatchObject({
          name: "reviewed",
          review_passed: true,
          reason: expect.stringContaining(`gate level is ${gate}`),
        });
      }
      expect(stageOf(facts({ ticket: { gate, status: "review" } }))).toMatchObject({
        name: "ready",
        review_passed: true,
      });
      // PR がない・todo・done・止まった Run の判定は段によらず先に効く
      expect(stageOf(facts({ ticket: { gate, pr: undefined } })).name).toBe("claimed");
      expect(stageOf(facts({ ticket: { gate, status: "todo", pr: undefined } })).name).toBe("todo");
      expect(stageOf(facts({ ticket: { gate, status: "done" } })).name).toBe("merged");
      const waiting = run("implement", 1, {
        finished_at: null,
        result: null,
        waiting_since: "2026-11-07T10:02:00Z",
      });
      expect(stageOf(facts({ ticket: { gate }, runs: [waiting] })).name).toBe("waiting_human");
    }
    // 段のない・high のチケットは今と同じ（見直しがなければ implemented）
    expect(stageOf(facts()).name).toBe("implemented");
    expect(stageOf(facts({ ticket: { gate: "high" } })).name).toBe("implemented");
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

  it("印で頼む手（実装・見直し・手直し）は、落ちたセッションに残ったサブエージェントの Run を待たずに、印で頼み直す手順とその Run を閉じることを返す（t765）", async () => {
    const ctx = await prepared();
    const open = { finished_at: null, result: null, session: "s-old" };
    const crashedOf = (r: Run) => ({ crashed: new Map([[r.id, "2026-11-07T10:02:00Z"]]) });
    const reviewing = review(6, null, open);
    const asked = nextOf(ctx, facts({ runs: [reviewing] }), crashedOf(reviewing));
    expect(asked).toMatchObject({ kind: "review", running_run: null });
    expect(asked.commands[0]).toContain(`The review Run ${reviewing.id} was opened by a sub-agent`);
    expect(asked.commands[0]).toContain("since 2026-11-07T10:02:00Z");
    expect(asked.commands[1]).toContain("deguboard: ticket=t1 step=review");
    const fixing = run("fix", 7, open);
    const fix = nextOf(ctx, facts({ runs: [review(6, heavy), fixing] }), crashedOf(fixing));
    expect(fix).toMatchObject({ kind: "fix", running_run: null });
    expect(fix.commands[0]).toContain(`The fix Run ${fixing.id}`);
    // 残りでない Run（crashed にない）は今までどおり待つ
    expect(nextOf(ctx, facts({ runs: [reviewing] })).commands).toEqual([
      expect.stringContaining("Wait for the running Run"),
    ]);
    // 印で頼まない手（ready）は、残りの見直しの Run も今までどおり待つ
    const low = facts({ ticket: { gate: "low" }, runs: [review(6, passed), reviewing] });
    expect(nextOf(ctx, low, crashedOf(reviewing))).toMatchObject({
      kind: "ready",
      running_run: reviewing.id,
    });
  });

  it("段階から手を選ぶ：見直しが通れば ready、重い指摘なら fix（印で頼み、直す者が run retry-reason で理由を書く）、上限を超えたら通っても wait_human、出した PR は wait_merge", async () => {
    const ctx = await prepared();
    const kind = (f: StageFacts) => nextOf(ctx, f);
    const ready = kind(facts({ runs: [review(6, passed)] }));
    expect(ready).toMatchObject({ kind: "ready", stage: { review_passed: true } });
    expect(ready.commands).toEqual([
      "dg --json --actor agent pr ready t1",
      "dg --json --actor agent sync",
    ]);
    const fix = kind(facts({ runs: [review(6, heavy)] }));
    expect(fix).toMatchObject({ kind: "fix", step: "fix" });
    expect(fix.commands.join(" ")).toContain("run retry-reason t1 --reason");
    expect(fix.commands.join(" ")).toContain("deguboard: ticket=t1 step=fix");
    expect(fix.commands.join(" ")).not.toContain("ticket claim");
    const over = kind(
      facts({ runs: [review(1, heavy), review(2, heavy), review(3, heavy), review(6, passed)] }),
    );
    expect(over).toMatchObject({ kind: "wait_human", stage: { name: "waiting_human", fixes: 3 } });
    expect(over.ask_human).toContain("gh pr ready");
    // 出した PR は、マージしてよいかを人に聞く問いと、承認の後に打つ dg pr merge（承認者を渡す）を返す（t883）
    const merge = kind(facts({ ticket: { status: "review" }, runs: [review(6, passed)] }));
    expect(merge).toMatchObject({ kind: "wait_merge", step: null, running_run: null, pr: 7 });
    expect(merge.commands).toEqual([
      "dg --json --actor agent gate t1 --for merge",
      "Only after a person approves the merge: dg --json --actor agent pr merge t1 --approved-by human",
    ]);
    expect(merge.ask_human).toContain("ask a person whether to merge it");
    expect(merge.ask_human).toContain("dg pr merge t1 --approved-by human");
    expect(merge.ask_human).toContain("When declined or not answered, do not merge");
    // auto.merge が true でも false でも同じ形を返す（聞かずにマージするかは dg guide all の --auto が決める）
    for (const autoMerge of [true, false]) {
      const set = {
        ...ctx,
        config: { ...ctx.config, auto: { ...ctx.config.auto, merge: autoMerge } },
      };
      expect(
        nextOf(set, facts({ ticket: { status: "review" }, runs: [review(6, passed)] })),
      ).toEqual(merge);
    }
    // 実装を委譲する親は --no-run で claim し、印で頼む
    const impl = kind(facts({ ticket: { status: "todo", pr: undefined } }));
    expect(impl.commands[0]).toBe(
      "dg --json --actor agent ticket claim t1 --branch <type>/<content> --no-run",
    );
    expect(impl.commands[1]).toContain("deguboard: ticket=t1 step=implement");
    // 実行中の見直し・実装があれば、新しく起動させず終わりを待つ
    const reviewing = kind(facts({ runs: [review(6, null, { finished_at: null, result: null })] }));
    expect(reviewing).toMatchObject({ kind: "review", running_run: expect.any(String) });
    expect(reviewing.commands).toEqual([expect.stringContaining("Wait for the running Run")]);
    const implementing = kind(
      facts({
        ticket: { pr: undefined },
        runs: [run("implement", 1, { finished_at: null, result: null })],
      }),
    );
    expect(implementing.commands).toEqual([expect.stringContaining("Wait for the running Run")]);
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
    expect(fixing.commands).toEqual([expect.stringContaining("Wait for the running Run")]);
    // 最後の push が読めないときは最後の見直しを今の見直しとみなし、開いたままの手直しを待つ
    const noPush = kind(
      facts({
        pushedAt: undefined,
        runs: [review(6, heavy), run("fix", 7, { finished_at: null, result: null })],
      }),
    );
    expect(noPush.commands).toEqual([expect.stringContaining("Wait for the running Run")]);
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
    expect(reviewWaits.commands).toEqual([expect.stringContaining("Wait for the running Run")]);
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
    expect(stale.commands.join(" ")).toContain("run retry-reason t1 --reason");
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

  it("フックが届くセッションでは、implement・fix の手はモデルが親と同じ（null）ときも、いつもサブエージェントに頼むと先に案内し、親が自分で進める道を案内しない（t713）", async () => {
    const ctx = await prepared();
    ctx.config = { ...ctx.config, models: { ...ctx.config.models, standard: "" } };
    const always = "Always ask a sub-agent";
    const hooked = { hooksReach: true };
    const todo = facts({ ticket: { status: "todo", pr: undefined } });
    const claimed = facts({ ticket: { pr: undefined } });
    const fixing = facts({ runs: [review(6, heavy)] });
    for (const f of [todo, claimed, fixing]) {
      const step = nextOf(ctx, f, hooked);
      expect(step.model).toBeNull();
      expect(step.commands[0]).toContain(always);
      expect(step.commands[0]).toContain("do not do it yourself");
      // claim は --no-run のまま（親が自分で Run を開く claim を案内しない）
      for (const c of step.commands.filter((c) => c.includes("ticket claim")))
        expect(c).toContain("--no-run");
      // フックが届かないセッションでは、この行を足さず、今までの手のまま
      const plain = nextOf(ctx, f);
      expect(plain.commands.some((c) => c.includes(always))).toBe(false);
      expect(step.commands.slice(1)).toEqual(plain.commands);
    }
    // review・ready の手と、実行中の Run を待つ手には足さない
    expect(nextOf(ctx, facts(), hooked).commands.join(" ")).not.toContain(always);
    expect(nextOf(ctx, facts({ runs: [review(6, passed)] }), hooked).commands).toEqual([
      "dg --json --actor agent pr ready t1",
      "dg --json --actor agent sync",
    ]);
    const implementing = nextOf(
      ctx,
      facts({ ticket: { pr: undefined }, runs: [run("implement", 1, { finished_at: null })] }),
      hooked,
    );
    expect(implementing.commands).toEqual([expect.stringContaining("Wait for the running Run")]);
    // 説明は、フックが届くセッションでいつも頼み、親が自分で進めるのは届かないときだけと書く
    const summary = findCommand("next")!.summary;
    expect(summary).toContain(
      "In a session that dg hooks have reached, implement and fix are always delegated",
    );
    expect(summary).toMatch(
      /Only when no dg hook reaches the session[^.]*, the parent may proceed on its own/,
    );
    expect(summary).not.toContain(
      "If the model is the same as the parent's and it proceeds on its own",
    );
  });

  it("段が low・free のチケットは review・fix の手を返さず、draft なら ready、出した PR は wait_merge。段がなければ review", async () => {
    const ctx = await prepared();
    for (const gate of ["low", "free"] as const) {
      const draft = nextOf(ctx, facts({ ticket: { gate }, runs: [review(6, heavy)] }));
      expect(draft).toMatchObject({ kind: "ready", step: null });
      expect(draft.commands).toEqual([
        "dg --json --actor agent pr ready t1",
        "dg --json --actor agent sync",
      ]);
      expect(nextOf(ctx, facts({ ticket: { gate, status: "review" } })).kind).toBe("wait_merge");
      // 実装の Run が実行中なら、ready の手も終わりを待つ
      const implementing = nextOf(
        ctx,
        facts({
          ticket: { gate },
          runs: [run("implement", 6, { finished_at: null, result: null })],
        }),
      );
      expect(implementing).toMatchObject({ kind: "ready", running_run: expect.any(String) });
      // 見直しの Run が開いたまま段を下げたら、ready の手は見直しの終わりを待つ（フックが閉じる Run を置いて進まない）
      const openReview = review(6, null, { finished_at: null, result: null });
      const reviewing = nextOf(ctx, facts({ ticket: { gate }, runs: [openReview] }));
      expect(reviewing).toMatchObject({ kind: "ready", running_run: openReview.id });
      expect(reviewing.commands).toEqual([
        expect.stringContaining(`Wait for the running Run ${openReview.id} to end`),
      ]);
      // 見直しが終われば、重い指摘があっても段は見直しを判定しないので dg pr ready を返す
      const reviewed = nextOf(ctx, facts({ ticket: { gate }, runs: [review(6, heavy)] }));
      expect(reviewed).toMatchObject({ kind: "ready", running_run: null });
      expect(reviewed.commands[0]).toContain("pr ready t1");
      // 出した PR（status review）は wait_merge で、開いた見直しの Run を待たない（マージは人を待つ手）
      expect(
        nextOf(ctx, facts({ ticket: { gate, status: "review" }, runs: [openReview] })),
      ).toMatchObject({ kind: "wait_merge" });
      // 使い回したブランチの前に始まった見直しの Run は待たない
      const stale = nextOf(
        ctx,
        facts({ ticket: { gate, branch_at: "2026-11-07T10:07:00Z" }, runs: [openReview] }),
      );
      expect(stale).toMatchObject({ kind: "ready", running_run: null });
    }
    expect(nextOf(ctx, facts()).kind).toBe("review");
  });

  it("段のないまま ready にした low のチケットを high に上げると、見直しがないので review の手を返す", async () => {
    const ctx = await prepared();
    // low で見直しを飛ばして PR を出した（status review）。そのままなら wait_merge
    const low = facts({ ticket: { gate: "low", status: "review" } });
    expect(nextOf(ctx, low).kind).toBe("wait_merge");
    // high に上げると、見直しの Run がないので implemented に戻り、見直しを頼む
    const high = facts({ ticket: { gate: "high", status: "review" } });
    expect(stageOf(high).name).toBe("implemented");
    const step = nextOf(ctx, high);
    expect(step).toMatchObject({ kind: "review", step: "review", running_run: null });
    expect(step.commands[0]).toContain("deguboard: ticket=t1 step=review");
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
    expect(merge.commands).toEqual([
      expect.stringContaining("gate t1 --for merge"),
      expect.stringContaining("pr merge t1 --approved-by human"),
    ]);
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

  it("自分で開いた手直しの Run が push なしで返った（止まって待っている印がある）ら、待たずに wait_human で続きを送るか人に聞く", async () => {
    const ctx = await prepared();
    const returned = run("fix", 7, {
      finished_at: null,
      result: null,
      waiting_since: "2026-11-07T10:08:00Z",
    });
    const step = nextOf(
      ctx,
      facts({
        pushedAt: "2026-11-07T10:05:00Z",
        runs: [review(6, heavy), returned],
      }),
    );
    expect(step).toMatchObject({
      kind: "wait_human",
      step: "fix",
      running_run: returned.id,
      stage: { name: "waiting_human" },
    });
    expect(step.commands).toEqual([]);
    expect(step.ask_human).toContain("returned without a push");
  });

  it("implement・fix の手の model は plan.tier を models.* に対応させ、tier を省いた段階は standard、対応が空なら null。review とほかの手は null", async () => {
    const ctx = await prepared();
    await runCommand(ticketCreate, ctx, { title: "C" });
    const created = await runCommand(planCreate, ctx, {
      tickets: ["t1", "t2"],
      tier: { t1: "heavy", t2: "light" },
    });
    // 承認待ちの Plan のチケットは implement を返さない（PL-5）。以下は承認した後の手を確かめる
    await runCommand(planApprove, ctx, { plan: created.data.id });
    const models = { light: "haiku", standard: "sonnet", heavy: "opus" };
    const withModels = { ...ctx, config: { ...ctx.config, models } };
    const kind = (f: StageFacts) => nextOf(withModels, f);
    const todo = (id: string) =>
      facts({ ticket: { id: id as TicketFacts["id"], status: "todo", pr: undefined } });
    // tier に対応するモデル（heavy は opus、light は haiku）
    expect(kind(todo("t1"))).toMatchObject({ kind: "implement", model: "opus" });
    expect(kind(todo("t2"))).toMatchObject({ kind: "implement", model: "haiku" });
    // Plan に入らないチケットは standard（tier を省いた段階と同じ）
    expect(kind(todo("t3"))).toMatchObject({ kind: "implement", model: "sonnet" });
    // 直す手は実装と同じモデル。見直しと、見直しが通った後の手は親のモデル（null）
    expect(kind(facts({ runs: [review(6, heavy)] }))).toMatchObject({ kind: "fix", model: "opus" });
    expect(kind(facts({ runs: [] }))).toMatchObject({ kind: "review", model: null });
    expect(kind(facts({ runs: [review(6, passed)] }))).toMatchObject({
      kind: "ready",
      model: null,
    });
    // 対応が空なら null（親のモデル）
    const bare = {
      ...ctx,
      config: { ...ctx.config, models: { light: "", standard: "", heavy: "" } },
    };
    expect(nextOf(bare, todo("t1"))).toMatchObject({ kind: "implement", model: null });
    expect(nextOf(bare, todo("t3"))).toMatchObject({ kind: "implement", model: null });
    // 既定の config（models.* は空）の dg next も model を返す
    const step = (await runCommand(next, ctx, { ticket: "t1" })).data as NextStep;
    expect(step).toMatchObject({ kind: "implement", model: null, plan: { tier: "heavy" } });
  });

  it("model は呼んだ agent の models.<agent>.<tier> を先に引き、指定がなければ models.<tier>、agent を判定できなければ models.<tier> を使う（t898）", async () => {
    const ctx = await prepared();
    const created = await runCommand(planCreate, ctx, {
      tickets: ["t1", "t2"],
      tier: { t1: "heavy", t2: "light" },
    });
    await runCommand(planApprove, ctx, { plan: created.data.id });
    const models = {
      ...ctx.config.models,
      light: "haiku",
      standard: "sonnet",
      heavy: "opus",
      codex: { light: "", standard: "", heavy: "gpt-heavy" },
    };
    const withModels = { ...ctx, config: { ...ctx.config, models } };
    const todo = (id: string) =>
      facts({ ticket: { id: id as TicketFacts["id"], status: "todo", pr: undefined } });
    const modelFor = (id: string, agent?: string | null) =>
      nextOf(withModels, todo(id), agent === undefined ? {} : { agent }).model;
    // 呼んだ agent の指定があればそれを返す。手直しも同じ
    expect(modelFor("t1", "codex")).toBe("gpt-heavy");
    expect(
      nextOf(withModels, facts({ runs: [review(6, heavy)] }), { agent: "codex" }),
    ).toMatchObject({ kind: "fix", model: "gpt-heavy" });
    // その agent の段階の指定が空なら models.<tier>
    expect(modelFor("t2", "codex")).toBe("haiku");
    // 指定のない agent は models.<tier>
    expect(modelFor("t1", "claude-code")).toBe("opus");
    // agent を判定できない（Copilot CLI のように判定の手がかりがない、2 つ以上が当たった）ときは models.<tier>
    expect(modelFor("t1", null)).toBe("opus");
    expect(modelFor("t1")).toBe("opus");
    // Adapter のない名前や、段階と同じ名前を agent に渡しても、models.<tier> に落ちる
    expect(modelFor("t1", "unknown")).toBe("opus");
    expect(modelFor("t1", "light")).toBe("opus");
    // agent の指定だけがあり models.<tier> が空でも、その agent には返す。ほかは親のモデル（null）
    const onlyAgent = {
      ...ctx,
      config: {
        ...ctx.config,
        models: { ...ctx.config.models, codex: { light: "", standard: "", heavy: "gpt-heavy" } },
      },
    };
    expect(nextOf(onlyAgent, todo("t1"), { agent: "codex" }).model).toBe("gpt-heavy");
    expect(nextOf(onlyAgent, todo("t1"), { agent: null }).model).toBeNull();

    // dg next は、呼んだプロセスの環境変数から agent を判定して引く（個人の設定の上書きも効く）
    await runCommand(configSet, ctx, { key: "models.heavy", value: "opus" });
    await runCommand(configSet, ctx, { key: "models.codex.heavy", value: "gpt-team" });
    // 文脈の config は開いたときの値なので、書いた後は開き直す
    const asked = async (env: NodeJS.ProcessEnv) => {
      const fresh = await openContext({
        cwd: ctx.repo.topLevel,
        actor: { kind: "agent", user: "eiki" },
      });
      return ((await runCommand(next, { ...fresh, env }, { ticket: "t1" })).data as NextStep).model;
    };
    expect(await asked({ CODEX_THREAD_ID: "0199a213-81c0-7800-8aa1-bbab2a035a53" })).toBe(
      "gpt-team",
    );
    expect(await asked({ CLAUDECODE: "1" })).toBe("opus");
    // 判定できない環境（Copilot CLI など）と、2 つ以上が当たった環境は models.<tier>
    expect(await asked({})).toBe("opus");
    expect(await asked({ CLAUDECODE: "1", CODEX_THREAD_ID: "t" })).toBe("opus");
    await runCommand(configSet, ctx, { key: "models.codex.heavy", value: "gpt-mine", local: true });
    expect(await asked({ CODEX_THREAD_ID: "0199a213-81c0-7800-8aa1-bbab2a035a53" })).toBe(
      "gpt-mine",
    );
  });

  it("承認待ちの Plan に入った todo は、dg next が着手ではなく人の承認を待つ手（wait_human）と Plan を返し、ticket show も同じ段階を出す。承認すると implement に戻る（PL-5）", async () => {
    const ctx = await prepared();
    const created = await runCommand(planCreate, ctx, { tickets: ["t1"] });
    const planId = created.data.id;
    const waiting = (await runCommand(next, ctx, { ticket: "t1" })).data as NextStep;
    expect(waiting).toMatchObject({
      kind: "wait_human",
      step: null,
      stage: { name: "awaiting_approval" },
      plan: { id: planId },
      running_run: null,
      commands: [],
      brief: null,
    });
    expect(waiting.ask_human).toContain(planId);
    const shown = (await runCommand(ticketShow, ctx, { ticket: "t1" })).data as TicketDetail;
    expect(shown.stage).toEqual(waiting.stage);
    // 承認すると、同じチケットは着手できる todo に戻る
    await runCommand(planApprove, ctx, { plan: planId });
    expect((await runCommand(next, ctx, { ticket: "t1" })).data).toMatchObject({
      kind: "implement",
      stage: { name: "todo" },
    });
  });

  it("CLI・HTTP・MCP が写す一覧に next があり、読み取りだけ（write: false）", () => {
    expect(findCommand("next")).toMatchObject({ write: false, needs: "store" });
  });
});
