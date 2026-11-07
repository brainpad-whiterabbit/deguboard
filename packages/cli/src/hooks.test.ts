import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalOnlyRepo } from "../../core/test/helpers/git-fixture.js";
import { run } from "./program.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function dg(cwd: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd,
    env,
    streams: { out: (t) => out.push(t), err: (t) => err.push(t) },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function tempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-home-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function repo(): Promise<string> {
  const r = await createLocalOnlyRepo();
  cleanups.push(r.cleanup);
  return r.dir;
}

const settingsOf = async (file: string) =>
  JSON.parse(await readFile(file, "utf8")) as { hooks: Record<string, unknown[]> } & Record<
    string,
    unknown
  >;

describe("dg hooks install / uninstall（ADR-012）", () => {
  it("install はリポジトリの .claude/settings.json に 5 つのイベントのフックを書き、もう一度実行しても重ねず、手で足したフックとほかの設定を残す", async () => {
    const cwd = await repo();
    const file = path.join(cwd, ".claude", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    const mine = { type: "command", command: "echo mine" };
    await writeFile(
      file,
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: { SessionStart: [{ hooks: [mine] }] },
      }),
    );
    expect((await dg(cwd, ["hooks", "install"])).code).toBe(0);
    const again = await dg(cwd, ["hooks", "install"]);
    expect(again.out).toContain("変わらなかった");
    const settings = await settingsOf(file);
    expect(settings["permissions"]).toEqual({ allow: ["Bash(ls)"] });
    expect(settings.hooks["SessionStart"]).toEqual([
      { hooks: [mine] },
      { hooks: [{ type: "command", command: "dg --actor agent hook SessionStart --payload -" }] },
    ]);
    expect(settings.hooks["PostToolUse"]).toEqual([
      {
        matcher: "Agent",
        hooks: [{ type: "command", command: "dg --actor agent hook PostToolUse --payload -" }],
      },
    ]);
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ["PostToolUse", "SessionEnd", "SessionStart", "SubagentStart", "SubagentStop"].sort(),
    );
  });

  it("--command で dg を呼ぶコマンドを変えると、前の dg のフックを入れ替える", async () => {
    const cwd = await repo();
    await dg(cwd, ["hooks", "install"]);
    await dg(cwd, ["hooks", "install", "--command", "npx deguboard"]);
    const settings = await settingsOf(path.join(cwd, ".claude", "settings.json"));
    expect(settings.hooks["SessionEnd"]).toEqual([
      {
        hooks: [
          { type: "command", command: "npx deguboard --actor agent hook SessionEnd --payload -" },
        ],
      },
    ]);
  });

  it("uninstall は dg のフックだけを外し、手で足したフックは残す。--dry-run は書かない", async () => {
    const cwd = await repo();
    const file = path.join(cwd, ".claude", "settings.json");
    await dg(cwd, ["hooks", "install"]);
    const settings = await settingsOf(file);
    settings.hooks["SessionEnd"]!.push({ hooks: [{ type: "command", command: "echo bye" }] });
    await writeFile(file, JSON.stringify(settings));
    const dry = await dg(cwd, ["--json", "hooks", "uninstall", "--dry-run"]);
    expect(JSON.parse(dry.out).data.dryRun).toBe(true);
    expect((await settingsOf(file)).hooks["PostToolUse"]).toBeDefined();
    await dg(cwd, ["hooks", "uninstall"]);
    expect((await settingsOf(file)).hooks).toEqual({
      SessionEnd: [{ hooks: [{ type: "command", command: "echo bye" }] }],
    });
  });

  it("--personal は個人の設定（~/.claude/settings.json）に書く", async () => {
    const cwd = await repo();
    const home = await tempHome();
    expect((await dg(cwd, ["hooks", "install", "--personal"], { HOME: home })).code).toBe(0);
    const settings = await settingsOf(path.join(home, ".claude", "settings.json"));
    expect(Object.keys(settings.hooks)).toHaveLength(5);
  });
});

describe("dg hook", () => {
  it("標準出力には何も出さない（SessionStart の標準出力は会話に足されうる）", async () => {
    const cwd = await repo();
    await dg(cwd, ["init"]);
    const home = await tempHome();
    const envFile = path.join(home, "env.sh");
    const payload = path.join(home, "payload.json");
    await writeFile(payload, JSON.stringify({ session_id: "s1", transcript_path: "/x/s1.jsonl" }));
    const r = await dg(cwd, ["--actor", "agent", "hook", "SessionStart", "--payload", payload], {
      HOME: home,
      CLAUDE_ENV_FILE: envFile,
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(await readFile(envFile, "utf8")).toContain("export DEGUBOARD_ACTOR=agent");
  });
});

describe("dg hook の失敗", () => {
  it("入力が JSON のオブジェクトでなくても、初期化していないリポジトリでも、終了コードは 0 で標準エラーにだけ書く", async () => {
    const cwd = await repo();
    const home = await tempHome();
    const bad = path.join(home, "bad.json");
    await writeFile(bad, "[1, 2]");
    const notInit = await dg(cwd, ["--actor", "agent", "hook", "SubagentStop", "--payload", bad], {
      HOME: home,
    });
    expect(notInit).toMatchObject({ code: 0, out: "" });
    expect(notInit.err).toContain("dg hook:");
    await dg(cwd, ["init"]);
    const invalid = await dg(cwd, ["--actor", "agent", "hook", "SubagentStop", "--payload", bad], {
      HOME: home,
    });
    expect(invalid).toMatchObject({ code: 0, out: "" });
  });

  it("dg のフックの見分け方は --actor agent hook <イベント> --payload - の終わりで、人のフックは消さない", async () => {
    const cwd = await repo();
    const file = path.join(cwd, ".claude", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    const theirs = { type: "command", command: "my-tool hook x --payload -" };
    await writeFile(file, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [theirs] }] } }));
    await dg(cwd, ["hooks", "uninstall"]);
    expect((await settingsOf(file)).hooks["SessionEnd"]).toEqual([{ hooks: [theirs] }]);
  });
});
