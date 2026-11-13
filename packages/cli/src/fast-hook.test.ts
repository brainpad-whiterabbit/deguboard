import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hookArgv, hooksOf, resolveRepoPaths } from "@deguboard/core";
import { fastHookEventOf } from "@deguboard/core/fast-hook";
import { createFixture, createFixtureFrom, git } from "../../core/test/helpers/git-fixture.js";
import { tryFastHook } from "./fast-hook.js";
import { installHooks } from "./hooks.js";
import { run } from "./program.js";
import {
  DEFAULT_HOOK_AGENT,
  DEFAULT_STOP_EVENT,
  DEFAULT_TOOL_EVENT,
  defaultHookSupport,
} from "../../core/src/agents/fast-hooks.js";

const isFastHookArgv = (argv: readonly string[]) => fastHookEventOf(argv) !== undefined;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const ARGV = hookArgv("claude-code", "PreToolUse");
const STOP_ARGV = hookArgv("claude-code", "Stop");
const SESSION = "s-fast";

async function initialized(): Promise<string> {
  const f = await createFixtureFrom("fast-hook-init", async (l) => {
    const code = await run(["init", "--template", "software-development"], {
      cwd: l.cloneA,
      env: {},
      streams: { out: () => undefined, err: () => undefined },
    });
    if (code !== 0) throw new Error("dg init に失敗した");
  });
  cleanups.push(f.cleanup);
  return f.cloneA;
}

async function uninitialized(): Promise<string> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f.cloneA;
}

async function outsideGit(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-nogit-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface Ran {
  code: number;
  out: string[];
  err: string[];
  /** 記録（hook-inputs・hook-sessions）のファイル名と中身。時刻は伏せる */
  records: Record<string, string>;
  /** 速い経路が受け持ったか（今の経路では undefined） */
  handled?: boolean;
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g;

/** deguboard-local の hook-inputs と hook-sessions を読み、読んだら消す（次の経路が初めから書く） */
async function takeRecords(cwd: string): Promise<Record<string, string>> {
  const paths = await resolveRepoPaths(cwd).catch(() => undefined);
  if (!paths) return {};
  const out: Record<string, string> = {};
  for (const sub of ["hook-inputs", "hook-sessions"]) {
    const dir = path.join(paths.localDir, sub);
    for (const name of await readdir(dir).catch(() => [] as string[]))
      out[`${sub}/${name}`] = (await readFile(path.join(dir, name), "utf8")).replace(ISO, "<time>");
    await rm(dir, { recursive: true, force: true });
  }
  return out;
}

/** bin/dg.js と同じ順に動かす：速い経路を試し、受け持たなければ読んだ標準入力を添えて main（run）に回す */
async function viaDgJs(cwd: string, stdin: string, argv = ARGV): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const streams = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
  const fast = await tryFastHook(argv, {
    stdin: async () => stdin,
    cwd,
    env: {},
    out: streams.out,
    err: streams.err,
  });
  const code = fast.handled
    ? fast.exitCode
    : await run(argv, {
        cwd,
        env: {},
        streams,
        ...(fast.stdin !== undefined ? { stdinText: fast.stdin } : {}),
      });
  return { code, out, err, records: await takeRecords(cwd), handled: fast.handled };
}

/** 今の経路（CLI の全体を読む main） */
async function viaMain(cwd: string, stdin: string, argv = ARGV): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd,
    env: {},
    stdinText: stdin,
    streams: { out: (t) => out.push(t), err: (t) => err.push(t) },
  });
  return { code, out, err, records: await takeRecords(cwd) };
}

const payload = (cwd: string, tool: string, input: Record<string, unknown>) =>
  JSON.stringify({ session_id: SESSION, tool_name: tool, tool_input: input, cwd });

async function compare(cwd: string, stdin: string, argv = ARGV): Promise<Ran> {
  await takeRecords(cwd);
  const fast = await viaDgJs(cwd, stdin, argv);
  const main = await viaMain(cwd, stdin, argv);
  const { handled: _handled, ...rest } = fast;
  expect(rest).toEqual(main);
  expect(fast.code).toBe(0);
  return fast;
}

describe("PreToolUse の速い経路（bin/dg.js。t768）", () => {
  it("拒む Bash・拒む書き込み・通す Bash・gh pr merge は速い経路が受け持ち、標準出力・標準エラー・終了コード・記録が今の経路と同じ", async () => {
    const cwd = await initialized();
    const { dataDir } = await resolveRepoPaths(cwd);
    const cases: Array<[string, string, boolean]> = [
      ["拒む Bash", payload(cwd, "Bash", { command: "cat .git/deguboard/tickets/t1.md" }), true],
      [
        "拒む書き込み",
        payload(cwd, "Write", { file_path: path.join(dataDir, "tickets", "t1.md") }),
        true,
      ],
      ["通す Bash", payload(cwd, "Bash", { command: "ls" }), false],
      ["gh pr merge", payload(cwd, "Bash", { command: "gh pr merge 5 --squash" }), true],
    ];
    for (const [name, stdin, denied] of cases) {
      const r = await compare(cwd, stdin);
      expect(r.handled, name).toBe(true);
      expect(r.out.length, name).toBe(denied ? 1 : 0);
      if (denied) expect(JSON.parse(r.out[0]!).hookSpecificOutput.permissionDecision).toBe("deny");
      // 入力の項目の有無と、セッションに届いたこと・届いた種類を残す
      expect(Object.keys(r.records).sort(), name).toEqual([
        "hook-inputs/PreToolUse.json",
        `hook-sessions/${SESSION}.json`,
        `hook-sessions/${SESSION}.kind-tool_requested.json`,
      ]);
    }
  });

  it("初期化していない・git の外・JSON でない・別のツール・オブジェクトでない入力は今の経路に回し、結果は今の経路と同じ", async () => {
    const init = await initialized();
    const cases: Array<[string, string, string]> = [
      [
        "初期化していない",
        await uninitialized(),
        payload("/x", "Bash", { command: "gh pr merge 5" }),
      ],
      ["git の外", await outsideGit(), payload("/x", "Bash", { command: "gh pr merge 5" })],
      ["JSON でない", init, "tool_name: Bash\nsession_id: s-yaml\n"],
      ["別のツール", init, payload(init, "Read", { file_path: "/etc/hosts" })],
      ["オブジェクトでない", init, "[1, 2]"],
    ];
    for (const [name, cwd, stdin] of cases) {
      const r = await compare(cwd, stdin);
      expect(r.handled, name).toBe(false);
      expect(r.out, name).toEqual([]);
    }
  });

  it("dg hooks install が書く PreToolUse と Stop のコマンドの引数を、速い経路が受け持つ。ほかのイベントと引数は受け持たない", async () => {
    const cwd = await initialized();
    const result = await installHooks({
      cwd,
      scope: "project",
      env: {},
      command: "dg",
      dryRun: true,
    });
    const settings = JSON.parse(result.content!) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const argvOf = (event: string) =>
      settings.hooks[event]![0]!.hooks[0]!.command.split(" ").slice(1);
    expect(fastHookEventOf(argvOf("PreToolUse"))).toBe("PreToolUse");
    expect(fastHookEventOf(argvOf("Stop"))).toBe("Stop");
    for (const event of ["SessionStart", "PostToolUse", "SubagentStop"])
      expect(isFastHookArgv(argvOf(event)), event).toBe(false);
    expect(isFastHookArgv(["--json", ...argvOf("PreToolUse")])).toBe(false);
    expect(isFastHookArgv(["ticket", "list"])).toBe(false);
    // 受け持たない argv では標準入力を読まない
    const fast = await tryFastHook(["ticket", "list"], {
      stdin: () => Promise.reject(new Error("読んではいけない")),
    });
    expect(fast).toEqual({ handled: false });
  });

  it("速い経路のフックの読み方は hooksOf の既定のエージェントと同じもの", () => {
    expect(defaultHookSupport).toBe(hooksOf(DEFAULT_HOOK_AGENT));
    for (const event of [DEFAULT_TOOL_EVENT, DEFAULT_STOP_EVENT]) {
      expect(defaultHookSupport.events.map((e) => e.event)).toContain(event);
      expect(fastHookEventOf(hookArgv(DEFAULT_HOOK_AGENT, event))).toBe(event);
    }
  });
});

describe("Stop の速い経路（bin/dg.js。t786）", () => {
  const stop = (continued = false) =>
    JSON.stringify({ session_id: SESSION, stop_hook_active: continued });
  const STOP_RECORDS = [
    "hook-inputs/Stop.json",
    `hook-sessions/${SESSION}.json`,
    `hook-sessions/${SESSION}.kind-turn_stopped.json`,
  ];
  const compareStop = async (cwd: string, stdin: string) => {
    const r = await compare(cwd, stdin, STOP_ARGV);
    expect(r.handled).toBe(true);
    expect(Object.keys(r.records).sort()).toEqual(STOP_RECORDS);
    return r;
  };

  it("dg の外の変更がない・未コミットの変更・続けさせた後・dg の外のコミットは速い経路が受け持ち、標準出力・標準エラー・終了コード・記録が今の経路と同じ", async () => {
    const cwd = await initialized();
    const { dataDir } = await resolveRepoPaths(cwd);
    // 変更がなければ何も出さない
    expect((await compareStop(cwd, stop())).out).toEqual([]);
    // 未コミットの変更は、止まらずに続けさせてファイルを伝える
    await writeFile(path.join(dataDir, "outside.md"), "x\n");
    const dirty = await compareStop(cwd, stop());
    expect(JSON.parse(dirty.out[0]!)).toMatchObject({ decision: "block" });
    expect(dirty.out[0]).toContain("outside.md");
    // 続けさせた後の Stop では伝えない
    expect((await compareStop(cwd, stop(true))).out).toEqual([]);
    // dg の外のコミット（HEAD が基準から動く）は、速い経路も config のリモートの名前を読んで確かめる
    await git(dataDir, ["add", "outside.md"]);
    await git(dataDir, ["commit", "-q", "-m", "outside commit"]);
    const committed = await compareStop(cwd, stop());
    const { decision, reason } = JSON.parse(committed.out[0]!) as Record<string, string>;
    expect(decision).toBe("block");
    expect(reason).toContain('"outside commit": outside.md');
  });

  it("初期化していない・git の外・JSON でない・オブジェクトでない・セッションのない入力は今の経路に回し、結果は今の経路と同じ", async () => {
    const init = await initialized();
    const cases: Array<[string, string, string]> = [
      ["初期化していない", await uninitialized(), stop()],
      ["git の外", await outsideGit(), stop()],
      ["JSON でない", init, `session_id: ${SESSION}\nstop_hook_active: false\n`],
      ["オブジェクトでない", init, "[1, 2]"],
      ["セッションのない", init, JSON.stringify({ stop_hook_active: false })],
    ];
    for (const [name, cwd, stdin] of cases) {
      const r = await compare(cwd, stdin, STOP_ARGV);
      expect(r.handled, name).toBe(false);
    }
  });
});

describe("速い経路が読むモジュール（t768）", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const coreSrc = path.resolve(here, "../../core/src");
  /**
   * 速い経路から静的に読んでよいファイル（packages/ からの相対）。同梱の dg の束ね方（vite.cli.config.ts）も同じ一覧で
   * 速い経路の chunk を分けるので、一覧は fast-path-files.json の 1 か所に置く。足すときは、そのファイルが重い依存を読まないことを確かめる
   */
  const allowed = async () =>
    JSON.parse(await readFile(path.join(here, "fast-path-files.json"), "utf8")) as string[];
  /** 型だけの import・export は実行時に読まないので除く */
  const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;

  it("静的な import は node の組み込みと許したファイルだけ（zod・yaml・commander・core の入口を読まない）", async () => {
    const packages = path.resolve(here, "../..");
    const seen = new Set<string>();
    const queue = [path.join(here, "fast-hook.ts")];
    while (queue.length > 0) {
      const file = queue.shift()!;
      const rel = path.relative(packages, file).split(path.sep).join("/");
      if (seen.has(rel)) continue;
      seen.add(rel);
      const text = await readFile(file, "utf8");
      for (const m of text.matchAll(IMPORT)) {
        if (m[1]) continue;
        const spec = m[2]!;
        if (spec.startsWith("node:") || builtinModules.includes(spec)) continue;
        if (spec === "@deguboard/core/fast-hook") {
          queue.push(path.join(coreSrc, "fast-hook.ts"));
          continue;
        }
        expect(spec.startsWith("."), `${rel} が ${spec} を読む`).toBe(true);
        queue.push(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    }
    expect([...seen].sort()).toEqual((await allowed()).sort());
  });
});

describe("bin/dg.js の dist の読み込み（t777）", () => {
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const normalBin = path.join(cliRoot, "bin", "dg.js");

  /**
   * dist を一時ディレクトリに写し、bin/dg.js の写しのパスを返す。
   * remove は消すファイル、replace は書き換えるファイル（どちらも dist からの相対）。
   * coreWithoutFastHook は、@deguboard/core を速い経路の dist/fast-hook.js を欠いた写しに替える（古いクローンの再現）
   */
  async function copyDist(
    opts: {
      remove?: string[];
      replace?: Record<string, string>;
      coreWithoutFastHook?: boolean;
    } = {},
  ): Promise<string> {
    if (!existsSync(path.join(cliRoot, "dist", "main.js")))
      throw new Error("dist がない。先に mise run build");
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "dg-dist-")));
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    await mkdir(path.join(root, "bin"));
    await cp(normalBin, path.join(root, "bin", "dg.js"));
    // bin/dg.js は Node の版を確かめる判定（t782）と、入口に共通の流れ（t788）を読む。写しにも置く
    for (const file of ["node-version.mjs", "run-entry.mjs"])
      await cp(path.join(cliRoot, "bin", file), path.join(root, "bin", file));
    await cp(path.join(cliRoot, "package.json"), path.join(root, "package.json"));
    await cp(path.join(cliRoot, "dist"), path.join(root, "dist"), { recursive: true });
    if (opts.coreWithoutFastHook) await linkNodeModulesWithCoreCopy(root);
    else await symlink(path.join(cliRoot, "node_modules"), path.join(root, "node_modules"), "dir");
    for (const file of opts.remove ?? []) await rm(path.join(root, "dist", file));
    for (const [file, text] of Object.entries(opts.replace ?? {}))
      await writeFile(path.join(root, "dist", file), text);
    return path.join(root, "bin", "dg.js");
  }

  /**
   * node_modules の各項目は実物への張り。@deguboard/core だけは dist/fast-hook.js を欠く写しに替える（core の依存は実物を張る）。
   * @deguboard の下は名前で選ばずに core のほかをすべて張り、CLI の依存が増えても写しに欠けないようにする
   */
  async function linkNodeModulesWithCoreCopy(root: string): Promise<void> {
    const real = path.join(cliRoot, "node_modules");
    const out = path.join(root, "node_modules");
    await mkdir(path.join(out, "@deguboard"), { recursive: true });
    for (const entry of await readdir(real))
      if (entry !== "@deguboard")
        await symlink(path.join(real, entry), path.join(out, entry), "dir");
    for (const entry of await readdir(path.join(real, "@deguboard")))
      if (entry !== "core")
        await symlink(
          path.join(real, "@deguboard", entry),
          path.join(out, "@deguboard", entry),
          "dir",
        );
    const core = await realpath(path.join(real, "@deguboard", "core"));
    const coreCopy = path.join(out, "@deguboard", "core");
    await mkdir(coreCopy);
    await cp(path.join(core, "package.json"), path.join(coreCopy, "package.json"));
    await cp(path.join(core, "dist"), path.join(coreCopy, "dist"), {
      recursive: true,
      filter: (src) => path.basename(src) !== "fast-hook.js",
    });
    await symlink(path.join(core, "node_modules"), path.join(coreCopy, "node_modules"), "dir");
  }

  /** bin/dg.js を子プロセスで動かす。DEGUBOARD_ の環境変数は外して、結果を呼び出しの間で比べられるようにする */
  function dg(bin: string, args: readonly string[], cwd: string, stdin: string) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("DEGUBOARD_")),
    );
    return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [bin, ...args], { cwd, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
      child.stdin.end(stdin);
    });
  }

  it("速い経路のファイルを消した dist でも、PreToolUse は今の経路で同じ結果を返す", async () => {
    const cwd = await initialized();
    const copied = await copyDist({ remove: ["fast-hook.js"] });
    const inputs = [
      payload(cwd, "Bash", { command: "gh pr merge 5 --squash" }),
      payload(cwd, "Bash", { command: "ls" }),
    ];
    const actuals = [];
    for (const stdin of inputs) {
      const expected = await dg(normalBin, ARGV, cwd, stdin);
      const actual = await dg(copied, ARGV, cwd, stdin);
      expect(actual).toEqual(expected);
      expect(actual.code).toBe(0);
      actuals.push(actual);
    }
    expect(JSON.parse(actuals[0]!.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("速い経路のファイルを消した dist でも、ほかのコマンドは今の経路で同じ結果を返す", async () => {
    const cwd = await initialized();
    const copied = await copyDist({ remove: ["fast-hook.js"] });
    const expected = await dg(normalBin, ["ticket", "list"], cwd, "");
    const actual = await dg(copied, ["ticket", "list"], cwd, "");
    expect(actual).toEqual(expected);
    expect(actual.code).toBe(0);
  });

  it("@deguboard/core の dist/fast-hook.js が無い古いクローンでも、PreToolUse は今の経路で同じ結果を返す", async () => {
    const cwd = await initialized();
    const copied = await copyDist({ coreWithoutFastHook: true });
    const inputs = [
      payload(cwd, "Bash", { command: "gh pr merge 5 --squash" }),
      payload(cwd, "Bash", { command: "ls" }),
    ];
    const actuals = [];
    for (const stdin of inputs) {
      const expected = await dg(normalBin, ARGV, cwd, stdin);
      const actual = await dg(copied, ARGV, cwd, stdin);
      expect(actual).toEqual(expected);
      expect(actual.code).toBe(0);
      actuals.push(actual);
    }
    expect(JSON.parse(actuals[0]!.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("古い dist で main が import 先の名前を持たない（SyntaxError）ときも、main に頼るコマンドは直し方を英語で出して 1 で終わる", async () => {
    const cwd = await initialized();
    // 速い経路の dist は今のまま。main だけが古く、fast-hook.js に無い名前を import する
    const copied = await copyDist({
      replace: {
        "main.js":
          'import { noSuchExport } from "./fast-hook.js";\nexport const main = async () => 0;\n',
      },
    });
    // 速い経路が受け持つ入力は main を読まないので、そのまま動く
    const merge = await dg(copied, ARGV, cwd, payload(cwd, "Bash", { command: "gh pr merge 5" }));
    expect(merge.code).toBe(0);
    expect(JSON.parse(merge.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    // 速い経路が受け持たないツールは main に回り、直し方を出して終わる
    const hook = await dg(copied, ARGV, cwd, payload(cwd, "Read", { file_path: "/etc/hosts" }));
    const list = await dg(copied, ["ticket", "list"], cwd, "");
    for (const r of [hook, list]) {
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("missing or out of date");
      expect(r.stderr).toContain("mise run build");
      expect(r.stderr).not.toContain("SyntaxError");
    }
  });

  it("main も読めない dist では、止まらずに dist が無いか古いことと直し方を英語で出して 1 で終わる", async () => {
    const cwd = await initialized();
    const copied = await copyDist({ remove: ["fast-hook.js", "main.js"] });
    const hook = await dg(copied, ARGV, cwd, payload(cwd, "Bash", { command: "ls" }));
    const list = await dg(copied, ["ticket", "list"], cwd, "");
    for (const r of [hook, list]) {
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("missing or out of date");
      expect(r.stderr).toContain("mise run build");
    }
  });

  it("速い経路が受け持たない入力は、読んだ標準入力を添えて本体に回り、速い経路を欠いた dist（本体が標準入力を自分で読む）と同じ結果になる（t781）", async () => {
    // 初期化していない repo の出力は標準入力に依らない（「not initialized」で終わる）ので、標準入力を取りこぼしても気づけない。
    // 初期化した repo で、標準入力の中身が本体の出力と記録を決める入力を使う
    const cwd = await initialized();
    const cases: Array<[string, string]> = [
      [
        "JSON でない（YAML）で拒む Bash",
        'tool_name: Bash\nsession_id: s-yaml\ntool_input:\n  command: "gh pr merge 5 --squash"\n',
      ],
      ["別のツール（記録だけ残る）", payload(cwd, "Read", { file_path: "/etc/hosts" })],
    ];
    const mainOnly = await copyDist({ remove: ["fast-hook.js"] });
    const stdouts: string[] = [];
    for (const [name, stdin] of cases) {
      await takeRecords(cwd);
      const expected = await dg(mainOnly, ARGV, cwd, stdin);
      const expectedRecords = await takeRecords(cwd);
      const actual = await dg(normalBin, ARGV, cwd, stdin);
      const actualRecords = await takeRecords(cwd);
      expect(actual, name).toEqual(expected);
      expect(actualRecords, name).toEqual(expectedRecords);
      expect(actual.code, name).toBe(0);
      // 本体が標準入力の中身を読んだこと（渡し忘れると、空の入力として扱われて記録が残らない）
      expect(Object.keys(actualRecords), name).not.toEqual([]);
      stdouts.push(actual.stdout);
    }
    // 最初の入力（YAML の拒む Bash）は、本体が読んだ入力で拒まれる（読めなければ拒まれない）
    expect(JSON.parse(stdouts[0]!)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });
});
