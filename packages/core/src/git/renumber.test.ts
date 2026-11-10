import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixture, git, type Fixture } from "../../test/helpers/git-fixture.js";
import { openContext } from "../commands/context.js";
import { runCommand } from "../commands/define.js";
import { init, sync } from "../commands/setup.js";
import { ticketCreate, ticketUpdate } from "../commands/ticket.js";
import { renumberCollisions, renumberProvisional } from "./renumber.js";
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

/** b がオフラインで起票した仮番号の t2 が、a の push した t2 と衝突し、b にまとめ待ちがある状態を作る */
async function collided() {
  return (await collidedWithA()).b;
}

/** collided と同じ状態を作り、リモートに push する側の a も返す */
async function collidedWithA() {
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
  return { a, b };
}

describe("仮番号の振り直し（renumberProvisional、--resolve なしの sync）", () => {
  it("リモートが同じファイルの別のフィールドを変えていても、振り直した後にリモートとローカルの両方の変更が残る", async () => {
    // b のまとめ待ちは t1 の題と t2 の優先度。その間に a が t1 の別のフィールド（優先度）を変えて push する
    const { a, b } = await collidedWithA();
    await runCommand(ticketUpdate, a, { ticket: "t1", priority: "low" });
    await runCommand(sync, a, {});

    const synced = await runCommand(sync, b, {});
    expect(synced.data.renumbered).toEqual([{ from: "t2", to: "t3" }]);
    expect(synced.data.conflicts).toEqual([]);
    expect(synced.data.pushed).toBe(true);
    // t1 にはリモートの優先度とローカルの題の両方が残り、t2 はリモートのまま、b の t2 は t3 になる
    expect(b.store.tickets.get("t1")?.data).toMatchObject({ title: "B の題", priority: "low" });
    expect(b.store.tickets.get("t2")?.data.title).toBe("A の 2");
    expect(b.store.tickets.get("t3")?.data).toMatchObject({ title: "B の 2", priority: "high" });

    await runCommand(sync, a, {});
    expect(a.store.tickets.get("t1")?.data).toMatchObject({ title: "B の題", priority: "low" });
    expect(a.store.tickets.get("t3")?.data.title).toBe("B の 2");
  });

  // diff-tree は分岐点の上の積み直しの途中、show-ref は振り直した後の取り込み（integrate の最初の git）の失敗
  it.each(["diff-tree", "show-ref"])(
    "振り直しが途中（%s）で失敗したら、元の先端に戻してまとめ待ちの中身を書き戻す",
    async (subcommand) => {
      const b = await collided();
      const dir = b.repo.dataDir;
      const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
      const status = (await git(dir, ["status", "--porcelain"])).stdout;
      const t1 = await readFile(path.join(dir, "tickets/t1.md"), "utf8");
      const t2 = await readFile(path.join(dir, "tickets/t2.md"), "utf8");
      expect(status).not.toBe("");

      failing.subcommand = subcommand;
      await expect(renumberProvisional(b.repo, ["tickets/t2.md"])).rejects.toThrow("故意の失敗");
      failing.subcommand = undefined;

      expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
      expect((await git(dir, ["status", "--porcelain"])).stdout).toBe(status);
      expect(await readFile(path.join(dir, "tickets/t1.md"), "utf8")).toBe(t1);
      expect(await readFile(path.join(dir, "tickets/t2.md"), "utf8")).toBe(t2);
      expect((await git(dir, ["ls-files", "--others"])).stdout).toBe("");
    },
  );

  it("振り直した後の取り込みも競合したら、元の先端に戻して残った競合を戻した番号で返す", async () => {
    const { a, b } = await collidedWithA();
    // b のまとめ待ちを先にコミットし、a が t1 の同じフィールド（題）を変えて push する
    await runCommand(sync, a, {});
    await git(b.repo.dataDir, ["add", "-A"]);
    await git(b.repo.dataDir, ["commit", "-qm", "まとめ待ち"]);
    await runCommand(ticketUpdate, a, { ticket: "t1", title: "A の題" });
    await runCommand(sync, a, {});
    await fetchData(b.repo);
    const dir = b.repo.dataDir;
    const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();

    const r = await renumberProvisional(b.repo, ["tickets/t2.md"]);
    expect(r).toEqual({ renumbered: [], conflicts: ["tickets/t1.md"] });
    expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect((await git(dir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("仮番号の衝突でない競合があれば null を返し、何も変えない", async () => {
    const b = await collided();
    const head = (await git(b.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    expect(await renumberProvisional(b.repo, ["tickets/t2.md", "config.yaml"])).toBeNull();
    expect((await git(b.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
  });
});

describe("仮番号の振り直し（renumberCollisions）", () => {
  // diff-tree はファイルを書く前、log と add は振り直した番号のファイル（未追跡）を書いた後の失敗
  it.each(["diff-tree", "log", "add"])(
    "積み直しが途中（%s）で失敗したら、元の先端に戻してまとめ待ちの中身を書き戻し、未追跡のファイルを残さない",
    async (subcommand) => {
      const b = await collided();
      const dir = b.repo.dataDir;
      const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
      const status = (await git(dir, ["status", "--porcelain"])).stdout;
      const t1 = await readFile(path.join(dir, "tickets/t1.md"), "utf8");
      const t2 = await readFile(path.join(dir, "tickets/t2.md"), "utf8");
      expect(status).not.toBe("");

      failing.subcommand = subcommand;
      await expect(renumberCollisions(b.repo)).rejects.toThrow("故意の失敗");
      failing.subcommand = undefined;

      expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
      expect((await git(dir, ["status", "--porcelain"])).stdout).toBe(status);
      expect(await readFile(path.join(dir, "tickets/t1.md"), "utf8")).toBe(t1);
      expect(await readFile(path.join(dir, "tickets/t2.md"), "utf8")).toBe(t2);
      expect(t1).toContain("B の題");
      expect(t2).toContain("priority: high");
      expect((await git(dir, ["ls-files", "--others"])).stdout).toBe("");
    },
  );

  it("戻しも失敗したら、元のエラーを cause に付けて投げる", async () => {
    const b = await collided();
    // clean は作業ツリーを空にするときと戻すときの両方で呼ぶので、積み直しも戻しも失敗する
    failing.subcommand = "clean";
    const error = await renumberCollisions(b.repo).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Could not write the pending changes back");
    expect(((error as Error).cause as Error).message).toBe("故意の失敗");
  });
});
