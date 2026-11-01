import { access, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slowLock } from "../../test/helpers/slow-lock.js";
import { withLock } from "./lock.js";

vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/helpers/slow-lock.js")).withSlowLock(await importOriginal()),
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  slowLock.enabled = false;
  slowLock.statError = undefined;
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function localDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deguboard-lock-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "locks"));
  return dir;
}

describe("withLock", () => {
  it("取得を遅らせて競合しやすくしても、同時に入るのは 1 つだけ（解放直後の ENOENT で他者の取り直したロックを消さない）", async () => {
    const dir = await localDir();
    slowLock.enabled = true;
    let inside = 0;
    let most = 0;
    let done = 0;
    // 窓は乱数の待ちで開くので、何回か繰り返して見逃しにくくする
    for (let round = 0; round < 5; round++) {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          withLock(dir, "write", async () => {
            inside += 1;
            most = Math.max(most, inside);
            await sleep(5);
            inside -= 1;
            done += 1;
          }),
        ),
      );
    }
    expect(done).toBe(40);
    expect(most).toBe(1);
  });

  it("古いロックを複数の待ち手が同時に消しにいっても、他者の取り直したロックを消さず同時に入るのは 1 つだけ", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    slowLock.enabled = true;
    let inside = 0;
    let most = 0;
    let done = 0;
    for (let round = 0; round < 5; round++) {
      // 2 分前に書かれた古いロックを置く（mtime で古いと判定される）
      await writeFile(lockPath, String(process.pid));
      const old = new Date(Date.now() - 120_000);
      await utimes(lockPath, old, old);
      await Promise.all(
        Array.from({ length: 8 }, () =>
          withLock(dir, "write", async () => {
            inside += 1;
            most = Math.max(most, inside);
            await sleep(5);
            inside -= 1;
            done += 1;
          }),
        ),
      );
    }
    expect(done).toBe(40);
    expect(most).toBe(1);
    // rename で奪った古いロックの一時ファイルを残さない
    expect(await readdir(path.join(dir, "locks"))).toEqual([]);
  });

  it("持ち主のプロセスが死んだロックは奪って入れる", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    // pid の上限を超える番号は生きたプロセスにならない
    await writeFile(lockPath, "2147483646");
    let entered = false;
    await withLock(dir, "write", async () => {
      entered = true;
    });
    expect(entered).toBe(true);
  });

  it("stat が ENOENT 以外のエラーを返し続けても、ロックを消さずに待ち時間の上限で止まる", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    await writeFile(lockPath, String(process.pid));
    slowLock.statError = "EACCES";
    let entered = false;
    const started = Date.now();
    await expect(
      withLock(
        dir,
        "write",
        async () => {
          entered = true;
        },
        { waitMs: 200 },
      ),
    ).rejects.toMatchObject({ code: "GIT_ERROR" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(entered).toBe(false);
    await expect(access(lockPath)).resolves.toBeUndefined();
  });
});
