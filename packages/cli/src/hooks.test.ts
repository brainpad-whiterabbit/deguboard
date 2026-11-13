import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRepoPaths, setBundleLayout } from "@deguboard/core";
import { createLocalOnlyRepo } from "../../core/test/helpers/git-fixture.js";
import {
  olderVersionOf,
  putSkill,
  skillFileOf,
  skillsDir,
} from "../../core/test/helpers/skills.js";
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

const git = async (cwd: string, args: string[]) =>
  (await promisify(execFile)("git", args, { cwd })).stdout;

/** --json の hooks install の結果のうち、テストが見る部分 */
type Installed = { data: { ignoreFile: string | null }; warnings: string[] };

const settingsOf = async (file: string) =>
  JSON.parse(await readFile(file, "utf8")) as { hooks: Record<string, unknown[]> } & Record<
    string,
    unknown
  >;

describe("dg hooks install / uninstall（AG-9）", () => {
  it("install --shared はリポジトリの追跡する .claude/settings.json に、PATH の dg を呼ぶ 7 つのイベントのフックを書き、もう一度実行しても重ねず、手で足したフックとほかの設定を残す", async () => {
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
    expect((await dg(cwd, ["hooks", "install", "--shared"])).code).toBe(0);
    const again = await dg(cwd, ["hooks", "install", "--shared"]);
    expect(again.out).toContain("No change");
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
      [
        "PostToolUse",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "SubagentStart",
        "SubagentStop",
      ].sort(),
    );
  });

  it("既定の install は、追跡しない .claude/settings.local.json に、動いている node と dg.js の実パスを引用した命令で書く（t698）", async () => {
    const cwd = await repo();
    expect((await dg(cwd, ["hooks", "install"])).code).toBe(0);
    const settings = await settingsOf(path.join(cwd, ".claude", "settings.local.json"));
    const script = await realpath(path.resolve(import.meta.dirname, "..", "bin", "dg.js"));
    expect(settings.hooks["SessionStart"]).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `"${process.execPath}" "${script}" --actor agent hook SessionStart --payload -`,
          },
        ],
      },
    ]);
    await expect(readFile(path.join(cwd, ".claude", "settings.json"), "utf8")).rejects.toThrow();
  });

  it("既定の install は実行のたびに .claude/.gitignore に settings.local.json がなければ足し、利用者の行を残して重ねず、警告しない", async () => {
    const cwd = await repo();
    const ignore = path.join(cwd, ".claude", ".gitignore");
    const first = JSON.parse((await dg(cwd, ["--json", "hooks", "install"])).out) as Installed;
    expect(first.data.ignoreFile).toBe(ignore);
    expect(first.warnings).toEqual([]);
    expect(await readFile(ignore, "utf8")).toBe("settings.local.json\n");
    const second = JSON.parse((await dg(cwd, ["--json", "hooks", "install"])).out) as Installed;
    expect(second.data.ignoreFile).toBeNull();
    expect(await readFile(ignore, "utf8")).toBe("settings.local.json\n");
    // 利用者が行を消して自分の行を書いていれば、残して足す。設定が変わらない（No change）実行でも足す
    await writeFile(ignore, "skills/dgwork/\n# mine");
    const third = await dg(cwd, ["hooks", "install"]);
    expect(third.out).toContain("No change");
    expect(third.out).toContain(`Added an ignore line for the settings file to ${ignore}`);
    expect(await readFile(ignore, "utf8")).toBe("skills/dgwork/\n# mine\nsettings.local.json\n");
    // git から見て、未追跡に出るのは .gitignore だけ
    const status = await git(cwd, ["status", "--porcelain", "-uall"]);
    expect(status.trim().split("\n")).toEqual(["?? .claude/.gitignore"]);
  });

  it("--shared・--personal・--dry-run の install と uninstall は .gitignore を書かない", async () => {
    const cwd = await repo();
    const home = await tempHome();
    const ignore = path.join(cwd, ".claude", ".gitignore");
    for (const args of [
      ["install", "--shared"],
      ["install", "--personal"],
      ["install", "--dry-run"],
      ["uninstall"],
    ]) {
      const r = JSON.parse((await dg(cwd, ["--json", "hooks", ...args], { HOME: home })).out) as {
        data: { ignoreFile?: string | null };
      };
      expect(r.data.ignoreFile ?? null, args.join(" ")).toBeNull();
      await expect(readFile(ignore, "utf8"), args.join(" ")).rejects.toThrow();
    }
    await expect(readFile(path.join(home, ".claude", ".gitignore"), "utf8")).rejects.toThrow();
  });

  it("settings.local.json がすでに追跡されていれば git rm --cached を案内し、追跡から外せば警告しない", async () => {
    const cwd = await repo();
    await dg(cwd, ["hooks", "install"]);
    // 無視の行より前に追跡された設定（-f で再現する）
    await git(cwd, ["add", "-f", ".claude/settings.local.json"]);
    const tracked = JSON.parse((await dg(cwd, ["--json", "hooks", "install"])).out) as Installed;
    expect(tracked.warnings).toEqual([
      expect.stringContaining("git rm --cached .claude/settings.local.json"),
    ]);
    await git(cwd, ["rm", "-q", "--cached", ".claude/settings.local.json"]);
    const after = JSON.parse((await dg(cwd, ["--json", "hooks", "install"])).out) as Installed;
    expect(after.warnings).toEqual([]);
    await expect(
      readFile(path.join(cwd, ".claude", "settings.local.json"), "utf8"),
    ).resolves.toContain("hook SessionStart");
  });

  it("追跡する .claude/settings.json に dg のフックが残っていれば、既定の install が警告する。手で足したフックだけなら警告しない（t698）", async () => {
    const cwd = await repo();
    const shared = path.join(cwd, ".claude", "settings.json");
    await mkdir(path.dirname(shared), { recursive: true });
    await writeFile(
      shared,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }),
    );
    const mine = JSON.parse((await dg(cwd, ["--json", "hooks", "install"])).out) as {
      warnings: string[];
    };
    expect(mine.warnings).toEqual([]);

    await dg(cwd, ["hooks", "install", "--shared"]);
    const both = JSON.parse((await dg(cwd, ["--json", "hooks", "install"])).out) as {
      warnings: string[];
    };
    expect(both.warnings).toContainEqual(expect.stringContaining("dg hooks uninstall --shared"));
    await dg(cwd, ["hooks", "uninstall", "--shared"]);
    const after = JSON.parse((await dg(cwd, ["--json", "hooks", "install"])).out) as {
      warnings: string[];
    };
    expect(after.warnings).toEqual([]);
  });

  it("--personal と --shared は一緒に渡せない", async () => {
    const cwd = await repo();
    const r = await dg(cwd, ["hooks", "install", "--personal", "--shared"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("cannot be given together");
  });

  it("--command で dg を呼ぶコマンドを変えると、前の dg のフックを入れ替える", async () => {
    const cwd = await repo();
    await dg(cwd, ["hooks", "install"]);
    await dg(cwd, ["hooks", "install", "--command", "npx deguboard"]);
    const settings = await settingsOf(path.join(cwd, ".claude", "settings.local.json"));
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
    const file = path.join(cwd, ".claude", "settings.local.json");
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

  it("uninstall は .claude/.gitignore の settings.local.json の行を残す（Claude Code が dg の外でも各自のマシンの設定に使うため）", async () => {
    const cwd = await repo();
    const ignore = path.join(cwd, ".claude", ".gitignore");
    await dg(cwd, ["hooks", "install"]);
    expect(await readFile(ignore, "utf8")).toBe("settings.local.json\n");
    await dg(cwd, ["hooks", "uninstall"]);
    expect(await readFile(ignore, "utf8")).toBe("settings.local.json\n");
    // 残った settings.local.json は追跡されない
    const status = await git(cwd, ["status", "--porcelain", "-uall"]);
    expect(status.trim().split("\n")).toEqual(["?? .claude/.gitignore"]);
  });

  it("--personal は個人の設定（~/.claude/settings.json）に書く", async () => {
    const cwd = await repo();
    const home = await tempHome();
    expect((await dg(cwd, ["hooks", "install", "--personal"], { HOME: home })).code).toBe(0);
    const settings = await settingsOf(path.join(home, ".claude", "settings.json"));
    expect(Object.keys(settings.hooks)).toHaveLength(7);
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
    await dg(cwd, ["hooks", "uninstall", "--shared"]);
    expect((await settingsOf(file)).hooks["SessionEnd"]).toEqual([{ hooks: [theirs] }]);
  });
});

describe("dg hooks check（AG-9・t542）", () => {
  afterEach(() => setBundleLayout(undefined));
  type Check = {
    ok: true;
    data: {
      events: Array<{
        event: string;
        installed: boolean;
        handler: string | null;
        received_at: string | null;
        missing: string[];
      }>;
    };
    warnings: string[];
  };
  const checkOf = async (cwd: string, argv: string[] = [], env: NodeJS.ProcessEnv = {}) => {
    const r = await dg(cwd, ["--json", "hooks", "check", ...argv], env);
    expect(r.code).toBe(0);
    return JSON.parse(r.out) as Check;
  };
  const recordOf = async (cwd: string, event: string, fields: Record<string, boolean>) => {
    const { localDir } = await resolveRepoPaths(cwd);
    await mkdir(path.join(localDir, "hook-inputs"), { recursive: true });
    await writeFile(
      path.join(localDir, "hook-inputs", `${event}.json`),
      JSON.stringify({ event, received_at: "2026-11-07T00:00:00Z", fields }),
    );
  };

  it("起動ファイル経由の install は、node と dg.js の代わりに起動ファイルを書き、確かめは ok。起動ファイルがなくなれば警告する（t735）", async () => {
    // 起動ファイル経由で動くのは束ねた dg なので、束ねた配置を置く
    const entry = path.join(os.tmpdir(), "ext", "dist", "cli", "dg.mjs");
    setBundleLayout({ entry, guideDir: path.dirname(path.dirname(entry)), version: "9.8.7" });
    const cwd = await repo();
    const home = await tempHome();
    const launcher = path.join(home, ".local", "share", "deguboard", "dg");
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, "#!/bin/sh\nexit 0\n");
    await chmod(launcher, 0o755);
    const env = { DEGUBOARD_LAUNCHER: launcher };

    expect((await dg(cwd, ["hooks", "install"], env)).code).toBe(0);
    const settings = await settingsOf(path.join(cwd, ".claude", "settings.local.json"));
    expect(settings.hooks["SessionStart"]).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `"${launcher}" --actor agent hook SessionStart --payload -`,
          },
        ],
      },
    ]);
    const ok = await checkOf(cwd, [], env);
    expect(ok.data.events.every((e) => e.installed && e.handler === "ok")).toBe(true);

    // 拡張が残っている（current もある）ままで起動ファイルだけが消えた場合
    await writeFile(path.join(home, ".local", "share", "deguboard", "current"), "version=9.8.7\n");
    await rm(launcher);
    const gone = await checkOf(cwd, [], env);
    expect(gone.data.events.every((e) => e.handler === "gone")).toBe(true);
    expect(gone.warnings).toContainEqual(
      expect.stringMatching(
        new RegExp(`${launcher.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*no longer exists`),
      ),
    );
    // 起動ファイルは dg hooks install では戻せない（別の dg が node と dg.js を書く）ので、拡張を開き直す案内にする
    expect(gone.warnings).toContainEqual(
      expect.stringContaining("Open VS Code with the deguboard extension"),
    );
    expect(gone.warnings.join("\n")).not.toContain("hooks install again");
  });

  it("拡張を消したあと（起動ファイルも current もない）は、開き直す案内ではなく、フックを入れ直すか外す案内を出す（t742）", async () => {
    const entry = path.join(os.tmpdir(), "ext", "dist", "cli", "dg.mjs");
    setBundleLayout({ entry, guideDir: path.dirname(path.dirname(entry)), version: "9.8.7" });
    const cwd = await repo();
    const home = await tempHome();
    const launcher = path.join(home, ".local", "share", "deguboard", "dg");
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, "#!/bin/sh\nexit 0\n");
    await chmod(launcher, 0o755);
    const env = { DEGUBOARD_LAUNCHER: launcher };
    expect((await dg(cwd, ["hooks", "install"], env)).code).toBe(0);

    // 拡張がなくなると、起動ファイルと current の両方が消える
    await rm(launcher);
    const gone = await checkOf(cwd, [], env);
    expect(gone.data.events.every((e) => e.handler === "gone")).toBe(true);
    expect(gone.warnings).toContainEqual(
      expect.stringMatching(
        new RegExp(`${launcher.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*extension.*was removed`),
      ),
    );
    expect(gone.warnings).toContainEqual(expect.stringContaining("dg hooks install again"));
    expect(gone.warnings).toContainEqual(expect.stringContaining("dg hooks uninstall"));
    expect(gone.warnings.join("\n")).not.toContain("Open VS Code");
  });

  it("起動ファイル経由でも --shared は追跡する設定に PATH の dg を書く（マシンのパスは書かない。t735）", async () => {
    const entry = path.join(os.tmpdir(), "ext", "dist", "cli", "dg.mjs");
    setBundleLayout({ entry, guideDir: path.dirname(path.dirname(entry)), version: "9.8.7" });
    const cwd = await repo();
    const launcher = path.join(await tempHome(), "dg");
    const env = { DEGUBOARD_LAUNCHER: launcher };
    expect((await dg(cwd, ["hooks", "install", "--shared"], env)).code).toBe(0);
    const settings = await settingsOf(path.join(cwd, ".claude", "settings.json"));
    expect(settings.hooks["SessionStart"]).toEqual([
      { hooks: [{ type: "command", command: "dg --actor agent hook SessionStart --payload -" }] },
    ]);
  });

  it("束ねていない dg（clone）は、起動ファイルの環境変数があっても node と dg.js を書く。起動ファイルも current もなければ、入れ直すか外す案内を出す（t735, t742）", async () => {
    const cwd = await repo();
    const launcher = path.join(await tempHome(), "dg");
    const env = { DEGUBOARD_LAUNCHER: launcher };
    expect((await dg(cwd, ["hooks", "install"], env)).code).toBe(0);
    const settings = await settingsOf(path.join(cwd, ".claude", "settings.local.json"));
    const command = JSON.stringify(settings.hooks["SessionStart"]);
    expect(command).not.toContain(launcher);
    expect(command).toContain(process.execPath);

    // 起動ファイルを指すフック（dg hooks install --command で書いた形）が、なくなっていれば（current もないので拡張は消えている）入れ直すか外す案内を出す
    expect((await dg(cwd, ["hooks", "install", "--command", `"${launcher}"`], env)).code).toBe(0);
    const gone = await checkOf(cwd, [], env);
    expect(gone.warnings).toContainEqual(expect.stringContaining("dg hooks install again"));
    expect(gone.warnings.join("\n")).not.toContain("Open VS Code");
  });

  it("フックがなければ、設定に dg のフックがないと警告する（終了コードは 0）", async () => {
    const cwd = await repo();
    const result = await checkOf(cwd);
    expect(result.data.events.every((e) => !e.installed && e.handler === null)).toBe(true);
    expect(result.warnings).toContainEqual(expect.stringContaining("no dg hooks"));
  });

  it("入れたフックは入っていると報告し、ハンドラが --version で動くことを確かめる。動かないコマンドは見つからないと警告する", async () => {
    const cwd = await repo();
    await dg(cwd, ["hooks", "install", "--command", process.execPath]);
    const ok = await checkOf(cwd);
    expect(ok.data.events.every((e) => e.installed && e.handler === "ok")).toBe(true);
    // ハンドラが動いても、まだ届いていないことだけは警告に残る（下の t697 のテスト）
    expect(ok.warnings).toEqual([expect.stringContaining("never received")]);

    // 絶対パスでない名前は PATH から探す（なくなった絶対パスは gone で、下の t698 のテスト）
    await dg(cwd, ["hooks", "install", "--command", "dg-for-test-not-on-path"]);
    const broken = await checkOf(cwd);
    expect(broken.data.events.every((e) => e.handler === "missing")).toBe(true);
    expect(broken.warnings).toContainEqual(expect.stringContaining("not found"));
  });

  it("既定の install が書いた引用した絶対パスの命令を確かめられ、node か dg.js のパスがなくなっていれば名前を出して警告する（t698）", async () => {
    const cwd = await repo();
    await dg(cwd, ["hooks", "install"]);
    const ok = await checkOf(cwd);
    expect(ok.data.events.every((e) => e.installed && e.handler === "ok")).toBe(true);

    const home = await tempHome();
    const gone = path.join(home, "node-24.0.0", "bin", "node");
    await dg(cwd, ["hooks", "install", "--command", `"${gone}" "${path.join(home, "dg.js")}"`]);
    const broken = await checkOf(cwd);
    expect(broken.data.events.every((e) => e.handler === "gone")).toBe(true);
    expect(broken.warnings).toContainEqual(
      expect.stringMatching(
        new RegExp(`${gone.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*no longer exists`),
      ),
    );
    expect(broken.warnings).toContainEqual(expect.stringContaining("Run dg hooks install again"));
  });

  it("シェルの書き方を含むハンドラは、確かめられないと報告して警告する", async () => {
    const cwd = await repo();
    await dg(cwd, ["hooks", "install", "--command", "~/bin/dg"]);
    const result = await checkOf(cwd);
    expect(result.data.events.every((e) => e.handler === "unverified")).toBe(true);
    expect(result.warnings).toContainEqual(expect.stringContaining("cannot be verified"));
  });

  it("直近の入力で受け取らなかった項目があれば、項目の名前を警告する。記録がなければ警告しない", async () => {
    const cwd = await repo();
    await dg(cwd, ["hooks", "install", "--command", process.execPath]);
    const before = await checkOf(cwd);
    expect(before.data.events.find((e) => e.event === "PostToolUse")!.received_at).toBeNull();
    expect(before.warnings.some((w) => w.includes("直近の入力"))).toBe(false);

    await recordOf(cwd, "PostToolUse", { session_id: true, "tool_response.agentId": false });
    const after = await checkOf(cwd);
    const post = after.data.events.find((e) => e.event === "PostToolUse")!;
    expect(post.missing).toEqual(["tool_response.agentId"]);
    expect(after.warnings).toContainEqual(expect.stringContaining("lacks tool_response.agentId"));
  });

  it("PreToolUse の Bash で command が欠けていれば、check が警告する", async () => {
    const cwd = await repo();
    await dg(cwd, ["hooks", "install", "--command", process.execPath]);
    await recordOf(cwd, "PreToolUse", { tool_name: true, cwd: true, "tool_input.command": false });
    const result = await checkOf(cwd);
    expect(result.warnings).toContainEqual(expect.stringContaining("lacks tool_input.command"));
  });

  it("設定が一部だけ入っているときは、入っていないイベントを名前で警告する", async () => {
    const cwd = await repo();
    await dg(cwd, ["hooks", "install", "--command", process.execPath]);
    const file = path.join(cwd, ".claude", "settings.local.json");
    const settings = await settingsOf(file);
    delete settings.hooks["SessionEnd"];
    await writeFile(file, JSON.stringify(settings));
    const result = await checkOf(cwd);
    expect(result.data.events.find((e) => e.event === "SessionEnd")!.installed).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining("SessionEnd"));
  });

  it("--personal はリポジトリの外でも動き、入力の記録は確かめずに飛ばす", async () => {
    const home = await tempHome();
    const outside = await tempHome();
    const env = { HOME: home };
    await dg(outside, ["hooks", "install", "--personal", "--command", process.execPath], env);
    const result = await checkOf(outside, ["--personal"], env);
    expect(result.data.events.every((e) => e.installed && e.handler === "ok")).toBe(true);
    expect(result.data.events.every((e) => e.received_at === null)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("入れてあるのに一度も届いていないイベントを、ハンドラが動いても警告する。すべて届けば警告しない（t697）", async () => {
    const cwd = await repo();
    await dg(cwd, ["hooks", "install", "--command", process.execPath]);
    await recordOf(cwd, "SessionStart", { session_id: true });
    const some = await checkOf(cwd);
    const never = some.warnings.find((w) => w.includes("never received"));
    expect(never).toContain("PreToolUse");
    expect(never).not.toContain("SessionStart");

    const all = some.data.events.map((e) => e.event);
    for (const event of all) await recordOf(cwd, event, {});
    expect((await checkOf(cwd)).warnings).toEqual([]);
  });

  it("Claude Code の中で呼んだセッションにフックが届いていなければ警告し、dg hook が届けば警告しない（t697）", async () => {
    const cwd = await repo();
    await dg(cwd, ["init"]);
    await dg(cwd, ["hooks", "install", "--command", process.execPath]);
    const home = await tempHome();
    const env = { HOME: home, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "sess-697" };
    const before = await checkOf(cwd, [], env);
    expect(before.warnings).toContainEqual(
      expect.stringContaining("No dg hook has reached this claude-code session (sess-697)"),
    );

    const payload = path.join(home, "payload.json");
    await writeFile(
      payload,
      JSON.stringify({ session_id: "sess-697", transcript_path: "/x.jsonl" }),
    );
    const hook = await dg(cwd, ["--actor", "agent", "hook", "SessionStart", "--payload", payload], {
      HOME: home,
      CLAUDE_ENV_FILE: path.join(home, "env.sh"),
    });
    expect(hook.code).toBe(0);
    const after = await checkOf(cwd, [], env);
    expect(after.warnings.some((w) => w.includes("No dg hook has reached"))).toBe(false);
  });

  it("dg hook の中で出た警告（標準エラーに出るだけのもの）を、まだ知らせていなければ一度だけ知らせる（t756）", async () => {
    const cwd = await repo();
    await dg(cwd, ["init"]);
    await dg(cwd, ["hooks", "install", "--command", process.execPath]);
    const home = await tempHome();
    const payload = path.join(home, "payload.json");
    await writeFile(
      payload,
      JSON.stringify({ session_id: "sess-756", transcript_path: "/x.jsonl" }),
    );
    // 環境を書くファイルが渡されないので、フックの中で警告になる（終了コードは 0）
    const hook = await dg(cwd, ["--actor", "agent", "hook", "SessionStart", "--payload", payload], {
      HOME: home,
    });
    expect(hook.code).toBe(0);
    expect(hook.err).toContain("No file to write the environment to was given");
    const reported = (w: string) =>
      w.startsWith("dg hook SessionStart") &&
      w.includes("session sess-756") &&
      w.includes("No file to write the environment to was given");
    expect((await checkOf(cwd, [], { HOME: home })).warnings.filter(reported)).toHaveLength(1);
    expect((await checkOf(cwd, [], { HOME: home })).warnings.filter(reported)).toEqual([]);
  });

  it("JSON では警告は最上位の warnings に出て、data には入らない", async () => {
    const cwd = await repo();
    const result = await checkOf(cwd);
    expect(result).not.toHaveProperty("data.warnings");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("入れてある dg の Skill が今の dg のものより古ければ、名前と dg skill install を警告する。手を加えたものは --force を分けて出し、dg skill install と同じ判定になる（t858）", async () => {
    const cwd = await repo();
    const home = await tempHome();
    const env = { HOME: home };
    const aboutSkills = async () =>
      (await checkOf(cwd, [], env)).warnings.filter((w) => w.includes("dg skill install"));
    /** 入れた Skill を、前の版の dg が入れたままのもの（古い Skill）にする。note を足すと手を加えたものになる */
    const makeOlder = async (base: string, name: string, note = "") => {
      const current = await readFile(skillFileOf(base, name), "utf8");
      await putSkill(base, name, olderVersionOf(current) + note);
    };

    // 入れていないときと、入れたばかり（今の dg と同じ）のときは何も足さない
    expect(await aboutSkills()).toEqual([]);
    expect((await dg(cwd, ["skill", "install"], env)).code).toBe(0);
    expect((await dg(cwd, ["skill", "install", "--personal"], env)).code).toBe(0);
    expect(await aboutSkills()).toEqual([]);

    await makeOlder(cwd, "dgwork");
    await makeOlder(cwd, "dgplan", "\nmy note\n");
    await makeOlder(home, "dgdone");
    const projectDir = skillsDir(cwd);
    const personalDir = skillsDir(home);
    const edited = `These dg Skills in ${projectDir} are older than this dg and were edited by hand, so dg skill install keeps them: dgplan. To overwrite them with the current Skills, run dg skill install --force`;
    expect(await aboutSkills()).toEqual([
      `These dg Skills in ${projectDir} are older than this dg (they differ from the Skills bundled with it): dgwork. Update them with dg skill install`,
      edited,
      `These dg Skills in ${personalDir} are older than this dg (they differ from the Skills bundled with it): dgdone. Update them with dg skill install --personal`,
    ]);

    // 案内のとおりに入れ直すと、警告と同じ分け方で更新され（手を加えたものは残る）、警告が消える
    const installed = JSON.parse((await dg(cwd, ["--json", "skill", "install"], env)).out) as {
      data: { updated: string[]; conflicts: string[] };
    };
    expect(installed.data).toMatchObject({ updated: ["dgwork"], conflicts: ["dgplan"] });
    expect((await dg(cwd, ["skill", "install", "--personal"], env)).code).toBe(0);
    expect(await aboutSkills()).toEqual([edited]);
    expect((await dg(cwd, ["skill", "install", "--force"], env)).code).toBe(0);
    expect(await aboutSkills()).toEqual([]);
  });
});
