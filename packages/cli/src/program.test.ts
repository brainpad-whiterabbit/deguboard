import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { commands, setBundleLayout } from "@deguboard/core";
import { createFixture, git, type Fixture } from "../../core/test/helpers/git-fixture.js";
import { selfCommand, selfMergeDriver } from "./hooks.js";
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
  it("init --data-remote に URL を渡すと、リモートを足してデータをそこへ送り、別の clone は同じ URL で取り込む（t904）", async () => {
    const f = await fixture();
    const dataDir = path.join(f.root, "data.git");
    await git(f.root, ["init", "--quiet", "--bare", dataDir]);
    const init = await dg(f.cloneA, ["--json", "init", "--data-remote", dataDir]);
    expect(init.json()).toMatchObject({
      ok: true,
      data: { worktree: "orphan", remote: "origin", data_remote: "deguboard-data" },
      write: { pushed: true },
    });
    expect((await git(f.cloneA, ["remote", "get-url", "deguboard-data"])).stdout.trim()).toBe(
      dataDir,
    );
    expect((await dg(f.cloneA, ["--json", "ticket", "create", "A"])).json().write).toMatchObject({
      pushed: true,
    });
    // データはデータのリポジトリにだけ入る
    const heads = async (bare: string) =>
      (await git(bare, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).stdout
        .trim()
        .split("\n");
    expect(await heads(dataDir)).toEqual(["deguboard"]);
    expect(await heads(f.remoteDir)).toEqual(["main"]);

    const joined = await dg(f.cloneB, ["--json", "init", "--data-remote", dataDir]);
    expect(joined.json()).toMatchObject({
      ok: true,
      data: { worktree: "from_remote", data_remote: "deguboard-data", created: [] },
    });
    const listed = await dg(f.cloneB, ["--json", "ticket", "list"]);
    expect(listed.json().data.map((t: { id: string }) => t.id)).toEqual(["t1"]);
    // ない名前は、同期なしで始めずに使い方を示して失敗する
    const g = await fixture();
    const missing = await dg(g.cloneA, ["--json", "init", "--data-remote", "nowhere"]);
    expect(missing.code).toBe(1);
    expect(missing.json().error).toMatchObject({ code: "DATA_REMOTE_MISSING" });
  });

  it("init --data-branch は、データをそのブランチに置いて config に書き、/ を含む名前は理由と勧める名前を出して拒む（t905）", async () => {
    const f = await fixture();
    const dataDir = path.join(f.root, "data.git");
    await git(f.root, ["init", "--quiet", "--bare", dataDir]);
    const rejected = await dg(f.cloneA, [
      "--json",
      "init",
      "--data-remote",
      dataDir,
      "--data-branch",
      "deguboard/webapp",
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.json().error).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/contains "\/".*such as deguboard-webapp/),
    });
    const init = await dg(f.cloneA, [
      "--json",
      "init",
      "--data-remote",
      dataDir,
      "--data-branch",
      "deguboard-webapp",
    ]);
    expect(init.json()).toMatchObject({
      ok: true,
      data: { worktree: "orphan", data_branch: "deguboard-webapp" },
      write: { pushed: true },
    });
    const shown = await dg(f.cloneA, ["--json", "config", "show"]);
    expect(shown.json().data.git).toMatchObject({ data_branch: "deguboard-webapp" });
    const heads = (await git(dataDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
      .stdout;
    expect(heads.trim()).toBe("deguboard-webapp");
  });

  it("init → ticket create → claim → show が通り、--json の形が ok / data / warnings / write になる", async () => {
    const f = await fixture();
    const init = await dg(f.cloneA, ["--json", "init"]);
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
      branch: "t1-login-validation",
    });

    const shown = await dg(f.cloneA, ["ticket", "show", "t1"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("assignee: claude/agent");
    expect(shown.out).toContain("## Acceptance criteria");

    const list = await dg(f.cloneA, ["ticket", "list"]);
    expect(list.out.split("\n")[0]).toMatch(/^id\s+status\s+priority\s+title/);
    expect(list.out).toContain("t1  in_progress  high      Login validation");
  });

  it("init は、remote に届かなければボードを作らずに止まり、--new-board なら手元だけで作る。届けばボードの有無で作るか取り込む（t1005）", async () => {
    const f = await fixture();
    // 届いてボードがない：orphan を作って送る
    const first = await dg(f.cloneA, ["--json", "init"]);
    expect(first.json()).toMatchObject({ ok: true, data: { worktree: "orphan" } });
    // 届いてボードがある：取り込む
    const joined = await dg(f.cloneB, ["--json", "init"]);
    expect(joined.json()).toMatchObject({ ok: true, data: { worktree: "from_remote" } });

    // 届かない：ボードを作らずに失敗し、やり直すか --new-board を付けるかを案内する
    const g = await fixture();
    await git(g.cloneA, ["remote", "set-url", "origin", path.join(g.root, "nonexistent.git")]);
    const stopped = await dg(g.cloneA, ["--json", "init"]);
    expect(stopped.code).toBe(1);
    expect(stopped.json().error).toMatchObject({
      code: "GIT_ERROR",
      message: expect.stringMatching(/run dg init again.*dg init --new-board.*separate board/),
    });
    const branches = await git(g.cloneA, ["branch", "--list", "deguboard"]);
    expect(branches.stdout).toBe("");
    const worktrees = await git(g.cloneA, ["worktree", "list", "--porcelain"]);
    expect(worktrees.stdout).not.toContain(path.join(".git", "deguboard"));

    // --new-board：届かなくても手元だけで新しいボードを作る
    const created = await dg(g.cloneA, ["--json", "init", "--new-board"]);
    expect(created.json()).toMatchObject({ ok: true, data: { worktree: "orphan" } });
    const listed = await dg(g.cloneA, ["--json", "ticket", "list"]);
    expect(listed.json()).toMatchObject({ ok: true, data: [] });
  });

  it("init --help は --new-board がチームのボードと別のボードになりうることを示す（t1005）", async () => {
    const f = await fixture();
    const help = await dg(f.cloneA, ["init", "--help"]);
    expect(help.out.replace(/\s+/g, " ")).toMatch(/--new-board .*separate board/);
  });

  it("Git リポジトリの外で呼ぶと、git init でリポジトリを作ってやり直す案内を出す（t1005）", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "deguboard-outside-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const ran = await dg(outside, ["--json", "ticket", "list"]);
    expect(ran.code).toBe(1);
    expect(ran.json().error).toMatchObject({
      code: "GIT_ERROR",
      message: expect.stringMatching(/not inside a Git repository.*git init.*run dg again/),
    });
  });

  it("setup check は、リポジトリの外でも init の前でも、導入の項目を上から順に core の判定のまま返す（t1006）", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "deguboard-home-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "deguboard-outside-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const env = { HOME: home };
    const ids = ["git", "repository", "board", "skills_hooks", "gitignore"];

    // リポジトリの外：失敗にせず、満たさない項目と待ちの項目を返す
    const out = await dg(outside, ["--json", "setup", "check"], env);
    expect(out.code).toBe(0);
    expect(out.json()).toMatchObject({ ok: true, data: { ready: false }, warnings: [] });
    const items = out.json().data.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i["id"])).toEqual(ids);
    expect(items.map((i) => i["status"])).toEqual(["ok", "unmet", "pending", "pending", "pending"]);
    for (const item of items)
      expect(Object.keys(item)).toEqual(
        expect.arrayContaining(["id", "label", "level", "status", "message", "fix"]),
      );
    expect(items[1]).toMatchObject({ level: "required", fix: ["git init"] });

    // init の前：ボードの項目が remote の状態を返し、--remote と --data-branch は確かめる先と直すコマンドに写る
    const f = await fixture();
    const before = await dg(f.cloneA, ["--json", "setup", "check"], env);
    expect(before.json().data.items[2]).toMatchObject({
      status: "unmet",
      state: "remote_no_board",
      fix: ["dg init"],
    });
    const branch = await dg(
      f.cloneA,
      ["--json", "setup", "check", "--data-branch", "deguboard-web"],
      env,
    );
    expect(branch.json().data.items[2]).toMatchObject({
      fix: ["dg init --data-branch deguboard-web"],
    });
    const remote = await dg(f.cloneA, ["--json", "setup", "check", "--remote", "upstream"], env);
    expect(remote.json().data.items[2]).toMatchObject({
      state: "no_remote",
      fix: ["dg init --remote upstream"],
    });

    // init の後：必須を満たし、推奨の項目は満たさなくても終了コードは 0。人向けの出力は項目ごとの行と直すコマンド
    await dg(f.cloneA, ["--json", "init"], env);
    const after = await dg(f.cloneA, ["setup", "check"], env);
    expect(after.code).toBe(0);
    const lines = after.out.split("\n");
    expect(lines[2]).toMatch(/^ok {7}Board \(required\): The board is set up/);
    expect(lines[3]).toMatch(/^unmet {4}Skills and hooks \(recommended\): .*dg hooks check$/);
    expect(lines.slice(4, 6)).toEqual([
      "         fix: dg hooks install",
      "         fix: dg skill install",
    ]);
    expect((await dg(f.cloneA, ["--json", "setup", "check"], env)).json().data.ready).toBe(true);
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

  it("ticket update の --gate low を --gate none で外すと、ticket show に gate が出なくなる（t663）", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await dg(f.cloneA, ["ticket", "create", "A"]);
    const set = await dg(f.cloneA, ["ticket", "update", "1", "--gate", "low"]);
    expect(set.code).toBe(0);
    expect((await dg(f.cloneA, ["ticket", "show", "t1"])).out).toContain("gate: low");
    const cleared = await dg(f.cloneA, ["--json", "ticket", "update", "1", "--gate", "none"]);
    expect(cleared.json().data.gate).toBeUndefined();
    expect((await dg(f.cloneA, ["ticket", "show", "t1"])).out).not.toContain("gate");
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

  it("run recent の --json は、チケットごとの { ticket, total, runs } を返し、実行中の Run の要約にだけ waiting_since・settling_since が入る", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await dg(f.cloneA, ["ticket", "create", "A"]);
    await dg(f.cloneA, ["ticket", "create", "B"]);
    const startRun = async (ticket: string) =>
      (
        await dg(f.cloneA, ["--json", "run", "start", ticket, "implement", "--agent", "codex"])
      ).json().data;
    const closed = await startRun("1");
    const finished = await dg(f.cloneA, [
      "--json",
      "run",
      "finish",
      closed.id,
      "--result",
      "failure",
      "--error",
      "tests failed",
    ]);
    const running = await startRun("2");
    const recent = await dg(f.cloneA, ["--json", "run", "recent"]);
    expect(recent.code).toBe(0);
    expect(recent.json()).toEqual({
      ok: true,
      data: [
        {
          ticket: "t1",
          total: 1,
          running: false,
          runs: [
            {
              id: closed.id,
              step: "implement",
              result: "failure",
              started_at: closed.started_at,
              finished_at: finished.json().data.finished_at,
              review: null,
              retries: 0,
              error: "tests failed",
              // 時間は run list と同じ（codex の Run は待ちを数えないので作業時間は null）
              waited_seconds: null,
              duration_seconds:
                (Date.parse(finished.json().data.finished_at) - Date.parse(closed.started_at)) /
                1000,
              active_seconds: null,
              running: false,
            },
          ],
        },
        {
          ticket: "t2",
          total: 1,
          running: true,
          runs: [
            {
              id: running.id,
              step: "implement",
              result: null,
              started_at: running.started_at,
              finished_at: null,
              review: null,
              retries: 0,
              error: null,
              waited_seconds: null,
              duration_seconds: null,
              active_seconds: null,
              running: true,
              waiting_since: null,
              settling_since: null,
            },
          ],
        },
      ],
      warnings: [],
      write: null,
    });
    expect(finished.json().data.finished_at).toEqual(expect.any(String));
    // 絞り込みは run list と同じ（今ない Iteration は空）
    expect(
      (await dg(f.cloneA, ["--json", "run", "recent", "--iteration", "s9"])).json().data,
    ).toEqual([]);
  });

  it("拒否された遷移は終了コード 1 と error.code、入力の誤りと未知のコマンドは 2", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    // 既定の Workflow：done へ進むには pr_merged が要る
    await dg(f.cloneA, ["ticket", "create", "A"]);
    const rejected = await dg(f.cloneA, ["--json", "ticket", "move", "1", "done"]);
    expect(rejected.code).toBe(1);
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: "TRANSITION_REJECTED" } });
    const human = await dg(f.cloneA, ["ticket", "move", "1", "done"]);
    expect(human.code).toBe(1);
    expect(human.err).toContain(
      "Error: The conditions for moving t1 from todo to done are not met: pr_merged",
    );
    // 人は --override "理由" で越え、エージェントの --override は拒否される
    const byAgent = await dg(f.cloneA, [
      "--json",
      "--actor",
      "agent",
      "ticket",
      "move",
      "1",
      "review",
      "--override",
      "急ぎ",
    ]);
    expect(byAgent.json().error?.code).toBe("TRANSITION_REJECTED");
    const forced = await dg(f.cloneA, [
      "--json",
      "ticket",
      "move",
      "1",
      "done",
      "--override",
      "PR なし",
    ]);
    expect(forced.json().data).toMatchObject({ status: "done" });

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

  it("--actor agent では人の承認が要る動き（既定の exceptions.abandon は always_ask）が承認なしでは拒否され、環境変数 DEGUBOARD_ACTOR も効く", async () => {
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
      "--goal",
      "読む",
    ]);
    expect(created.code).toBe(0);
    expect(created.json().data).toMatchObject({ id: "s1", goal: "読む" });
    const list = await dg(f.cloneA, ["iteration", "list"]);
    expect(list.out).toContain("s1");
  });

  it("iteration list の人向けの出力は started_at の列を出し、start・end の列は出さない（実績の期間だけ）", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    await dg(f.cloneA, ["iteration", "create", "Sprint 1"]);
    expect((await dg(f.cloneA, ["iteration", "start", "s1"])).code).toBe(0);
    const list = await dg(f.cloneA, ["iteration", "list"]);
    expect(list.code).toBe(0);
    // 列は空白で区切った見出しの語で確かめる（started_at は start で始まるので部分一致は使わない）
    const columns = list.out.split("\n")[0]!.trim().split(/\s+/);
    expect(columns).toContain("started_at");
    expect(columns).not.toContain("start");
    expect(columns).not.toContain("end");
  });

  it("ask --help は --place と historyRow の説明と、設定の項目を渡す --key の説明を出す", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const help = await dg(f.cloneA, ["ask", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("--place");
    expect(help.out).toContain("historyRow");
    expect(help.out).toContain("retro");
    expect(help.out).toContain("--key");
    expect(help.out).toContain("retro.perspectives.<id>");
  });

  it("Iteration は予定の期間を持たないので、create・update のヘルプに --start・--end がなく、渡すと使い方の誤り", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    for (const op of ["create", "update"]) {
      const help = await dg(f.cloneA, ["iteration", op, "--help"]);
      expect(help.out).not.toMatch(/--start|--end/);
    }
    const rejected = await dg(f.cloneA, ["iteration", "create", "Sprint 1", "--end", "2026-11-14"]);
    expect(rejected.code).toBe(2);
    expect((await dg(f.cloneA, ["--json", "iteration", "list"])).json().data).toEqual([]);
  });

  it("Project はやめたので、dg project・--project・default_project はなく、ヘルプにも出ず、渡すと使い方の誤り", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    // 群の一覧に project がない
    const top = await dg(f.cloneA, ["--help"]);
    expect(top.out).not.toMatch(/^\s+project\b/m);
    expect((await dg(f.cloneA, ["--json", "project", "list"])).code).toBe(2);
    // どのコマンドのヘルプにも --project がなく、Project の語も出ない
    for (const argv of [
      ["ticket", "create"],
      ["ticket", "list"],
      ["ticket", "update"],
      ["ticket", "claim"],
      ["epic", "create"],
      ["epic", "list"],
      ["epic", "add"],
      ["iteration", "create"],
      ["iteration", "list"],
      ["iteration", "start"],
      ["iteration", "reopen"],
      ["plan", "create"],
      ["plan", "list"],
      ["run", "list"],
      ["run", "recent"],
      ["metrics", "show"],
      ["lint"],
      ["init"],
    ]) {
      const help = await dg(f.cloneA, [...argv, "--help"]);
      expect(help.code, argv.join(" ")).toBe(0);
      expect(help.out, argv.join(" ")).not.toMatch(/--project|\bProjects?\b/);
    }
    for (const argv of [
      ["ticket", "create", "A", "--project", "default"],
      ["ticket", "list", "--project", "default"],
      ["iteration", "create", "S", "--project", "default"],
      ["metrics", "show", "--by", "project"],
    ])
      expect((await dg(f.cloneA, ["--json", ...argv])).code, argv.join(" ")).toBe(2);
    // config の項目にもない（代わりだった default_workflow もやめた）
    const fields = (await dg(f.cloneA, ["--json", "config", "show", "--fields"])).json().data;
    const keys = (fields.fields as { key: string }[]).map((x) => x.key);
    expect(keys).not.toContain("default_workflow");
    expect(keys).not.toContain("default_project");
    expect(fields.config).not.toHaveProperty("default_project");
    expect(fields.config).not.toHaveProperty("default_workflow");
    // 作ったチケットは project を持たない
    const created = (await dg(f.cloneA, ["--json", "ticket", "create", "A"])).json().data;
    expect(created).not.toHaveProperty("project");
    const shown = await dg(f.cloneA, ["ticket", "show", "t1"]);
    expect(shown.out).not.toMatch(/^project:/m);
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
    expect(log).toBe("Import 2 tickets: t1, t2");
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

  it("workflow set は --file の YAML を受け、検証の誤りは終了コード 1、--file なし・読めないファイル・やめた --template と Workflow の ID は 2。workflow list と init --template はない", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const bad = path.join(f.root, "bad.yaml");
    await writeFile(bad, "boundaries:\n  - { from: review, to: done, requires: [nope] }\n");
    const rejected = await dg(f.cloneA, ["--json", "workflow", "set", "--file", bad]);
    expect(rejected.code).toBe(1);
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });

    const good = path.join(f.root, "good.yaml");
    await writeFile(good, "states:\n  review: { label: Mine }\n");
    expect((await dg(f.cloneA, ["workflow", "set", "--file", good])).code).toBe(0);
    const shown = await dg(f.cloneA, ["--json", "workflow", "show"]);
    expect(shown.json().data).toMatchObject({ path: "workflow.yaml", labels: { review: "Mine" } });
    expect((await dg(f.cloneA, ["--json", "workflow", "validate"])).json().data).toMatchObject({
      ok: true,
      issues: [],
    });

    expect((await dg(f.cloneA, ["workflow", "set"])).code).toBe(2);
    expect((await dg(f.cloneA, ["workflow", "set", "--template", "general"])).code).toBe(2);
    expect((await dg(f.cloneA, ["workflow", "set", "general", "--file", good])).code).toBe(2);
    expect(
      (await dg(f.cloneA, ["workflow", "set", "--file", path.join(f.root, "none.yaml")])).code,
    ).toBe(2);
    expect((await dg(f.cloneA, ["workflow", "list"])).code).toBe(2);
    expect((await dg(f.cloneA, ["init", "--template", "general"])).code).toBe(2);
  });

  it("workflow set の --file は JSON のファイルと、- で標準入力も読む", async () => {
    const f = await fixture();
    await dg(f.cloneA, ["init"]);
    const json = path.join(f.root, "wf.json");
    await writeFile(json, JSON.stringify({ states: { todo: { label: "JSON から" } } }));
    const fromJson = await dg(f.cloneA, ["--json", "workflow", "set", "--file", json]);
    expect(fromJson.code).toBe(0);
    expect(fromJson.json().data.after.states.todo.label).toBe("JSON から");

    const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from("states:\n  todo: { label: 標準入力から }\n")]),
      configurable: true,
    });
    try {
      const fromStdin = await dg(f.cloneA, ["--json", "workflow", "set", "--file", "-"]);
      expect(fromStdin.code).toBe(0);
      expect(fromStdin.json().data).toMatchObject({
        before: { states: { todo: { label: "JSON から" } } },
        after: { states: { todo: { label: "標準入力から" } } },
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
    // iteration・epic・pr・branch・assignee・gate
    expect(help.match(/\(none to clear\)/g)).toHaveLength(6);
    expect(help).not.toContain("null");
  });

  it("ticket claim と ticket update のヘルプは、作業ブランチの名前の形（<id>-<値>）と値に使える文字を案内する（ST-3・t966）", async () => {
    const f = await fixture();
    for (const op of ["claim", "update"]) {
      // 折り返しの位置によらず読めるように、空白を 1 つに詰めて比べる
      const help = (await dg(f.cloneA, ["ticket", op, "--help"])).out.replace(/\s+/g, " ");
      expect(help, op).toContain("The name is recorded as <id>-<value> (t12-fix-login)");
      expect(help, op).toContain(
        "short English words as the value, in lowercase letters, digits, and hyphens, up to 50 characters",
      );
      expect(help, op).toContain("A value that starts with another ticket's ID is rejected");
    }
    const claim = (await dg(f.cloneA, ["ticket", "claim", "--help"])).out.replace(/\s+/g, " ");
    expect(claim).toContain(
      "<id>-<slug of the title> if the title is ASCII only, and <id> otherwise",
    );
    expect(claim).not.toContain("feature/");
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

describe("束ねた dg.mjs（VS Code 拡張に同梱する CLI）", () => {
  afterEach(() => setBundleLayout(undefined));

  it("版とマージドライバの自分のパスは、入口が置いた配置から引く", async () => {
    const entry = path.join(os.tmpdir(), "ext", "dist", "cli", "dg.mjs");
    setBundleLayout({ entry, guideDir: path.dirname(path.dirname(entry)), version: "9.8.7" });
    expect((await dg(os.tmpdir(), ["--version"])).out).toBe("9.8.7");
    expect(selfMergeDriver()).toEqual([process.execPath, entry, "merge-driver"]);
  });

  it("配置がなければ、マージドライバは bin/dg.js を指す", () => {
    expect(selfMergeDriver()[1]).toMatch(/[/\\]bin[/\\]dg\.js$/);
  });

  it("マージドライバはフックと同じ selfCommand に merge-driver を足した並びで、起動ファイルのリンクは実パスに辿る", async () => {
    expect(selfMergeDriver({})).toEqual([...selfCommand(), "merge-driver"]);

    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-self-")));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const entry = path.join(dir, "dg.mjs");
    const link = path.join(dir, "link.mjs");
    await writeFile(entry, "");
    await symlink(entry, link);
    setBundleLayout({ entry: link, guideDir: dir, version: "9.8.7" });
    expect(selfCommand()).toEqual([process.execPath, entry]);
    expect(selfMergeDriver({})).toEqual([process.execPath, entry, "merge-driver"]);
  });

  it("起動ファイル経由（DEGUBOARD_LAUNCHER があるとき）のマージドライバは、node と dg.mjs の代わりに起動ファイルを指す（t735）", async () => {
    const entry = path.join(os.tmpdir(), "ext", "dist", "cli", "dg.mjs");
    setBundleLayout({ entry, guideDir: path.dirname(path.dirname(entry)), version: "9.8.7" });
    const launcher = "/home/u/.local/share/deguboard/dg";
    expect(selfMergeDriver({ DEGUBOARD_LAUNCHER: launcher })).toEqual([launcher, "merge-driver"]);
    expect(selfMergeDriver({})).toEqual([process.execPath, entry, "merge-driver"]);
  });

  it("束ねていない dg（clone）は、子から引き継いだ DEGUBOARD_LAUNCHER を読まず、node と bin/dg.js を指す（t735）", () => {
    const driver = selfMergeDriver({ DEGUBOARD_LAUNCHER: "/home/u/.local/share/deguboard/dg" });
    expect(driver).toEqual([process.execPath, expect.any(String), "merge-driver"]);
    expect(driver[1]).toMatch(/[/\\]bin[/\\]dg\.js$/);
  });

  it("init と sync が登録するマージドライバは、起動ファイル経由なら起動ファイルを書き、そうでなければ node と dg.js を書く（t735）", async () => {
    const f = await fixture();
    const launcher = path.join(os.tmpdir(), "deguboard-launcher-test", "dg");
    const entry = path.join(os.tmpdir(), "ext", "dist", "cli", "dg.mjs");
    setBundleLayout({ entry, guideDir: path.dirname(path.dirname(entry)), version: "9.8.7" });
    expect((await dg(f.cloneA, ["init"], { DEGUBOARD_LAUNCHER: launcher })).code).toBe(0);
    const viaLauncher = await git(f.cloneA, ["config", "--get", "merge.deguboard.driver"]);
    expect(viaLauncher.stdout.trim()).toMatch(
      new RegExp(`^'?${launcher.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}'? merge-driver `),
    );

    // clone の dg（束ねていない）は、同じ環境変数があっても node と dg.js を書く
    setBundleLayout(undefined);
    expect((await dg(f.cloneB, ["init"], { DEGUBOARD_LAUNCHER: launcher })).code).toBe(0);
    const direct = await git(f.cloneB, ["config", "--get", "merge.deguboard.driver"]);
    expect(direct.stdout.trim()).toContain(process.execPath);
    expect(direct.stdout.trim()).toMatch(/bin\/dg\.js'? merge-driver /);
  });
});
