// ファイルの有無。core の中でファイルがあるかを調べるときはこれを使う

import { access } from "node:fs/promises";

/** パスにファイルかディレクトリがあるか。読めないときも false */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
