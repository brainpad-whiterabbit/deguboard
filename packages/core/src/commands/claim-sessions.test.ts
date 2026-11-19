// claim したセッションの記録を読み書きする経路の代表（SY-5。t1148）。記録が効くか・拒むかの組み合わせ（SessionEnd・30 分・主体・
// セッション・--take-over）は claim-judge.test.ts が git なしで見る。ここは、記録が deguboard-local に書かれて Git に入らないこと、
// フックの記録から生きているかを読むこと、通った操作が記録を移す・消すことを、git を通して確かめる

import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../test/helpers/git-fixture.js";
import { toIsoDateTime } from "../model/common.js";
import { readSessionClaim } from "./claim-sessions.js";
import type { CommandContext } from "./define.js";
import { runCommand } from "./define.js";
import { recordHookSession } from "./hook-records.js";
import { ticketClaim, ticketCreate, ticketUnclaim, ticketUpdate } from "./ticket.js";
import {
  agentWithRuns,
  fakeGh,
  initializedFixture,
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

const again = { approved_by: "human", no_worktree: true, no_run: true, ticket: "t1" } as const;

describe("claim したセッションの記録（SY-5）", () => {
  it("agent の claim は呼んだセッションを deguboard-local に記録して Git には書かず、別のセッションのもう一度の claim・unclaim を拒む。--take-over で記録が移り、SessionEnd か 30 分で無視され、人とセッションのわからない呼び出しは警告だけで記録を作らない", async () => {
    const f = await initializedFixture();
    const start = new Date("2026-11-06T00:00:00Z");
    let clock = start;
    /** start から分だけ後に時計を進め、その時刻の文字列を返す */
    const at = (minutes: number) => {
      clock = new Date(start.getTime() + minutes * 60_000);
      return toIsoDateTime(clock);
    };
    const human = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, human, { title: "Shared" });
    const a = await inSession(f.cloneA, "sess-a", () => clock);
    const b = await inSession(f.cloneA, "sess-b", () => clock);
    const unknown = await agentWithRuns(f.cloneA, () => clock);
    const local = a.repo.localDir;
    const restore = await fakeGh(f.root, {
      "41": '{"number":41,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T00:02:00Z"}',
    });
    try {
      // 新しい claim：push の後に、呼んだセッションを記録する。Git のデータには書かない
      const claimedAt = at(0);
      await runCommand(ticketClaim, a, { ...again, branch: "t1" });
      expect(await readSessionClaim(local, "t1")).toEqual({
        session: "sess-a",
        claimed_at: claimedAt,
      });
      const history = (await git(a.repo.dataDir, ["log", "-p", "--all"])).stdout;
      expect(history).toContain("Claim t1");
      expect(history).not.toContain("sess-a");
      expect(history).not.toContain("claim-sessions");

      // 別のセッションの unclaim は拒み、記録したセッションと越え方を示す。チケットも記録も変わらない
      at(5);
      await expect(
        runCommand(ticketUnclaim, await fresh(b), { ticket: "t1" }),
      ).rejects.toMatchObject({
        code: "REJECTED",
        message: expect.stringMatching(
          /another session of yours: session sess-a .*cannot unclaim it.*add --take-over/,
        ),
      });
      expect((await fresh(b)).store.tickets.get("t1")!.data.status).toBe("in_progress");

      // PR を記録すると、次の claim はもう一度の claim になる。別のセッションのそれも拒む
      await runCommand(ticketUpdate, await fresh(a), { ticket: "t1", pr: 41 });
      await expect(runCommand(ticketClaim, await fresh(b), again)).rejects.toMatchObject({
        code: "REJECTED",
        message: expect.stringMatching(
          /another session of yours: session sess-a .*cannot claim it again.*add --take-over/,
        ),
      });
      expect(await readSessionClaim(local, "t1")).toEqual({
        session: "sess-a",
        claimed_at: claimedAt,
      });

      // 人とセッションのわからない agent は拒まれず、警告だけで、記録も変えない
      const byHuman = await runCommand(ticketClaim, await fresh(human), {
        no_worktree: true,
        ticket: "t1",
      });
      expect(byHuman.warnings).toContainEqual(
        expect.stringContaining("A person's claim is not stopped"),
      );
      const byUnknown = await runCommand(ticketClaim, await fresh(unknown), again);
      expect(byUnknown.warnings).toContainEqual(
        expect.stringContaining("The session calling dg is unknown"),
      );
      expect((await readSessionClaim(local, "t1"))?.session).toBe("sess-a");

      // --take-over は拒否を越え、記録は呼んだセッションに移る。今度は前のセッションが拒まれる
      const takenAt = at(6);
      const taken = await runCommand(ticketClaim, await fresh(b), { ...again, take_over: true });
      expect(taken.warnings).toContainEqual(
        expect.stringContaining("Took t1 over from session sess-a"),
      );
      expect(await readSessionClaim(local, "t1")).toEqual({
        session: "sess-b",
        claimed_at: takenAt,
      });
      await expect(runCommand(ticketClaim, await fresh(a), again)).rejects.toMatchObject({
        code: "REJECTED",
        message: expect.stringContaining("session sess-b"),
      });

      // 記録したセッションに SessionEnd が届くと、記録は無視され、別のセッションの claim が通って記録が移る
      await recordHookSession(local, "sess-b", at(7), "session_end");
      const backAt = at(8);
      const back = await runCommand(ticketClaim, await fresh(a), again);
      expect(back.warnings).not.toContainEqual(expect.stringContaining("sess-b"));
      expect(await readSessionClaim(local, "t1")).toEqual({
        session: "sess-a",
        claimed_at: backAt,
      });

      // フックが届いている間は記録から 30 分を過ぎても効き、最後のフックから 30 分で無視される
      await recordHookSession(local, "sess-a", at(30), "tool_requested");
      at(59);
      await expect(runCommand(ticketClaim, await fresh(b), again)).rejects.toMatchObject({
        code: "REJECTED",
      });
      const idleAt = at(60);
      await runCommand(ticketClaim, await fresh(b), again);
      expect(await readSessionClaim(local, "t1")).toEqual({
        session: "sess-b",
        claimed_at: idleAt,
      });

      // 人の unclaim は警告だけで通り、claim がなくなるので記録を消す
      at(61);
      const released = await runCommand(ticketUnclaim, await fresh(human), { ticket: "t1" });
      expect(released.data.status).toBe("todo");
      expect(released.warnings).toContainEqual(
        expect.stringContaining("A person's unclaim is not stopped"),
      );
      expect(await readSessionClaim(local, "t1")).toBeUndefined();

      // セッションのわからない agent の新しい claim は記録を作らないので、別のセッションの unclaim も拒まれない
      await runCommand(ticketClaim, await fresh(unknown), { ...again, branch: "t1-again" });
      expect(await readSessionClaim(local, "t1")).toBeUndefined();
      const dropped = await runCommand(ticketUnclaim, await fresh(b), { ticket: "t1" });
      expect(dropped.data.status).toBe("todo");

      // --take-over を付けた unclaim は拒否を越え、claim がなくなるので記録を消す
      await runCommand(ticketClaim, await fresh(a), { ...again, branch: "t1-third" });
      expect((await readSessionClaim(local, "t1"))?.session).toBe("sess-a");
      await runCommand(ticketUnclaim, await fresh(b), { ticket: "t1", take_over: true });
      expect(await readSessionClaim(local, "t1")).toBeUndefined();
    } finally {
      restore();
    }
  });
});
