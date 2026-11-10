import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { commands } from "@deguboard/core";
import { createFixture, git, type Fixture } from "../../core/test/helpers/git-fixture.js";
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

/** 制約を書いた Workflow（strict）を clone のデータディレクトリに直に置き、dg adopt で取り込む（SY-8） */
async function writeStrictWorkflow(clone: string): Promise<void> {
  await writeFile(
    path.join(clone, ".git/deguboard/workflows/strict.yaml"),
    [
      "id: strict",
      "name: Strict",
      "transitions:",
      "  - { from: todo, to: done, by: [] }",
      "  - { from: todo, to: abandoned, by: [human] }",
      "",
    ].join("\n"),
  );
  const adopted = await dg(clone, ["--json", "adopt"]);
  expect(adopted.json()).toMatchObject({ ok: true, data: { adopted: true } });
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
      "--user",
      "claude",
      "ticket",
      "claim",
      "1",
    ]);
    expect(claimed.json().data).toMatchObject({
      status: "in_progress",
      assignee: "claude/agent",
      branch: "feature/t1-login-validation",
    });

    const shown = await dg(f.cloneA, ["ticket", "show", "t1"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("assignee: claude/agent");
    expect(shown.out).toContain("## Acceptance criteria");

    const list = await dg(f.cloneA, ["ticket", "list"]);
    expect(list.out.split("\n")[0]).toMatch(/^id\s+status\s+priority\s+title/);
    expect(list.out).toContain("t1  in_progress  high      Login validation");
  });

  it("init は書き込みがあればコミットを案内し、2 人目の clone の書き込みのない init では「作業ツリーに残した」を出さない", async () => {
    const f = await fixture();
    const first = await dg(f.cloneA, ["init"]);
    expect(first.code).toBe(0);
    expect(first.err).toContain("Committed, pushed");
    const second = await dg(f.cloneB, ["init"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("from_remote");
    expect(second.err).not.toContain("Left in the working tree");
    expect(second.err).not.toContain("Committed");
    // deguboard worktree に未コミットの変更は残っていない
    const status = await git(path.join(f.cloneB, ".git", "deguboard"), ["status", "--porcelain"]);
    expect(status.stdout).toBe("");
    const json = await dg(f.cloneB, ["--json", "init"]);
    expect(json.json()).toMatchObject({ ok: true, data: { created: [] }, write: null });
  });

  it("claim の --without-branch は branch を記録せず、--branch と一緒なら使い方の誤り。update の --branch none で外す", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await dg(f.cloneA, ["ticket", "create", "A"]);
    await dg(f.cloneA, ["ticket", "create", "B"]);
    const both = await dg(f.cloneA, [
      "--json",
      "ticket",
      "claim",
      "1",
      "--without-branch",
      "--branch",
      "x",
    ]);
    expect(both.code).toBe(2);
    const claimed = await dg(f.cloneA, ["--json", "ticket", "claim", "1", "--without-branch"]);
    expect(claimed.code).toBe(0);
    expect(claimed.json().data.branch).toBeUndefined();
    await dg(f.cloneA, ["ticket", "claim", "2"]);
    const detached = await dg(f.cloneA, ["--json", "ticket", "update", "2", "--branch", "none"]);
    expect(detached.json().data.branch).toBeUndefined();
  });

  it("agent の claim は開いた Run の ID を人向けの出力の最後の行と --json の data.run に出し、--no-run では開かない（RN-5）", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await dg(f.cloneA, ["ticket", "create", "A"]);
    await dg(f.cloneA, ["ticket", "create", "B"]);
    const opened = await dg(f.cloneA, [
      "--actor",
      "agent",
      "ticket",
      "claim",
      "1",
      "--agent",
      "claude-code",
    ]);
    expect(opened.code).toBe(0);
    expect(opened.out).toContain("## Acceptance criteria");
    expect(opened.out.trimEnd().split("\n").at(-1)).toMatch(/^run: r\d{8}-\d{6}-[0-9a-f]{4}$/);
    // commander は --no-run を run: false にするが、入力では no_run: true になる
    const skipped = await dg(f.cloneA, [
      "--json",
      "--actor",
      "agent",
      "ticket",
      "claim",
      "2",
      "--no-run",
    ]);
    expect(skipped.code).toBe(0);
    expect(skipped.json().data.run).toBeNull();
    expect(skipped.json().warnings).toEqual([]);
    const runs = await dg(f.cloneA, ["--json", "run", "list", "--running"]);
    expect(runs.json().data.map((r: any) => [r.ticket, r.step, r.agent])).toEqual([
      ["t1", "implement", "claude-code"],
    ]);
  });

  it("拒否された遷移は終了コード 1 と error.code、入力の誤りと未知のコマンドは 2", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await writeStrictWorkflow(f.cloneA);
    await dg(f.cloneA, ["ticket", "create", "A", "--workflow", "strict"]);
    const rejected = await dg(f.cloneA, ["--json", "ticket", "move", "1", "done"]);
    expect(rejected.code).toBe(1);
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: "TRANSITION_REJECTED" } });
    const human = await dg(f.cloneA, ["ticket", "move", "1", "done"]);
    expect(human.code).toBe(1);
    expect(human.err).toContain(
      "Error: The Workflow does not allow this actor to move from todo to done",
    );

    expect((await dg(f.cloneA, ["ticket", "create", "x", "--priority", "nope"])).code).toBe(2);
    expect((await dg(f.cloneA, ["ticket", "nope"])).code).toBe(2);
    expect((await dg(f.cloneA, ["ticket", "show"])).code).toBe(2);
    expect((await dg(f.cloneA, ["ticket", "create", ""])).code).toBe(2);
  });

  it("ticket check の番号に数でない値を渡すと、その値と理由を stderr に出して終了コード 2", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await dg(f.cloneA, ["ticket", "create", "A", "--acceptance", "一つ目"]);
    const ran = await dg(f.cloneA, ["ticket", "check", "1", "all"]);
    expect(ran.code).toBe(2);
    expect(ran.err).toContain("'all'");
    expect(ran.err).toContain("Specify a number");
    expect((await dg(f.cloneA, ["ticket", "check", "1", "--all"])).code).toBe(0);
  });

  it("--json のとき commander が拒否した引数のエラーも { ok: false, error } で stdout に出し、平文は出さない", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    for (const argv of [
      ["--json", "metrics", "show", "--by", "nothing"],
      ["metrics", "show", "--by", "nothing", "--json"],
      ["--json", "ticket", "create", "x", "--priority", "nope"],
      ["--json", "ticket", "show"],
      ["--json", "nosuch"],
      ["--json", "--bogus"],
      ["--json", "ticket"],
      ["--json", "help", "nosuch"],
    ]) {
      const ran = await dg(f.cloneA, argv);
      expect(ran.code, argv.join(" ")).toBe(2);
      expect(ran.err, argv.join(" ")).toBe("");
      const json = ran.json();
      expect(json.ok).toBe(false);
      expect(json.error?.code).toBe("INVALID_INPUT");
      expect(json.error?.message).not.toBe("");
      expect(json.error?.message).not.toMatch(/^error: /);
    }
    const by = await dg(f.cloneA, ["--json", "metrics", "show", "--by", "nothing"]);
    expect(by.json().error?.message).toContain("'nothing'");
    // commander.help は文言がないので、コマンドを省いたときにも知らないコマンドにも合う文言を補う
    for (const argv of [
      ["--json", "ticket"],
      ["--json", "help", "nosuch"],
    ])
      expect((await dg(f.cloneA, argv)).json().error?.message).toBe(
        "Missing or unknown command (See usage with --help)",
      );
  });

  it("--json なしでは commander の引数のエラーを従来どおり stderr に平文で出し、stdout には出さない", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const ran = await dg(f.cloneA, ["metrics", "show", "--by", "nothing"]);
    expect(ran.code).toBe(2);
    expect(ran.out).toBe("");
    expect(ran.err).toContain("Error: option '--by <value>' argument 'nothing' is invalid");
    expect(ran.err).toContain("(See usage with --help)");
  });

  it("--json のとき commander 以外の例外も { ok: false, error } で stdout に出し、平文は出さない", async () => {
    const f = await fixture();
    for (const argv of [
      ["--json", "serve", "--port", "abc"],
      ["serve", "--port", "abc", "--json"],
    ]) {
      const ran = await dg(f.cloneA, argv);
      expect(ran.code, argv.join(" ")).toBe(1);
      expect(ran.err, argv.join(" ")).toBe("");
      const json = ran.json();
      expect(json.ok).toBe(false);
      expect(json.error?.code).toBe("INTERNAL");
      expect(json.error?.message).toBe("The port must be an integer from 0 to 65535");
    }
  });

  it("--json なしでは commander 以外の例外を従来どおり stderr に平文で出し、stdout には出さない", async () => {
    const f = await fixture();
    const ran = await dg(f.cloneA, ["serve", "--port", "abc"]);
    expect(ran.code).toBe(1);
    expect(ran.out).toBe("");
    expect(ran.err).toBe("Error: The port must be an integer from 0 to 65535");
  });

  it("初期化前は NOT_INITIALIZED で終了コード 1", async () => {
    const f = await fixture();
    const before = await dg(f.cloneB, ["--json", "ticket", "list"]);
    expect(before.code).toBe(1);
    expect(before.json().error?.code).toBe("NOT_INITIALIZED");
  });

  it("--actor agent では by: [human] の遷移が拒否され、環境変数 DEGUBOARD_ACTOR も効く", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await writeStrictWorkflow(f.cloneA);
    await dg(f.cloneA, ["ticket", "create", "A", "--workflow", "strict"]);
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

  it("plan create は --after・--scope・--approach・--tier を key=value で受け、段階の誤りは終了コード 2、開いた Plan と同じチケットは 1", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await dg(f.cloneA, ["ticket", "create", "A"]);
    await dg(f.cloneA, ["ticket", "create", "B"]);
    // 段階（tier）は light / standard / heavy だけ。それ以外は INVALID_INPUT で、Plan は作られない
    const invalid = await dg(f.cloneA, ["--json", "plan", "create", "t1", "--tier", "t1=huge"]);
    expect(invalid.code).toBe(2);
    expect(invalid.json()).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    const created = await dg(f.cloneA, [
      "--json",
      "plan",
      "create",
      "t1",
      "t2",
      "--after",
      "t2=t1",
      "--scope",
      "t1=API と CLI、画面なし",
      "--approach",
      "2=既存に倣う",
      "--tier",
      "t1=light",
    ]);
    expect(created.code).toBe(0);
    // key=value の値は、番号の鍵（2=）も含めて CLI の引数から読む
    expect(created.json().data).toMatchObject({
      id: "p1",
      tickets: ["t1", "t2"],
      after: { t2: ["t1"] },
      details: {
        t1: { scope: "API と CLI、画面なし", tier: "light" },
        t2: { approach: "既存に倣う" },
      },
    });
    // 同じチケットを別の開いた Plan に入れると終了コード 1 と REJECTED
    const dup = await dg(f.cloneA, ["--json", "plan", "create", "t1"]);
    expect(dup.code).toBe(1);
    expect(dup.json().error?.code).toBe("REJECTED");
  });

  it("run は --agent と --retry-reason（繰り返し、カンマでは割らない）を受け、二重の start は終了コード 1、不正な --result は 2、refresh は位置引数を受ける", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await dg(f.cloneA, ["ticket", "create", "A"]);
    const started = await dg(f.cloneA, [
      "--json",
      "run",
      "start",
      "t1",
      "implement",
      "--agent",
      "claude-code",
    ]);
    expect(started.code).toBe(0);
    const id = started.json().data.id as string;
    expect(started.json().data).toMatchObject({ ticket: "t1", step: "implement", result: null });
    const dup = await dg(f.cloneA, ["--json", "run", "start", "1", "implement", "--agent", "x"]);
    expect(dup.code).toBe(1);
    expect(dup.json().error?.code).toBe("ALREADY_EXISTS");
    const finished = await dg(f.cloneA, [
      "--json",
      "run",
      "finish",
      id,
      "--result",
      "interrupted",
      "--retry-reason",
      "検査が落ちた, 直して通した",
      "--retry-reason",
      "見直しの指摘",
    ]);
    expect(finished.code).toBe(0);
    // --retry-reason は繰り返すだけで、カンマでは割らない。回数を省けば理由の数
    expect(finished.json().data).toMatchObject({
      result: "interrupted",
      retries: 2,
      retry_reasons: ["検査が落ちた, 直して通した", "見直しの指摘"],
    });
    const bad = await dg(f.cloneA, ["--json", "run", "finish", id, "--result", "done"]);
    expect(bad.code).toBe(2);
    // run refresh は閉じた Run を位置引数で受け、--dry-run では書き換えずに差分を返す
    const refreshed = await dg(f.cloneA, ["--json", "run", "refresh", id, "--dry-run"]);
    expect(refreshed.code).toBe(0);
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

  it("ticket import は本文の項目の引用しない値に行末コメントがあると、INVALID_INPUT の JSON と終了コード 2 で起票しない", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const dataDir = path.join(f.cloneA, ".git", "deguboard");
    const before = (await git(dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    const file = path.join(f.root, "drafts.yaml");
    await writeFile(file, "- title: 設定 #/config の画面\n");
    const rejected = await dg(f.cloneA, ["--json", "ticket", "import", file]);
    expect(rejected.code).toBe(2);
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(rejected.json().error!.message).toContain("title of draft 1");
    expect((await git(dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before);
  });

  it("ticket import は下書きの YAML の構文エラーを INVALID_INPUT にする", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const file = path.join(f.root, "drafts.yaml");
    await writeFile(file, "- title: [閉じない\n");
    const rejected = await dg(f.cloneA, ["--json", "ticket", "import", file]);
    expect(rejected.code).toBe(2);
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("workflow set は --file の YAML と --template を受け、検証の誤りは終了コード 1、--file と --template の両方か無指定・読めないファイルは 2", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const bad = path.join(f.root, "bad.yaml");
    await writeFile(bad, "id: general\nname: G\nreconcile:\n  - { when: [nope], status: done }\n");
    const rejected = await dg(f.cloneA, ["--json", "workflow", "set", "general", "--file", bad]);
    expect(rejected.code).toBe(1);
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });

    const good = path.join(f.root, "good.yaml");
    await writeFile(good, "id: general\nname: Mine\nsteps:\n  - { id: implement }\n");
    expect((await dg(f.cloneA, ["workflow", "set", "general", "--file", good])).code).toBe(0);
    expect((await dg(f.cloneA, ["workflow", "set", "general", "--template", "general"])).code).toBe(
      0,
    );

    expect((await dg(f.cloneA, ["workflow", "set", "general"])).code).toBe(2);
    expect(
      (await dg(f.cloneA, ["workflow", "set", "general", "--file", good, "--template", "general"]))
        .code,
    ).toBe(2);
    expect(
      (await dg(f.cloneA, ["workflow", "set", "general", "--file", path.join(f.root, "none.yaml")]))
        .code,
    ).toBe(2);
  });

  it("workflow set の --file は JSON のファイルと、- で標準入力も読む", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const json = path.join(f.root, "wf.json");
    await writeFile(json, JSON.stringify({ id: "general", name: "JSON から" }));
    const fromJson = await dg(f.cloneA, ["--json", "workflow", "set", "general", "--file", json]);
    expect(fromJson.code).toBe(0);
    expect(fromJson.json().data.after.name).toBe("JSON から");

    const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from("id: general\nname: 標準入力から\n")]),
      configurable: true,
    });
    try {
      const fromStdin = await dg(f.cloneA, ["--json", "workflow", "set", "general", "--file", "-"]);
      expect(fromStdin.code).toBe(0);
      expect(fromStdin.json().data).toMatchObject({
        before: { name: "JSON から" },
        after: { name: "標準入力から" },
      });
    } finally {
      Object.defineProperty(process, "stdin", original);
    }
  });

  it("validate と lint は指摘があると終了コード 1 になり、validate は指摘のあるファイルのパスを出す。--acceptance の値はカンマで割らない", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    expect((await dg(f.cloneA, ["validate"])).code).toBe(0);
    await dg(f.cloneA, ["ticket", "create", "A", "--body", "本文だけ"]);
    await dg(f.cloneA, ["ticket", "create", "B", "--summary", "s"]);
    await dg(f.cloneA, ["ticket", "create", "C", "--summary", "s", "--acceptance", "a, b"]);
    const lint = await dg(f.cloneA, ["--json", "lint"]);
    expect(lint.code).toBe(1);
    const shown = await dg(f.cloneA, ["--json", "ticket", "show", "t3"]);
    expect(shown.json().data.body).toContain("- [ ] a, b\n");
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

  it("外せるオプションのヘルプは外し方を none の 1 つだけ示す", async () => {
    const f = await fixture();
    const help = (await dg(f.cloneA, ["ticket", "update", "--help"])).out;
    expect(help.match(/\(none to clear\)/g)).toHaveLength(6);
    expect(help).not.toContain("null");
  });

  it("隠しコマンド merge-driver は frontmatter を 3-way マージして ours に書き、同じフィールドの競合は終了コード 1 にする。--help には出ない", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deguboard-driver-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const md = (title: string, priority: string) =>
      `---\nid: t1\ntitle: ${title}\npriority: ${priority}\n---\n本文\n`;
    const [o, a, b] = ["o", "a", "b"].map((n) => path.join(dir, n)) as [string, string, string];
    await writeFile(o, md("題", "medium"));
    await writeFile(a, md("題", "high"));
    await writeFile(b, md("新しい題", "medium"));
    const merged = await dg(dir, ["merge-driver", o, a, b, "tickets/t1.md"]);
    expect(merged.code).toBe(0);
    expect(await readFile(a, "utf8")).toBe(md("新しい題", "high"));

    await writeFile(a, md("題", "high"));
    await writeFile(b, md("題", "low"));
    const clash = await dg(dir, ["merge-driver", o, a, b, "tickets/t1.md"]);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain("tickets/t1.md: both sides changed to different values: priority");
    expect(await readFile(a, "utf8")).toContain("<<<<<<< ours");

    expect((await dg(dir, ["--help"])).out).not.toContain("merge-driver");
  });
});
