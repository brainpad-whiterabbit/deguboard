// ロックの取得を遅らせ、withLock の競合を起こしやすくする（vi.mock("node:fs/promises") の factory で使う）
//
// 有効にすると、"wx" の open が EEXIST で失敗したときと stat・readdir の結果を返すときに少し待つ。
// 前の持ち主が解放した直後に stat が ENOENT を見て、その結果を返すまでに別の待ち手が取り直す窓が広がり、
// 取り直した側がロックの中で読み終えて書く前に、もう一方が入る窓も広がる

import { setTimeout as sleep } from "node:timers/promises";

type FsPromises = typeof import("node:fs/promises");

export const slowLock = { enabled: false, delayMs: 15 };

const pause = () => sleep(Math.random() * slowLock.delayMs);

export function withSlowLock(actual: FsPromises): FsPromises {
  const open: FsPromises["open"] = async (...args) => {
    try {
      return await actual.open(...args);
    } catch (error) {
      if (slowLock.enabled && args[1] === "wx") await pause();
      throw error;
    }
  };
  const stat = (async (...args: Parameters<FsPromises["stat"]>) => {
    if (!slowLock.enabled) return actual.stat(...args);
    const settled = await actual.stat(...args).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await pause();
    if ("error" in settled) throw settled.error;
    return settled.value;
  }) as FsPromises["stat"];
  const readdir = (async (...args: Parameters<FsPromises["readdir"]>) => {
    const entries = await actual.readdir(...args);
    if (slowLock.enabled) await pause();
    return entries;
  }) as FsPromises["readdir"];
  return { ...actual, open, stat, readdir };
}
