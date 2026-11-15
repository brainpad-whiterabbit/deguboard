// hook-settings.ts（dg hooks install・uninstall・check の判定と書き込み）を、CLI を通さずに直接確かめる（t1003）。
// CLI から見た振る舞い（引数・出力・.gitignore・警告の文）は packages/cli/src/hooks.test.ts が見るので、
// ここは入口が渡すもの（self）の使い方と、入口を通さずに呼ぶ判定（hookInstallStateOf）を見る

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import { setBundleLayout } from "../bundle-layout.js";
import { UsageError } from "../errors.js";
import { runGit } from "../git/index.js";
import {
  checkHooks,
  hookInstallStateOf,
  hookScope,
  installHooks,
  uninstallHooks,
} from "./hook-settings.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setBundleLayout(undefined);
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-hooks-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** bare リモート付きのリポジトリの clone */
async function repoDir(): Promise<string> {
  const fixture = await createFixture();
  cleanups.push(fixture.cleanup);
  return fixture.cloneA;
}

/** 入口が渡す、いま動いている dg を呼ぶ語の並びの代わり */
const SELF = ["/opt/node 24/bin/node", "/opt/dg/bin/dg.js"];
/** 呼ばれたら落ちる self。入口の場所を引かずに済む場合を確かめる */
const noSelf = (): string[] => {
  throw new Error("self は呼ばれないはず");
};

const commandsOf = async (file: string, event: string) => {
  const settings = JSON.parse(await readFile(file, "utf8")) as {
    hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  return (settings.hooks?.[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
};

describe("installHooks・uninstallHooks（AG-9）", () => {
  it("追跡しない設定には、入口が渡した語（self）を二重引用符で囲んで書き、.gitignore に設定の行を足す", async () => {
    const cwd = await repoDir();
    const file = path.join(cwd, ".claude", "settings.local.json");
    const result = await installHooks({ cwd, scope: "local", env: {}, self: () => SELF });
    expect(result).toMatchObject({
      agent: "claude-code",
      scope: "local",
      file,
      unchanged: false,
      dryRun: false,
      ignoreFile: path.join(cwd, ".claude", ".gitignore"),
      warnings: [],
    });
    expect(await commandsOf(file, "Stop")).toEqual([
      `"/opt/node 24/bin/node" "/opt/dg/bin/dg.js" --actor agent hook Stop --payload -`,
    ]);
    expect(await readFile(path.join(cwd, ".claude", ".gitignore"), "utf8")).toBe(
      "settings.local.json\n",
    );
    // もう一度入れても重ならず、変わらない
    const again = await installHooks({ cwd, scope: "local", env: {}, self: () => SELF });
    expect(again).toMatchObject({ unchanged: true, ignoreFile: null });
    expect(await commandsOf(file, "Stop")).toHaveLength(1);
  });

  it("追跡する設定（project）・--command・起動ファイル経由では self を呼ばない", async () => {
    const cwd = await repoDir();
    const shared = await installHooks({ cwd, scope: "project", env: {}, self: noSelf });
    expect(await commandsOf(shared.file, "Stop")).toEqual([
      "dg --actor agent hook Stop --payload -",
    ]);
    const local = path.join(cwd, ".claude", "settings.local.json");
    await installHooks({ cwd, scope: "local", env: {}, command: "npx deguboard", self: noSelf });
    expect(await commandsOf(local, "Stop")).toEqual([
      "npx deguboard --actor agent hook Stop --payload -",
    ]);
    // 起動ファイル経由で動くのは束ねた dg
    setBundleLayout({ entry: "/ext/dist/cli/dg.mjs", guideDir: "/ext/dist", version: "9.8.7" });
    const env = { DEGUBOARD_LAUNCHER: "/home/u/.local/share/deguboard/dg" };
    await installHooks({ cwd, scope: "local", env, self: noSelf });
    expect(await commandsOf(local, "Stop")).toEqual([
      `"/home/u/.local/share/deguboard/dg" --actor agent hook Stop --payload -`,
    ]);
  });

  it("--dry-run は書かずに設定の全体を返し、uninstall は dg のフックだけを外す", async () => {
    const cwd = await repoDir();
    const file = path.join(cwd, ".claude", "settings.local.json");
    const dry = await installHooks({
      cwd,
      scope: "local",
      env: {},
      self: () => SELF,
      dryRun: true,
    });
    expect(dry).toMatchObject({ dryRun: true, unchanged: false, ignoreFile: null });
    expect(dry.content).toContain("hook SessionStart");
    await expect(readFile(file, "utf8")).rejects.toThrow();

    const mine = { type: "command", command: "echo mine" };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ hooks: { Stop: [{ hooks: [mine] }] } }));
    await installHooks({ cwd, scope: "local", env: {}, self: () => SELF });
    expect(await commandsOf(file, "Stop")).toHaveLength(2);
    const removed = await uninstallHooks({ cwd, scope: "local", env: {} });
    expect(removed).toMatchObject({ unchanged: false, warnings: [] });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      hooks: { Stop: [{ hooks: [mine] }] },
    });
  });

  it("追跡されている設定に書くと git rm --cached を案内する（git 層の trackedFiles を通す）", async () => {
    const cwd = await repoDir();
    const first = await installHooks({ cwd, scope: "local", env: {}, self: () => SELF });
    expect(first.warnings).toEqual([]);
    await runGit(cwd, ["add", "-f", ".claude/settings.local.json"]);
    const tracked = await installHooks({ cwd, scope: "local", env: {}, self: () => SELF });
    expect(tracked.warnings).toEqual([
      expect.stringContaining("git rm --cached .claude/settings.local.json"),
    ]);
  });

  it("hookScope は --personal と --shared を一緒に受け付けない", () => {
    expect(hookScope({})).toBe("local");
    expect(hookScope({ shared: true })).toBe("project");
    expect(hookScope({ personal: true })).toBe("personal");
    expect(() => hookScope({ personal: true, shared: true })).toThrow(UsageError);
  });
});

describe("checkHooks のハンドラの確かめ（AG-9）", () => {
  const handlersOf = async (cwd: string, command: string) => {
    await installHooks({ cwd, scope: "local", env: {}, command, self: noSelf });
    const result = await checkHooks({ cwd, scope: "local", env: {} });
    return { handlers: new Set(result.events.map((e) => e.handler)), warnings: result.warnings };
  };

  it("動く命令は ok、PATH にない命令は missing、終了コードが 0 でない命令は failed", async () => {
    const cwd = await repoDir();
    expect((await handlersOf(cwd, `"${process.execPath}"`)).handlers).toEqual(new Set(["ok"]));

    const missing = await handlersOf(cwd, "dg-for-test-not-on-path");
    expect(missing.handlers).toEqual(new Set(["missing"]));
    expect(missing.warnings).toContainEqual(expect.stringContaining("not found"));

    const script = path.join(await tempDir(), "fail.js");
    await writeFile(script, "process.exit(3);\n");
    const failed = await handlersOf(cwd, `"${process.execPath}" "${script}"`);
    expect(failed.handlers).toEqual(new Set(["failed"]));
    expect(failed.warnings).toContainEqual(expect.stringContaining("exited abnormally"));
  });
});

describe("hookInstallStateOf（フックが入っているかだけを見る）", () => {
  it("リポジトリの外では個人の設定だけを見て、入っていなければすべてのイベントを absent に返す", async () => {
    const home = await tempDir();
    const states = await hookInstallStateOf({ env: { HOME: home } });
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      scope: "personal",
      file: path.join(home, ".claude", "settings.json"),
      installed: false,
    });
    expect(states[0]!.absent).toHaveLength(7);
  });

  it("入れた設定だけを installed にし、checkHooks と同じ判定で、欠けたイベントと matcher の違うイベントを absent に返す", async () => {
    const cwd = await repoDir();
    const home = await tempDir();
    const env = { HOME: home };
    const { file } = await installHooks({ cwd, scope: "local", env, self: () => SELF });
    const stateOf = async () =>
      Object.fromEntries(
        (await hookInstallStateOf({ topLevel: cwd, env })).map((s) => [s.scope, s]),
      );
    const all = await stateOf();
    expect(Object.keys(all)).toEqual(["local", "project", "personal"]);
    expect(all["local"]).toEqual({ scope: "local", file, installed: true, absent: [] });
    expect(all["project"]).toMatchObject({ installed: false });
    expect(all["personal"]).toMatchObject({ installed: false });

    const settings = JSON.parse(await readFile(file, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string }>>;
    };
    delete settings.hooks["SessionEnd"];
    settings.hooks["PostToolUse"]![0]!.matcher = "Bash";
    await writeFile(file, JSON.stringify(settings));
    const partial = (await stateOf())["local"]!;
    expect(partial.installed).toBe(false);
    expect(partial.absent.sort()).toEqual(["PostToolUse", "SessionEnd"]);
    const checked = await checkHooks({ cwd, scope: "local", env });
    expect(
      checked.events
        .filter((e) => !e.installed)
        .map((e) => e.event)
        .sort(),
    ).toEqual(partial.absent);
  });
});
