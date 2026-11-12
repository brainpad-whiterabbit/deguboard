// bin/dg.js が Node 24 より古い node で止まることを確かめる（t782）。判定は bin/node-version.mjs の関数で、
// bin/dg.js は起動の最初にそれを呼ぶ。実際の node の版は変えられないので、判定の関数を版ごとに確かめる。
// bin/dg.js の配線は、Node 24 より古い node（例：/usr/bin/node が 20 の環境）で `node packages/cli/bin/dg.js` を動かして確かめる。

import { describe, expect, it } from "vitest";
import { nodeVersionProblemOf, REQUIRED_NODE_MAJOR } from "../../packages/cli/bin/node-version.mjs";

describe("bin/dg.js の Node の版の確かめ（t782）", () => {
  it("要る版は 24（launcher.ts と同じ基準）", () => {
    expect(REQUIRED_NODE_MAJOR).toBe(24);
  });

  it("24 より古い node は、要る版と直し方を英語で書いた文を返す", () => {
    const problem = nodeVersionProblemOf("22.22.0");
    expect(problem).toContain("Node.js 24 or later");
    expect(problem).toContain("v22.22.0");
    expect(problem).toContain("mise run dg --");
    expect(problem?.endsWith("\n")).toBe(true);
  });

  it("20 系も同じく止める", () => {
    expect(nodeVersionProblemOf("20.19.2")).toContain("v20.19.2");
  });

  it("24 以上の node は通す", () => {
    expect(nodeVersionProblemOf("24.0.0")).toBeUndefined();
    expect(nodeVersionProblemOf("24.22.2")).toBeUndefined();
    expect(nodeVersionProblemOf("25.1.0")).toBeUndefined();
  });

  it("版が読めないときは止めない", () => {
    expect(nodeVersionProblemOf("")).toBeUndefined();
    expect(nodeVersionProblemOf("dev")).toBeUndefined();
  });
});
