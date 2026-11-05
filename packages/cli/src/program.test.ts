import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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

/** 制約を書いた Workflow（strict）を clone のデータディレクトリに置く */
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
    expect(shown.out).toContain("## 受け入れ条件");

    const list = await dg(f.cloneA, ["ticket", "list"]);
    expect(list.out.split("\n")[0]).toMatch(/^id\s+status\s+priority\s+title/);
    expect(list.out).toContain("t1  in_progress  high      Login validation");
  });

  it("init は書き込みがあればコミットを案内し、2 人目の clone の書き込みのない init では「作業ツリーに残した」を出さない", async () => {
    const f = await fixture();
    const first = await dg(f.cloneA, ["init"]);
    expect(first.code).toBe(0);
    expect(first.err).toContain("コミット済み・push 済み");
    const second = await dg(f.cloneB, ["init"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("from_remote");
    expect(second.err).not.toContain("作業ツリーに残した");
    expect(second.err).not.toContain("コミット済み");
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
      "エラー: todo から done への遷移は Workflow がこの主体に許していない",
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
    expect(ran.err).toContain("数値を指定する");
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
        "コマンドが足りないか、知らないコマンドを指定した（--help で使い方を見る）",
      );
  });

  it("--json なしでは commander の引数のエラーを従来どおり stderr に平文で出し、stdout には出さない", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const ran = await dg(f.cloneA, ["metrics", "show", "--by", "nothing"]);
    expect(ran.code).toBe(2);
    expect(ran.out).toBe("");
    expect(ran.err).toContain("エラー: option '--by <value>' argument 'nothing' is invalid");
    expect(ran.err).toContain("（--help で使い方を見る）");
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
      expect(json.error?.message).toBe("ポートは 0〜65535 の整数");
    }
  });

  it("--json なしでは commander 以外の例外を従来どおり stderr に平文で出し、stdout には出さない", async () => {
    const f = await fixture();
    const ran = await dg(f.cloneA, ["serve", "--port", "abc"]);
    expect(ran.code).toBe(1);
    expect(ran.out).toBe("");
    expect(ran.err).toBe("エラー: ポートは 0〜65535 の整数");
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

  it("plan create / approve / show / close がコアの定義を写し、--after・--scope・--tier を key=value で受ける", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await dg(f.cloneA, ["ticket", "create", "A"]);
    await dg(f.cloneA, ["ticket", "create", "B"]);
    // 段階（tier）は light / standard / heavy だけ。それ以外は INVALID_INPUT で、Plan は作られない
    const invalid = await dg(f.cloneA, ["--json", "plan", "create", "t1", "--tier", "t1=huge"]);
    expect(invalid.code).toBe(2);
    expect(invalid.json()).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(invalid.json().error?.message).toContain("plan.create");
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
    expect(created.json().data).toMatchObject({
      id: "p1",
      tickets: ["t1", "t2"],
      after: { t2: ["t1"] },
      pending_approval: true,
      details: {
        t1: { scope: "API と CLI、画面なし", tier: "light" },
        t2: { approach: "既存に倣う" },
      },
    });
    // 同じチケットを別の開いた Plan に入れると終了コード 1 と REJECTED
    const dup = await dg(f.cloneA, ["--json", "plan", "create", "t1"]);
    expect(dup.code).toBe(1);
    expect(dup.json().error?.code).toBe("REJECTED");
    const approved = await dg(f.cloneA, ["--json", "--actor", "agent", "plan", "approve", "p1"]);
    expect(approved.json().data).toMatchObject({ pending_approval: false });
    expect(approved.json().data.approved_by).toMatch(/\/agent$/);
    const shown = await dg(f.cloneA, ["plan", "show", "1"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("progress.done: 0");
    const closed = await dg(f.cloneA, ["--json", "plan", "close", "p1"]);
    expect(closed.json().data.closed_at).toBeDefined();
    expect(closed.json().warnings).toEqual(["t1, t2 を残したまま閉じた"]);
  });

  it("run start / list / finish / refresh がコアの定義を写し、二重の start は 1、止まった Run は interrupted で閉じる", async () => {
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
    const running = await dg(f.cloneA, ["--json", "run", "list", "--running"]);
    expect(running.json().data.map((r: { id: string }) => r.id)).toEqual([id]);
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
    expect((await dg(f.cloneA, ["--json", "run", "list", "--running"])).json().data).toEqual([]);
    const bad = await dg(f.cloneA, ["--json", "run", "finish", id, "--result", "done"]);
    expect(bad.code).toBe(2);
    // run refresh は閉じた Run を位置引数で受け、--dry-run では書き換えずに差分を返す
    const refreshed = await dg(f.cloneA, ["--json", "run", "refresh", id, "--dry-run"]);
    expect(refreshed.code).toBe(0);
    expect(refreshed.json().data).toMatchObject([{ id, changes: [], updated: false }]);
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

  it("ticket import は本文の項目の引用しない値に行末コメントがあると、ファイルでも標準入力でも INVALID_INPUT で起票しない", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const dataDir = path.join(f.cloneA, ".git", "deguboard");
    const head = async () => (await git(dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    const before = await head();
    const cases: Array<[string, string]> = [
      ["- title: 設定 #/config の画面\n", "1 件目の title"],
      ["- title: A\n- title: B\n  summary: 戻る #/board へ\n", "2 件目の summary"],
      [
        "- title: A\n  acceptance:\n    - 条件 1\n    - 歯車で #/config # 開く\n",
        "1 件目の acceptance",
      ],
      ["drafts:\n  - title: A\n    body: 本文 #/config\n", "1 件目の body"],
      ["- title: A\n  body: 複数行の\n    最後の行 #/config\n", "1 件目の body"],
    ];
    for (const [yaml, field] of cases) {
      const file = path.join(f.root, "drafts.yaml");
      await writeFile(file, yaml);
      const rejected = await dg(f.cloneA, ["--json", "ticket", "import", file]);
      expect(rejected.code).toBe(2);
      expect(rejected.json()).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
      expect(rejected.json().error!.message).toContain(field);
    }

    const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from("- title: 設定 #/config の画面\n")]),
      configurable: true,
    });
    try {
      const fromStdin = await dg(f.cloneA, ["--json", "ticket", "import", "-"]);
      expect(fromStdin.code).toBe(2);
      expect(fromStdin.json().error).toMatchObject({ code: "INVALID_INPUT" });
      expect(fromStdin.json().error!.message).toContain("1 件目の title");
    } finally {
      Object.defineProperty(process, "stdin", original);
    }
    expect(await head()).toBe(before);
  });

  it("ticket import はほかの項目の行末コメント・行だけのコメント・引用した値・body の | の中の # を本文として残す", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const file = path.join(f.root, "drafts.yaml");
    await writeFile(
      file,
      [
        "# 行だけのコメント",
        "- key: a # 仮キー",
        '  title: "設定 #/config の画面" # 引用の後ろ',
        "  priority: high # 優先度",
        "  # 項目の間のコメント",
        "  acceptance: ['歯車で #/config を開く', \"戻る #/board\"] # 条件",
        "- key: b",
        "  title: 本文を書く",
        "  depends_on: [a] # 依存",
        "  body: | # 見出しの後ろ",
        "    ## 概要",
        "",
        "    #/config を開く # 中の #",
        "",
      ].join("\n"),
    );
    const imported = await dg(f.cloneA, ["--json", "ticket", "import", file]);
    expect(imported.code).toBe(0);
    const show = async (id: string) =>
      (await dg(f.cloneA, ["--json", "ticket", "show", id])).json().data;
    const [a, b] = await Promise.all(imported.json().data.map((t: { id: string }) => show(t.id)));
    expect(a).toMatchObject({ title: "設定 #/config の画面", priority: "high" });
    expect(a.body).toContain("- [ ] 歯車で #/config を開く");
    expect(a.body).toContain("- [ ] 戻る #/board");
    expect(b).toMatchObject({ title: "本文を書く", depends_on: [a.id] });
    expect(b.body).toContain("#/config を開く # 中の #");
  });

  it("ticket import は引用しない値の次の行の、深く字下げした行だけのコメントを拒否しない", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const file = path.join(f.root, "drafts.yaml");
    for (const yaml of ["- title: A\n  body: x\n    # c\n", "- title: A\n      # c\n  body: y\n"]) {
      await writeFile(file, yaml);
      const imported = await dg(f.cloneA, ["--json", "ticket", "import", file]);
      expect(imported.code).toBe(0);
      expect(imported.json().data).toMatchObject([{ title: "A" }]);
    }
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

  it("workflow set は --file の YAML を検証して書き、誤りは何も書かずに 1、--file と --template の両方か無指定は 2", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const dataDir = path.join(f.cloneA, ".git", "deguboard");
    const before = await readFile(path.join(dataDir, "workflows/general.yaml"), "utf8");
    const bad = path.join(f.root, "bad.yaml");
    await writeFile(bad, "id: general\nname: G\nreconcile:\n  - { when: [nope], status: done }\n");
    const rejected = await dg(f.cloneA, ["--json", "workflow", "set", "general", "--file", bad]);
    expect(rejected.code).toBe(1);
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect((rejected.json().error as { detail?: string }).detail).toContain("未知の条件 nope");
    expect(await readFile(path.join(dataDir, "workflows/general.yaml"), "utf8")).toBe(before);

    const good = path.join(f.root, "good.yaml");
    await writeFile(good, "id: general\nname: Mine\nsteps:\n  - { id: implement }\n");
    const set = await dg(f.cloneA, ["--json", "workflow", "set", "general", "--file", good]);
    expect(set.code).toBe(0);
    expect(set.json().data).toMatchObject({
      created: false,
      before: { name: "General" },
      after: { name: "Mine", steps: [{ id: "implement" }] },
    });
    const shown = await dg(f.cloneA, ["--json", "workflow", "show", "general"]);
    expect(shown.json().data.definition.name).toBe("Mine");

    const back = await dg(f.cloneA, ["workflow", "set", "general", "--template", "general"]);
    expect(back.code).toBe(0);
    expect(back.out).toContain("after.name: General");

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

  it("外せるオプションのヘルプは外し方を none の 1 つだけ示す", async () => {
    const f = await fixture();
    const help = (await dg(f.cloneA, ["ticket", "update", "--help"])).out;
    expect(help.match(/（none で外す）/g)).toHaveLength(6);
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
    expect(clash.err).toContain("tickets/t1.md: 両側で違う値に変えた: priority");
    expect(await readFile(a, "utf8")).toContain("<<<<<<< ours");

    expect((await dg(dir, ["--help"])).out).not.toContain("merge-driver");
  });
});
