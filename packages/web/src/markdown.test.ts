import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, parseBlocks, sectionTasks } from "./markdown.js";

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

  it("節ごとにタスクリストの済んだ数と全体を数える（見出しの名前に頼らない）", () => {
    const blocks = parseBlocks(
      [
        "## 概要",
        "",
        "本文",
        "",
        "- ただの箇条書き",
        "",
        "## やること",
        "",
        "- [x] a",
        "- [ ] b",
        "- 印のない行は数えない",
        "",
        "段落をはさむ",
        "",
        "- [X] c",
        "",
        "### 小見出し",
        "",
        "- [ ] d",
        "",
        "## メモ",
        "",
        "なし",
      ].join("\n"),
    );
    const counts = sectionTasks(blocks);
    const byHeading = Object.fromEntries(
      [...counts].map(([i, c]) => {
        const b = blocks[i]!;
        return [b.kind === "heading" ? b.text : "?", c];
      }),
    );
    expect(byHeading).toEqual({
      やること: { done: 2, total: 3 },
      小見出し: { done: 0, total: 1 },
    });
  });

  it("見出しの前のタスクリストは数えず、見出しがなければ何も返さない", () => {
    expect(sectionTasks(parseBlocks("- [x] a\n- [ ] b\n")).size).toBe(0);
  });

  it("タスクリストのある節の見出しにだけ「済 / 全」とメーターを出す", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { body: "## 概要\n\n本文\n\n## 確かめること\n\n- [x] a\n- [ ] b\n" }),
    );
    expect(html.match(/task-meter/g)?.length).toBe(1);
    expect(html).toContain("<h4><span>概要</span></h4>");
    expect(html).toMatch(
      /<h4><span>確かめること<\/span><span class="progress task-meter"[^>]*>.*<span class="muted">1 \/ 2<\/span><\/span><\/h4>/,
    );
    expect(html).toContain('style="width:50%"');
  });
});
