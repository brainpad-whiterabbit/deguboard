import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationError } from "../errors.js";
import { WORKFLOW_TEMPLATES } from "../workflow/templates/index.js";
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
    await store.update("ticket", "t1", { status: "in_progress", claimed_by: "eiki@laptop" });
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
      "claimed_by",
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
});
