// 進め始める Plan とチケットの予約を読み書きする経路の代表（PL-7。t1149）。予約が効くか・拒むかの組み合わせ（SessionEnd・30 分・
// 主体・セッション・--take-over・操作）は claim-judge.test.ts が git なしで見る。ここは、--reserve を付けた呼び出しだけが予約を
// deguboard-local に書いて Git には書かないこと、別のセッションの claim が拒まれて dg next が進める手を返さないこと、
// --take-over・unclaim・plan close が予約を移す・消すことを、コマンドを通して確かめる

import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../test/helpers/git-fixture.js";
import { toIsoDateTime } from "../model/common.js";
import type { CommandContext } from "./define.js";
import { runCommand } from "./define.js";
import { recordHookSession } from "./hook-records.js";
import { next } from "./next.js";
import { planApprove, planClose, planCreate, planShow } from "./plan.js";
import { readReservation } from "./reservations.js";
import { ticketClaim, ticketCreate, ticketUnclaim } from "./ticket.js";
import {
  agentWithRuns,
  initializedLocalFixture,
  reopenInitialized,
  runCleanups,
} from "../../test/helpers/commands-context.js";

afterEach(runCleanups);

/** セッション ID を環境に持つ agent の文脈（Claude Code が Bash の環境に付ける ID。サブエージェントでも親のセッション） */
async function inSession(cwd: string, session: string, now: () => Date): Promise<CommandContext> {
  const agent = await agentWithRuns(cwd, now);
  agent.env = { ...agent.env, CLAUDE_CODE_SESSION_ID: session };
  return agent;
}

/** 別の文脈の変更を索引に読み直してから使う（CLI では毎回読む） */
async function fresh(ctx: CommandContext): Promise<CommandContext> {
  await ctx.store.rescan();
  return ctx;
}

/** 着手の承認の要否によらず通る claim（土台の Workflow の値に頼らず、人の承認を渡す） */
const claimOf = (ticket: string) =>
  ({ approved_by: "human", no_worktree: true, no_run: true, ticket, branch: ticket }) as const;

describe("進め始める Plan とチケットの予約（PL-7）", () => {
  it("--reserve を付けた plan show・next だけが呼んだセッションの予約を deguboard-local に書き、別のセッションの agent の claim を拒んで dg next は進める手を返さない。--take-over で予約が移り、SessionEnd か 30 分で無視され、人とセッションのわからない呼び出しは止めず予約も作らない", async () => {
    const f = await initializedLocalFixture();
    const start = new Date("2026-11-06T00:00:00Z");
    let clock = start;
    /** start から分だけ後に時計を進め、その時刻の文字列を返す */
    const at = (minutes: number) => {
      clock = new Date(start.getTime() + minutes * 60_000);
      return toIsoDateTime(clock);
    };
    const human = await reopenInitialized(f, { now: () => clock });
    for (const title of ["In plan 1", "In plan 2", "No plan"])
      await runCommand(ticketCreate, human, { title });
    await runCommand(planCreate, human, { tickets: ["t1", "t2"] });
    await runCommand(planApprove, human, { plan: "p1" });
    const a = await inSession(f.cloneA, "sess-a", () => clock);
    const b = await inSession(f.cloneA, "sess-b", () => clock);
    const unknown = await agentWithRuns(f.cloneA, () => clock);
    const local = a.repo.localDir;
    const reservedBy = async (target: string) => (await readReservation(local, target))?.session;

    // 見るだけの呼び出し（--reserve なし）は予約を作らない
    await runCommand(planShow, await fresh(a), { plan: "p1" });
    expect((await runCommand(next, a, { ticket: "t1" })).data.kind).toBe("implement");
    expect(await reservedBy("p1")).toBeUndefined();
    expect(await reservedBy("t1")).toBeUndefined();

    // --reserve を付けた plan show は、呼んだセッションの予約を書く。Git のデータには書かない
    const reservedAt = at(0);
    await runCommand(planShow, a, { plan: "p1", reserve: true });
    expect(await readReservation(local, "p1")).toEqual({
      session: "sess-a",
      claimed_at: reservedAt,
    });
    const history = (await git(a.repo.dataDir, ["log", "-p", "--all"])).stdout;
    expect(history).not.toContain("sess-a");
    expect(history).not.toContain("reservations");

    // 別のセッションの dg next は、予約した Plan のチケットの進める手を返さず、進めているセッションと越え方を返す。
    // --reserve を付けても同じで、予約は書かない
    at(5);
    for (const reserve of [false, true]) {
      const held = await runCommand(next, await fresh(b), { ticket: "t1", reserve });
      expect(held.data).toMatchObject({
        kind: "wait_session",
        stage: { name: "todo" },
        step: null,
        model: null,
        brief: null,
        ask_human: null,
      });
      expect(held.data.commands).toEqual([
        expect.stringMatching(
          /another session of yours: session sess-a \(it reserved p1 .*--take-over/,
        ),
      ]);
    }
    expect(await reservedBy("t1")).toBeUndefined();

    // 別のセッションの claim と Plan の予約は拒む。チケットも予約も変わらない
    await expect(runCommand(ticketClaim, b, claimOf("t1"))).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringMatching(/session sess-a \(it reserved p1 .*cannot claim it while/),
    });
    await expect(runCommand(planShow, b, { plan: "p1", reserve: true })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringMatching(/session sess-a .*cannot reserve it/),
    });
    expect((await fresh(b)).store.tickets.get("t1")!.data.status).toBe("todo");
    expect(await reservedBy("p1")).toBe("sess-a");
    // --take-over は予約を移す指定なので、--reserve なしでは使えない
    await expect(runCommand(next, b, { ticket: "t1", take_over: true })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    // 人とセッションのわからない agent は止めず、--reserve を付けても予約を作らない
    const byHuman = await runCommand(next, await fresh(human), { ticket: "t1", reserve: true });
    expect(byHuman.data.kind).toBe("implement");
    expect(byHuman.warnings).toContainEqual(
      expect.stringContaining("A person's call is not stopped"),
    );
    expect(byHuman.warnings).toContainEqual(
      expect.stringContaining("t1 was not reserved: only an agent's session makes a reservation"),
    );
    const byUnknown = await runCommand(next, await fresh(unknown), { ticket: "t1", reserve: true });
    expect(byUnknown.data.kind).toBe("implement");
    expect(byUnknown.warnings).toContainEqual(
      expect.stringContaining("The session calling dg is unknown"),
    );
    expect(await reservedBy("t1")).toBeUndefined();

    // 予約したセッション自身は、進める手を受け取って claim できる
    expect((await runCommand(next, await fresh(a), { ticket: "t1" })).data.kind).toBe("implement");
    const claimed = await runCommand(ticketClaim, a, claimOf("t1"));
    expect(claimed.data.status).toBe("in_progress");
    expect(claimed.warnings).not.toContainEqual(expect.stringContaining("is being worked on"));

    // next --reserve --take-over は拒否を越え、チケットの予約を呼んだセッションに書く。
    // チケットの予約は Plan の予約より先に効くので、今度は Plan を予約したセッションが止まる
    const takenAt = at(6);
    const taken = await runCommand(next, await fresh(b), {
      ticket: "t2",
      reserve: true,
      take_over: true,
    });
    expect(taken.data.kind).toBe("implement");
    expect(taken.warnings).toContainEqual(
      expect.stringContaining("Took t2 over from session sess-a (it reserved p1"),
    );
    expect(await readReservation(local, "t2")).toEqual({ session: "sess-b", claimed_at: takenAt });
    const lost = await runCommand(next, await fresh(a), { ticket: "t2" });
    expect(lost.data.kind).toBe("wait_session");
    expect(lost.data.commands[0]).toContain("session sess-b (it reserved t2");

    // Plan のないチケットは next --reserve でそのチケットを予約する。--take-over を付けた claim は拒否を越え、予約が移る
    await runCommand(next, a, { ticket: "t3", reserve: true });
    expect(await reservedBy("t3")).toBe("sess-a");
    await expect(runCommand(ticketClaim, b, claimOf("t3"))).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("session sess-a (it reserved t3"),
    });
    const movedAt = at(7);
    const moved = await runCommand(ticketClaim, b, { ...claimOf("t3"), take_over: true });
    expect(moved.warnings).toContainEqual(
      expect.stringContaining("Took t3 over from session sess-a"),
    );
    expect(await readReservation(local, "t3")).toEqual({ session: "sess-b", claimed_at: movedAt });

    // unclaim はチケットの予約を消す（進めるのをやめたチケットを別のセッションが取れる）
    await runCommand(ticketUnclaim, await fresh(b), { ticket: "t3" });
    expect(await reservedBy("t3")).toBeUndefined();

    // Plan を --take-over で引き継ぐと、Plan の予約が移り、その Plan のチケットに残る別のセッションの予約も消える
    at(8);
    await runCommand(planShow, await fresh(a), { plan: "p1", reserve: true });
    await runCommand(next, a, { ticket: "t1", reserve: true });
    await runCommand(planShow, await fresh(b), { plan: "p1", reserve: true, take_over: true });
    expect(await reservedBy("p1")).toBe("sess-b");
    expect(await reservedBy("t1")).toBeUndefined();
    expect(await reservedBy("t2")).toBe("sess-b");
    expect((await runCommand(next, await fresh(a), { ticket: "t2" })).data.kind).toBe(
      "wait_session",
    );

    // claim の記録を持つセッション自身は、別のセッションの予約では止まらない（t1 は sess-a が claim 済み）。
    // 別のセッションがチケットの予約を上書きしても進められ、予約し直すと自分の予約に戻る
    expect((await runCommand(next, a, { ticket: "t1" })).data.kind).toBe("implement");
    await runCommand(next, b, { ticket: "t1", reserve: true, take_over: true });
    expect(await reservedBy("t1")).toBe("sess-b");
    expect((await runCommand(next, a, { ticket: "t1", reserve: true })).data.kind).toBe(
      "implement",
    );
    expect(await reservedBy("t1")).toBe("sess-a");

    // 予約したセッションに SessionEnd が届くと、予約は無視され、別のセッションが進められて予約し直せる
    await recordHookSession(local, "sess-b", at(9), "session_end");
    const backAt = at(10);
    expect((await runCommand(next, await fresh(a), { ticket: "t2" })).data.kind).toBe("implement");
    await runCommand(planShow, a, { plan: "p1", reserve: true });
    expect(await readReservation(local, "p1")).toEqual({ session: "sess-a", claimed_at: backAt });

    // フックが届いている間は予約から 30 分を過ぎても効き、最後のフックから 30 分で無視される
    await recordHookSession(local, "sess-a", at(30), "tool_requested");
    at(59);
    await expect(
      runCommand(planShow, await fresh(b), { plan: "p1", reserve: true }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    at(60);
    await runCommand(planShow, b, { plan: "p1", reserve: true });
    expect(await reservedBy("p1")).toBe("sess-b");

    // Plan を閉じると Plan の予約を消し、閉じた Plan は予約しない
    await runCommand(planClose, await fresh(human), { plan: "p1" });
    expect(await reservedBy("p1")).toBeUndefined();
    const closed = await runCommand(planShow, await fresh(b), { plan: "p1", reserve: true });
    expect(closed.warnings).toContainEqual("p1 is closed, so it was not reserved");
    expect(await reservedBy("p1")).toBeUndefined();

    // 承認待ちの Plan も予約しない（承認を待つ間に、別のセッションの claim を止めない）
    await runCommand(planCreate, await fresh(human), { tickets: ["t3"] });
    const pending = await runCommand(planShow, await fresh(b), { plan: "p2", reserve: true });
    expect(pending.warnings).toContainEqual(expect.stringContaining("p2 is awaiting approval"));
    expect(await reservedBy("p2")).toBeUndefined();

    // 同時の予約は、読む・決める・書くをロックの中で行うので片方だけが通り、もう片方は進める手を受け取らない
    await fresh(a);
    const both = await Promise.all(
      [a, b].map((ctx) => runCommand(next, ctx, { ticket: "t3", reserve: true })),
    );
    const waits = both.map((r) => r.data.kind === "wait_session");
    expect(waits.filter(Boolean)).toHaveLength(1);
    expect(await reservedBy("t3")).toBe(waits[0] ? "sess-b" : "sess-a");
  });
});
