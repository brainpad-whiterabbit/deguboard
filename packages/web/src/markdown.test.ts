import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// web の番号付けが core の ticket.check の番号と一致するかを照らすためだけに、core の実行時のコードを取り込む
import { parseAcceptance } from "@deguboard/core";
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
          { checked: false, text: "a", acceptance: 1 },
          { checked: true, text: "b", acceptance: 2 },
          { checked: null, text: "c" },
        ],
      },
    ]);
  });

  describe("受け入れ条件の番号は core の parseAcceptance と一致する", () => {
    /** web が番号を振った項目を、番号・文・印で core の形にそろえる */
    const webAcceptance = (body: string) =>
      parseBlocks(body).flatMap((b) =>
        b.kind === "list"
          ? b.items.flatMap((x) =>
              x.acceptance === undefined
                ? []
                : [{ index: x.acceptance, text: x.text.trim(), checked: x.checked === true }],
            )
          : [],
      );
    const cases: Record<string, string> = {
      入れ子: "## 受け入れ条件\n\n- [ ] a\n  - [ ] 入れ子は数えない\n- [ ] b\n",
      コードブロックの中: "## 受け入れ条件\n\n- [ ] a\n\n```\n- [ ] b\n```\n",
      大文字の印: "## 受け入れ条件\n\n- [X] a\n- [x] b\n- [ ] c\n",
      空の文: "## 受け入れ条件\n\n- [ ] \n- [ ]   \n- [ ] a\n",
      見出しが2つ:
        "## 受け入れ条件\n\n- [ ] a\n\n## メモ\n\n- [ ] x\n\n## 受け入れ条件\n\n- [ ] b\n",
      CRLF: "## 概要\r\n\r\n本文\r\n\r\n## 受け入れ条件\r\n\r\n- [ ] a\r\n- [x] b\r\n",
    };
    for (const [name, body] of Object.entries(cases)) {
      it(name, () => {
        expect(webAcceptance(body)).toEqual(parseAcceptance(body) ?? []);
      });
    }
  });

  it("見出しが 2 つあると、core と同じく最初の節の項目にだけ番号を振る", () => {
    const blocks = parseBlocks("## 受け入れ条件\n\n- [ ] a\n\n## 受け入れ条件\n\n- [ ] b\n");
    const numbered = blocks.flatMap((b) =>
      b.kind === "list" ? b.items.map((x) => [x.text, x.acceptance ?? null]) : [],
    );
    expect(numbered).toEqual([
      ["a", 1],
      ["b", null],
    ]);
  });

  it("受け入れ条件の番号は ## 受け入れ条件 の節の `- [ ]` の行で、文のない行を飛ばし、次の ## で終わる（core の ticket.check の番号）", () => {
    const blocks = parseBlocks(
      [
        "## 概要",
        "- [ ] 節の外",
        "## 受け入れ条件",
        "- [ ] a",
        "- [ ] ",
        "* [ ] 星の行は数えない",
        "### 小見出し",
        "- [X] b",
        "## メモ",
        "- [ ] 節の外",
      ].join("\n"),
    );
    const numbered = blocks.flatMap((b) =>
      b.kind === "list" ? b.items.map((x) => [x.text, x.acceptance ?? null]) : [],
    );
    expect(numbered).toEqual([
      ["節の外", null],
      ["a", 1],
      ["", null],
      ["星の行は数えない", null],
      ["b", 2],
      ["節の外", null],
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
