// チケットの流れのうち、もう一度の claim・lint の Run の抜け・手直しの Run の閉じ方

import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "../../test/helpers/git-fixture.js";
import { UsageError } from "../errors.js";
import type { TicketId } from "../model/id.js";
import { recordBaseline } from "../git/outside.js";
import { closeRun, peekRunningRuns, startRun } from "../run/record.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { iterationAdd, iterationClose, iterationCreate } from "./iteration.js";
import { runFinish, runStart } from "./run.js";
import { STALE_SESSION_ERROR } from "./run-close-judge.js";
import { commit, lint, sync } from "./setup.js";
import { ticketClaim, ticketCreate, ticketMove, ticketUnclaim, ticketUpdate } from "./ticket.js";
import {
  initializedBothFixture,
  initializedFixture,
  reopenInitialized,
  agentWithRuns,
  fakeGh,
  pushCommitAt,
  runCleanups,
} from "../../test/helpers/commands-context.js";

// 照合の書き込みが閉じる直前に、別の文脈が先に閉じる形を作るための差し込み（通常は素通し）
const race = vi.hoisted(() => ({ beforeClose: undefined as undefined | (() => Promise<void>) }));
vi.mock("../run/record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run/record.js")>();
  return {
    ...actual,
    closeRun: async (...args: Parameters<typeof actual.closeRun>) => {
      const hook = race.beforeClose;
      race.beforeClose = undefined;
      if (hook) await hook();
      return actual.closeRun(...args);
    },
  };
});

afterEach(runCleanups);

describe("チケットの流れ（もう一度の claim と手直し）", () => {
  // 拒否ともう一度の claim かの組み合わせ（status・担当・PR・--retry-reason・--branch）は claim-judge.test.ts、前の手直しの Run の
  // 閉じ方の組み合わせ（push の時刻・セッション・step・同じ秒の開始）は run-close-judge.test.ts が git なしで見る。ここは経路の代表
  it("自分が claim 済みで PR のあるチケットのもう一度の claim は、チケットを変えずに opens_on: reclaim の step（fix）の Run を --retry-reason 付きで開き、前の手直しの Run は最後の push の時刻で閉じる。ほかの主体の claim と、ブランチを変えるもう一度の claim は拒否する（RN-5・ST-9）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, human, { title: "Reviewed" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const implement = (
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        branch: "t1",
      })
    ).data.run!;
    await git(f.cloneA, ["branch", "t1"]);
    const restore = await fakeGh(f.root, {
      "t1|41":
        '{"number":41,"state":"OPEN","isDraft":false,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
    });
    try {
      clock = new Date("2026-11-06T00:30:00Z");
      await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      expect(agent.store.runs.get(implement)!.data.result).toBe("success");
      // 照合で review に進む（手直しの Run はまだない）
      const first = await runCommand(sync, agent, {});
      expect(first.data.reconciled.map((r) => [r.id, r.to])).toEqual([["t1", "review"]]);
      expect(first.data.runs_closed).toEqual([]);
      const head = (await git(agent.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
      const before = agent.store.tickets.get("t1")!.data;

      // もう一度の claim：チケットは変えず（コミットもしない）、fix の Run に理由を入れて開く
      clock = new Date("2026-11-06T01:00:00Z");
      const reclaimed = await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        retry_reasons: ["指摘 A"],
        session: "s-fix",
      });
      expect(reclaimed.data).toMatchObject({ status: "review", assignee: "eiki/agent", pr: 41 });
      expect(reclaimed.write).toBeUndefined();
      expect(reclaimed.warnings).toEqual([
        "t1 is already claimed by you (eiki/agent) and has PR #41, so this is treated as the start of a fix and the ticket is not changed",
      ]);
      expect((await git(agent.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
      expect(agent.store.tickets.get("t1")!.data).toEqual(before);
      const fix1 = reclaimed.data.run!;
      expect((await peekRunningRuns(agent.repo)).find((r) => r.id === fix1)).toMatchObject({
        ticket: "t1",
        step: "fix",
        agent: "claude-code",
        retries: 1,
        retry_reasons: ["指摘 A"],
        started_at: "2026-11-06T01:00:00Z",
        // もう一度の claim も会話記録の場所を手直しの Run に渡す（RN-5）
        session: "s-fix",
      });

      // 人の claim は Run を開かず、ほかのユーザは CLAIM_LOST。ブランチを変えるもう一度の claim は使い方の誤り
      // （human の索引は別の文脈の変更を知らないので読み直す。CLI では毎回読む）
      await human.store.rescan();
      const humanAgain = await runCommand(ticketClaim, human, { no_worktree: true, ticket: "t1" });
      expect(humanAgain.data.run).toBeNull();
      expect(humanAgain.warnings[0]).toContain(
        "treated as the start of a fix and the ticket is not changed",
      );
      const other = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "taro" } });
      await expect(
        runCommand(ticketClaim, other, { no_worktree: true, ticket: "t1" }),
      ).rejects.toMatchObject({
        code: "CLAIM_LOST",
        message: "t1 is already claimed by eiki/agent",
      });
      await expect(
        runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
          branch: "t1-other",
        }),
      ).rejects.toSatisfy(
        (e) =>
          e instanceof UsageError && e.message.includes("Claiming again cannot change the branch"),
      );
      // 拒否された claim は Run を開かず、前の手直しの Run も閉じない
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([fix1]);
      // 同じブランチ名なら通り、fix の Run が開いたままなので重ねては開かず閉じてから開く
      await pushCommitAt(f.cloneA, "t1", "2026-11-06T01:30:00Z");
      clock = new Date("2026-11-06T02:00:00Z");
      const again = await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        branch: "t1",
        retry_reasons: ["指摘 B", "指摘 C"],
      });
      const fix2 = again.data.run!;
      expect(fix2).not.toBe(fix1);
      expect(again.warnings).toContainEqual(
        `Closed the fix Run ${fix1} of t1 with success (finished_at 2026-11-06T01:30:00Z)`,
      );
      expect(agent.store.runs.get(fix1)!.data).toMatchObject({
        step: "fix",
        result: "success",
        finished_at: "2026-11-06T01:30:00Z",
        retries: 1,
        retry_reasons: ["指摘 A"],
      });
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([fix2]);
      expect((await peekRunningRuns(agent.repo))[0]).toMatchObject({
        retries: 2,
        retry_reasons: ["指摘 B", "指摘 C"],
      });
      // 閉じた集計は commit.mode（既定は batch）に従ってコミットに入る
      await runCommand(commit, agent, {});
      expect(
        (await git(agent.repo.dataDir, ["show", "--name-only", "--format=", "HEAD"])).stdout,
      ).toContain(`runs/${fix1}.json`);
    } finally {
      restore();
    }
  });

  // セッションを読む経路の代表（環境のセッション ID。--session を渡す経路は上の件が Run に入ることを見る）
  it("サブエージェントのもう一度の claim は、DEGUBOARD_SESSION がなくても Claude Code が環境に付けるセッション ID で手直しの Run を開き、別のセッションの前の手直しを interrupted で閉じる（RN-6）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, human, { title: "Subagent fix" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t1",
      branch: "t1",
      no_run: true,
    });
    const restore = await fakeGh(f.root, {
      "41": '{"number":41,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
    });
    // サブエージェントの Bash の環境：SessionStart のフックの DEGUBOARD_SESSION は届かず、Claude Code が親のセッションの ID を付ける
    const subagentOf = (session: string) => {
      agent.env = {
        HOME: agent.env!["HOME"],
        AI_AGENT: "claude-code_2-1-319_agent",
        CLAUDE_CODE_SESSION_ID: session,
      };
    };
    try {
      clock = new Date("2026-11-06T00:30:00Z");
      await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      clock = new Date("2026-11-06T01:00:00Z");
      subagentOf("s-old");
      const fix1 = (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
        })
      ).data.run!;
      // 開いた手直しの Run に、起動した親のセッションの ID が入る
      expect((await peekRunningRuns(agent.repo)).map((r) => [r.id, r.session])).toEqual([
        [fix1, "s-old"],
      ]);
      // s-old が落ちて fix1 が開いたまま残り、別のセッションのサブエージェントが手直しを始める
      clock = new Date("2026-11-06T02:00:00Z");
      subagentOf("s-new");
      const again = await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
      });
      const fix2 = again.data.run!;
      expect(again.warnings).toContainEqual(
        `t1: the earlier fix Run ${fix1} was still open in another session (s-old), so it is treated as left over from a crashed session and closed as interrupted`,
      );
      expect(agent.store.runs.get(fix1)!.data).toMatchObject({
        result: "interrupted",
        error: STALE_SESSION_ERROR,
      });
      // 同じセッションのサブエージェントの前の手直しは、今までどおりこの claim を区切りとして success
      clock = new Date("2026-11-06T03:00:00Z");
      const third = await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
      });
      expect(agent.store.runs.get(fix2)!.data).toMatchObject({ result: "success", error: null });
      // フックが入れた DEGUBOARD_SESSION があれば、そちらを先に使う（親の Bash）
      agent.env = { ...agent.env, DEGUBOARD_SESSION: "s-env" };
      clock = new Date("2026-11-06T04:00:00Z");
      const fourth = await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
      });
      expect(agent.store.runs.get(third.data.run!)!.data.result).toBe("interrupted");
      expect((await peekRunningRuns(agent.repo)).map((r) => [r.id, r.session])).toEqual([
        [fourth.data.run, "s-env"],
      ]);
    } finally {
      restore();
    }
  });

  it("もう一度の claim が閉じる前の手直しの Run を別の文脈が先に閉じていても、claim は止まらずに警告し、新しい手直しの Run を開く（RN-6）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, human, { title: "Raced fix" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t1",
      branch: "t1",
    });
    const restore = await fakeGh(f.root, {
      "41": '{"number":41,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
    });
    try {
      clock = new Date("2026-11-06T00:30:00Z");
      await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      clock = new Date("2026-11-06T01:00:00Z");
      const fix1 = (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
          retry_reasons: ["指摘 A"],
        })
      ).data.run!;
      // 別の文脈（同じマシンの sync に相当）が、もう一度の claim が fix1 を閉じる直前に先に閉じる
      const otherCtx = await agentWithRuns(f.cloneA, () => new Date("2026-11-06T01:10:00Z"));
      race.beforeClose = async () => {
        await closeRun(otherCtx.store, otherCtx.repo, fix1, {
          result: "success",
          finishedAt: "2026-11-06T01:10:00Z",
          now: new Date("2026-11-06T01:10:00Z"),
        });
      };
      const head = (await git(agent.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
      clock = new Date("2026-11-06T02:00:00Z");
      const again = await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        retry_reasons: ["指摘 B"],
      });
      expect(race.beforeClose).toBeUndefined();
      const fix2 = again.data.run!;
      expect(fix2).not.toBe(fix1);
      expect(again.warnings.filter((w) => w.includes(fix1))).toEqual([
        `t1: the fix Run ${fix1} was already closed (another operation or another machine closed it first), so it is not closed in this operation`,
      ]);
      // 先に閉じた方の記録のまま。この claim は書き込まない
      expect(agent.store.runs.get(fix1)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T01:10:00Z",
      });
      expect((await git(agent.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([fix2]);
    } finally {
      race.beforeClose = undefined;
      restore();
    }
  });

  it("もう一度の claim かは取り込んだ後の索引で決め、別のマシンで済んだ claim と PR の記録や unclaim を古い索引で見誤らない（ST-9）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const a = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, a, { title: "Elsewhere" });
    // 同じユーザの別のマシン（clone B）で claim し、PR 番号を記録して push する
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "agent", user: "eiki" },
      now: () => clock,
    });
    const restore = await fakeGh(f.root, {});
    try {
      await runCommand(ticketClaim, b, {
        no_worktree: true,
        ticket: "t1",
        branch: "t1",
        no_run: true,
        approved_by: "human",
      });
      await runCommand(ticketUpdate, b, { ticket: "t1", pr: 41 });
      await runCommand(sync, b, {});
      // clone A の agent の索引は t1 を todo のまま知っているが、claim は取り込んでから判定するので手直しになる
      const agent = await agentWithRuns(f.cloneA, () => clock);
      expect(agent.store.tickets.get("t1")!.data.status).toBe("todo");
      clock = new Date("2026-11-06T01:00:00Z");
      const reclaimed = await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        retry_reasons: ["A"],
      });
      expect(reclaimed.data).toMatchObject({
        status: "in_progress",
        assignee: "eiki/agent",
        pr: 41,
      });
      expect(reclaimed.warnings).toContainEqual(
        "t1 is already claimed by you (eiki/agent) and has PR #41, so this is treated as the start of a fix and the ticket is not changed",
      );
      expect(
        (await peekRunningRuns(agent.repo)).find((r) => r.id === reclaimed.data.run),
      ).toMatchObject({
        step: "fix",
        retry_reasons: ["A"],
      });
      // 逆に、clone B で unclaim されていれば、古い索引では手直しに見えても取り込んでから新しい claim になる
      await runCommand(ticketUnclaim, b, { ticket: "t1" });
      await runCommand(sync, b, {});
      // unclaim で前の PR の記録も外すので、新しい claim は手直しではなく実装の Run になる（ST-7・ST-9）
      const fresh = await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        branch: "t1-again",
      });
      expect(fresh.data).toMatchObject({ status: "in_progress", branch: "t1-again" });
      expect(fresh.data.pr).toBeUndefined();
      expect(fresh.warnings).not.toContainEqual(expect.stringContaining("the start of a fix"));
      expect(
        (await peekRunningRuns(agent.repo)).find((r) => r.id === fresh.data.run),
      ).toMatchObject({
        step: "implement",
      });
    } finally {
      restore();
    }
  });

  it("claim の push が拒否されて最新の状態からやり直すと、拒否はやり直した後の状態で決め直され、そこで止まった claim は前の手直しの Run を閉じない。次に取れた claim が 1 回だけ閉じる（ST-3・RN-6）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, human, { title: "Raced claim" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const restore = await fakeGh(f.root, {
      "41": '{"number":41,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
    });
    try {
      // このマシン（clone A）で claim して PR を記録し、手直しの Run を開いたままにする
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        branch: "t1",
        no_run: true,
      });
      await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      clock = new Date("2026-11-06T01:00:00Z");
      const fix = (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
          session: "s-old",
        })
      ).data.run!;
      await runCommand(sync, agent, {});
      // 同じユーザの別のマシン（clone B）が unclaim する。clone A の手直しの Run は閉じられずに残る
      const b = await openContext({
        cwd: f.cloneB,
        initialize: {},
        actor: { kind: "agent", user: "eiki" },
        now: () => clock,
      });
      await runCommand(sync, b, {});
      await runCommand(ticketUnclaim, b, { ticket: "t1" });
      await runCommand(sync, b, {});
      const taro = await openContext({
        cwd: f.cloneB,
        actor: { kind: "agent", user: "taro" },
        now: () => clock,
      });

      // 1 回目：todo と見て claim を書き、push の直前に別のユーザ（taro）が先に claim する。push は拒否され、
      // やり直した後の状態（taro の claim）で決め直して CLAIM_LOST になる
      let raced = 0;
      agent.hooks = {
        beforePush: async () => {
          agent.hooks = undefined;
          raced += 1;
          await runCommand(ticketClaim, taro, {
            approved_by: "human",
            no_worktree: true,
            ticket: "t1",
            branch: "t1-taro",
            no_run: true,
          });
        },
      };
      clock = new Date("2026-11-06T02:00:00Z");
      await expect(
        runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
          branch: "t1-again",
          session: "s-new",
        }),
      ).rejects.toMatchObject({
        code: "CLAIM_LOST",
        message: "t1 is already claimed by taro/agent",
      });
      // 1 回目の判定は通って push まで進んでいた（拒否は、やり直した後の判定）
      expect(raced).toBe(1);
      expect(agent.store.tickets.get("t1")!.data).toMatchObject({
        status: "in_progress",
        assignee: "taro/agent",
        branch: "t1-taro",
      });
      expect((await git(agent.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
      // 途中で止まった claim は Run を開かず、前の手直しの Run も閉じていない
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([fix]);
      expect(agent.store.runs.has(fix)).toBe(false);

      // taro が unclaim した後の 2 回目：push の直前に別の変更（別のチケットの claim）が入って 1 度拒否され、
      // やり直した後の状態（todo のまま）で決め直して取れる。前の手直しの Run は、取れた後に 1 回だけ閉じる
      await runCommand(ticketUnclaim, taro, { ticket: "t1" });
      await runCommand(sync, taro, {});
      await runCommand(ticketCreate, taro, { title: "Unrelated" });
      await runCommand(sync, taro, {});
      agent.hooks = {
        beforePush: async () => {
          agent.hooks = undefined;
          raced += 1;
          await runCommand(ticketClaim, taro, {
            approved_by: "human",
            no_worktree: true,
            ticket: "t2",
            branch: "t2",
            no_run: true,
          });
        },
      };
      clock = new Date("2026-11-06T03:00:00Z");
      const claimed = await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        branch: "t1-again",
        session: "s-new",
      });
      expect(raced).toBe(2);
      expect(claimed.write).toMatchObject({ pushed: true, attempts: 2 });
      expect(claimed.data).toMatchObject({
        status: "in_progress",
        assignee: "eiki/agent",
        branch: "t1-again",
      });
      // 実装の Run を開くので、別のセッションの前の手直しも success。閉じた知らせは 1 つ
      expect(claimed.warnings.filter((w) => w.includes(fix))).toEqual([
        `t1: closing the earlier fix Run ${fix} with the start of the next implement Run as the boundary, at the start time, since there was no push`,
        `Closed the fix Run ${fix} of t1 with success (finished_at 2026-11-06T03:00:00Z)`,
        `Run ${fix}: metrics.read_transcripts is false, so the conversation record is not read. Usage is left as null`,
      ]);
      expect(agent.store.runs.get(fix)!.data).toMatchObject({
        step: "fix",
        result: "success",
        finished_at: "2026-11-06T03:00:00Z",
      });
      const running = await peekRunningRuns(agent.repo);
      expect(running.map((r) => [r.id, r.step])).toEqual([[claimed.data.run, "implement"]]);
      // 閉じた Run の記録は 1 つのコミットにだけ入る
      await runCommand(commit, agent, {});
      const commits = (
        await git(agent.repo.dataDir, ["log", "--format=%H", "--", `runs/${fix}.json`])
      ).stdout
        .trim()
        .split("\n");
      expect(commits).toHaveLength(1);
    } finally {
      agent.hooks = undefined;
      restore();
    }
  });

  it("lint は agent が PR まで進めたのに実装の Run がないチケットを指摘し、Run がある・人の claim は指摘しない（RN-5・RN-6）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    for (const title of ["No run", "With run", "By human"])
      await runCommand(ticketCreate, human, { title, summary: "s", acceptance: ["a"] });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    // t1 は Run を開かずに claim した agent の PR（Run の抜け）。t2 は Run を開いて PR を記録した agent
    await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t1",
      branch: "t1",
      no_run: true,
    });
    await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t2",
      branch: "t2",
    });
    await runCommand(ticketClaim, human, { no_worktree: true, ticket: "t3", branch: "t3" });
    for (const t of ["t1", "t2", "t3"]) await git(f.cloneA, ["branch", `${t}`]);
    await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
    await runCommand(ticketUpdate, agent, { ticket: "t2", pr: 42 });
    await runCommand(ticketUpdate, human, { ticket: "t3", pr: 43 });
    const missing = async () =>
      (await runCommand(lint, agent, {})).data.issues
        .filter((i) => i.code === "lint_run_implement_missing")
        .map((i) => [i.id, i.message]);
    expect(await missing()).toEqual([
      ["t1", "Reached PR 41, but there is no implementation Run (implement)"],
    ]);
  });

  it("lint は閉じた実装の Run の後の push で、どの Run の期間にも入らないものを指摘し、手直しの Run の期間に入れば指摘しない（RN-6）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, human, {
      title: "Pushed after",
      summary: "s",
      acceptance: ["a"],
    });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t1",
      branch: "t1",
    });
    await git(f.cloneA, ["branch", "t1"]);
    await pushCommitAt(f.cloneA, "t1", "2026-11-06T00:30:00Z");
    // PR の作成（gh がないので今の時刻）で実装の Run を閉じる
    clock = new Date("2026-11-06T01:00:00Z");
    await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
    const outside = async () =>
      (await runCommand(lint, agent, {})).data.issues
        .filter((i) => i.code === "lint_commit_outside_run")
        .map((i) => [i.id, i.message]);
    // 実装の Run の期間（00:00〜01:00）の中の push は指摘しない
    expect(await outside()).toEqual([]);
    // 閉じた後に push されたコミットは、どの Run の期間にも入らない
    await pushCommitAt(f.cloneA, "t1", "2026-11-06T02:00:00Z");
    const tip = (await git(f.cloneA, ["rev-parse", "--short=7", "origin/t1"])).stdout.trim();
    expect(await outside()).toEqual([
      [
        "t1",
        `1 commit(s) after a closed implementation Run (${tip} etc.) fall in no Run's period. Do not rewrite the Run records. Check the content of the commits (git show <sha>) and tell a person (this also happens with a push or rebase by a person, or with a Run opened on another machine)`,
      ],
    ]);
    // 手直しの Run（開いたまま）の期間に入れば指摘しない。もう一度の claim は PR のある自分の claim なので fix を開く
    clock = new Date("2026-11-06T01:30:00Z");
    await runCommand(ticketClaim, agent, { approved_by: "human", no_worktree: true, ticket: "t1" });
    expect(await outside()).toEqual([]);
  });

  it("lint の実装の Run の抜けは、終わっていないチケットと閉じていない Iteration の done だけを見て、閉じた Iteration の done と Iteration のない done は指摘しない", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    for (const title of ["Unfinished", "Done"])
      await runCommand(ticketCreate, human, { title, summary: "s", acceptance: ["a"] });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    for (const t of ["t1", "t2"]) {
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: t,
        branch: `${t}`,
        no_run: true,
      });
      await git(f.cloneA, ["branch", `${t}`]);
      await runCommand(ticketUpdate, agent, { ticket: t, pr: t === "t1" ? 41 : 42 });
    }
    // done は pr_merged が要るので、人が理由を付けて動かす（人の索引は agent の書き込みを知らないので、読み直してから）
    await human.store.rescan();
    await runCommand(ticketMove, human, { ticket: "t2", status: "done", override: "PR なし" });
    await agent.store.rescan();
    const missing = async () =>
      (await runCommand(lint, agent, {})).data.issues
        .filter((i) => i.code === "lint_run_implement_missing")
        .map((i) => i.id);
    // t1 は終わっていない。t2 は done だが Iteration がない
    expect(await missing()).toEqual(["t1"]);
    // 人の索引は agent の書き込みを知らないので、読み直してから Iteration を変える（古い索引で書くと pr を戻す）
    await human.store.rescan();
    await runCommand(iterationCreate, human, { name: "Sprint 1" });
    await runCommand(iterationAdd, human, { iteration: "s1", tickets: ["t2"] });
    await agent.store.rescan();
    // 閉じていない Iteration に入った done は対象
    expect(await missing()).toEqual(["t1", "t2"]);
    // 閉じた Iteration の done は直せないので指摘しない
    await human.store.rescan();
    await runCommand(iterationClose, human, { iteration: "s1" });
    await agent.store.rescan();
    expect(await missing()).toEqual(["t1"]);
  });

  it("lint は作業ブランチに main をマージしたマージコミットを、実装の Run の後のコミットとして指摘しない", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, human, {
      title: "Merged main",
      summary: "s",
      acceptance: ["a"],
    });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t1",
      branch: "t1",
    });
    await git(f.cloneA, ["branch", "t1"]);
    await pushCommitAt(f.cloneA, "t1", "2026-11-06T00:30:00Z");
    clock = new Date("2026-11-06T01:00:00Z");
    await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
    // main に進みを作り、作業ブランチに取り込んで push する（マージコミットは 02:00）
    const saved = { ...process.env };
    try {
      await git(f.cloneA, ["checkout", "--quiet", "main"]);
      process.env["GIT_AUTHOR_DATE"] = process.env["GIT_COMMITTER_DATE"] = "2026-11-06T01:10:00Z";
      await git(f.cloneA, ["commit", "--quiet", "--allow-empty", "-m", "main が進む"]);
      await git(f.cloneA, ["push", "--quiet", "origin", "main"]);
      await git(f.cloneA, ["checkout", "--quiet", "t1"]);
      process.env["GIT_AUTHOR_DATE"] = process.env["GIT_COMMITTER_DATE"] = "2026-11-06T02:00:00Z";
      await git(f.cloneA, ["merge", "--quiet", "--no-ff", "--no-edit", "main"]);
      await git(f.cloneA, ["push", "--quiet", "origin", "t1"]);
      await git(f.cloneA, ["checkout", "--quiet", "main"]);
    } finally {
      delete process.env["GIT_AUTHOR_DATE"];
      delete process.env["GIT_COMMITTER_DATE"];
      Object.assign(process.env, saved);
    }
    expect(
      (await runCommand(lint, agent, {})).data.issues.filter(
        (i) => i.code === "lint_commit_outside_run",
      ),
    ).toEqual([]);
  });

  it("lint は見直し（review）の後にコミットがあるのに、その後に手直しの Run（fix）がないチケットを指摘し、fix がある・見直しのないチケットは指摘しない（t509）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    for (const title of ["Reviewed", "Fixed", "Not reviewed"])
      await runCommand(ticketCreate, human, { title, summary: "s", acceptance: ["a"] });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    for (const t of ["t1", "t2", "t3"]) {
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: t,
        branch: `${t}`,
      });
      await git(f.cloneA, ["branch", `${t}`]);
    }
    clock = new Date("2026-11-06T01:00:00Z");
    for (const t of ["t1", "t2", "t3"])
      await runCommand(ticketUpdate, agent, { ticket: t, pr: 40 + Number(t.slice(1)) });
    // t1 は 01:10〜01:20、t2 は 01:20〜01:25 に見直しをした。t3 は見直しのないチケット
    clock = new Date("2026-11-06T01:10:00Z");
    const review1 = (
      await runCommand(runStart, agent, { ticket: "t1", step: "review", agent: "claude-code" })
    ).data.id;
    clock = new Date("2026-11-06T01:20:00Z");
    await runCommand(runFinish, agent, { run: review1, result: "success" });
    clock = new Date("2026-11-06T01:20:00Z");
    const review2 = (
      await runCommand(runStart, agent, { ticket: "t2", step: "review", agent: "claude-code" })
    ).data.id;
    clock = new Date("2026-11-06T01:25:00Z");
    await runCommand(runFinish, agent, { run: review2, result: "success" });
    // 見直しの後に、手直しの Run のないコミットを push する（コミットの時刻は 01:30）
    for (const t of ["t1", "t2", "t3"])
      await pushCommitAt(f.cloneA, `${t}`, "2026-11-06T01:30:00Z");
    const missing = async () =>
      (await runCommand(lint, agent, {})).data.issues
        .filter((i) => i.code === "lint_run_fix_missing")
        .map((i) => [i.id, i.message]);
    const tipOf = async (t: string) =>
      (await git(f.cloneA, ["rev-parse", "--short=7", `origin/${t}`])).stdout.trim();
    const message = (tip: string) =>
      `1 commit(s) after the review (${tip} etc.), but no fix Run (fix) after them. Do not rewrite the Run records. Check the content of the commits (git show <sha>) and tell a person whether they are fixes (this also happens with a push by a person or a rebase after the review, or with a Run opened on another machine)`;
    expect(await missing()).toEqual([
      ["t1", message(await tipOf("t1"))],
      ["t2", message(await tipOf("t2"))],
    ]);
    // t2 は手直しの claim（fix の Run）を開いたので指摘しない。t1 は開くまで指摘のまま
    clock = new Date("2026-11-06T01:40:00Z");
    await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t2",
      retry_reasons: ["指摘 A"],
    });
    expect((await missing()).map(([id]) => id)).toEqual(["t1"]);
  });

  it("lint は見直しが 2 回あり、手直しの Run が 1 回目の見直しの後にしかない場合は、2 回目の見直しの後のコミットを指摘する（t509）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, human, { title: "Twice", summary: "s", acceptance: ["a"] });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t1",
      branch: "t1",
    });
    await git(f.cloneA, ["branch", "t1"]);
    clock = new Date("2026-11-06T01:00:00Z");
    await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
    // 1 回目の見直し（01:10〜01:20）のあとに手直しの claim（01:25）をして push（01:30）
    clock = new Date("2026-11-06T01:10:00Z");
    const review1 = (
      await runCommand(runStart, agent, { ticket: "t1", step: "review", agent: "claude-code" })
    ).data.id;
    clock = new Date("2026-11-06T01:20:00Z");
    await runCommand(runFinish, agent, { run: review1, result: "success" });
    clock = new Date("2026-11-06T01:25:00Z");
    await runCommand(ticketClaim, agent, {
      approved_by: "human",
      no_worktree: true,
      ticket: "t1",
      retry_reasons: ["指摘 A"],
    });
    await pushCommitAt(f.cloneA, "t1", "2026-11-06T01:30:00Z");
    // 2 回目の見直し（01:40〜01:45）のあとは手直しをせず、push だけする（01:50）
    clock = new Date("2026-11-06T01:40:00Z");
    const review2 = (
      await runCommand(runStart, agent, { ticket: "t1", step: "review", agent: "claude-code" })
    ).data.id;
    clock = new Date("2026-11-06T01:45:00Z");
    await runCommand(runFinish, agent, { run: review2, result: "success" });
    await pushCommitAt(f.cloneA, "t1", "2026-11-06T01:50:00Z");
    const tip = (await git(f.cloneA, ["rev-parse", "--short=7", "origin/t1"])).stdout.trim();
    expect(
      (await runCommand(lint, agent, {})).data.issues
        .filter((i) => i.code === "lint_run_fix_missing")
        .map((i) => [i.id, i.message]),
    ).toEqual([
      [
        "t1",
        `1 commit(s) after the review (${tip} etc.), but no fix Run (fix) after them. Do not rewrite the Run records. Check the content of the commits (git show <sha>) and tell a person whether they are fixes (this also happens with a push by a person or a rebase after the review, or with a Run opened on another machine)`,
      ],
    ]);
  });

  // 区切りと finished_at の組み合わせ（同じ秒の次の Run・複数の次の Run・push が開始より前か区切りより後・PR のマージ時刻・
  // PR の ready）は reconcile-judge.test.ts が git なしで見る。ここは、ロックの外で読んだ最後の push の時刻と索引の Run が決定に届き、
  // 閉じた Run の記録とコミットの題になる経路を、対象のチケット（次の Run の開始・done への前進）と終わったチケットで見る
  it("照合は開いたままの手直しの Run を、次の Run の開始・マージ（done への前進）・終わったチケットの区切りで、それまでの最後の push の時刻で閉じる。unclaim は手直しの Run も failure で閉じる（RN-6）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    for (const title of ["Next run", "Done by move", "Unclaimed"])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    for (const t of ["t1", "t2", "t3"])
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: t,
        branch: `${t}`,
      });
    for (const t of ["t1", "t2", "t3"]) await git(f.cloneA, ["branch", `${t}`]);
    const claimT2 = (await peekRunningRuns(agent.repo)).find((r) => r.ticket === "t2")!.id;
    // t2・t3 は PR 番号だけ記録する（gh は知らない）
    await agent.store.update("ticket", "t2", { pr: 42 });
    await agent.store.update("ticket", "t3", { pr: 43 });
    await recordBaseline(agent.repo);
    let restore = await fakeGh(f.root, {
      "t1|41":
        '{"number":41,"state":"OPEN","isDraft":false,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
    });
    try {
      clock = new Date("2026-11-06T00:30:00Z");
      await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      await runCommand(sync, agent, {});
      expect(agent.store.tickets.get("t1")!.data.status).toBe("review");

      // 区切り 1：同じチケットの次の Run（review）の開始。finished_at はそれまでの最後の push。
      // 次の Run は普段は開いた openRun が前の手直しを閉じるので、ここでは閉じずに開いた形（別のマシン・前の版の dg）を startRun で作る
      const openWithoutClosing = async (ticket: TicketId, step: string) =>
        (await startRun(agent.repo, { ticket, step, agent: "claude-code", now: clock })).id;
      clock = new Date("2026-11-06T01:00:00Z");
      const fix1 = (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
          retry_reasons: ["A"],
        })
      ).data.run!;
      await pushCommitAt(f.cloneA, "t1", "2026-11-06T01:30:00Z");
      // 区切りがなければ閉じない
      expect((await runCommand(sync, agent, {})).data.runs_closed).toEqual([]);
      clock = new Date("2026-11-06T02:00:00Z");
      const review = await openWithoutClosing("t1", "review");
      clock = new Date("2026-11-06T02:10:00Z");
      const synced = await runCommand(sync, agent, {});
      expect(synced.data.reconciled).toEqual([]);
      expect(synced.data.runs_closed).toEqual([
        { id: "t1", run: fix1, opener: "reclaim", result: "success" },
      ]);
      expect(synced.warnings).toContainEqual(
        `t1: closed with start of the next Run ${review} as the boundary (time of the last push)`,
      );
      expect(agent.store.runs.get(fix1)!.data).toMatchObject({
        step: "fix",
        result: "success",
        finished_at: "2026-11-06T01:30:00Z",
        retry_reasons: ["A"],
      });
      expect((await git(agent.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
        `Record fix Runs: t1 ${fix1} success`,
      );
      await runCommand(runFinish, agent, { run: review, result: "success" });

      // 区切り 2：マージ（done への前進）。push より後に始まった次の Run はないので、最後の push の時刻
      clock = new Date("2026-11-06T03:00:00Z");
      const fix2 = (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
          retry_reasons: ["B"],
        })
      ).data.run!;
      await pushCommitAt(f.cloneA, "t1", "2026-11-06T03:30:00Z");
      restore();
      restore = await fakeGh(f.root, {
        "t1|41":
          '{"number":41,"state":"MERGED","isDraft":false,"mergedAt":"2026-11-06T04:00:00Z","createdAt":"2026-11-06T00:20:00Z"}',
      });
      // 区切り 3：終わったチケット。t2 は PR 番号だけあり、手直しの Run を開いた後に人が done にした（branch があるので move は閉じない）
      const fix3 = (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t2",
          retry_reasons: ["C"],
        })
      ).data.run!;
      await human.store.rescan();
      await runCommand(ticketMove, human, { ticket: "t2", status: "done", override: "PR なし" });
      await agent.store.rescan();
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id).sort()).toEqual(
        expect.arrayContaining([fix2, fix3]),
      );
      clock = new Date("2026-11-06T05:00:00Z");
      const merged = await runCommand(sync, agent, {});
      expect(merged.data.reconciled).toEqual([
        { id: "t1", from: "review", to: "done", when: ["pr_merged"] },
      ]);
      expect(merged.data.runs_closed).toEqual([
        { id: "t1", run: fix2, opener: "reclaim", result: "success" },
        // t2 は PR の番号だけあり PR を gh で引けない done なので、実装の Run は今の時刻で success（PR のある done）
        { id: "t2", run: claimT2, opener: "claim", result: "success" },
        { id: "t2", run: fix3, opener: "reclaim", result: "success" },
      ]);
      expect(merged.warnings).toContainEqual(
        "t1: closed with advance to done as the boundary (time of the last push)",
      );
      expect(merged.warnings).toContainEqual(
        "t2: closed with ticket finished (done) as the boundary (current time, since there was no push)",
      );
      expect(agent.store.runs.get(fix2)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T03:30:00Z",
      });
      // push していないブランチでは区切りの時刻も PR の時刻もないので、今の時刻
      expect(agent.store.runs.get(fix3)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T05:00:00Z",
      });

      // unclaim は実装の Run と手直しの Run の両方を failure で閉じる
      const fix6 = (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t3",
        })
      ).data.run!;
      const unclaimed = await runCommand(ticketUnclaim, agent, { ticket: "t3" });
      expect(unclaimed.warnings.filter((w) => /^Closed the .* with failure/.test(w))).toEqual([
        expect.stringMatching(/^Closed the implementation Run r\S+ of t3 with failure/),
        `Closed the fix Run ${fix6} of t3 with failure (finished_at 2026-11-06T05:00:00Z)`,
      ]);
      expect(agent.store.runs.get(fix6)!.data).toMatchObject({
        step: "fix",
        result: "failure",
        error: "Returned to todo by ticket unclaim",
      });
      expect(await peekRunningRuns(agent.repo)).toEqual([]);
    } finally {
      restore();
    }
  });

  // 閉じ方の組み合わせ（PR のない done・todo に戻った・担当の組み合わせ・PR の作成時刻と Run の開始の前後・作成時刻を読めない）は
  // reconcile-judge.test.ts が git なしで見る。ここは、別のマシンの操作を取り込んだ後のチケットの値・sync を呼んだ主体・
  // ロックの外で gh から読んだ PR の作成時刻が決定に届き、閉じた Run の記録とコミットの題になる経路を見る
  it("照合は、別のマシンで終わったチケットの開いたままの実装の Run を ticket move と同じ結果で閉じ、別の主体の claim になったチケットの実装の Run を failure で閉じる。自分の claim は閉じない（RN-6）", async () => {
    const f = await initializedBothFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    for (const title of ["Abandoned elsewhere", "Taken", "Mine", "Done with PR elsewhere"])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    for (const t of ["t1", "t2", "t3", "t4"])
      await runCommand(ticketClaim, agent, { approved_by: "human", no_worktree: true, ticket: t });
    const opened = new Map(
      (await peekRunningRuns(agent.repo)).map((r) => [r.ticket, r.id] as const),
    );
    await runCommand(sync, agent, {});
    // 別のマシン（cloneB）の人が操作してリモートに送る。cloneA の実装の Run は開いたまま残る
    const other = await reopenInitialized(f, { cwd: f.cloneB, now: () => clock });
    await runCommand(sync, other, {});
    clock = new Date("2026-11-06T01:00:00Z");
    await runCommand(ticketMove, other, { ticket: "t1", status: "abandoned" });
    await runCommand(ticketUnclaim, other, { ticket: "t2" });
    // PR のある done：別のマシンが PR を記録して done にした。実装の Run は PR の作成時刻で success になる
    await runCommand(ticketUpdate, other, { ticket: "t4", pr: 46 });
    await runCommand(ticketMove, other, { ticket: "t4", status: "done", override: "PR なし" });
    const hanako = await openContext({
      cwd: f.cloneB,
      actor: { kind: "human", user: "hanako" },
      now: () => clock,
    });
    await runCommand(ticketClaim, hanako, { no_worktree: true, ticket: "t2" });
    await runCommand(sync, other, {});

    clock = new Date("2026-11-06T02:00:00Z");
    const restoreGh = await fakeGh(f.root, {
      "46": '{"number":46,"state":"MERGED","isDraft":false,"mergedAt":"2026-11-06T01:30:00Z","createdAt":"2026-11-06T00:45:00Z"}',
    });
    let synced;
    try {
      synced = await runCommand(sync, agent, {});
    } finally {
      restoreGh();
    }
    expect(synced.data.runs_closed).toHaveLength(3);
    expect(synced.data.runs_closed).toEqual(
      expect.arrayContaining([
        { id: "t1", run: opened.get("t1"), opener: "claim", result: "failure" },
        { id: "t2", run: opened.get("t2"), opener: "claim", result: "failure" },
        { id: "t4", run: opened.get("t4"), opener: "claim", result: "success" },
      ]),
    );
    expect(synced.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Closed the implementation Run r\S+ of t1 with failure/),
        expect.stringMatching(/^Closed the implementation Run r\S+ of t2 with failure/),
        expect.stringMatching(/^Closed the implementation Run r\S+ of t4 with success/),
      ]),
    );
    expect(agent.store.runs.get(opened.get("t4")!)!.data).toMatchObject({
      result: "success",
      finished_at: "2026-11-06T00:45:00Z",
    });
    expect(agent.store.runs.get(opened.get("t2")!)!.data).toMatchObject({
      result: "failure",
      error: "Became claimed by another actor during reconcile",
    });
    expect((await git(agent.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim()).toContain(
      `t1 ${opened.get("t1")} failure`,
    );
    // 自分の claim（in_progress）の実装の Run は開いたまま
    expect((await peekRunningRuns(agent.repo)).map((r) => r.ticket)).toEqual(["t3"]);
    expect(agent.store.tickets.get("t3")!.data.status).toBe("in_progress");
  });

  // 手直しと同じ秒に始まった次の Run を区切りに数えること・手直しでない step は別のセッションの手直しも success で閉じることは、
  // run-close-judge.test.ts（Run を開く操作）と reconcile-judge.test.ts（照合）が git なしで見る。
  // run start が前の手直しを閉じてから開く経路は、下の見直しの修正ループの件が見る
  it("手直しの step の run start を重ねると、開いたままの手直しの Run を閉じずに拒む（二重起動の拒否。SY-5）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, human, { title: "Run start twice" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const start = (step: string, session: string) =>
      runCommand(runStart, agent, { ticket: "t1", step, agent: "claude-code", session });
    clock = new Date("2026-11-06T03:00:00Z");
    const fix = (await start("fix", "s-new")).data.id;
    clock = new Date("2026-11-06T03:10:00Z");
    await expect(start("fix", "s-new")).rejects.toThrow(`Run ${fix} of t1 fix is running`);
    expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([fix]);
    expect(agent.store.runs.has(fix)).toBe(false);
  });

  it("見直しの修正ループの手直しは、draft の PR を記録した in_progress のチケットのもう一度の claim（--retry-reason）が fix の Run を開き、次の見直しの run start と照合の PR の ready が区切りとして push の時刻で閉じる（RN-5・RN-6）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await reopenInitialized(f, { now: () => clock });
    await runCommand(ticketCreate, human, { title: "Review loop" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const implement = (
      await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        branch: "t1",
      })
    ).data.run!;
    await git(f.cloneA, ["branch", "t1"]);
    let restore = await fakeGh(f.root, {
      "t1|41":
        '{"number":41,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
    });
    try {
      // 実装者が draft の PR を作り、親が PR 番号を記録して実装の Run を閉じる。draft なので in_progress のまま
      clock = new Date("2026-11-06T00:30:00Z");
      await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      expect(agent.store.runs.get(implement)!.data.result).toBe("success");
      expect((await runCommand(sync, agent, {})).data.reconciled).toEqual([]);
      clock = new Date("2026-11-06T00:40:00Z");
      const review1 = (
        await runCommand(runStart, agent, { ticket: "t1", step: "review", agent: "claude-code" })
      ).data.id;
      clock = new Date("2026-11-06T00:50:00Z");
      await runCommand(runFinish, agent, { run: review1, result: "success" });

      // 1 回目の手直し：もう一度の claim が理由付きで fix の Run を開く。チケットは in_progress のまま変わらない
      clock = new Date("2026-11-06T01:00:00Z");
      const reclaimed = await runCommand(ticketClaim, agent, {
        approved_by: "human",
        no_worktree: true,
        ticket: "t1",
        retry_reasons: ["指摘 A"],
      });
      expect(reclaimed.data).toMatchObject({ status: "in_progress", pr: 41 });
      expect(reclaimed.write).toBeUndefined();
      const fix1 = reclaimed.data.run!;
      expect((await peekRunningRuns(agent.repo)).find((r) => r.id === fix1)).toMatchObject({
        step: "fix",
        retry_reasons: ["指摘 A"],
        started_at: "2026-11-06T01:00:00Z",
      });
      await pushCommitAt(f.cloneA, "t1", "2026-11-06T01:20:00Z");
      // 区切り（次の見直し・ready）がなければ閉じない
      clock = new Date("2026-11-06T01:25:00Z");
      expect((await runCommand(sync, agent, {})).data.runs_closed).toEqual([]);

      // 見直し直しの review の Run の開始が区切り。run start がその場で閉じ、finished_at は手直しの最後の push の時刻（RN-6）
      clock = new Date("2026-11-06T01:30:00Z");
      const started = await runCommand(runStart, agent, {
        ticket: "t1",
        step: "review",
        agent: "claude-code",
      });
      const review2 = started.data.id;
      expect(started.warnings).toContainEqual(
        `t1: closing the earlier fix Run ${fix1} with the start of the next review Run as the boundary, at the time of the last push`,
      );
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([review2]);
      // 閉じた後の照合は何も閉じない
      clock = new Date("2026-11-06T01:35:00Z");
      expect((await runCommand(sync, agent, {})).data.runs_closed).toEqual([]);
      expect(agent.store.runs.get(fix1)!.data).toMatchObject({
        step: "fix",
        result: "success",
        finished_at: "2026-11-06T01:20:00Z",
        retry_reasons: ["指摘 A"],
      });
      clock = new Date("2026-11-06T01:40:00Z");
      await runCommand(runFinish, agent, { run: review2, result: "success" });

      // 2 回目の手直し：直して push した後に親が PR を ready にすると、照合が review に進めて push の時刻で閉じる
      clock = new Date("2026-11-06T02:00:00Z");
      const fix2 = (
        await runCommand(ticketClaim, agent, {
          approved_by: "human",
          no_worktree: true,
          ticket: "t1",
          retry_reasons: ["指摘 B"],
        })
      ).data.run!;
      await pushCommitAt(f.cloneA, "t1", "2026-11-06T02:20:00Z");
      restore();
      restore = await fakeGh(f.root, {
        "t1|41":
          '{"number":41,"state":"OPEN","isDraft":false,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
      });
      clock = new Date("2026-11-06T02:30:00Z");
      const ready = await runCommand(sync, agent, {});
      expect(ready.data.reconciled).toEqual([
        { id: "t1", from: "in_progress", to: "review", when: ["pr_open", "!pr_draft"] },
      ]);
      expect(ready.data.runs_closed).toEqual([
        { id: "t1", run: fix2, opener: "reclaim", result: "success" },
      ]);
      expect(ready.warnings).toContainEqual(
        "t1: closed with advance to review as the boundary (time of the last push)",
      );
      expect(agent.store.runs.get(fix2)!.data).toMatchObject({
        step: "fix",
        result: "success",
        finished_at: "2026-11-06T02:20:00Z",
        retry_reasons: ["指摘 B"],
      });
      expect(await peekRunningRuns(agent.repo)).toEqual([]);
    } finally {
      restore();
    }
  });
});
