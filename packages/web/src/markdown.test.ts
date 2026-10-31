import { describe, expect, it } from "vitest";
import { parseBlocks } from "./markdown.js";

describe("本文の Markdown", () => {
  it("見出し・段落・チェックリストに分ける", () => {
    const blocks = parseBlocks(
      "## 概要\n\n1 行目\n2 行目\n\n## 受け入れ条件\n\n- [ ] a\n- [x] b\n- c\n",
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "概要" },
      { kind: "paragraph", text: "1 行目 2 行目" },
      { kind: "heading", level: 2, text: "受け入れ条件" },
      {
        kind: "list",
        items: [
          { checked: false, text: "a" },
          { checked: true, text: "b" },
          { checked: null, text: "c" },
        ],
      },
    ]);
  });
});
