// bin/dg.js から呼ばれる入口

import { run } from "./program.js";

export async function main(argv: string[]): Promise<number> {
  return run(argv);
}
