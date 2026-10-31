import { describe, expect, it } from "vitest";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter.js";

describe("frontmatter", () => {
  it("frontmatter と本文に分け、結合すると元に戻る", () => {
    const text = "---\nid: t1\ntitle: x\n---\n\n## 概要\n\n本文\n";
    const split = splitFrontmatter(text);
    expect(split).toEqual({ yaml: "id: t1\ntitle: x\n", body: "\n## 概要\n\n本文\n" });
    if (typeof split === "object") expect(joinFrontmatter(split.yaml, split.body)).toBe(text);
  });

  it("BOM と CRLF を許し、閉じがなければ unterminated を返す", () => {
    const split = splitFrontmatter("﻿---\r\nid: t1\r\n---\r\nbody");
    expect(split).toEqual({ yaml: "id: t1\r\n", body: "body" });
    expect(splitFrontmatter("---\nid: t1\n")).toBe("unterminated");
    expect(splitFrontmatter("# 見出し\n")).toBeUndefined();
  });
});
