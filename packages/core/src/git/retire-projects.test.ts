// やめた Project の残り（projects/ と config の default_project）を dg が消すこと（ADR-034）。
// 前の dg が書いた形のデータ（projects/default.yaml と、project: default を持つチケット・Epic・Iteration・Plan）を一時リポジトリに作って確かめる

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fixture,
  initialized,
  reopenInitialized,
  runCleanups,
} from "../../test/helpers/commands-context.js";
import { git, type Fixture } from "../../test/helpers/git-fixture.js";
import { openContext } from "../commands/context.js";
import { runCommand, type CommandContext } from "../commands/define.js";
import { epicCreate } from "../commands/epic.js";
import { iterationCreate, iterationUpdate } from "../commands/iteration.js";
import { planCreate } from "../commands/plan.js";
import { commit, configSet, sync, validate } from "../commands/setup.js";
import { ticketCreate, ticketList, ticketShow, ticketUpdate } from "../commands/ticket.js";
import { pathExists } from "../storage/exists.js";
import { checkOutside, DG_COMMIT_TRAILER, recordBaseline } from "./outside.js";
import { push } from "./sync.js";

afterEach(runCleanups);

const REMOVAL = "Remove projects/ (Projects are retired; default_workflow takes their place)";

/** ファイルの id の行の後に project の行を足す（前の dg が書いた形にする） */
async function addProject(ctx: CommandContext, rel: string, project = "default") {
  const file = path.join(ctx.repo.dataDir, rel);
  const text = await readFile(file, "utf8");
  await writeFile(file, text.replace(/^(id: .*\n)/m, `$1project: ${project}\n`));
}

/**
 * 前の dg が書いた形のデータを作って push する：projects/default.yaml（既定の Workflow は software-development）、
 * config の default_project、project: default を持つチケット（t1・t2）・Epic（e1）・Iteration（s1）・Plan（p1）。
 * 前の dg のコミットとして印を付け、今の状態を dg の外の変更の基準にする。mode は commit.mode
 */
async function legacy(mode: "each" | "batch", extra?: (ctx: CommandContext) => Promise<void>) {
  const f = await fixture();
  const first = await initialized(f.cloneA);
  await runCommand(configSet, first, { key: "commit.mode", value: mode });
  await runCommand(ticketCreate, first, { title: "A" });
  await runCommand(ticketCreate, first, { title: "B" });
  await runCommand(epicCreate, first, { title: "E" });
  await runCommand(iterationCreate, first, { name: "S" });
  await runCommand(planCreate, first, { tickets: ["t1"] });
  await runCommand(commit, first, {});
  const dir = first.repo.dataDir;
  for (const rel of ["tickets/t1.md", "tickets/t2.md", "epics/e1.md"]) await addProject(first, rel);
  for (const rel of ["iterations/s1.yaml", "plans/p1.yaml"]) await addProject(first, rel);
  await mkdir(path.join(dir, "projects"), { recursive: true });
  await writeFile(
    path.join(dir, "projects/default.yaml"),
    'id: default\nname: Default\ndescription: ""\nworkflow: software-development\nstatus: active\n',
  );
  const config = path.join(dir, "config.yaml");
  await writeFile(config, `default_project: default\n${await readFile(config, "utf8")}`);
  await extra?.(first);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "前の dg が書いた形", "-m", DG_COMMIT_TRAILER]);
  expect(await push(first.repo)).toEqual({ ok: true });
  await recordBaseline(first.repo);
  return { f, ctx: await reopenInitialized(f) };
}

const tracked = async (ctx: CommandContext, rel: string) =>
  (await git(ctx.repo.dataDir, ["ls-files", "--", rel])).stdout.trim();
const subjects = async (dir: string, rev = "HEAD") =>
  (await git(dir, ["log", "--format=%s", rev])).stdout.trim().split("\n");
const read = (ctx: CommandContext, rel: string) =>
  readFile(path.join(ctx.repo.dataDir, rel), "utf8");
const workflowOf = async (ctx: CommandContext, ticket: string) =>
  ctx.store.workflowFor((await runCommand(ticketShow, ctx, { ticket })).data)?.definition.id;
const remoteFiles = async (f: Fixture) =>
  (await git(f.remoteDir, ["ls-tree", "-r", "--name-only", "deguboard"])).stdout;
/** テストの文脈はマージドライバを登録しないので、その警告は除く */
const warningsOf = (r: { warnings: string[] }) =>
  r.warnings.filter((w) => !w.startsWith("The merge driver is not registered"));

describe("やめた Project の残りを消す", () => {
  it("読むコマンドは projects/ を消さず、既定の Project の Workflow でチケットを読み、validate が通る", async () => {
    const { ctx } = await legacy("each");
    const head = (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout;
    expect((await runCommand(ticketList, ctx, {})).data.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect((await runCommand(ticketList, ctx, {})).warnings).toEqual([]);
    expect(await workflowOf(ctx, "t1")).toBe("software-development");
    expect((await runCommand(validate, ctx, {})).data).toEqual({ ok: true, issues: [] });
    expect(await pathExists(path.join(ctx.repo.dataDir, "projects/default.yaml"))).toBe(true);
    expect((await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect((await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("書き込みのときに projects/ と default_project と .gitattributes の projects の行を印付きのコミットで一度だけ消し、既定の Workflow を default_workflow に移す。dg の外の変更として止まらない", async () => {
    // 前の dg は .gitattributes に projects/*.yaml の行（マージドライバを当てるパス）も書いていた
    const { f, ctx } = await legacy("each", async (first) => {
      const file = path.join(first.repo.dataDir, ".gitattributes");
      await writeFile(file, `${await readFile(file, "utf8")}projects/*.yaml merge=deguboard\n`);
    });
    const updated = await runCommand(ticketUpdate, ctx, { ticket: "t1", priority: "high" });
    expect(updated.write).toMatchObject({ committed: true, pushed: true });

    // projects/ は作業ツリーからも Git からも消え、消したコミットは dg の印を持つ
    expect(await pathExists(path.join(ctx.repo.dataDir, "projects"))).toBe(false);
    expect(await tracked(ctx, "projects")).toBe("");
    expect(await subjects(ctx.repo.dataDir)).toEqual(
      expect.arrayContaining([REMOVAL, "前の dg が書いた形"]),
    );
    const removal = (
      await git(ctx.repo.dataDir, ["log", "--format=%H", "--grep", "^Remove projects/"])
    ).stdout.trim();
    expect(removal.split("\n")).toHaveLength(1);
    const body = (await git(ctx.repo.dataDir, ["show", "-s", "--format=%B", removal])).stdout;
    expect(body.trim().split("\n").at(-1)).toBe(DG_COMMIT_TRAILER);
    // 消したコミットは projects/ と config.yaml と .gitattributes だけを変える（チケットの project は、そのチケットを書くときに消える）
    const changed = (
      await git(ctx.repo.dataDir, ["show", "--name-only", "--format=", removal])
    ).stdout.trim();
    expect(changed.split("\n").sort()).toEqual([
      ".gitattributes",
      "config.yaml",
      "projects/default.yaml",
    ]);
    // .gitattributes：projects の行だけが消え、ほかの行は残る
    const attributes = await read(ctx, ".gitattributes");
    expect(attributes).not.toContain("projects/");
    expect(attributes).toContain("tickets/*.md merge=deguboard\n");
    expect(attributes).toContain("iterations/*.yaml merge=deguboard\n");

    // config：default_project は消え、既定の Project の Workflow が default_workflow になる
    const config = await read(ctx, "config.yaml");
    expect(config).not.toContain("default_project");
    expect(config).toContain("default_workflow: software-development");
    expect(ctx.store.config.default_workflow).toBe("software-development");
    expect(await workflowOf(ctx, "t1")).toBe("software-development");
    expect(await workflowOf(ctx, "t2")).toBe("software-development");

    // 書いたチケット（t1）の project は消え、書いていないもの（t2）は読めるまま残る
    expect(await read(ctx, "tickets/t1.md")).not.toContain("project:");
    expect(await read(ctx, "tickets/t2.md")).toContain("project: default");
    expect(updated.data).not.toHaveProperty("project");

    // dg の外の変更とみなさず、次の書き込みも読みも止まらない。2 回目は消すコミットを作らない
    expect(await checkOutside(ctx.repo)).toEqual({ kind: "clean", initial: false });
    expect((await runCommand(ticketList, ctx, {})).warnings).toEqual([]);
    await runCommand(iterationUpdate, ctx, { iteration: "s1", goal: "目標" });
    expect(await read(ctx, "iterations/s1.yaml")).not.toContain("project:");
    expect((await subjects(ctx.repo.dataDir)).filter((s) => s === REMOVAL)).toHaveLength(1);
    expect((await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
    expect((await runCommand(validate, ctx, {})).data).toEqual({ ok: true, issues: [] });

    // リモートにも届く。別の clone は取り込むだけで、外の変更として止まらず validate が通る
    expect(await remoteFiles(f)).not.toContain("projects/");
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "human", user: "eiki" },
    });
    expect(await pathExists(path.join(b.repo.dataDir, "projects"))).toBe(false);
    expect(b.store.config.default_workflow).toBe("software-development");
    expect((await runCommand(validate, b, {})).data).toEqual({ ok: true, issues: [] });
    await runCommand(ticketUpdate, b, { ticket: "t2", priority: "low" });
    expect(await read(b, "tickets/t2.md")).not.toContain("project:");
    expect((await subjects(b.repo.dataDir)).filter((s) => s === REMOVAL)).toHaveLength(1);
  });

  it("同期のときにも消して push する。commit.mode が batch で、まとめ待ちの変更があっても、消すコミットには混ぜない", async () => {
    const { f, ctx } = await legacy("batch");
    // まとめ待ちの変更は、書き込みのとき（消した後）に作業ツリーに残る
    await runCommand(ticketUpdate, ctx, { ticket: "t2", priority: "low" });
    const removal = (
      await git(ctx.repo.dataDir, ["log", "--format=%H", "--grep", "^Remove projects/"])
    ).stdout.trim();
    const changed = (
      await git(ctx.repo.dataDir, ["show", "--name-only", "--format=", removal])
    ).stdout.trim();
    expect(changed.split("\n").sort()).toEqual(["config.yaml", "projects/default.yaml"]);
    expect((await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout.trim()).toBe(
      "M tickets/t2.md",
    );
    expect(await checkOutside(ctx.repo)).toEqual({ kind: "clean", initial: false });

    const synced = await runCommand(sync, ctx, {});
    expect(warningsOf(synced)).toEqual([]);
    expect(await remoteFiles(f)).not.toContain("projects/");
    expect((await subjects(f.remoteDir, "deguboard")).filter((s) => s === REMOVAL)).toHaveLength(1);
    expect((await runCommand(validate, ctx, {})).data).toEqual({ ok: true, issues: [] });
  });

  it("消すときに書き換える config.yaml にまとめ待ちの変更があれば見送り、dg commit がまとめ待ちをコミットした後に別のコミットで消す", async () => {
    const { ctx } = await legacy("batch");
    // 前の dg が残したまとめ待ちの変更（config.yaml）を模す
    const config = path.join(ctx.repo.dataDir, "config.yaml");
    await writeFile(config, `${await readFile(config, "utf8")}# まとめ待ちの変更\n`);
    await recordBaseline(ctx.repo);

    // 書き込みは見送る：消すコミットを作らず、projects/ も config.yaml の default_project も残り、チケットの Workflow は変わらない
    await runCommand(ticketUpdate, ctx, { ticket: "t2", priority: "low" });
    expect(await subjects(ctx.repo.dataDir)).not.toContain(REMOVAL);
    expect(await pathExists(path.join(ctx.repo.dataDir, "projects/default.yaml"))).toBe(true);
    expect(await read(ctx, "config.yaml")).toContain("default_project: default");
    expect(await workflowOf(ctx, "t1")).toBe("software-development");
    expect((await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout).toBe(
      " M config.yaml\n M tickets/t2.md\n",
    );

    // dg commit：まとめ待ちを先にコミットし、その後に消す。消すコミットにまとめ待ちの変更は入らない
    const committed = await runCommand(commit, ctx, { message: "まとめ待ち" });
    expect(committed.data.committed).toBe(true);
    expect((await subjects(ctx.repo.dataDir)).slice(0, 2)).toEqual([REMOVAL, "まとめ待ち"]);
    const removal = (await git(ctx.repo.dataDir, ["show", "--format=", "HEAD"])).stdout;
    expect(removal).not.toContain("+# まとめ待ちの変更");
    expect(removal).toContain("-default_project: default");
    expect(
      (await git(ctx.repo.dataDir, ["show", "--name-only", "--format=", "HEAD"])).stdout
        .trim()
        .split("\n")
        .sort(),
    ).toEqual(["config.yaml", "projects/default.yaml"]);
    const pending = (await git(ctx.repo.dataDir, ["show", "--format=", "HEAD~1"])).stdout;
    expect(pending).toContain("+# まとめ待ちの変更");
    expect(await pathExists(path.join(ctx.repo.dataDir, "projects"))).toBe(false);
    expect(await read(ctx, "config.yaml")).toContain("# まとめ待ちの変更");
    expect(await workflowOf(ctx, "t1")).toBe("software-development");
    expect((await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
    expect(await checkOutside(ctx.repo)).toEqual({ kind: "clean", initial: false });
    expect((await runCommand(validate, ctx, {})).data).toEqual({ ok: true, issues: [] });
  });

  it("まだ消していない clone の同期は、消してから取り込み、相手が先に消していても競合しない", async () => {
    const { f, ctx: a } = await legacy("each");
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "human", user: "eiki" },
    });
    expect(await pathExists(path.join(b.repo.dataDir, "projects/default.yaml"))).toBe(true);
    // a が先に消して push する
    await runCommand(ticketUpdate, a, { ticket: "t1", priority: "high" });
    // b は自分でも消してから取り込む（どちらも同じ変更なので競合しない）
    const synced = await runCommand(sync, b, {});
    expect(synced.data.conflicts).toEqual([]);
    expect(warningsOf(synced)).toEqual([]);
    expect(await pathExists(path.join(b.repo.dataDir, "projects"))).toBe(false);
    expect(await read(b, "config.yaml")).toContain("default_workflow: software-development");
    expect(await checkOutside(b.repo)).toEqual({ kind: "clean", initial: false });
    expect((await runCommand(validate, b, {})).data).toEqual({ ok: true, issues: [] });
  });

  it("既定でない Project のチケットは、その Project の Workflow が既定と違えば workflow に書いて残す", async () => {
    const { ctx } = await legacy("each", async (first) => {
      // t2 は Project web（既定の Workflow は general）のチケット
      await writeFile(
        path.join(first.repo.dataDir, "projects/web.yaml"),
        "id: web\nname: Web\nworkflow: general\nstatus: active\n",
      );
      const t2 = path.join(first.repo.dataDir, "tickets/t2.md");
      await writeFile(t2, (await readFile(t2, "utf8")).replace("project: default", "project: web"));
    });
    expect(await workflowOf(ctx, "t1")).toBe("software-development");
    await runCommand(ticketUpdate, ctx, { ticket: "t1", priority: "high" });
    expect(await pathExists(path.join(ctx.repo.dataDir, "projects"))).toBe(false);
    expect(await workflowOf(ctx, "t1")).toBe("software-development");
    expect(await workflowOf(ctx, "t2")).toBe("general");
    const t2 = await read(ctx, "tickets/t2.md");
    expect(t2).toContain("workflow: general");
    expect(t2).not.toContain("project:");
    expect((await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
    expect((await runCommand(validate, ctx, {})).data).toEqual({ ok: true, issues: [] });
  });
});
