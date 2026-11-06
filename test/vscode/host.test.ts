// host.ts の VS Code に触れない部分（環境変数の掃除・CSP 違反の判定・ディスプレイ番号の選び方）と、
// 落とした VS Code とスクリーンショットが git に入らないことを確かめる（t439）。実機を起動する検査は sidebar.vscode.ts（mise run test:vscode）

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanEnv, isCspViolation, pickDisplay, ROOT } from "./host.js";

describe("cleanEnv", () => {
  it("ELECTRON_RUN_AS_NODE・ELECTRON_*・VSCODE_*・NODE_OPTIONS を外し、DISPLAY を上書きする", () => {
    const env = cleanEnv(
      {
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
        VSCODE_IPC_HOOK_CLI: "/tmp/x.sock",
        VSCODE_NLS_CONFIG: "{}",
        NODE_OPTIONS: "--max-old-space-size=4096",
        DISPLAY: ":0",
        PATH: "/usr/bin",
        HOME: "/home/me",
        EMPTY: undefined,
      },
      ":99",
      { DEGUBOARD_USER: "vscode-test" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      DEGUBOARD_USER: "vscode-test",
      DISPLAY: ":99",
    });
  });
});

describe("isCspViolation", () => {
  it("Chromium の CSP 違反の文（新旧の言い回し）を見分ける", () => {
    expect(
      isCspViolation(
        "Applying inline style violates the following Content Security Policy directive 'style-src 'self''. Either the 'unsafe-inline' keyword ... The action has been blocked.",
      ),
    ).toBe(true);
    expect(
      isCspViolation(
        "Refused to apply inline style because it violates the following Content Security Policy directive: \"style-src 'self'\".",
      ),
    ).toBe(true);
    expect(
      isCspViolation(
        "Refused to load the script 'https://example.com/x.js' because it violates the following Content Security Policy directive: \"script-src 'nonce-abc'\".",
      ),
    ).toBe(true);
  });

  it("ほかの Console の error は違反にしない", () => {
    expect(isCspViolation("Uncaught TypeError: x is not a function")).toBe(false);
    expect(isCspViolation("Failed to load resource: net::ERR_FILE_NOT_FOUND")).toBe(false);
  });
});

describe("pickDisplay", () => {
  it("lock ファイルのない最初の番号を 99 から選ぶ", () => {
    expect(pickDisplay([])).toBe(99);
    expect(pickDisplay([".X99-lock", ".X100-lock", ".X11-unix", "other"])).toBe(101);
    expect(pickDisplay([".X100-lock"])).toBe(99);
  });
});

describe("git に入れないもの", () => {
  it(".gitignore に VS Code 本体の置き場とスクリーンショットの出し先がある", async () => {
    const lines = (await readFile(path.join(ROOT, ".gitignore"), "utf8")).split("\n");
    expect(lines).toContain(".vscode-test/");
    expect(lines).toContain("test/vscode/screenshots/");
  });
});
