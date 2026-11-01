import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
});
