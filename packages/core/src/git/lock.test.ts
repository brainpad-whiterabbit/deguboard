import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
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
    // 消す役の印（.break）を残さない
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
    // 経過時間の上限は負荷で揺れるので見ない。待ち時間の上限で出るエラー（stat のエラーを添える）で止まったことを確かめる
    await expect(
      withLock(
        dir,
        "write",
        async () => {
          entered = true;
        },
        { waitMs: 200 },
      ),
    ).rejects.toMatchObject({
      code: "GIT_ERROR",
      message: expect.stringMatching(/別の dg が書き込み中.*EACCES/),
    });
    expect(entered).toBe(false);
    await expect(access(lockPath)).resolves.toBeUndefined();
  });

  it("自分のロックが古いと判定されて消され、別の待ち手が取り直していれば、終わったときにそのロックを消さない", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    await withLock(dir, "write", async () => {
      // 持ち主の処理中に、古いと判定されて消され、別の待ち手が取り直したことにする
      await rm(lockPath);
      await writeFile(lockPath, "2147483645");
    });
    expect(await readFile(lockPath, "utf8")).toBe("2147483645");
  });

  it("process.kill が EPERM を返す（他ユーザの生きた）持ち主のロックは古いと扱わない", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    await writeFile(lockPath, "4242");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    cleanups.push(async () => kill.mockRestore());
    await expect(
      withLock(dir, "write", async () => undefined, { waitMs: 200 }),
    ).rejects.toMatchObject({ code: "GIT_ERROR" });
    expect(await readFile(lockPath, "utf8")).toBe("4242");
  });

  it("消す役が落ちて残った .break の印は、60 秒より古ければ片付けて古いロックを奪える", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    const old = new Date(Date.now() - 120_000);
    await writeFile(lockPath, "2147483646");
    await writeFile(`${lockPath}.break`, "");
    await utimes(`${lockPath}.break`, old, old);
    let entered = false;
    await withLock(
      dir,
      "write",
      async () => {
        entered = true;
      },
      { waitMs: 2_000 },
    );
    expect(entered).toBe(true);
    expect(await readdir(path.join(dir, "locks"))).toEqual([]);
  });

  it("新しい .break の印が残っていれば古いロックを消さず、待ち時間の上限で止まる", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    await writeFile(lockPath, "2147483646");
    await writeFile(`${lockPath}.break`, "");
    await expect(withLock(dir, "write", async () => undefined, { waitMs: 200 })).rejects.toThrow(
      /\.break/,
    );
    expect(await readFile(lockPath, "utf8")).toBe("2147483646");
  });

  it("持ち主が生きていれば、古いと判定する時間を超えて持ち続けても他の待ち手に消されない（ハートビート）", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    const staleMs = 200;
    let inside = 0;
    let most = 0;
    const order: string[] = [];
    let firstMtime = 0;
    let lastMtime = 0;
    // 持ち主がロックを取った合図。待ち手はこれを待ってから始めるので、順序を待ち時間に頼らない
    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const owner = withLock(
      dir,
      "write",
      async () => {
        inside += 1;
        order.push("owner-in");
        firstMtime = (await stat(lockPath)).mtimeMs;
        signalAcquired();
        // 古いと判定する時間の 3 倍持ち続ける（待ち手はこの間ずっと待つ）
        await sleep(staleMs * 3);
        lastMtime = (await stat(lockPath)).mtimeMs;
        order.push("owner-out");
        inside -= 1;
      },
      { staleMs },
    );
    await acquired;
    const waiter = withLock(
      dir,
      "write",
      async () => {
        inside += 1;
        most = Math.max(most, inside);
        order.push("waiter-in");
        inside -= 1;
      },
      { staleMs, waitMs: 30_000 },
    );
    await Promise.all([owner, waiter]);
    expect(most).toBe(1);
    expect(order).toEqual(["owner-in", "owner-out", "waiter-in"]);
    // 持ち主が持つ間に mtime が更新されていた（現在時刻との差は負荷で揺れるので、取ったときの mtime と比べる）
    expect(lastMtime).toBeGreaterThan(firstMtime);
  }, 60_000);

  it("持ち主がハートビートを止めた（落ちた）ロックは、古いと判定する時間の後に奪える", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    // 自分の pid を書くと pid では生死を見ないので、mtime だけで判定される
    await writeFile(lockPath, `${process.pid} ${os.hostname()}`);
    let entered = false;
    await withLock(
      dir,
      "write",
      async () => {
        entered = true;
      },
      { staleMs: 200, waitMs: 5_000 },
    );
    expect(entered).toBe(true);
  });

  it("別のホストの持ち主は pid で生死を判定せず、mtime が新しければ消さない", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    // このホストでは生きていない pid でも、別のホストでは生きているかもしれない
    await writeFile(lockPath, "2147483646 another-host.invalid");
    await expect(
      withLock(dir, "write", async () => undefined, { waitMs: 200 }),
    ).rejects.toMatchObject({ code: "GIT_ERROR" });
    expect(await readFile(lockPath, "utf8")).toBe("2147483646 another-host.invalid");
  });

  it("別のホストの持ち主のロックも、mtime が古ければ奪える", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    await writeFile(lockPath, "4242 another-host.invalid");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    let entered = false;
    await withLock(dir, "write", async () => {
      entered = true;
    });
    expect(entered).toBe(true);
  });

  it("ロックの中身に pid とホスト名を書く", async () => {
    const dir = await localDir();
    const lockPath = path.join(dir, "locks", "write");
    let content = "";
    await withLock(dir, "write", async () => {
      content = await readFile(lockPath, "utf8");
    });
    expect(content).toBe(`${process.pid} ${os.hostname()}`);
  });
});
