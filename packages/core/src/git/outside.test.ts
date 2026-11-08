import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git } from "../../test/helpers/git-fixture.js";
import { openContext } from "../commands/context.js";
import { runCommand, type CommandContext } from "../commands/define.js";
import { hook, type HookView } from "../commands/hook.js";
import { adopt, commit, init, sync } from "../commands/setup.js";
import { ticketCreate, ticketList, ticketShow, ticketUpdate } from "../commands/ticket.js";
import { checkOutside, DG_COMMIT_TRAILER } from "./outside.js";
import { withWriteLock } from "./write.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const actor = { kind: "agent" as const, user: "eiki" };

/** init して t1 を起票した文脈（commit.mode は既定の batch） */
async function prepared(cwd?: string) {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {});
  const ctx = await openContext({ cwd: cwd ?? f.cloneA, actor });
  await runCommand(ticketCreate, ctx, { title: "A" });
  return { f, ctx };
}

const ticketFile = (ctx: CommandContext, id = "t1") =>
  path.join(ctx.repo.dataDir, "tickets", `${id}.md`);

/** dg の外でチケットのファイルを書き換える（エージェントがエディタや python で書いた形） */
async function editOutside(ctx: CommandContext, id = "t1") {
  const text = await readFile(ticketFile(ctx, id), "utf8");
  await writeFile(ticketFile(ctx, id), text.replace("title: A", "title: 書き換えた"));
}

describe("dg の外の変更（t546・ADR-021）", () => {
  it("dg が書いたコミットは印を持ち、まとめ待ちの dg の変更も dg の外の変更とみなさない", async () => {
    const { ctx } = await prepared();
    // batch：t1 の更新は作業ツリーに残る
    await runCommand(ticketUpdate, ctx, { ticket: "t1", priority: "high" });
    expect((await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout).not.toBe("");
    expect(await checkOutside(ctx.repo)).toEqual({ kind: "clean", initial: false });
    await runCommand(commit, ctx, {});
    const body = (await git(ctx.repo.dataDir, ["log", "-1", "--format=%B"])).stdout;
    expect(body.trim().split("\n").at(-1)).toBe(DG_COMMIT_TRAILER);
    expect((await runCommand(ticketList, ctx, {})).warnings).toEqual([]);
  });

  it("未コミットの dg の外の変更は、読むコマンドは警告し、書くコマンドは OUTSIDE_CHANGES でファイルを示して止める", async () => {
    const { ctx } = await prepared();
    await editOutside(ctx);
    const shown = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(shown.warnings).toEqual([
      expect.stringContaining("dg の外の変更がある（未コミットの変更: tickets/t1.md）"),
    ]);
    expect(shown.warnings[0]).toContain("dg adopt");
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t1", priority: "high" }),
    ).rejects.toMatchObject({
      code: "OUTSIDE_CHANGES",
      detail: "未コミットの変更: tickets/t1.md",
    });
    // dg のまとめ待ちの変更を外で戻したときも見つける
    await runCommand(adopt, ctx, {});
    await runCommand(ticketUpdate, ctx, { ticket: "t1", priority: "high" });
    await git(ctx.repo.dataDir, ["checkout", "--", "."]);
    const reverted = await checkOutside(ctx.repo);
    expect(reverted.kind === "found" && reverted.changes.files).toContainEqual({
      path: "tickets/t1.md",
      change: "reverted",
    });
  });

  it("印のないコミットを、短い SHA・件名・ファイルで示して書き込みを止める。リモートから取り込んだ dg のコミットは見つけない", async () => {
    const { f, ctx } = await prepared();
    await runCommand(sync, ctx, {});
    // 別の clone の dg が書いて push したものは、取り込んでも dg の外の変更ではない
    await runCommand(init, await openContext({ cwd: f.cloneB, initialize: {}, actor }), {});
    const other = await openContext({ cwd: f.cloneB, actor });
    await runCommand(ticketCreate, other, { title: "B" });
    await runCommand(sync, other, {});
    await runCommand(sync, ctx, {});
    expect(await checkOutside(ctx.repo)).toEqual({ kind: "clean", initial: false });

    await editOutside(ctx);
    await git(ctx.repo.dataDir, ["commit", "-qam", "外で直した"]);
    const sha = (await git(ctx.repo.dataDir, ["rev-parse", "--short=7", "HEAD"])).stdout.trim();
    await expect(runCommand(sync, ctx, {})).rejects.toMatchObject({
      code: "OUTSIDE_CHANGES",
      detail: `コミット ${sha}「外で直した」: tickets/t1.md`,
    });
  });

  it("dg adopt は検査を通してから今の状態を基準にし、エラーがあれば VALIDATION_FAILED で取り込まない", async () => {
    const { ctx } = await prepared();
    await writeFile(ticketFile(ctx), "---\n: [壊れた\n");
    await expect(runCommand(adopt, ctx, {})).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect((await checkOutside(ctx.repo)).kind).toBe("found");

    await git(ctx.repo.dataDir, ["checkout", "--", "tickets/t1.md"]);
    await editOutside(ctx);
    const adopted = await runCommand(adopt, ctx, {});
    expect(adopted.data).toMatchObject({
      adopted: true,
      files: [{ path: "tickets/t1.md", change: "changed" }],
    });
    // 取り込んだ後は書ける。取り込んだ変更はまとめ待ちの変更として dg のコミットに入る
    await runCommand(ticketUpdate, ctx, { ticket: "t1", priority: "high" });
    await runCommand(commit, ctx, {});
    expect((await runCommand(ticketShow, ctx, { ticket: "t1" })).data.title).toBe("書き換えた");
    expect((await runCommand(adopt, ctx, {})).data).toMatchObject({ adopted: false });
  });

  it("初めて確かめるとき（基準がない）は今の状態を基準にし、それより前の印のないコミットを見つけない", async () => {
    const { ctx } = await prepared();
    await editOutside(ctx);
    await git(ctx.repo.dataDir, ["commit", "-qam", "古い版の dg のコミット"]);
    await rm(path.join(ctx.repo.localDir, "outside-baseline.json"));
    expect(await checkOutside(ctx.repo)).toEqual({ kind: "clean", initial: true });
    expect((await runCommand(ticketList, ctx, {})).warnings).toEqual([]);
    await runCommand(ticketUpdate, ctx, { ticket: "t1", priority: "high" });
  });

  it("同じマシンで並べて動く dg の書きかけを、dg の外の変更と取り違えない", async () => {
    const { f, ctx } = await prepared();
    await runCommand(ticketCreate, ctx, { title: "B" });
    const other = await openContext({ cwd: f.cloneA, actor });
    const reader = await openContext({ cwd: f.cloneA, actor });
    const priorities = ["high", "low", "medium"] as const;
    const writes = (c: CommandContext, ticket: string) =>
      (async () => {
        for (let i = 0; i < 15; i++)
          await runCommand(ticketUpdate, c, { ticket, priority: priorities[i % 3]! });
      })();
    const warnings: string[] = [];
    const reads = (async () => {
      for (let i = 0; i < 15; i++)
        warnings.push(...(await runCommand(ticketList, reader, {})).warnings);
    })();
    await Promise.all([writes(ctx, "t1"), writes(other, "t2"), reads]);
    expect(warnings.filter((w) => w.includes("dg の外"))).toEqual([]);
    expect(await checkOutside(ctx.repo)).toEqual({ kind: "clean", initial: false });
  });

  it("落ちた dg が残した古いロックがあっても、作業ツリーの dg の外の変更を見つける", async () => {
    const { ctx } = await prepared();
    await editOutside(ctx);
    // 持ち主の pid がいないロック（落ちた dg の残り）
    await writeFile(path.join(ctx.repo.localDir, "locks", "write"), `999999999 ${os.hostname()}`);
    const found = await checkOutside(ctx.repo);
    expect(found.kind === "found" && found.changes.files).toEqual([
      { path: "tickets/t1.md", change: "changed" },
    ]);
  });

  it("書き込みのロックの中で外の変更を見つけたら書かず、外の変更を dg のコミットに入れない（検査を自分で扱う hook の書き込みも）", async () => {
    const { ctx } = await prepared();
    await editOutside(ctx);
    const head = (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout;
    let ran = false;
    await expect(
      withWriteLock(ctx.repo, async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: "OUTSIDE_CHANGES", detail: "未コミットの変更: tickets/t1.md" });
    expect(ran).toBe(false);
    expect((await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect((await checkOutside(ctx.repo)).kind).toBe("found");
  });

  it("dg のコミットを dg の外で捨てた・書き換えたら、基準のコミットが HEAD の祖先でないことを示す", async () => {
    const { ctx } = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t1", priority: "high" });
    await runCommand(commit, ctx, {});
    await git(ctx.repo.dataDir, ["reset", "-q", "--hard", "HEAD~1"]);
    const found = await checkOutside(ctx.repo);
    expect(found.kind === "found" && found.changes.rewritten).toBe(true);
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t1", priority: "low" }),
    ).rejects.toMatchObject({
      code: "OUTSIDE_CHANGES",
      detail: expect.stringContaining("今の HEAD の祖先でない"),
    });
  });

  it("Stop のフックは dg の外の変更を、止まらずに続けさせる形でエージェントに返し、続けさせた後の Stop では返さない", async () => {
    const { ctx } = await prepared();
    const stop = async (active: boolean) =>
      (
        await runCommand(hook, ctx, {
          event: "Stop",
          payload: { session_id: "s", stop_hook_active: active },
        })
      ).data as HookView;
    expect((await stop(false)).output).toBeUndefined();
    await editOutside(ctx);
    const out = JSON.parse((await stop(false)).output!) as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("tickets/t1.md");
    expect(out.reason).toContain("dg adopt");
    expect((await stop(true)).output).toBeUndefined();
    // ほかのイベントのフックは、dg の外の変更があっても止まらない
    const started = await runCommand(hook, ctx, {
      event: "SessionStart",
      payload: { session_id: "s" },
    });
    expect(started.warnings.filter((w) => w.includes("dg の外"))).toEqual([]);
  });
});
