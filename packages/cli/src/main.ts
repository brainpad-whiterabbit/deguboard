// bin/dg.js から呼ばれる入口

import { run } from "./program.js";

/** stdinText は bin/dg.js の速い経路が先に読んだ標準入力（受け持たなかったとき。t768） */
export async function main(argv: string[], opts: { stdinText?: string } = {}): Promise<number> {
  return run(argv, opts.stdinText !== undefined ? { stdinText: opts.stdinText } : {});
}
