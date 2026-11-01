import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationError } from "../errors.js";
import { WORKFLOW_TEMPLATES } from "../workflow/templates/index.js";
import { emptyUsage } from "../model/run.js";
import { checkReferences, wouldCreateCycle } from "./integrity.js";
import { Store } from "./store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const ts = "2026-10-31T04:00:00Z";
const ticketText = (id: string, extra = "") =>
  `---\nid: ${id}\nproject: default\ntitle: ${id} のタイトル\nstatus: todo\npriority: medium # low | medium | high\nlabels: [frontend]\n${extra}created_at: ${ts}\nupdated_at: ${ts}\n---\n\n## 概要\n\n本文\n`;

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "deguboard-store-"));
  dirs.push(root);
  await writeFile(path.join(root, "config.yaml"), "default_project: default\n");
  await mkdir(path.join(root, "projects"), { recursive: true });
  await writeFile(
    path.join(root, "projects/default.yaml"),
    "id: default\nname: Default\nworkflow: general\n",
  );
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  return root;
}

describe("Store", () => {
  it("採番は墓標を含めた最大 + 1 になる", async () => {
    const root = await fixture({
      "tickets/t2.md": ticketText("t2"),
      "tickets/deleted/t9.md": "",
      "epics/e1.md": "",
    });
    const store = await Store.open(root);
    expect(store.nextId("ticket")).toBe("t10");
    expect(store.nextId("epic")).toBe("e1"); // 読めない e1 は索引に入らない
    expect(store.nextId("iteration")).toBe("s1");
  });

  it("t12 でも 12 でも同じチケットを引ける", async () => {
    const root = await fixture({ "tickets/t12.md": ticketText("t12") });
    const store = await Store.open(root);
    expect(store.resolve("ticket", "12")?.id).toBe("t12");
    expect(store.resolve("ticket", "t12")?.id).toBe("t12");
    expect(() => store.require("ticket", "t13")).toThrow(OperationError);
  });

  it("スキーマにないキーは読み書きの往復で消えない", async () => {
    const root = await fixture({ "tickets/t1.md": ticketText("t1", "estimate: 3\n") });
    const store = await Store.open(root);
    expect(store.tickets.get("t1")?.data["estimate"]).toBe(3);
    await store.update("ticket", "t1", { title: "新しい題" });
    const text = await readFile(path.join(root, "tickets/t1.md"), "utf8");
    expect(text).toContain("estimate: 3");
    expect(text).toContain("title: 新しい題");
  });

  it("frontmatter だけ更新しても本文とコメントとキー順が変わらない", async () => {
    const root = await fixture({ "tickets/t1.md": ticketText("t1") });
    const store = await Store.open(root);
    await store.update("ticket", "t1", { status: "in_progress", assignee: "eiki" });
    const text = await readFile(path.join(root, "tickets/t1.md"), "utf8");
    const keys = text
      .split("---")[1]!
      .trim()
      .split("\n")
      .map((l) => l.split(":")[0]);
    expect(keys).toEqual([
      "id",
      "project",
      "title",
      "status",
      "priority",
      "labels",
      "created_at",
      "updated_at",
      "assignee",
    ]);
    expect(text).toContain("priority: medium # low | medium | high");
    expect(text).toContain("labels: [frontend]");
    expect(text.endsWith("---\n\n## 概要\n\n本文\n")).toBe(true);
  });

  it("壊れた YAML のチケットが 1 件あっても他は読め、Issue に path と理由が載る", async () => {
    const root = await fixture({
      "tickets/t1.md": ticketText("t1"),
      "tickets/t2.md": "---\nid: t2\ntitle: [\n---\n",
      "tickets/t3.md":
        "---\nid: t4\nproject: default\ntitle: x\nstatus: todo\ncreated_at: " +
        ts +
        "\nupdated_at: " +
        ts +
        "\n---\n",
      "tickets/t5.md": "## frontmatter なし\n",
    });
    const store = await Store.open(root);
    expect([...store.tickets.keys()]).toEqual(["t1"]);
    expect(store.issues.map((i) => [i.path, i.code])).toEqual([
      ["tickets/t2.md", "yaml_error"],
      ["tickets/t3.md", "id_mismatch"],
      ["tickets/t5.md", "frontmatter_missing"],
    ]);
  });

  it("スキーマに合わない更新は拒否され、ファイルは変わらない", async () => {
    const root = await fixture({ "tickets/t1.md": ticketText("t1") });
    const store = await Store.open(root);
    const before = await readFile(path.join(root, "tickets/t1.md"), "utf8");
    await expect(store.update("ticket", "t1", { status: "nope" })).rejects.toThrow(OperationError);
    expect(await readFile(path.join(root, "tickets/t1.md"), "utf8")).toBe(before);
    expect((await readdir(path.join(root, "tickets"))).filter((f) => f.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("作成すると索引とファイルの両方に入り、削除すると墓標へ移る", async () => {
    const root = await fixture({});
    const store = await Store.open(root);
    const id = store.nextId("ticket");
    await store.create(
      "ticket",
      {
        id,
        project: "default",
        title: "新規",
        status: "todo",
        depends_on: [],
        created_at: ts,
        updated_at: ts,
      },
      "## 概要\n",
    );
    expect(store.tickets.get("t1")?.data.title).toBe("新規");
    const text = await readFile(path.join(root, "tickets/t1.md"), "utf8");
    expect(text).toContain("depends_on: []");
    expect(text.endsWith("---\n## 概要\n")).toBe(true);
    await expect(
      store.create("ticket", {
        id,
        project: "default",
        title: "重複",
        status: "todo",
        created_at: ts,
        updated_at: ts,
      }),
    ).rejects.toThrow(/既にある/);
    await store.deleteTicket("t1");
    expect(store.tickets.size).toBe(0);
    expect(await readdir(path.join(root, "tickets/deleted"))).toEqual(["t1.md"]);
    expect(store.nextId("ticket")).toBe("t2");
  });

  it("Workflow はテンプレートから書け、誤りのある定義は索引に入らず Issue になる", async () => {
    const root = await fixture({
      "workflows/bad.yaml": "id: bad\nname: Bad\nreconcile:\n  - { when: [nope], status: done }\n",
    });
    const store = await Store.open(root);
    expect(store.workflows.has("bad")).toBe(false);
    expect(store.issues.some((i) => i.code === "workflow_condition_unknown")).toBe(true);
    await store.writeWorkflow(WORKFLOW_TEMPLATES[2]!, "汎用のワークフロー");
    const text = await readFile(path.join(root, "workflows/general.yaml"), "utf8");
    expect(text.startsWith("# 汎用のワークフロー\n")).toBe(true);
    expect(store.workflows.get("general")?.resolved.labels.todo).toBe("Todo");
  });

  it("config は既定値で補われ、部分的に書き換えられる", async () => {
    const root = await fixture({});
    const store = await Store.open(root);
    expect(store.config.git.remote).toBe("origin");
    await store.writeConfig({ commit: { mode: "each" } });
    expect(store.config.commit.mode).toBe("each");
    expect(
      (await readFile(path.join(root, "config.yaml"), "utf8")).startsWith(
        "default_project: default\n",
      ),
    ).toBe(true);
  });

  it("参照の整合を検査し、依存の循環を見つける", async () => {
    const root = await fixture({
      "tickets/t1.md": ticketText("t1", "depends_on: [t2]\nepic: e9\n"),
      "tickets/t2.md": ticketText("t2", "depends_on: [t1]\niteration: s1\n"),
      "workflows/general.yaml": "id: general\nname: General\n",
    });
    const store = await Store.open(root);
    const codes = checkReferences(store)
      .map((i) => i.code)
      .sort();
    expect(codes).toEqual(["depends_on_cycle", "epic_missing", "iteration_missing"]);
    expect(wouldCreateCycle(store, "t3", ["t1"])).toBe(false);
    expect(wouldCreateCycle(store, "t1", ["t2"])).toBe(true);
  });

  it("Run を JSON で書いて読み直すと、null と estimated とスキーマにないキーが残る", async () => {
    const id = "r20261031-041500-3fa2";
    const root = await fixture({ "tickets/t1.md": ticketText("t1") });
    const store = await Store.open(root);
    await store.create("run", {
      id,
      ticket: "t1",
      step: "implement",
      agent: "claude-code",
      model: null,
      started_at: ts,
      finished_at: null,
      result: null,
      error: null,
      retries: 0,
      usage: { ...emptyUsage(), input: 1200, estimated: true, reasoning: 5 },
      files: ["src/a.ts"],
    });
    const text = await readFile(path.join(root, `runs/${id}.json`), "utf8");
    expect(JSON.parse(text)).toMatchObject({ model: null, usage: { output: null } });
    expect(text.endsWith("}\n")).toBe(true);

    // 別の版の dg が足したキーを置いてから、読み直して更新する
    const raw = JSON.parse(text);
    await writeFile(
      path.join(root, `runs/${id}.json`),
      JSON.stringify({ ...raw, future: { a: 1 } }),
    );
    const reopened = await Store.open(root);
    expect(reopened.issues).toEqual([]);
    const run = reopened.runs.get(id)!.data;
    expect(run.model).toBeNull();
    expect(run.usage).toEqual({ ...emptyUsage(), input: 1200, estimated: true, reasoning: 5 });
    await reopened.update("run", id, {
      finished_at: "2026-10-31T05:00:00Z",
      result: "success",
    });
    const after = JSON.parse(await readFile(path.join(root, `runs/${id}.json`), "utf8"));
    expect(after).toMatchObject({
      result: "success",
      model: null,
      error: null,
      files: ["src/a.ts"],
      future: { a: 1 },
      usage: { input: 1200, output: null, estimated: true, reasoning: 5 },
    });
    expect(Object.keys(after).slice(0, 2)).toEqual(["id", "ticket"]);
    expect(checkReferences(reopened).filter((i) => i.path.startsWith("runs/"))).toEqual([]);
  });

  it("読めない Run は Issue になり、ほかの Run とチケットの読み込みは止まらない", async () => {
    const good = (id: string, ticket = "t1") =>
      JSON.stringify({
        id,
        ticket,
        step: "review",
        agent: "codex",
        model: "gpt",
        started_at: ts,
        finished_at: ts,
        result: "failure",
        error: "テストが落ちた",
        retries: 2,
        usage: emptyUsage(),
      });
    const root = await fixture({
      "tickets/t1.md": ticketText("t1"),
      "runs/r20261031-040000-0001.json": good("r20261031-040000-0001"),
      "runs/r20261031-040000-0002.json": "{ 壊れた",
      "runs/r20261031-040000-0003.json": good("r20261031-040000-0003").replace(
        '"failure"',
        '"done"',
      ),
      "runs/r20261031-040000-0004.json": good("r20261031-040000-0005"),
      "runs/r20261031-040000-0006.json": "[]",
      "runs/r1.json": good("r1"),
      "runs/r20261031-040000-0007.json": good("r20261031-040000-0007", "t9"),
    });
    const store = await Store.open(root);
    expect([...store.tickets.keys()]).toEqual(["t1"]);
    expect([...store.runs.keys()]).toEqual(["r20261031-040000-0001", "r20261031-040000-0007"]);
    expect(store.issues.map((i) => [i.path, i.severity, i.code])).toEqual([
      ["runs/r1.json", "warning", "unexpected_file"],
      ["runs/r20261031-040000-0002.json", "error", "json_error"],
      ["runs/r20261031-040000-0003.json", "error", "schema_error"],
      ["runs/r20261031-040000-0004.json", "error", "id_mismatch"],
      ["runs/r20261031-040000-0006.json", "error", "json_error"],
    ]);
    const runRefs = checkReferences(store).filter((i) => i.path.startsWith("runs/"));
    expect(runRefs.map((i) => [i.id, i.code])).toEqual([
      ["r20261031-040000-0007", "ticket_missing"],
    ]);
  });
});
