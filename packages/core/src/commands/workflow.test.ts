import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git, type Fixture } from "../../test/helpers/git-fixture.js";
import { recordBaseline } from "../git/outside.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { commit, configSet, init } from "./setup.js";
import { ticketClaim, ticketCreate, ticketMove, ticketShow } from "./ticket.js";
import { workflowSet, workflowShow } from "./workflow.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

/** init まで済ませ、書き込みのたびにコミットする（commit.mode: each）文脈を開く */
async function initialized(cwd: string): Promise<CommandContext> {
  const first = await openContext({ cwd, initialize: {}, actor: { kind: "human", user: "eiki" } });
  await runCommand(init, first, { template: "general" });
  await runCommand(configSet, first, { key: "commit.mode", value: "each" });
  await runCommand(commit, first, {});
  return openContext({ cwd, actor: { kind: "agent", user: "eiki" } });
}

async function gitOut(ctx: CommandContext, args: string[]): Promise<string> {
  return (await git(ctx.repo.dataDir, args)).stdout.trim();
}

async function commitCount(ctx: CommandContext): Promise<number> {
  return Number(await gitOut(ctx, ["rev-list", "--count", "HEAD"]));
}

async function workflowText(ctx: CommandContext, id: string): Promise<string> {
  return readFile(path.join(ctx.repo.dataDir, `workflows/${id}.yaml`), "utf8");
}

const strict = {
  id: "general",
  name: "Strict General",
  transitions: [{ from: "todo", to: "done", by: [] }],
  reconcile: [{ when: ["branch_merged"], status: "done" }],
  steps: [{ id: "implement" }, { id: "review" }],
};

describe("workflow set", () => {
  it("検証を通った定義で置き換え、1 コミットで push し、前と後と変わった項目を返す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const commits = await commitCount(ctx);
    const r = await runCommand(workflowSet, ctx, { workflow: "general", definition: strict });
    expect(r.data).toMatchObject({
      workflow: "general",
      path: "workflows/general.yaml",
      created: false,
      before: { name: "General" },
      after: { name: "Strict General" },
    });
    expect(r.data.changed).toEqual(["name", "transitions", "reconcile", "steps"]);
    expect(r.write).toMatchObject({ committed: true, pushed: true });
    expect(await commitCount(ctx)).toBe(commits + 1);
    expect(await gitOut(ctx, ["log", "-1", "--format=%s"])).toBe("Replace Workflow general");
    expect(await workflowText(ctx, "general")).toContain("name: Strict General");

    // 別の clone でも読める
    const b = await openContext({ cwd: f.cloneB, initialize: {} });
    const shown = await runCommand(workflowShow, b, { workflow: "general" });
    expect(shown.data.definition.name).toBe("Strict General");
  });

  it("なければ作る", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const r = await runCommand(workflowSet, ctx, {
      workflow: "research",
      definition: { id: "research", name: "Research" },
    });
    expect(r.data).toMatchObject({ created: true, before: null, after: { id: "research" } });
    expect(ctx.store.workflows.has("research")).toBe(true);
  });

  it("WF-3 の誤り・形の誤り・id の食い違いは何も書かずに拒否し、指摘を detail に返す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const before = await workflowText(ctx, "general");
    const commits = await commitCount(ctx);
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { id: "general", name: "G", transitions: [{ from: "todo", to: "done", requires: ["x"] }] },
        "transitions[0]: unknown condition x",
      ],
      [
        { id: "general", name: "G", reconcile: [{ when: ["nope"], status: "done" }] },
        "reconcile[0]: unknown condition nope",
      ],
      [
        { id: "general", name: "G", reconcile: [{ when: ["pr_merged"], status: "abandoned" }] },
        "reconcile cannot set abandoned",
      ],
      [{ id: "general", name: "G", steps: [{ id: "a" }, { id: "a" }] }, "a is duplicated"],
      [
        { id: "general", transitions: [{ from: "todo", to: "nowhere" }] },
        "The Workflow definition has the wrong shape",
      ],
      [{ ...strict, id: "other" }, "The id in the definition (other) differs from general"],
    ];
    for (const [definition, message] of cases) {
      const error = await runCommand(workflowSet, ctx, { workflow: "general", definition }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: "VALIDATION_FAILED" });
      const { message: m, detail } = error as { message: string; detail?: string };
      expect(`${m}\n${detail ?? ""}`).toContain(message);
    }
    expect(await workflowText(ctx, "general")).toBe(before);
    expect(await commitCount(ctx)).toBe(commits);
    expect(await gitOut(ctx, ["status", "--porcelain"])).toBe("");
    expect(ctx.store.workflows.get("general")?.definition.name).toBe("General");
  });

  it("定義とテンプレートは どちらか一方だけ受ける", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await expect(runCommand(workflowSet, ctx, { workflow: "general" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      runCommand(workflowSet, ctx, {
        workflow: "general",
        definition: strict,
        template: "general",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("--template で同梱のテンプレートに戻し、id は引数に置き換えて別の Workflow も作れる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(workflowSet, ctx, { workflow: "general", definition: strict });
    const back = await runCommand(workflowSet, ctx, { workflow: "general", template: "general" });
    expect(back.data.before?.name).toBe("Strict General");
    expect(back.data.after.name).toBe("General");
    expect(back.data.after.steps?.map((s) => s.id)).toEqual([
      "investigate",
      "implement",
      "review",
      "fix",
    ]);
    const text = await workflowText(ctx, "general");
    expect(text.startsWith("# General のワークフロー。dg workflow set が同梱のテンプレート")).toBe(
      true,
    );
    expect(await gitOut(ctx, ["log", "-1", "--format=%s"])).toBe(
      "Replace Workflow general (template general)",
    );

    const copy = await runCommand(workflowSet, ctx, {
      workflow: "my-dev",
      template: "software-development",
    });
    expect(copy.data).toMatchObject({ created: true, after: { id: "my-dev" } });
    expect(ctx.store.workflows.get("my-dev")?.resolved.reconcile.length).toBeGreaterThan(0);
  });

  it("使っている Project の Workflow を置き換えても既存のチケットが読め、新しい制約で遷移する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const a = await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: a.data.id, branch: "feat/a" });
    const b = await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(workflowSet, ctx, { workflow: "general", definition: strict });

    // 開き直しても読め、どちらのチケットも新しい定義の Workflow を使う
    const again = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    expect(again.store.issues).toEqual([]);
    const shown = await runCommand(ticketShow, again, { ticket: a.data.id });
    expect(shown.data.status).toBe("in_progress");
    expect(again.store.workflowFor(shown.data)?.definition.name).toBe("Strict General");
    await expect(
      runCommand(ticketMove, again, { ticket: b.data.id, status: "done" }),
    ).rejects.toMatchObject({ code: "TRANSITION_REJECTED" });
  });

  it("init は誤りがあって索引から外れた Workflow も書き換えず、workflow set で直せる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const broken = "id: general\nname: G\nreconcile:\n  - { when: [nope], status: done }\n";
    await writeFile(path.join(ctx.repo.dataDir, "workflows/general.yaml"), broken);
    // 古い版の dg のときに壊れた Workflow を模すので、検査の基準をここに置く（SY-8）
    await recordBaseline(ctx.repo);
    await ctx.store.rescan();
    expect(ctx.store.workflows.has("general")).toBe(false);
    const again = await openContext({ cwd: f.cloneA, initialize: {} });
    const r = await runCommand(init, again, {});
    expect(r.data.created).toEqual([]);
    expect(await workflowText(ctx, "general")).toBe(broken);

    const fixed = await runCommand(workflowSet, again, {
      workflow: "general",
      template: "general",
    });
    expect(fixed.data).toMatchObject({ created: false, before: null, after: { name: "General" } });
    expect(again.store.issues.filter((i) => i.path === "workflows/general.yaml")).toEqual([]);
  });

  it("未知の Action は警告にとどめて書く", async () => {
    const f = await fixture();
    const first = await initialized(f.cloneA);
    const ctx = await openContext({
      cwd: first.repo.topLevel,
      actor: { kind: "agent", user: "eiki" },
      actions: ["create_branch"],
    });
    const r = await runCommand(workflowSet, ctx, {
      workflow: "general",
      definition: { id: "general", name: "G", steps: [{ id: "x", actions: ["nope"] }] },
    });
    expect(r.write).toMatchObject({ committed: true });
    expect(r.warnings.some((w) => w.includes("unknown Action nope"))).toBe(true);
  });
});
