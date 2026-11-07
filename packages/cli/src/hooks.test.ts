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
  it("install はリポジトリの .claude/settings.json に 4 つのイベントのフックを書き、もう一度実行しても重ねず、手で足したフックとほかの設定を残す", async () => {
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
      ["PostToolUse", "SessionEnd", "SessionStart", "SubagentStop"].sort(),
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
    expect(Object.keys(settings.hooks)).toHaveLength(4);
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
