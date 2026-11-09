import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixture, git, type Fixture } from "../../test/helpers/git-fixture.js";
import { openContext } from "../commands/context.js";
import { runCommand } from "../commands/define.js";
import { init, sync } from "../commands/setup.js";
import { ticketCreate, ticketUpdate } from "../commands/ticket.js";
import { renumberCollisions } from "./renumber.js";
import { fetchData } from "./sync.js";

// 積み直し（replay）の途中で git を失敗させるため、指定したサブコマンドだけ失敗させる runGit に差し替える
const failing = vi.hoisted(() => ({ subcommand: undefined as string | undefined }));
vi.mock("./run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run.js")>();
  return {
    ...actual,
    runGit: (cwd: string, args: readonly string[], opts?: Parameters<typeof actual.runGit>[2]) =>
      failing.subcommand !== undefined && args[0] === failing.subcommand
        ? Promise.reject(new Error("故意の失敗"))
        : actual.runGit(cwd, args, opts),
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  failing.subcommand = undefined;
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const DRIVER = [
  process.execPath,
  "--no-warnings",
  "--experimental-transform-types",
  fileURLToPath(new URL("../../test/helpers/merge-driver.mjs", import.meta.url)),
];

describe("仮番号の振り直し（renumberCollisions）", () => {
  it("積み直しが途中で失敗したら、元の先端に戻してまとめ待ちの中身を書き戻す", async () => {
    const f: Fixture = await createFixture();
    cleanups.push(f.cleanup);
    let tick = Date.parse("2026-11-01T00:00:00Z");
    const now = () => new Date((tick += 1000));
    const open = (cwd: string, initialize?: object) =>
      openContext({
        cwd,
        actor: { kind: "human", user: "eiki" },
        now,
        mergeDriver: DRIVER,
        initialize,
      });
    await runCommand(init, await open(f.cloneA, {}), {});
    const a = await open(f.cloneA);
    await runCommand(ticketCreate, a, { title: "ログイン" });
    await runCommand(sync, a, {});
    await runCommand(init, await open(f.cloneB, {}), {});
    const b = await open(f.cloneB);
    // b はオフラインで t2 を起票し（仮番号）、その間に a が t2 を起票して push する
    await git(f.cloneB, ["remote", "set-url", "origin", path.join(f.root, "nonexistent.git")]);
    await runCommand(ticketCreate, b, { title: "B の 2" });
    await runCommand(ticketCreate, a, { title: "A の 2" });
    await runCommand(sync, a, {});
    // b のまとめ待ち（未コミット）
    await runCommand(ticketUpdate, b, { ticket: "t2", priority: "high" });
    await runCommand(ticketUpdate, b, { ticket: "t1", title: "B の題" });
    await git(f.cloneB, ["remote", "set-url", "origin", f.remoteDir]);
    await fetchData(b.repo);

    const dir = b.repo.dataDir;
    const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    const status = (await git(dir, ["status", "--porcelain"])).stdout;
    const t1 = await readFile(path.join(dir, "tickets/t1.md"), "utf8");
    const t2 = await readFile(path.join(dir, "tickets/t2.md"), "utf8");
    expect(status).not.toBe("");

    failing.subcommand = "diff-tree";
    await expect(renumberCollisions(b.repo)).rejects.toThrow("故意の失敗");
    failing.subcommand = undefined;

    expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect((await git(dir, ["status", "--porcelain"])).stdout).toBe(status);
    expect(await readFile(path.join(dir, "tickets/t1.md"), "utf8")).toBe(t1);
    expect(await readFile(path.join(dir, "tickets/t2.md"), "utf8")).toBe(t2);
    expect(t1).toContain("B の題");
    expect(t2).toContain("priority: high");
  });
});
