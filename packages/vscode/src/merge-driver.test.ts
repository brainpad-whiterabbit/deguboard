// 拡張だけで使ったリポジトリの同期が、同梱の dg を呼ぶマージドライバを登録して使うこと（SY-4、t759）。
// 起動ファイル（launcher.ts）は本物を書き、その先の dg.mjs だけを、ビルドせずに core の src のドライバを呼ぶものに替える

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalClient,
  init,
  mergeDriverCommandLine,
  openContext,
  runCommand,
} from "@deguboard/core";
import { createFixture, git, type Fixture } from "../../core/test/helpers/git-fixture.js";
import {
  installLauncher,
  launcherDir,
  launcherFileOf,
  mergeDriverOf,
  type Current,
} from "./launcher.js";

const CORE_DRIVER = fileURLToPath(
  new URL("../../core/test/helpers/merge-driver.mjs", import.meta.url),
);

let home: string;
let savedHome: string | undefined;
let fixture: Fixture | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "dg-ext-driver-"));
  // 起動ファイルは $HOME/.local/share/deguboard/current を読む。git が起こすドライバにこの HOME を届ける
  savedHome = process.env["HOME"];
  process.env["HOME"] = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  await fixture?.cleanup();
  fixture = undefined;
  rmSync(home, { recursive: true, force: true });
});

/** 同梱の dg.mjs の代わり。merge-driver だけを受け、core の src のドライバに渡す */
function fakeBundledDg(): string {
  const file = path.join(home, "ext", "dist", "cli", "dg.mjs");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      `import { spawnSync } from "node:child_process";`,
      `const [command, ...args] = process.argv.slice(2);`,
      `if (command !== "merge-driver") process.exit(2);`,
      `const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-transform-types", ${JSON.stringify(CORE_DRIVER)}, ...args], { stdio: "inherit" });`,
      `process.exit(r.status ?? 1);`,
      "",
    ].join("\n"),
  );
  return file;
}

describe("拡張の同期のマージドライバ（t759）", () => {
  it("起動ファイルを書ける環境では起動ファイルを、書けない環境（Windows）では拡張ホストの node と同梱の dg.mjs を指す", () => {
    const mine: Current = { version: "1.0.0", node: "/opt/code/code", dg: "/ext/dist/cli/dg.mjs" };
    expect(mergeDriverOf(mine, { home: "/home/u", platform: "linux" })).toEqual([
      launcherFileOf("/home/u"),
      "merge-driver",
    ]);
    expect(mergeDriverOf(mine, { platform: "win32" })).toEqual([
      "ELECTRON_RUN_AS_NODE=1",
      "/opt/code/code",
      "/ext/dist/cli/dg.mjs",
      "merge-driver",
    ]);
  });

  it("拡張だけで使ったリポジトリで、同じチケットの近いフィールドを両側で変えても同期が止まらない", async () => {
    const mine: Current = { version: "1.0.0", node: process.execPath, dg: fakeBundledDg() };
    expect(await installLauncher(mine, { dir: launcherDir(home) })).toBe("written");
    const f = (fixture = await createFixture());
    const driver = mergeDriverOf(mine, { home });

    // ドライバを登録しない init（属性ファイルだけが置かれる状態）から、拡張の同期だけを使う
    const extensionClient = async (cwd: string) => {
      await runCommand(
        init,
        await openContext({ cwd, actor: { kind: "human", user: "eiki" }, initialize: {} }),
        {},
      );
      return createLocalClient({ cwd, user: "eiki", mergeDriver: driver });
    };
    const a = await extensionClient(f.cloneA);
    await a.run("ticket.create", { title: "ログイン" });
    await a.run("sync");
    const b = await extensionClient(f.cloneB);
    await b.run("sync");
    const registered = await git(f.cloneB, ["config", "--get", "merge.deguboard.driver"]);
    expect(registered.stdout.trim()).toBe(mergeDriverCommandLine(driver));

    // priority と labels は frontmatter の隣り合う行。ドライバがなく行単位のマージになると、ここで同期が止まる
    await a.run("ticket.update", { ticket: "t1", priority: "high" });
    await a.run("sync");
    await b.run("ticket.update", { ticket: "t1", labels: ["ui"] });
    const synced = await b.run<{ conflicts: string[]; pushed: boolean }>("sync");
    expect(synced.data.conflicts).toEqual([]);
    expect(synced.data.pushed).toBe(true);
    expect(synced.warnings.filter((w) => w.includes("merge.deguboard.driver"))).toEqual([]);
    const status = await b.status();
    const text = await readFile(path.join(status.data_dir, "tickets", "t1.md"), "utf8");
    expect(text).toContain("priority: high\nlabels: [ui]\n");
  });
});
