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
import { runFinish, runStart, STALE_SESSION_ERROR } from "./run.js";
import { commit, lint, sync } from "./setup.js";
import { ticketClaim, ticketCreate, ticketMove, ticketUnclaim, ticketUpdate } from "./ticket.js";
import {
  fixture,
  initialized,
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
  it("自分が claim 済みで PR のあるチケットのもう一度の claim は、チケットを変えずに opens_on: reclaim の step（fix）の Run を --retry-reason 付きで開き、前の手直しの Run は最後の push の時刻で閉じる。ほかの主体と PR のない自分の claim は拒否する（RN-5）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    for (const title of ["Reviewed", "No PR", "Todo"])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const implement = (await runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/t1" }))
      .data.run!;
    await runCommand(ticketClaim, agent, { ticket: "t2", branch: "feat/t2", no_run: true });
    await git(f.cloneA, ["branch", "feat/t1"]);
    const restore = await fakeGh(f.root, {
      "feat/t1|41":
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
        ticket: "t1",
        retry_reasons: ["指摘 A"],
        session: "s-fix",
      });
      expect(reclaimed.data).toMatchObject({ status: "review", assignee: "eiki/agent", pr: 41 });
      expect(reclaimed.write).toBeUndefined();
      expect(reclaimed.warnings).toEqual([
        "t1 は自分（eiki/agent）が claim 済みで PR #41 があるので、手直しの開始とみなしてチケットは変えない",
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
        // もう一度の claim も会話記録の場所を手直しの Run に渡す（ADR-005）
        session: "s-fix",
      });

      // 人の claim は Run を開かず、ほかのユーザは CLAIM_LOST。自分でも PR のないチケットは手直しにならない。todo の claim に理由は渡せない
      // （human の索引は別の文脈の変更を知らないので読み直す。CLI では毎回読む）
      await human.store.rescan();
      const humanAgain = await runCommand(ticketClaim, human, { ticket: "t1" });
      expect(humanAgain.data.run).toBeNull();
      expect(humanAgain.warnings[0]).toContain("手直しの開始とみなしてチケットは変えない");
      const other = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "taro" } });
      await expect(runCommand(ticketClaim, other, { ticket: "t1" })).rejects.toMatchObject({
        code: "CLAIM_LOST",
        message: "t1 は eiki/agent が claim 済み",
      });
      await expect(runCommand(ticketClaim, agent, { ticket: "t2" })).rejects.toMatchObject({
        code: "CLAIM_LOST",
        message: expect.stringContaining("PR がまだない"),
      });
      await expect(
        runCommand(ticketClaim, agent, { ticket: "t3", retry_reasons: ["x"] }),
      ).rejects.toBeInstanceOf(UsageError);
      await expect(
        runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/other" }),
      ).rejects.toBeInstanceOf(UsageError);
      await expect(
        runCommand(ticketClaim, agent, { ticket: "t1", without_branch: true }),
      ).rejects.toBeInstanceOf(UsageError);
      // 同じブランチ名なら通り、fix の Run が開いたままなので重ねては開かず閉じてから開く
      await pushCommitAt(f.cloneA, "feat/t1", "2026-11-06T01:30:00Z");
      clock = new Date("2026-11-06T02:00:00Z");
      const again = await runCommand(ticketClaim, agent, {
        ticket: "t1",
        branch: "feat/t1",
        retry_reasons: ["指摘 B", "指摘 C"],
      });
      const fix2 = again.data.run!;
      expect(fix2).not.toBe(fix1);
      expect(again.warnings).toContainEqual(
        `t1 の手直しの Run ${fix1} を success で閉じた（finished_at 2026-11-06T01:30:00Z）`,
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
      // 前の Run の開始（02:00）より後の push がなければ、最後の push（01:30）ではなくこの claim の時刻で閉じる
      clock = new Date("2026-11-06T02:30:00Z");
      const third = await runCommand(ticketClaim, agent, { ticket: "t1" });
      expect(third.warnings).toContainEqual(
        `t1: 前の手直しの Run ${fix2} を、次の fix の Run の開始を区切りとして、push がないので開始の時刻で閉じる`,
      );
      expect(agent.store.runs.get(fix2)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T02:30:00Z",
      });
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([third.data.run]);
      // 閉じた集計は commit.mode（既定は batch）に従ってコミットに入る（fix1 の集計は 3 回目の claim の書き込みが先にまとめてコミットした）
      await runCommand(commit, agent, {});
      expect(
        (await git(agent.repo.dataDir, ["show", "--name-only", "--format=", "HEAD"])).stdout,
      ).toContain(`runs/${fix2}.json`);
      expect(agent.store.runs.has(fix1)).toBe(true);
    } finally {
      restore();
    }
  });

  it("もう一度の claim は、別のセッションで開いたままの前の手直しの Run を落ちたセッションの残りとみなして interrupted で閉じ、同じセッションの前の手直しは今までどおり区切りとして success で閉じる（ADR-025）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    await runCommand(ticketCreate, human, { title: "Crashed fix" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/t1" });
    const restore = await fakeGh(f.root, {
      "41": '{"number":41,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
    });
    try {
      clock = new Date("2026-11-06T00:30:00Z");
      await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      clock = new Date("2026-11-06T01:00:00Z");
      const fix1 = (await runCommand(ticketClaim, agent, { ticket: "t1", session: "s-old" })).data
        .run!;
      // s-old が落ちて fix1 が開いたまま残り、別のセッションが手直しを始める
      clock = new Date("2026-11-06T02:00:00Z");
      const again = await runCommand(ticketClaim, agent, { ticket: "t1", session: "s-new" });
      const fix2 = again.data.run!;
      expect(fix2).not.toBe(fix1);
      expect(again.warnings).toContainEqual(
        `t1: 前の手直しの Run ${fix1} は別のセッション（s-old）で開いたままだったので、落ちたセッションの残りとみなして interrupted で閉じる`,
      );
      expect(agent.store.runs.get(fix1)!.data).toMatchObject({
        step: "fix",
        result: "interrupted",
        error: STALE_SESSION_ERROR,
        finished_at: "2026-11-06T02:00:00Z",
      });
      // 同じセッションの前の手直しは、今までどおりこの claim を区切りとして success
      clock = new Date("2026-11-06T03:00:00Z");
      const third = await runCommand(ticketClaim, agent, { ticket: "t1", session: "s-new" });
      expect(third.warnings).toContainEqual(
        `t1: 前の手直しの Run ${fix2} を、次の fix の Run の開始を区切りとして、push がないので開始の時刻で閉じる`,
      );
      expect(agent.store.runs.get(fix2)!.data).toMatchObject({ result: "success", error: null });
      // --session を省けば、フックが環境に入れた DEGUBOARD_SESSION と比べる
      agent.env = { ...agent.env, DEGUBOARD_SESSION: "s-env" };
      clock = new Date("2026-11-06T04:00:00Z");
      const fourth = await runCommand(ticketClaim, agent, { ticket: "t1" });
      expect(agent.store.runs.get(third.data.run!)!.data.result).toBe("interrupted");
      expect((await peekRunningRuns(agent.repo)).map((r) => [r.id, r.session])).toEqual([
        [fourth.data.run, "s-env"],
      ]);
    } finally {
      restore();
    }
  });

  it("サブエージェントのもう一度の claim は、DEGUBOARD_SESSION がなくても Claude Code が環境に付けるセッション ID で手直しの Run を開き、別のセッションの前の手直しを interrupted で閉じる（ADR-025）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    await runCommand(ticketCreate, human, { title: "Subagent fix" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/t1", no_run: true });
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
      const fix1 = (await runCommand(ticketClaim, agent, { ticket: "t1" })).data.run!;
      // 開いた手直しの Run に、起動した親のセッションの ID が入る
      expect((await peekRunningRuns(agent.repo)).map((r) => [r.id, r.session])).toEqual([
        [fix1, "s-old"],
      ]);
      // s-old が落ちて fix1 が開いたまま残り、別のセッションのサブエージェントが手直しを始める
      clock = new Date("2026-11-06T02:00:00Z");
      subagentOf("s-new");
      const again = await runCommand(ticketClaim, agent, { ticket: "t1" });
      const fix2 = again.data.run!;
      expect(again.warnings).toContainEqual(
        `t1: 前の手直しの Run ${fix1} は別のセッション（s-old）で開いたままだったので、落ちたセッションの残りとみなして interrupted で閉じる`,
      );
      expect(agent.store.runs.get(fix1)!.data).toMatchObject({
        result: "interrupted",
        error: STALE_SESSION_ERROR,
      });
      // 同じセッションのサブエージェントの前の手直しは、今までどおりこの claim を区切りとして success
      clock = new Date("2026-11-06T03:00:00Z");
      const third = await runCommand(ticketClaim, agent, { ticket: "t1" });
      expect(agent.store.runs.get(fix2)!.data).toMatchObject({ result: "success", error: null });
      // フックが入れた DEGUBOARD_SESSION があれば、そちらを先に使う（親の Bash）
      agent.env = { ...agent.env, DEGUBOARD_SESSION: "s-env" };
      clock = new Date("2026-11-06T04:00:00Z");
      const fourth = await runCommand(ticketClaim, agent, { ticket: "t1" });
      expect(agent.store.runs.get(third.data.run!)!.data.result).toBe("interrupted");
      expect((await peekRunningRuns(agent.repo)).map((r) => [r.id, r.session])).toEqual([
        [fourth.data.run, "s-env"],
      ]);
    } finally {
      restore();
    }
  });

  it("もう一度の claim が閉じる前の手直しの Run を別の文脈が先に閉じていても、claim は止まらずに警告し、新しい手直しの Run を開く（RN-6）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    await runCommand(ticketCreate, human, { title: "Raced fix" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/t1" });
    const restore = await fakeGh(f.root, {
      "41": '{"number":41,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
    });
    try {
      clock = new Date("2026-11-06T00:30:00Z");
      await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      clock = new Date("2026-11-06T01:00:00Z");
      const fix1 = (
        await runCommand(ticketClaim, agent, { ticket: "t1", retry_reasons: ["指摘 A"] })
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
        ticket: "t1",
        retry_reasons: ["指摘 B"],
      });
      expect(race.beforeClose).toBeUndefined();
      const fix2 = again.data.run!;
      expect(fix2).not.toBe(fix1);
      expect(again.warnings.filter((w) => w.includes(fix1))).toEqual([
        `t1: 手直しの Run ${fix1} は既に閉じていた（別の操作や別のマシンが先に閉じた）ので、この操作では閉じない`,
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

  it("もう一度の claim かは取り込んだ後の索引で決め、別のマシンで済んだ claim と PR の記録や unclaim を古い索引で見誤らない（ST-3）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const a = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
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
      await runCommand(ticketClaim, b, { ticket: "t1", branch: "feat/t1", no_run: true });
      await runCommand(ticketUpdate, b, { ticket: "t1", pr: 41 });
      await runCommand(sync, b, {});
      // clone A の agent の索引は t1 を todo のまま知っているが、claim は取り込んでから判定するので手直しになる
      const agent = await agentWithRuns(f.cloneA, () => clock);
      expect(agent.store.tickets.get("t1")!.data.status).toBe("todo");
      clock = new Date("2026-11-06T01:00:00Z");
      const reclaimed = await runCommand(ticketClaim, agent, {
        ticket: "t1",
        retry_reasons: ["A"],
      });
      expect(reclaimed.data).toMatchObject({
        status: "in_progress",
        assignee: "eiki/agent",
        pr: 41,
      });
      expect(reclaimed.warnings).toContainEqual(
        "t1 は自分（eiki/agent）が claim 済みで PR #41 があるので、手直しの開始とみなしてチケットは変えない",
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
      // unclaim で前の PR の記録も外すので、新しい claim は手直しではなく実装の Run になる（ST-3・ST-7）
      const fresh = await runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/t1-again" });
      expect(fresh.data).toMatchObject({ status: "in_progress", branch: "feat/t1-again" });
      expect(fresh.data.pr).toBeUndefined();
      expect(fresh.warnings).not.toContainEqual(expect.stringContaining("手直しの開始"));
      expect(
        (await peekRunningRuns(agent.repo)).find((r) => r.id === fresh.data.run),
      ).toMatchObject({
        step: "implement",
      });
    } finally {
      restore();
    }
  });

  it("lint は agent が PR まで進めたのに実装の Run がないチケットを指摘し、Run がある・人の claim は指摘しない（RN-5・RN-6）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    for (const title of ["No run", "With run", "By human"])
      await runCommand(ticketCreate, human, { title, summary: "s", acceptance: ["a"] });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    // t1 は Run を開かずに claim した agent の PR（Run の抜け）。t2 は Run を開いて PR を記録した agent
    await runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/t1", no_run: true });
    await runCommand(ticketClaim, agent, { ticket: "t2", branch: "feat/t2" });
    await runCommand(ticketClaim, human, { ticket: "t3", branch: "feat/t3" });
    for (const t of ["t1", "t2", "t3"]) await git(f.cloneA, ["branch", `feat/${t}`]);
    await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
    await runCommand(ticketUpdate, agent, { ticket: "t2", pr: 42 });
    await runCommand(ticketUpdate, human, { ticket: "t3", pr: 43 });
    const missing = async () =>
      (await runCommand(lint, agent, {})).data.issues
        .filter((i) => i.code === "lint_run_implement_missing")
        .map((i) => [i.id, i.message]);
    expect(await missing()).toEqual([["t1", "PR 41 まで進んだが実装の Run（implement）がない"]]);
  });

  it("lint は閉じた実装の Run の後の push で、どの Run の期間にも入らないものを指摘し、手直しの Run の期間に入れば指摘しない（RN-6）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    await runCommand(ticketCreate, human, {
      title: "Pushed after",
      summary: "s",
      acceptance: ["a"],
    });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/t1" });
    await git(f.cloneA, ["branch", "feat/t1"]);
    await pushCommitAt(f.cloneA, "feat/t1", "2026-11-06T00:30:00Z");
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
    await pushCommitAt(f.cloneA, "feat/t1", "2026-11-06T02:00:00Z");
    const tip = (await git(f.cloneA, ["rev-parse", "--short=7", "origin/feat/t1"])).stdout.trim();
    expect(await outside()).toEqual([
      ["t1", `実装の Run を閉じた後のコミット 1 件（${tip} など）がどの Run の期間にも入らない`],
    ]);
    // 手直しの Run（開いたまま）の期間に入れば指摘しない。もう一度の claim は PR のある自分の claim なので fix を開く
    clock = new Date("2026-11-06T01:30:00Z");
    await runCommand(ticketClaim, agent, { ticket: "t1" });
    expect(await outside()).toEqual([]);
  });

  it("lint の実装の Run の抜けは、終わっていないチケットと閉じていない Iteration の done だけを見て、閉じた Iteration の done と Iteration のない done は指摘しない", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    for (const title of ["Unfinished", "Done"])
      await runCommand(ticketCreate, human, { title, summary: "s", acceptance: ["a"] });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    for (const t of ["t1", "t2"]) {
      await runCommand(ticketClaim, agent, { ticket: t, branch: `feat/${t}`, no_run: true });
      await git(f.cloneA, ["branch", `feat/${t}`]);
      await runCommand(ticketUpdate, agent, { ticket: t, pr: t === "t1" ? 41 : 42 });
    }
    await runCommand(ticketMove, agent, { ticket: "t2", status: "done" });
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
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    await runCommand(ticketCreate, human, {
      title: "Merged main",
      summary: "s",
      acceptance: ["a"],
    });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/t1" });
    await git(f.cloneA, ["branch", "feat/t1"]);
    await pushCommitAt(f.cloneA, "feat/t1", "2026-11-06T00:30:00Z");
    clock = new Date("2026-11-06T01:00:00Z");
    await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
    // main に進みを作り、作業ブランチに取り込んで push する（マージコミットは 02:00）
    const saved = { ...process.env };
    try {
      await git(f.cloneA, ["checkout", "--quiet", "main"]);
      process.env["GIT_AUTHOR_DATE"] = process.env["GIT_COMMITTER_DATE"] = "2026-11-06T01:10:00Z";
      await git(f.cloneA, ["commit", "--quiet", "--allow-empty", "-m", "main が進む"]);
      await git(f.cloneA, ["push", "--quiet", "origin", "main"]);
      await git(f.cloneA, ["checkout", "--quiet", "feat/t1"]);
      process.env["GIT_AUTHOR_DATE"] = process.env["GIT_COMMITTER_DATE"] = "2026-11-06T02:00:00Z";
      await git(f.cloneA, ["merge", "--quiet", "--no-ff", "--no-edit", "main"]);
      await git(f.cloneA, ["push", "--quiet", "origin", "feat/t1"]);
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
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    for (const title of ["Reviewed", "Fixed", "Not reviewed"])
      await runCommand(ticketCreate, human, { title, summary: "s", acceptance: ["a"] });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    for (const t of ["t1", "t2", "t3"]) {
      await runCommand(ticketClaim, agent, { ticket: t, branch: `feat/${t}` });
      await git(f.cloneA, ["branch", `feat/${t}`]);
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
      await pushCommitAt(f.cloneA, `feat/${t}`, "2026-11-06T01:30:00Z");
    const missing = async () =>
      (await runCommand(lint, agent, {})).data.issues
        .filter((i) => i.code === "lint_run_fix_missing")
        .map((i) => [i.id, i.message]);
    const tipOf = async (t: string) =>
      (await git(f.cloneA, ["rev-parse", "--short=7", `origin/feat/${t}`])).stdout.trim();
    const message = (tip: string) =>
      `見直しの後のコミット 1 件（${tip} など）があるが、その後に手直しの Run（fix）がない`;
    expect(await missing()).toEqual([
      ["t1", message(await tipOf("t1"))],
      ["t2", message(await tipOf("t2"))],
    ]);
    // t2 は手直しの claim（fix の Run）を開いたので指摘しない。t1 は開くまで指摘のまま
    clock = new Date("2026-11-06T01:40:00Z");
    await runCommand(ticketClaim, agent, { ticket: "t2", retry_reasons: ["指摘 A"] });
    expect((await missing()).map(([id]) => id)).toEqual(["t1"]);
  });

  it("lint は見直しが 2 回あり、手直しの Run が 1 回目の見直しの後にしかない場合は、2 回目の見直しの後のコミットを指摘する（t509）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    await runCommand(ticketCreate, human, { title: "Twice", summary: "s", acceptance: ["a"] });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/t1" });
    await git(f.cloneA, ["branch", "feat/t1"]);
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
    await runCommand(ticketClaim, agent, { ticket: "t1", retry_reasons: ["指摘 A"] });
    await pushCommitAt(f.cloneA, "feat/t1", "2026-11-06T01:30:00Z");
    // 2 回目の見直し（01:40〜01:45）のあとは手直しをせず、push だけする（01:50）
    clock = new Date("2026-11-06T01:40:00Z");
    const review2 = (
      await runCommand(runStart, agent, { ticket: "t1", step: "review", agent: "claude-code" })
    ).data.id;
    clock = new Date("2026-11-06T01:45:00Z");
    await runCommand(runFinish, agent, { run: review2, result: "success" });
    await pushCommitAt(f.cloneA, "feat/t1", "2026-11-06T01:50:00Z");
    const tip = (await git(f.cloneA, ["rev-parse", "--short=7", "origin/feat/t1"])).stdout.trim();
    expect(
      (await runCommand(lint, agent, {})).data.issues
        .filter((i) => i.code === "lint_run_fix_missing")
        .map((i) => [i.id, i.message]),
    ).toEqual([
      ["t1", `見直しの後のコミット 1 件（${tip} など）があるが、その後に手直しの Run（fix）がない`],
    ]);
  });

  it("照合は開いたままの手直しの Run を、次の Run の開始・マージ（done への前進）・終わったチケットの区切りで、それまでの最後の push の時刻で閉じる。unclaim は手直しの Run も failure で閉じる（RN-6）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    for (const title of ["Next run", "Done by move", "Unclaimed", "Ready later"])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    for (const t of ["t1", "t2", "t3", "t4"])
      await runCommand(ticketClaim, agent, { ticket: t, branch: `feat/${t}` });
    for (const t of ["t1", "t2", "t3", "t4"]) await git(f.cloneA, ["branch", `feat/${t}`]);
    const claimT2 = (await peekRunningRuns(agent.repo)).find((r) => r.ticket === "t2")!.id;
    // t2・t3 は PR 番号だけ記録する（gh は知らない）
    await agent.store.update("ticket", "t2", { pr: 42 });
    await agent.store.update("ticket", "t3", { pr: 43 });
    await recordBaseline(agent.repo);
    let restore = await fakeGh(f.root, {
      "feat/t1|41":
        '{"number":41,"state":"OPEN","isDraft":false,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
      "feat/t4|44":
        '{"number":44,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
    });
    try {
      clock = new Date("2026-11-06T00:30:00Z");
      await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      await runCommand(ticketUpdate, agent, { ticket: "t4", pr: 44 });
      await runCommand(sync, agent, {});
      expect(agent.store.tickets.get("t1")!.data.status).toBe("review");
      // t4 の PR は draft のまま（上限を超えて人を待つ形）なので in_progress のまま
      expect(agent.store.tickets.get("t4")!.data.status).toBe("in_progress");

      // 区切り 1：同じチケットの次の Run（review）の開始。finished_at はそれまでの最後の push。
      // 次の Run は普段は開いた openRun が前の手直しを閉じるので、ここでは閉じずに開いた形（別のマシン・前の版の dg）を startRun で作る
      const openWithoutClosing = async (ticket: TicketId, step: string) =>
        (await startRun(agent.repo, { ticket, step, agent: "claude-code", now: clock })).id;
      clock = new Date("2026-11-06T01:00:00Z");
      const fix1 = (await runCommand(ticketClaim, agent, { ticket: "t1", retry_reasons: ["A"] }))
        .data.run!;
      await pushCommitAt(f.cloneA, "feat/t1", "2026-11-06T01:30:00Z");
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
        `t1: 次の Run ${review} の開始を区切りとして閉じた（最後の push の時刻）`,
      );
      expect(agent.store.runs.get(fix1)!.data).toMatchObject({
        step: "fix",
        result: "success",
        finished_at: "2026-11-06T01:30:00Z",
        retry_reasons: ["A"],
      });
      expect((await git(agent.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
        `手直しの Run を記録: t1 ${fix1} success`,
      );
      await runCommand(runFinish, agent, { run: review, result: "success" });

      // 区切り 2：マージ（done への前進）。push より後に始まった次の Run はないので、最後の push の時刻
      clock = new Date("2026-11-06T03:00:00Z");
      const fix2 = (await runCommand(ticketClaim, agent, { ticket: "t1", retry_reasons: ["B"] }))
        .data.run!;
      await pushCommitAt(f.cloneA, "feat/t1", "2026-11-06T03:30:00Z");
      // 区切り 4：PR の ready（review への前進）。draft のまま待っていた t4 を続けて直し、push の後に ready になった
      const fix5 = (await runCommand(ticketClaim, agent, { ticket: "t4", retry_reasons: ["D"] }))
        .data.run!;
      await pushCommitAt(f.cloneA, "feat/t4", "2026-11-06T03:40:00Z");
      // 区切り 5：最後の push（04:00）が手直しの Run の開始（04:30）より前なら、その Run の push はないので区切りの時刻
      await pushCommitAt(f.cloneA, "feat/t3", "2026-11-06T04:00:00Z");
      clock = new Date("2026-11-06T04:30:00Z");
      const fix4 = (await runCommand(ticketClaim, agent, { ticket: "t3", retry_reasons: ["E"] }))
        .data.run!;
      clock = new Date("2026-11-06T04:40:00Z");
      const review3 = await openWithoutClosing("t3", "review");
      restore();
      restore = await fakeGh(f.root, {
        "feat/t1|41":
          '{"number":41,"state":"MERGED","isDraft":false,"mergedAt":"2026-11-06T04:00:00Z","createdAt":"2026-11-06T00:20:00Z"}',
        "feat/t4|44":
          '{"number":44,"state":"OPEN","isDraft":false,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
      });
      // 区切り 3：終わったチケット。t2 は PR 番号だけあり、手直しの Run を開いた後に人が done にした（branch があるので move は閉じない）
      const fix3 = (await runCommand(ticketClaim, agent, { ticket: "t2", retry_reasons: ["C"] }))
        .data.run!;
      await human.store.rescan();
      await runCommand(ticketMove, human, { ticket: "t2", status: "done" });
      await agent.store.rescan();
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id).sort()).toEqual(
        expect.arrayContaining([fix2, fix3]),
      );
      clock = new Date("2026-11-06T05:00:00Z");
      const merged = await runCommand(sync, agent, {});
      expect(merged.data.reconciled).toEqual([
        { id: "t1", from: "review", to: "done", when: ["pr_merged"] },
        { id: "t4", from: "in_progress", to: "review", when: ["pr_open", "!pr_draft"] },
      ]);
      expect(merged.data.runs_closed).toEqual([
        { id: "t1", run: fix2, opener: "reclaim", result: "success" },
        { id: "t3", run: fix4, opener: "reclaim", result: "success" },
        { id: "t4", run: fix5, opener: "reclaim", result: "success" },
        // t2 は PR の番号だけあり PR を gh で引けない done なので、実装の Run は今の時刻で success（PR のある done）
        { id: "t2", run: claimT2, opener: "claim", result: "success" },
        { id: "t2", run: fix3, opener: "reclaim", result: "success" },
      ]);
      expect(merged.warnings).toContainEqual(
        "t1: done への前進を区切りとして閉じた（最後の push の時刻）",
      );
      expect(merged.warnings).toContainEqual(
        "t4: review への前進を区切りとして閉じた（最後の push の時刻）",
      );
      expect(merged.warnings).toContainEqual(
        `t3: 次の Run ${review3} の開始を区切りとして閉じた（区切りまでの push がないので区切りの時刻）`,
      );
      expect(agent.store.runs.get(fix4)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T04:40:00Z",
        retry_reasons: ["E"],
      });
      await runCommand(runFinish, agent, { run: review3, result: "success" });
      expect(agent.store.runs.get(fix5)!.data).toMatchObject({
        result: "success",
        finished_at: "2026-11-06T03:40:00Z",
        retry_reasons: ["D"],
      });
      expect(merged.warnings).toContainEqual(
        "t2: チケットの終了（done）を区切りとして閉じた（push がないので今の時刻）",
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
      const fix6 = (await runCommand(ticketClaim, agent, { ticket: "t3" })).data.run!;
      const unclaimed = await runCommand(ticketUnclaim, agent, { ticket: "t3" });
      expect(unclaimed.warnings.filter((w) => /を failure で閉じた/.test(w))).toEqual([
        expect.stringMatching(/^t3 の実装の Run r\S+ を failure で閉じた/),
        `t3 の手直しの Run ${fix6} を failure で閉じた（finished_at 2026-11-06T05:00:00Z）`,
      ]);
      expect(agent.store.runs.get(fix6)!.data).toMatchObject({
        step: "fix",
        result: "failure",
        error: "ticket unclaim で todo に戻した",
      });
      expect(await peekRunningRuns(agent.repo)).toEqual([]);
    } finally {
      restore();
    }
  });

  it("照合は、別のマシンで終わったチケットの開いたままの実装の Run を ticket move と同じ結果で閉じ、戻った・別の主体の claim になったチケットの実装の Run を failure で閉じる。自分の claim は閉じない（RN-6）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(f.cloneA, { now: () => clock });
    for (const title of [
      "Abandoned elsewhere",
      "Done elsewhere",
      "Unclaimed",
      "Taken",
      "Mine",
      "Done with PR elsewhere",
    ])
      await runCommand(ticketCreate, human, { title });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    for (const t of ["t1", "t2", "t3", "t4", "t5", "t6"])
      await runCommand(ticketClaim, agent, { ticket: t });
    const opened = new Map(
      (await peekRunningRuns(agent.repo)).map((r) => [r.ticket, r.id] as const),
    );
    await runCommand(sync, agent, {});
    // 別のマシン（cloneB）の人が操作してリモートに送る。cloneA の実装の Run は開いたまま残る
    const other = await initialized(f.cloneB, { now: () => clock });
    await runCommand(sync, other, {});
    clock = new Date("2026-11-06T01:00:00Z");
    await runCommand(ticketMove, other, { ticket: "t1", status: "abandoned" });
    await runCommand(ticketMove, other, { ticket: "t2", status: "done" });
    await runCommand(ticketUnclaim, other, { ticket: "t3" });
    await runCommand(ticketUnclaim, other, { ticket: "t4" });
    // PR のある done：別のマシンが PR を記録して done にした。実装の Run は PR の作成時刻で success になる
    await runCommand(ticketUpdate, other, { ticket: "t6", pr: 46 });
    await runCommand(ticketMove, other, { ticket: "t6", status: "done" });
    const hanako = await openContext({
      cwd: f.cloneB,
      actor: { kind: "human", user: "hanako" },
      now: () => clock,
    });
    await runCommand(ticketClaim, hanako, { ticket: "t4" });
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
    expect(synced.data.runs_closed).toHaveLength(5);
    expect(synced.data.runs_closed).toEqual(
      expect.arrayContaining([
        { id: "t1", run: opened.get("t1"), opener: "claim", result: "failure" },
        { id: "t2", run: opened.get("t2"), opener: "claim", result: "success" },
        { id: "t3", run: opened.get("t3"), opener: "claim", result: "failure" },
        { id: "t4", run: opened.get("t4"), opener: "claim", result: "failure" },
        { id: "t6", run: opened.get("t6"), opener: "claim", result: "success" },
      ]),
    );
    expect(synced.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^t1 の実装の Run r\S+ を failure で閉じた/),
        expect.stringMatching(/^t2 の実装の Run r\S+ を success で閉じた/),
        expect.stringMatching(/^t3 の実装の Run r\S+ を failure で閉じた/),
        expect.stringMatching(/^t4 の実装の Run r\S+ を failure で閉じた/),
        expect.stringMatching(/^t6 の実装の Run r\S+ を success で閉じた/),
      ]),
    );
    expect(agent.store.runs.get(opened.get("t6")!)!.data).toMatchObject({
      result: "success",
      finished_at: "2026-11-06T00:45:00Z",
    });
    expect(agent.store.runs.get(opened.get("t3")!)!.data).toMatchObject({
      result: "failure",
      error: "照合で todo に戻っていた",
    });
    expect(agent.store.runs.get(opened.get("t4")!)!.data).toMatchObject({
      result: "failure",
      error: "照合で別の主体の claim になっていた",
    });
    expect((await git(agent.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim()).toContain(
      `t1 ${opened.get("t1")} failure`,
    );
    // 自分の claim（in_progress）の実装の Run は開いたまま
    expect((await peekRunningRuns(agent.repo)).map((r) => r.ticket)).toEqual(["t5"]);
    expect(agent.store.tickets.get("t5")!.data.status).toBe("in_progress");
  });

  it("run start は、同じチケットの開いたままの手直しの Run を、手直しと同じ秒の開始も区切りとして閉じてから始める。手直しでない step では別のセッションの手直しも success。照合も同じ秒の次の Run を区切りに数える（RN-6・ADR-025）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    await runCommand(ticketCreate, human, { title: "Run start closes fix" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    await runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/t1", no_run: true });
    await git(f.cloneA, ["branch", "feat/t1"]);
    const restore = await fakeGh(f.root, {
      "feat/t1|41":
        '{"number":41,"state":"OPEN","isDraft":true,"mergedAt":null,"createdAt":"2026-11-06T00:20:00Z"}',
    });
    const start = (step: string, session: string) =>
      runCommand(runStart, agent, { ticket: "t1", step, agent: "claude-code", session });
    try {
      clock = new Date("2026-11-06T00:30:00Z");
      await runCommand(ticketUpdate, agent, { ticket: "t1", pr: 41 });
      // 別のセッションで開いた手直しの Run も、見直しの run start は success で閉じる。開始が手直しと同じ秒でも区切り
      clock = new Date("2026-11-06T01:00:00Z");
      const fix1 = (await start("fix", "s-old")).data.id;
      const review1 = await start("review", "s-new");
      expect(review1.warnings).toContainEqual(
        `t1: 前の手直しの Run ${fix1} を、次の review の Run の開始を区切りとして、push がないので開始の時刻で閉じる`,
      );
      expect(agent.store.runs.get(fix1)!.data).toMatchObject({
        result: "success",
        error: null,
        finished_at: "2026-11-06T01:00:00Z",
      });
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toEqual([review1.data.id]);
      await runCommand(runFinish, agent, { run: review1.data.id, result: "success" });
      // 同じセッションの手直しも、見直しの run start は success で閉じる
      clock = new Date("2026-11-06T01:30:00Z");
      const fixSame = (await start("fix", "s-new")).data.id;
      clock = new Date("2026-11-06T01:40:00Z");
      const reviewSame = (await start("review", "s-new")).data.id;
      expect(agent.store.runs.get(fixSame)!.data).toMatchObject({
        result: "success",
        error: null,
        finished_at: "2026-11-06T01:40:00Z",
      });
      await runCommand(runFinish, agent, { run: reviewSame, result: "success" });

      // 照合も、手直しと同じ秒に始まった次の Run を区切りに数える（閉じずに開いた形（別のマシン・前の版の dg）を startRun で作る）
      clock = new Date("2026-11-06T02:00:00Z");
      const fix2 = (await start("fix", "s-new")).data.id;
      const review2 = (
        await startRun(agent.repo, {
          ticket: "t1",
          step: "review",
          agent: "claude-code",
          now: clock,
        })
      ).id;
      clock = new Date("2026-11-06T02:10:00Z");
      const synced = await runCommand(sync, agent, {});
      expect(synced.data.runs_closed).toEqual([
        { id: "t1", run: fix2, opener: "reclaim", result: "success" },
      ]);
      expect(synced.warnings).toContainEqual(
        `t1: 次の Run ${review2} の開始を区切りとして閉じた（区切りまでの push がないので区切りの時刻）`,
      );
      expect(agent.store.runs.get(fix2)!.data.finished_at).toBe("2026-11-06T02:00:00Z");

      // 手直しの step の run start を重ねると、前の手直しを閉じずに拒む（二重起動の拒否。SY-5）
      clock = new Date("2026-11-06T03:00:00Z");
      const fix3 = (await start("fix", "s-new")).data.id;
      clock = new Date("2026-11-06T03:10:00Z");
      await expect(start("fix", "s-new")).rejects.toThrow(`Run ${fix3} が実行中`);
      expect((await peekRunningRuns(agent.repo)).map((r) => r.id)).toContain(fix3);
    } finally {
      restore();
    }
  });

  it("見直しの修正ループの手直しは、draft の PR を記録した in_progress のチケットのもう一度の claim（--retry-reason）が fix の Run を開き、次の見直しの run start と照合の PR の ready が区切りとして push の時刻で閉じる（RN-5・RN-6・ADR-025）", async () => {
    const f = await fixture();
    let clock = new Date("2026-11-06T00:00:00Z");
    const human = await initialized(
      f.cloneA,
      { now: () => clock },
      { template: "software-development" },
    );
    await runCommand(ticketCreate, human, { title: "Review loop" });
    const agent = await agentWithRuns(f.cloneA, () => clock);
    const implement = (await runCommand(ticketClaim, agent, { ticket: "t1", branch: "feat/t1" }))
      .data.run!;
    await git(f.cloneA, ["branch", "feat/t1"]);
    let restore = await fakeGh(f.root, {
      "feat/t1|41":
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
      await pushCommitAt(f.cloneA, "feat/t1", "2026-11-06T01:20:00Z");
      // 区切り（次の見直し・ready）がなければ閉じない
      clock = new Date("2026-11-06T01:25:00Z");
      expect((await runCommand(sync, agent, {})).data.runs_closed).toEqual([]);

      // 見直し直しの review の Run の開始が区切り。run start がその場で閉じ、finished_at は手直しの最後の push の時刻（ADR-025）
      clock = new Date("2026-11-06T01:30:00Z");
      const started = await runCommand(runStart, agent, {
        ticket: "t1",
        step: "review",
        agent: "claude-code",
      });
      const review2 = started.data.id;
      expect(started.warnings).toContainEqual(
        `t1: 前の手直しの Run ${fix1} を、次の review の Run の開始を区切りとして最後の push の時刻で閉じる`,
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
        await runCommand(ticketClaim, agent, { ticket: "t1", retry_reasons: ["指摘 B"] })
      ).data.run!;
      await pushCommitAt(f.cloneA, "feat/t1", "2026-11-06T02:20:00Z");
      restore();
      restore = await fakeGh(f.root, {
        "feat/t1|41":
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
        "t1: review への前進を区切りとして閉じた（最後の push の時刻）",
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
