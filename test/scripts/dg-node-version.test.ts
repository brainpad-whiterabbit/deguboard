// bin/dg.js が Node 24 より古い node で止まることを確かめる（t782）。判定は bin/node-version.mjs の関数で、
// bin/dg.js は起動の最初にそれを呼ぶ。実際の node の版は変えられないので、判定の関数を版ごとに確かめる。
// bin/dg.js の配線は、Node 24 より古い node（例：/usr/bin/node が 20 の環境）で `node packages/cli/bin/dg.js` を動かして確かめる。

import { describe, expect, it } from "vitest";
import {
  isPreToolUseHookArgv,
  nodeVersionExitCodeOf,
  nodeVersionProblemOf,
  REQUIRED_NODE_MAJOR,
} from "../../packages/cli/bin/node-version.mjs";
import { claudeCodeHooks } from "../../packages/core/src/agents/adapters/claude-code-hooks.js";
import { DEFAULT_HOOK_AGENT } from "../../packages/core/src/agents/fast-hooks.js";
import { hookArgv } from "../../packages/core/src/commands/hook-argv.js";

// dg hooks install が書くフックの引数（既定のエージェント）。hookArgv と同じ形を作り、形がずれたら検査が落ちる
const HOOK = hookArgv(DEFAULT_HOOK_AGENT, "PreToolUse");

describe("bin/dg.js の Node の版の確かめ（t782）", () => {
  it("要る版は 24（launcher.ts と同じ基準）", () => {
    expect(REQUIRED_NODE_MAJOR).toBe(24);
  });

  it("24 より古い node は、要る版と直し方を英語で書いた文を返す", () => {
    const problem = nodeVersionProblemOf("22.22.0");
    expect(problem).toContain("Node.js 24 or later");
    expect(problem).toContain("v22.22.0");
    expect(problem).toContain("mise run dg --");
    expect(problem?.endsWith("\n")).toBe(true);
  });

  it("20 系も同じく止める", () => {
    expect(nodeVersionProblemOf("20.19.2")).toContain("v20.19.2");
  });

  it("24 以上の node は通す", () => {
    expect(nodeVersionProblemOf("24.0.0")).toBeUndefined();
    expect(nodeVersionProblemOf("24.22.2")).toBeUndefined();
    expect(nodeVersionProblemOf("25.1.0")).toBeUndefined();
  });

  it("版が読めないときは止めない", () => {
    expect(nodeVersionProblemOf("")).toBeUndefined();
    expect(nodeVersionProblemOf("dev")).toBeUndefined();
  });

  it("古い node の PreToolUse のフックは、止めたことを英語で足す", () => {
    const problem = nodeVersionProblemOf("20.19.2", HOOK);
    expect(problem).toContain("PreToolUse hook");
    expect(problem).toContain("exit 2");
    expect(problem).toContain("dg hooks install");
  });

  it("古い node のほかのコマンドには、フックの文を足さない", () => {
    expect(nodeVersionProblemOf("20.19.2", ["--json", "status"])).not.toContain("PreToolUse");
  });
});

describe("古い node で止めるときの終了コード（t782）", () => {
  it("dg hooks install が書く hook PreToolUse（既定と別のエージェント）は終了コード 2 で止める（Claude Code がツールの呼び出しを拒む）", () => {
    expect(nodeVersionExitCodeOf(HOOK)).toBe(2);
    expect(nodeVersionExitCodeOf(hookArgv("other-agent", "PreToolUse"))).toBe(2);
  });

  it("グローバルオプションを前に付けた hook PreToolUse も 2", () => {
    expect(nodeVersionExitCodeOf(["--json", ...HOOK])).toBe(2);
    expect(nodeVersionExitCodeOf(["--actor", "agent", "--json", "hook", "PreToolUse"])).toBe(2);
    expect(nodeVersionExitCodeOf(["--actor=agent", "hook", "PreToolUse", "--payload", "-"])).toBe(
      2,
    );
    expect(nodeVersionExitCodeOf(["-C", "/repo", "--user", "x", "hook", "PreToolUse"])).toBe(2);
  });

  it("claude-code-hooks.ts の PreToolUse 以外のフックの event は、どれも 1 のまま", () => {
    const others = claudeCodeHooks.events
      .map((spec) => spec.event)
      .filter((event) => event !== "PreToolUse");
    expect(others.length).toBeGreaterThan(0);
    for (const event of others) {
      expect(nodeVersionExitCodeOf(hookArgv(DEFAULT_HOOK_AGENT, event))).toBe(1);
      expect(nodeVersionExitCodeOf(hookArgv("other-agent", event))).toBe(1);
    }
  });

  it("ほかのコマンドは 1 のまま（dist が無いときと同じ）", () => {
    expect(nodeVersionExitCodeOf(["--version"])).toBe(1);
    expect(nodeVersionExitCodeOf(["--json", "status"])).toBe(1);
    expect(nodeVersionExitCodeOf(["hook"])).toBe(1);
    expect(nodeVersionExitCodeOf([])).toBe(1);
  });

  it("知らないオプションが前にあるときは、フックとは判定せず 1", () => {
    expect(isPreToolUseHookArgv(["--no-color", "hook", "PreToolUse"])).toBe(false);
    expect(nodeVersionExitCodeOf(["--no-color", "hook", "PreToolUse"])).toBe(1);
  });
});
