// 原子的な書き込み（DT-1、NF-4）。同じディレクトリに一時ファイルを書き、fsync してから rename する

import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}
