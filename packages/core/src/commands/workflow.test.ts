import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git, type Fixture } from "../../test/helpers/git-fixture.js";
import { recordBaseline } from "../git/outside.js";
import { pathExists } from "../storage/exists.js";
import { DEFAULT_WORKFLOW, defaultWorkflowFile, writtenForm } from "../workflow/resolve.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { commands } from "./registry.js";
import { commit, configSet, init } from "./setup.js";
import { ticketClaim, ticketCreate, ticketMove, ticketShow } from "./ticket.js";
import { workflowSet, workflowShow, workflowValidate } from "./workflow.js";

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
  await runCommand(init, first, {});
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

const workflowFile = (ctx: CommandContext) => path.join(ctx.repo.dataDir, "workflow.yaml");

async function workflowText(ctx: CommandContext): Promise<string> {
  return readFile(workflowFile(ctx), "utf8");
}

/** workflow.yaml を直に書き換え、利用者が直した状態にして索引を作り直す（dg の外の変更の検査の基準。SY-8） */
async function writeWorkflowFile(ctx: CommandContext, text: string): Promise<void> {
  await writeFile(workflowFile(ctx), text);
  await recordBaseline(ctx.repo);
  await ctx.store.rescan();
}

const strict = {
  states: { review: { label: "Client Review" } },
  transitions: [{ from: "todo", to: "done", by: [] }],
  reconcile: [{ when: ["branch_merged"], status: "done" }],
};

describe("init", () => {
  it("既定の workflow.yaml を 1 つ置き、workflows/ は作らない。--template はない", async () => {
    const f = await fixture();
    const first = await openContext({
      cwd: f.cloneA,
      initialize: {},
      actor: { kind: "human", user: "eiki" },
    });
    const r = await runCommand(init, first, {});
    expect(r.data.created).toContain("workflow.yaml");
    expect(await pathExists(path.join(first.repo.dataDir, "workflows"))).toBe(false);
    expect((await readdir(first.repo.dataDir)).filter((name) => name.includes("workflow"))).toEqual(
      ["workflow.yaml"],
    );
    // dg がファイルに書くコメントも dg の出力なので英語（CL-8）
    const text = await workflowText(first);
    expect(text.startsWith("# The board's Workflow. Placed by dg init")).toBe(true);
    // 置いた既定は Core の既定と同じ Workflow で、指摘もない
    expect(first.store.workflow).toMatchObject({ exists: true, resolved: DEFAULT_WORKFLOW });
    expect(first.store.issues).toEqual([]);
    expect(Object.keys(init.input.shape)).not.toContain("template");
  });

  it("誤りがあって読めない workflow.yaml も書き換えず、workflow set で直せる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const broken = "reconcile:\n  - { when: [nope], status: done }\n";
    await writeWorkflowFile(ctx, broken);
    expect(ctx.store.workflow).toBeUndefined();
    const again = await openContext({ cwd: f.cloneA, initialize: {} });
    const r = await runCommand(init, again, {});
    expect(r.data.created).toEqual([]);
    expect(await workflowText(ctx)).toBe(broken);

    const fixed = await runCommand(workflowSet, again, { definition: {} });
    expect(fixed.data).toMatchObject({ created: false, after: writtenForm(DEFAULT_WORKFLOW) });
    expect(again.store.issues.filter((i) => i.path === "workflow.yaml")).toEqual([]);
  });
});

describe("workflow のコマンド", () => {
  it("show・validate・set だけがあり、list はない。どれも Workflow の ID を取らない", () => {
    const names = commands.filter((c) => c.group === "workflow").map((c) => c.name);
    expect(names.sort()).toEqual(["workflow.set", "workflow.show", "workflow.validate"]);
    expect(Object.keys(workflowShow.input.shape)).toEqual([]);
    expect(Object.keys(workflowValidate.input.shape)).toEqual([]);
    expect(Object.keys(workflowSet.input.shape)).toEqual(["definition"]);
  });
});

describe("workflow show", () => {
  it("workflow.yaml がなければ exists: false で、どの項目も Core の既定を返す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await git(ctx.repo.dataDir, ["rm", "--quiet", "workflow.yaml"]);
    await git(ctx.repo.dataDir, ["commit", "--quiet", "-m", "remove workflow.yaml"]);
    await recordBaseline(ctx.repo);
    await ctx.store.rescan();
    const shown = await runCommand(workflowShow, ctx, {});
    expect(shown.data).toMatchObject({
      path: "workflow.yaml",
      exists: false,
      definition: writtenForm(DEFAULT_WORKFLOW),
      labels: DEFAULT_WORKFLOW.labels,
      transitions: [],
    });
    // 6 つの項目は dg init が置く既定と同じ値
    expect(shown.data.definition).toMatchObject(defaultWorkflowFile());
    const validated = await runCommand(workflowValidate, ctx, {});
    expect(validated.data).toEqual({ ok: true, exists: false, issues: [] });
  });

  it("states の label で書き換えた表示名を labels に返し、default_labels は書き換える前の core の既定のまま（画面が同じ文の Status だけを訳す）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(workflowSet, ctx, { definition: strict });
    const shown = await runCommand(workflowShow, ctx, {});
    expect(shown.data.exists).toBe(true);
    expect(shown.data.labels).toMatchObject({ review: "Client Review", todo: "Todo" });
    expect(shown.data.definition.states).toMatchObject({ review: { label: "Client Review" } });
    expect(shown.data.default_labels).toEqual({
      todo: "Todo",
      in_progress: "In Progress",
      review: "Review",
      done: "Done",
      abandoned: "Abandoned",
    });
    expect(shown.data.transitions).toEqual([{ from: "todo", to: "done", by: [], requires: [] }]);
  });

  it("Run の step の語彙と表示名は Core の固定で、workflow.yaml に書いても変わらない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const r = await runCommand(workflowSet, ctx, {
      definition: { steps: [{ id: "deploy", label: "Deploy" }] },
    });
    expect(r.warnings.some((w) => w.includes("Unknown item steps"))).toBe(true);
    const shown = await runCommand(workflowShow, ctx, {});
    expect(shown.data.steps).toEqual([
      { id: "investigate", label: "Investigate" },
      { id: "implement", label: "Implement" },
      { id: "review", label: "Review" },
      { id: "fix", label: "Fix" },
      { id: "merge", label: "Merge" },
    ]);
    expect(shown.data.definition).not.toHaveProperty("steps");
    expect(shown.data.definition).not.toHaveProperty("id");
    expect(shown.data.definition).not.toHaveProperty("name");
    expect(shown.data.definition).not.toHaveProperty("labels");
  });
});

describe("workflow validate", () => {
  it("読み込み時と同じ指摘（未知の項目・値・事実、増やした Status）を返し、誤りがあれば ok: false", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await writeWorkflowFile(
      ctx,
      [
        "name: Old",
        "states:",
        "  qa: { label: QA }",
        "boundaries:",
        "  - { from: todo, to: in_progress, requires: [tests_pass] }",
        "",
      ].join("\n"),
    );
    // 読み込み時の指摘（ストアの issues）と同じものを返す
    const loaded = ctx.store.issues.filter((i) => i.path === "workflow.yaml");
    const r = await runCommand(workflowValidate, ctx, {});
    expect(r.data.issues).toEqual(loaded);
    expect(r.data.ok).toBe(false);
    expect(r.data.issues.map((i) => [i.code, i.severity])).toEqual([
      ["workflow_item_unknown", "warning"],
      ["workflow_status_unknown", "error"],
      ["workflow_condition_unknown", "error"],
    ]);
    // 誤りのある Workflow は使わない
    expect(ctx.store.workflow).toBeUndefined();
    await expect(runCommand(workflowShow, ctx, {})).rejects.toMatchObject({ code: "NOT_FOUND" });

    // 値の誤り（未知の権限の値）は形の誤りとして返す
    await writeWorkflowFile(ctx, "exceptions:\n  abandon: nobody\n");
    const shape = await runCommand(workflowValidate, ctx, {});
    expect(shape.data.issues.map((i) => i.code)).toEqual(["workflow_schema"]);

    // 未知の項目だけなら警告で、Workflow は使える
    await writeWorkflowFile(ctx, "name: Old\nwip:\n  review: 2\n");
    const warned = await runCommand(workflowValidate, ctx, {});
    expect(warned.data).toMatchObject({ ok: true, exists: true });
    expect(warned.data.issues.map((i) => i.severity)).toEqual(["warning"]);
    expect(ctx.store.workflow?.resolved.wip).toEqual({ review: 2 });
  });
});

describe("workflow set", () => {
  it("検証を通った定義で置き換え、1 コミットで push し、前と後と変わった項目を返す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const commits = await commitCount(ctx);
    const r = await runCommand(workflowSet, ctx, { definition: strict });
    expect(r.data).toMatchObject({
      path: "workflow.yaml",
      created: false,
      before: writtenForm(DEFAULT_WORKFLOW),
      after: { states: { review: { label: "Client Review" } } },
    });
    expect(r.data.changed).toEqual(["states", "transitions", "reconcile"]);
    expect(r.data).not.toHaveProperty("removed");
    expect(r.write).toMatchObject({ committed: true, pushed: true });
    expect(await commitCount(ctx)).toBe(commits + 1);
    expect(await gitOut(ctx, ["log", "-1", "--format=%s"])).toBe("Replace workflow.yaml");
    expect(await workflowText(ctx)).toContain("label: Client Review");

    // 別の clone でも読める
    const b = await openContext({ cwd: f.cloneB, initialize: {} });
    const shown = await runCommand(workflowShow, b, {});
    expect(shown.data.labels.review).toBe("Client Review");
  });

  it("workflow.yaml がなければ作り、前の版の workflows/ が残っていれば同じコミットで消す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const dir = path.join(ctx.repo.dataDir, "workflows");
    await mkdir(dir);
    await writeFile(path.join(dir, "general.yaml"), "id: general\nname: General\n");
    await git(ctx.repo.dataDir, ["rm", "--quiet", "workflow.yaml"]);
    await git(ctx.repo.dataDir, ["add", "workflows"]);
    await git(ctx.repo.dataDir, ["commit", "--quiet", "-m", "the form of earlier versions"]);
    await recordBaseline(ctx.repo);
    await ctx.store.rescan();
    // workflows/ は読まない：workflow.yaml がないので Core の既定で動く
    expect(ctx.store.workflow).toMatchObject({ exists: false, resolved: DEFAULT_WORKFLOW });
    // 残っている間は workflow validate が警告し、workflow set を案内する（誤りではないので ok のまま）
    const stale = await runCommand(workflowValidate, ctx, {});
    expect(stale.data).toMatchObject({ ok: true, exists: false });
    expect(stale.data.issues.map((i) => [i.severity, i.code, i.path])).toEqual([
      ["warning", "retired_workflows_dir", "workflows"],
    ]);
    expect(stale.data.issues[0]?.message).toContain("dg workflow set");

    const r = await runCommand(workflowSet, ctx, { definition: { wip: { review: 1 } } });
    expect(r.data).toMatchObject({ created: true, changed: ["wip"], removed: "workflows" });
    expect(await pathExists(dir)).toBe(false);
    expect(await gitOut(ctx, ["log", "-1", "--format=%s"])).toBe("Create workflow.yaml");
    expect(await gitOut(ctx, ["status", "--porcelain"])).toBe("");
    expect(await gitOut(ctx, ["ls-files", "workflows"])).toBe("");
    expect((await runCommand(workflowValidate, ctx, {})).data.issues).toEqual([]);
  });

  it("WF-3 の誤りと形の誤りは何も書かずに拒否し、指摘を detail に返す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const before = await workflowText(ctx);
    const commits = await commitCount(ctx);
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { transitions: [{ from: "todo", to: "done", requires: ["x"] }] },
        "transitions[0]: unknown condition x",
      ],
      [{ reconcile: [{ when: ["nope"], status: "done" }] }, "reconcile[0]: unknown condition nope"],
      [
        { reconcile: [{ when: ["pr_merged"], status: "abandoned" }] },
        "reconcile cannot set abandoned",
      ],
      [{ states: { qa: { label: "QA" } } }, "Status qa does not exist"],
      [{ boundaries: [{ from: "todo", to: "done" }] }, "todo → done is not a boundary"],
      [
        { boundaries: [{ from: "review", to: "done", requires: ["approved"] }] },
        "boundaries[0]: unknown condition approved",
      ],
      [{ flow: { skip: ["nope"] } }, "flow.skip: unknown stage nope"],
      [{ governance: { delete: "nobody" } }, "The Workflow definition has the wrong shape"],
      [
        { transitions: [{ from: "todo", to: "nowhere" }] },
        "The Workflow definition has the wrong shape",
      ],
    ];
    for (const [definition, message] of cases) {
      const error = await runCommand(workflowSet, ctx, { definition }).catch((e: unknown) => e);
      expect(error, message).toMatchObject({ code: "VALIDATION_FAILED" });
      const { message: m, detail } = error as { message: string; detail?: string };
      expect(`${m}\n${detail ?? ""}`).toContain(message);
    }
    expect(await workflowText(ctx)).toBe(before);
    expect(await commitCount(ctx)).toBe(commits);
    expect(await gitOut(ctx, ["status", "--porcelain"])).toBe("");
    expect(ctx.store.workflow?.resolved).toEqual(DEFAULT_WORKFLOW);
  });

  it("定義は必須", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await expect(runCommand(workflowSet, ctx, {} as never)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("未知の項目は警告にとどめて書く", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const r = await runCommand(workflowSet, ctx, { definition: { boundries: [] } });
    expect(r.write).toMatchObject({ committed: true });
    expect(r.warnings.some((w) => w.includes("Unknown item boundries"))).toBe(true);
  });

  it("Workflow を置き換えても既存のチケットが読め、どのチケットも新しい制約で遷移する（チケットの workflow は Workflow を選ばない）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const a = await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: a.data.id, branch: "t1-a" });
    const b = await runCommand(ticketCreate, ctx, { title: "B", workflow: "general" });
    await runCommand(workflowSet, ctx, { definition: strict });

    const again = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    expect(again.store.issues).toEqual([]);
    const shown = await runCommand(ticketShow, again, { ticket: a.data.id });
    expect(shown.data.status).toBe("in_progress");
    await expect(
      runCommand(ticketMove, again, { ticket: b.data.id, status: "done" }),
    ).rejects.toMatchObject({ code: "TRANSITION_REJECTED" });
  });
});
