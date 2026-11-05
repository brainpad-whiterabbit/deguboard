import { mkdtemp, readFile, readdir, writeFile, mkdir, rm, unlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationError } from "../errors.js";
import { emptyUsage } from "../model/run.js";
import { WORKFLOW_TEMPLATES } from "../workflow/templates/index.js";
import { checkReferences, wouldCreateCycle } from "./integrity.js";
import { Store } from "./store.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
  it("rescan は変わっていないファイルを読み直さず、書き換え・追加・削除したファイルだけを取り込む", async () => {
    const root = await fixture({
      "tickets/t1.md": ticketText("t1"),
      "tickets/t2.md": ticketText("t2"),
      "tickets/t3.md": "---\nid: t3\ntitle: [\n---\n",
    });
    // 時計を進め、どのファイルも更新が十分に古いものとして覚えさせる
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const store = await Store.open(root);
    const id = String(WORKFLOW_TEMPLATES[2]!["id"]);
    await store.writeWorkflow(WORKFLOW_TEMPLATES[2]!);
    // 自分で書いた Workflow の 1 ファイルだけを読み直す
    await store.rescan();
    const files = store.lastScan.read + store.lastScan.reused;
    expect(store.lastScan.read).toBe(1);
    const before = store.tickets.get("t1");

    await store.rescan();
    expect(store.lastScan).toEqual({ read: 0, reused: files });
    // 前の結果をそのまま使い、読めないファイルの Issue も残る
    expect(store.tickets.get("t1")).toBe(before);
    expect(store.issues.map((i) => [i.path, i.code])).toEqual([["tickets/t3.md", "yaml_error"]]);
    expect(store.workflows.has(id)).toBe(true);

    // 同じ大きさで同じファイルに上書きする。経過時間に頼らないよう、更新時刻は前と違う値に決めて付ける
    const t1 = path.join(root, "tickets/t1.md");
    await writeFile(t1, ticketText("t1").replace("本文", "本日"));
    await utimes(t1, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    await writeFile(path.join(root, "tickets/t4.md"), ticketText("t4"));
    await unlink(path.join(root, "tickets/t2.md"));
    await store.rescan();
    expect(store.lastScan).toEqual({ read: 2, reused: files - 2 });
    expect([...store.tickets.keys()]).toEqual(["t1", "t4"]);
    expect(store.tickets.get("t1")?.body).toContain("本日");
  });

  it("localDir を渡すと個人の config.yaml を重ねて読み、無ければ読まず、あれば変わらない間は読み直さない（t437）", async () => {
    const root = await fixture({});
    const localDir = await mkdtemp(path.join(os.tmpdir(), "deguboard-store-local-"));
    dirs.push(localDir);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    // 無い：チームの値のまま。読み直した数にも数えない
    const store = await Store.open(root, { localDir });
    const files = store.lastScan.read;
    expect(store.config.commit.mode).toBe("batch");
    expect(store.localConfig).toEqual({});
    await store.rescan();
    expect(store.lastScan).toEqual({ read: 0, reused: files });
    // 置くと次の rescan で重なり、変わらなければ覚えた結果を使う
    await writeFile(
      path.join(localDir, "config.yaml"),
      "commit:\n  mode: each\nauto:\n  merge: true\n",
    );
    await store.rescan();
    expect(store.lastScan.read).toBe(1);
    expect(store.config.commit.mode).toBe("each");
    expect(store.teamConfig.commit.mode).toBe("batch");
    expect(store.localConfig).toEqual({ "commit.mode": "each" });
    expect(store.issues.map((i) => [i.severity, i.code, i.path])).toEqual([
      ["warning", "local_config_ignored", "deguboard-local/config.yaml"],
    ]);
    await store.rescan();
    expect(store.lastScan).toEqual({ read: 0, reused: files + 1 });
    expect(store.config.commit.mode).toBe("each");
    // writeLocalConfig は無視されている項目（auto.merge）を残して葉だけ書き、消して空になればファイルも消す
    await store.writeLocalConfig("models.light", "sonnet");
    expect(await readFile(path.join(localDir, "config.yaml"), "utf8")).toContain("merge: true");
    expect(store.config.models.light).toBe("sonnet");
    await store.writeLocalConfig("commit.mode", undefined);
    expect(store.config.commit.mode).toBe("batch");
    expect(store.localConfig).toEqual({ "models.light": "sonnet" });
    // 新たに無視される項目（チーム専用）を書こうとすると拒む。前から無視されている auto.merge は書き換えても拒まない
    await expect(store.writeLocalConfig("metrics.read_transcripts", true)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await store.writeLocalConfig("auto.merge", false);
    expect(store.config.auto.merge).toBe(false);
    // localDir を渡さなければ個人の設定は書けない
    const plain = await Store.open(root);
    await expect(plain.writeLocalConfig("commit.mode", "each")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("更新が新しいファイルは印が同じでも覚えずに毎回読み、時刻が過ぎてから覚える", async () => {
    const root = await fixture({ "tickets/t1.md": ticketText("t1") });
    const now = vi.spyOn(Date, "now");
    const base = Date.now();
    // 書いた直後：同じ刻みの中で書き直されても印が変わらないことがあるので、覚えない
    now.mockReturnValue(base);
    const store = await Store.open(root);
    const files = store.lastScan.read;
    await store.rescan();
    expect(store.lastScan).toEqual({ read: files, reused: 0 });
    // 刻みの中で同じ大きさに書き直す。覚えていないので、印が変わっても変わらなくても取り込む
    await writeFile(path.join(root, "tickets/t1.md"), ticketText("t1").replace("本文", "本日"));
    await store.rescan();
    expect(store.tickets.get("t1")?.body).toContain("本日");
    // 幅（3 秒）を過ぎたら覚え、次からは読み直さない
    now.mockReturnValue(base + 10_000);
    await store.rescan();
    expect(store.lastScan).toEqual({ read: files, reused: 0 });
    await store.rescan();
    expect(store.lastScan).toEqual({ read: 0, reused: files });
  });
});
