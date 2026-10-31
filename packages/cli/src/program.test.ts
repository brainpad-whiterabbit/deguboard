import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commands } from "@deguboard/core";
import {
  createFixture,
  createLocalOnlyRepo,
  git,
  type Fixture,
} from "../../core/test/helpers/git-fixture.js";
import { run } from "./program.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

interface Ran {
  code: number;
  out: string;
  err: string;
  json: () => {
    ok: boolean;
    data?: any;
    error?: { code: string; message: string };
    warnings?: string[];
    write?: unknown;
  };
}

/** dg を in-process で動かす */
async function dg(cwd: string, argv: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd,
    env,
    streams: { out: (t) => out.push(t), err: (t) => err.push(t) },
  });
  return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) };
}

describe("dg", () => {
  it("init → ticket create → claim → show が通り、--json の形が ok / data / warnings / write になる", async () => {
    const f = await fixture();
    const init = await dg(f.cloneA, ["--json", "init", "--template", "software-development"]);
    expect(init.code).toBe(0);
    expect(init.json()).toMatchObject({
      ok: true,
      data: { worktree: "orphan" },
      warnings: [],
      write: { pushed: true },
    });

    const created = await dg(f.cloneA, [
      "--json",
      "ticket",
      "create",
      "Login validation",
      "--label",
      "frontend,auth",
      "--priority",
      "high",
    ]);
    expect(created.code).toBe(0);
    expect(created.json().data).toMatchObject({
      id: "t1",
      labels: ["frontend", "auth"],
      priority: "high",
      status: "todo",
    });

    const claimed = await dg(f.cloneA, [
      "--json",
      "--actor",
      "agent",
      "--actor-id",
      "claude@pc",
      "ticket",
      "claim",
      "1",
    ]);
    expect(claimed.json().data).toMatchObject({
      status: "in_progress",
      claimed_by: "claude@pc",
      branch: "feature/t1-login-validation",
    });

    const shown = await dg(f.cloneA, ["ticket", "show", "t1"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("claimed_by: claude@pc");
    expect(shown.out).toContain("## 受け入れ条件");

    const list = await dg(f.cloneA, ["ticket", "list"]);
    expect(list.out.split("\n")[0]).toMatch(/^id\s+status\s+priority\s+title/);
    expect(list.out).toContain("t1  in_progress  high      Login validation");
  });

  it("拒否された遷移は終了コード 1 と error.code、入力の誤りと未知のコマンドは 2", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await dg(f.cloneA, ["ticket", "create", "A"]);
    const rejected = await dg(f.cloneA, ["--json", "ticket", "move", "1", "done"]);
    expect(rejected.code).toBe(1);
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: "TRANSITION_REJECTED" } });
    const human = await dg(f.cloneA, ["ticket", "move", "1", "done"]);
    expect(human.code).toBe(1);
    expect(human.err).toContain("エラー: todo から done への遷移は遷移表にない");

    expect((await dg(f.cloneA, ["ticket", "create", "x", "--priority", "nope"])).code).toBe(2);
    expect((await dg(f.cloneA, ["ticket", "nope"])).code).toBe(2);
    expect((await dg(f.cloneA, ["ticket", "show"])).code).toBe(2);
    expect((await dg(f.cloneA, ["ticket", "create", ""])).code).toBe(2);
  });

  it("初期化前は NOT_INITIALIZED で 1、リモートがなくても init と起票ができる", async () => {
    const f = await fixture();
    const before = await dg(f.cloneB, ["--json", "ticket", "list"]);
    expect(before.code).toBe(1);
    expect(before.json().error?.code).toBe("NOT_INITIALIZED");

    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    expect((await dg(local.dir, ["init"])).code).toBe(0);
    const created = await dg(local.dir, ["--json", "ticket", "create", "オフライン"]);
    expect(created.json()).toMatchObject({
      ok: true,
      data: { id: "t1" },
      write: { committed: true, pushed: false },
    });
  });

  it("--actor agent では abandoned への move が拒否され、環境変数 DEGUBOARD_ACTOR も効く", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await dg(f.cloneA, ["ticket", "create", "A"]);
    const viaOption = await dg(f.cloneA, [
      "--json",
      "--actor",
      "agent",
      "ticket",
      "move",
      "1",
      "abandoned",
    ]);
    expect(viaOption.json().error?.code).toBe("TRANSITION_REJECTED");
    const viaEnv = await dg(f.cloneA, ["--json", "ticket", "move", "1", "abandoned"], {
      DEGUBOARD_ACTOR: "agent",
    });
    expect(viaEnv.json().error?.code).toBe("TRANSITION_REJECTED");
    const human = await dg(f.cloneA, ["--json", "ticket", "move", "1", "abandoned"]);
    expect(human.json().data).toMatchObject({ status: "abandoned" });
  });

  it("dg sprint は dg iteration と同じで、-C で別のディレクトリに対して動く", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const created = await dg(f.root, [
      "-C",
      "a",
      "--json",
      "sprint",
      "create",
      "Sprint 1",
      "--start",
      "2026-11-01",
    ]);
    expect(created.code).toBe(0);
    expect(created.json().data).toMatchObject({ id: "s1", start: "2026-11-01" });
    const list = await dg(f.cloneA, ["iteration", "list"]);
    expect(list.out).toContain("s1");
  });

  it("ticket import はファイルの下書きを読み、key を depends_on に解決する", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const file = path.join(f.root, "drafts.yaml");
    await writeFile(
      file,
      "- key: schema\n  title: スキーマ\n- key: api\n  title: API\n  depends_on: [schema]\n",
    );
    const imported = await dg(f.cloneA, ["--json", "ticket", "import", file]);
    expect(imported.code).toBe(0);
    expect(imported.json().data).toMatchObject([{ id: "t1" }, { id: "t2", depends_on: ["t1"] }]);
    const log = (
      await git(path.join(f.cloneA, ".git", "deguboard"), ["log", "-1", "--format=%s"])
    ).stdout.trim();
    expect(log).toBe("2 件のチケットを取り込み: t1, t2");
  });

  it("validate と lint は指摘があると ok: false で終了コード 1 になる", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    expect((await dg(f.cloneA, ["validate"])).code).toBe(0);
    await dg(f.cloneA, ["ticket", "create", "A", "--body", "本文だけ"]);
    await dg(f.cloneA, ["ticket", "create", "B", "--summary", "s"]);
    await dg(f.cloneA, ["ticket", "create", "C", "--summary", "s", "--acceptance", "a, b"]);
    const lint = await dg(f.cloneA, ["--json", "lint"]);
    expect(lint.code).toBe(1);
    expect(
      lint.json().data.issues.map((i: { id: string; code: string }) => [i.id, i.code]),
    ).toEqual([
      ["t1", "lint_summary_missing"],
      ["t1", "lint_acceptance_missing"],
      ["t2", "lint_acceptance_empty"],
    ]);
    const shown = await dg(f.cloneA, ["--json", "ticket", "show", "t3"]);
    expect(shown.json().data.body).toContain("- [ ] a, b\n");
    const updated = await dg(f.cloneA, [
      "--json",
      "ticket",
      "update",
      "t2",
      "--acceptance",
      "x, y",
    ]);
    expect(updated.code).toBe(0);
    expect(updated.json().data.body).toBe("## 概要\n\ns\n\n## 受け入れ条件\n\n- [ ] x, y\n");
    await writeFile(
      path.join(f.cloneA, ".git", "deguboard", "tickets", "t2.md"),
      "---\nid: t2\n---\n",
    );
    const validate = await dg(f.cloneA, ["validate"]);
    expect(validate.code).toBe(1);
    expect(validate.out).toContain("tickets/t2.md");
  });

  it("--help にすべてのコマンドが載る", async () => {
    const f = await fixture();
    const top = await dg(f.cloneA, ["--help"]);
    expect(top.code).toBe(0);
    for (const def of commands) {
      const [group, op] = def.name.split(".");
      const help = op ? await dg(f.cloneA, [group!, "--help"]) : top;
      expect(help.out, def.name).toContain(op ?? group!);
    }
    expect((await dg(f.cloneA, ["--version"])).out).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
