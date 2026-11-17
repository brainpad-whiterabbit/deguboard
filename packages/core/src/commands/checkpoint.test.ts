// 流れの段階の関所（dg checkpoint）：段階の値での判定と、Iteration の checkpoints に足す記録（EX-8）。
// 記録を dg flow next がどう数えるかは flow.test.ts

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../test/helpers/git-fixture.js";
import {
  initializedFixture,
  reopenInitialized,
  runCleanups,
  writeWorkflowYaml,
} from "../../test/helpers/commands-context.js";
import { toIsoDateTime } from "../model/common.js";
import { checkpoint, type CheckpointResult } from "./checkpoint.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { iterationAdd, iterationCreate } from "./iteration.js";
import { ticketCreate, ticketMove } from "./ticket.js";

afterEach(runCleanups);

/** 関所を呼ぶ時刻（記録の at の期待値は、ここから求める） */
const NOW = new Date("2026-03-04T05:06:07Z");

/**
 * 人（eiki）と、別のユーザのエージェント（claude/agent）の文脈。索引は同じものを使い、時刻は NOW に固定する。
 * agent の --approved-by human は claude になる。Iteration s1 に t1（done）と t2（todo）があり、t3 は Iteration に入っていない todo
 */
async function humanAndAgent() {
  const f = await initializedFixture();
  const human: CommandContext = { ...(await reopenInitialized(f)), now: () => NOW };
  const opened = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
  const agent: CommandContext = { ...human, actor: opened.actor };
  await runCommand(iterationCreate, human, { name: "S1" });
  for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, human, { title });
  await runCommand(iterationAdd, human, { iteration: "s1", tickets: ["t1", "t2"] });
  await runCommand(ticketMove, human, { ticket: "t1", status: "done", override: "PR なし" });
  /** 書いた項目だけの workflow.yaml を置く */
  const workflow = (...lines: string[]) => writeWorkflowYaml(human, lines);
  const subject = async () =>
    (await git(human.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim();
  const records = () => human.store.require("iteration", "s1").data.checkpoints ?? [];
  const pass = async (ctx: CommandContext, stage: string, input: Record<string, unknown> = {}) =>
    (await runCommand(checkpoint, ctx, { stage, targets: ["s1"], ...input }))
      .data as CheckpointResult;
  return { human, agent, workflow, subject, records, pass };
}

const rejected = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code: string; message: string; detail?: string },
  );

const asks = (stage: string, value: string) => ({
  code: "TRANSITION_REJECTED",
  message: `The Workflow asks for a person's approval for passing the ${stage} checkpoint (${value})`,
});
const limits = (stage: string, value: string) => ({
  code: "TRANSITION_REJECTED",
  message: `The Workflow limits passing the ${stage} checkpoint to a person (${value})`,
});

describe("dg checkpoint は段階の値で判定し、通ったら Iteration の checkpoints に記録を足す", () => {
  it("既定の点検（ask_unless_auto）：エージェントは承認がなければ拒否されて何も記録されず、--approved-by で通ると名前・日時・主体・承認者・根拠が足される", async () => {
    const { agent, subject, records, pass } = await humanAndAgent();
    expect(await rejected(pass(agent, "check"))).toMatchObject(
      asks("check", "flow.check: ask_unless_auto"),
    );
    expect(records()).toEqual([]);

    const result = await pass(agent, "check", { approved_by: "human" });
    expect(result).toMatchObject({ stage: "check", iteration: "s1", local: false });
    expect(result.checkpoint).toEqual({
      name: "check",
      at: toIsoDateTime(NOW),
      by: "claude/agent",
      approved_by: "claude",
      basis: { facts: expect.stringMatching(/^[0-9a-f]{16}$/) },
    });
    expect(records()).toEqual([result.checkpoint]);
    // 共有する記録なので、その場でコミットされ、承認者がコミットの題に残る
    expect(await subject()).toBe("Checkpoint check of s1 (approved by claude)");
    // ファイルには、名前から始まる 1 つの項目として書かれる（経過は「- name:」の行で拾う）
    const yaml = await readFile(path.join(agent.repo.dataDir, "iterations", "s1.yaml"), "utf8");
    expect(yaml).toMatch(/^checkpoints:\n {2}- name: check\n {4}at: /m);
  });

  it("--auto は ask_unless_auto の段階だけを聞かずに通し、承認者に進めたエージェントを記録する。always_ask の見直しと振り返りは --auto でも承認が要る", async () => {
    const { agent, subject, records, pass } = await humanAndAgent();
    const check = await pass(agent, "check", { auto: true });
    expect(check.checkpoint).toMatchObject({ by: "claude/agent", approved_by: "claude/agent" });
    expect(await subject()).toBe("Checkpoint check of s1 (approved by claude/agent with --auto)");
    for (const stage of ["audit", "retro"] as const) {
      expect(await rejected(pass(agent, stage, { auto: true }))).toMatchObject({
        code: "TRANSITION_REJECTED",
        message: `--auto goes ahead without asking only where the value is ask_unless_auto, and passing the ${stage} checkpoint is not such a place (flow.${stage}: always_ask)`,
      });
      expect(await rejected(pass(agent, stage))).toMatchObject(
        asks(stage, `flow.${stage}: always_ask`),
      );
    }
    expect(records().map((c) => c.name)).toEqual(["check"]);
    // 承認があれば通る。見直しの根拠は、そのとき done だったチケット。振り返りは根拠を持たない
    const audit = await pass(agent, "audit", { approved_by: "human" });
    expect(audit.checkpoint).toEqual({
      name: "audit",
      at: toIsoDateTime(NOW),
      by: "claude/agent",
      approved_by: "claude",
      basis: { done: ["t1"] },
    });
    const retro = await pass(agent, "retro", { approved_by: "human" });
    expect(retro.checkpoint).toEqual({
      name: "retro",
      at: toIsoDateTime(NOW),
      by: "claude/agent",
      approved_by: "claude",
    });
  });

  it("既定のリリース（human_only）：エージェントは承認者を渡しても拒否され、人が通すと承認者なしで記録される", async () => {
    const { human, agent, subject, records, pass } = await humanAndAgent();
    for (const input of [{}, { approved_by: "human" }])
      expect(await rejected(pass(agent, "release", input))).toMatchObject(
        limits("release", "flow.release: human_only"),
      );
    expect(records()).toEqual([]);
    const release = await pass(human, "release");
    expect(release.checkpoint).toEqual({ name: "release", at: toIsoDateTime(NOW), by: "eiki" });
    expect(await subject()).toBe("Checkpoint release of s1");
  });

  it("workflow.yaml の値を替えると判定が変わる：anyone は聞かずに通り、human_only は人だけ、always_ask は --auto でも承認が要る", async () => {
    const { agent, workflow, records, pass } = await humanAndAgent();
    await workflow("flow: { check: anyone, audit: human_only, assign: always_ask }");
    const check = await pass(agent, "check");
    expect(check.checkpoint).not.toHaveProperty("approved_by");
    expect(await rejected(pass(agent, "audit", { approved_by: "human" }))).toMatchObject(
      limits("audit", "flow.audit: human_only"),
    );
    expect(await rejected(pass(agent, "assign", { auto: true }))).toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    // 割り当ての根拠は、そのときの候補（チケットの指定の、Iteration に入っていない対象）。記録は対象の Iteration s1 に足す
    const assign = await pass(agent, "assign", { approved_by: "human", targets: ["t2", "t3"] });
    expect(assign.checkpoint.basis).toEqual({ candidates: ["t3"] });
    expect(records().map((c) => c.name)).toEqual(["check", "assign"]);
  });

  it("記録は消さずに足す：同じ段階をもう一度通っても、前の記録はそのまま残り、後ろに足される", async () => {
    const { human, records, pass } = await humanAndAgent();
    const first = await pass(human, "check");
    const audit = await pass(human, "audit");
    const second = await pass(human, "check");
    expect(records()).toEqual([first.checkpoint, audit.checkpoint, second.checkpoint]);
    // ほかのプロセスが読んでも同じ並び（ファイルに書かれている）
    const reread = await openContext({ cwd: human.repo.topLevel, actor: { kind: "human" } });
    expect(reread.store.require("iteration", "s1").data.checkpoints).toEqual(records());
  });

  it("計画の段階は関所を持たない（Plan の承認の記録が受け持つ）。知らない段階も受けない", async () => {
    const { human, pass } = await humanAndAgent();
    for (const stage of ["plan", "work", "deploy"])
      expect(await rejected(pass(human, stage))).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("独自の段階の関所は、workflow.yaml のその段階の decide で判定し、根拠のない記録を足す。定義にない名前は受けない", async () => {
    const { human, agent, workflow, subject, records, pass } = await humanAndAgent();
    await workflow(
      "flow:",
      "  deploy-staging: { decide: always_ask, after: audit, guide: docs/deploy.md }",
      "  notify: { decide: human_only, after: release, guide: docs/notify.md }",
    );
    // always_ask：--auto でも承認が要る
    for (const input of [{}, { auto: true }])
      expect(await rejected(pass(agent, "deploy-staging", input))).toMatchObject({
        code: "TRANSITION_REJECTED",
      });
    expect(await rejected(pass(agent, "deploy-staging"))).toMatchObject(
      asks("deploy-staging", "flow.deploy-staging.decide: always_ask"),
    );
    expect(await rejected(pass(agent, "notify", { approved_by: "human" }))).toMatchObject(
      limits("notify", "flow.notify.decide: human_only"),
    );
    expect(records()).toEqual([]);
    const deploy = await pass(agent, "deploy-staging", { approved_by: "human" });
    expect(deploy).toMatchObject({ stage: "deploy-staging", iteration: "s1", local: false });
    expect(deploy.checkpoint).toEqual({
      name: "deploy-staging",
      at: toIsoDateTime(NOW),
      by: "claude/agent",
      approved_by: "claude",
    });
    expect(await subject()).toBe("Checkpoint deploy-staging of s1 (approved by claude)");
    const notify = await pass(human, "notify");
    expect(records()).toEqual([deploy.checkpoint, notify.checkpoint]);
    // 定義にない名前は、使える名前を添えて断る
    expect(await rejected(pass(human, "deploy"))).toMatchObject({
      code: "INVALID_INPUT",
      message:
        "No stage deploy has a checkpoint. Use one of: assign / check / audit / release / retro / deploy-staging / notify",
    });
  });
});
