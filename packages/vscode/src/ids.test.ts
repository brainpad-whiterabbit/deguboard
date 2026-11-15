import { readFileSync } from "node:fs";
import { bundleTranslator, setTranslator } from "./l10n.js";
import { describe, expect, it } from "vitest";
import {
  buildIdIndex,
  hoverMarkdown,
  ID_DOCUMENT_SELECTOR,
  linksOf,
  openIdArgs,
  openIdCommandUri,
} from "./ids.js";

// 文言は日本語の訳で確かめる（表示言語が日本語のときに今までと同じ文言が出ること）。英語は l10n.test.ts で確かめる
setTranslator(
  bundleTranslator(
    JSON.parse(
      readFileSync(new URL("../l10n/bundle.l10n.ja.json", import.meta.url), "utf8"),
    ) as Record<string, string>,
  ),
);

const index = buildIdIndex({
  tickets: [{ id: "t1", title: "ホバー *強調*", status: "in_progress", assignee: "maji/agent" }],
  iterations: [{ id: "s1", name: "sprint1", status: "active", goal: "最初の版" }],
  epics: [{ id: "e1", title: "CLI", status: "open", progress: { total: 4, done: 1 } }],
  plans: [{ id: "p1", status: "approved", tickets: ["t1", "t2"] }],
});

describe("buildIdIndex・hoverMarkdown", () => {
  it("存在する ID だけが索引に載る", () => {
    expect(index.has("t1")).toBe(true);
    expect(index.has("t999")).toBe(false);
  });
  it("チケットはタイトル・Status・担当を出し、Markdown の記号は文字として出す", () => {
    const text = hoverMarkdown(index.get("t1")!);
    expect(text).toContain("t1");
    expect(text).toContain("in_progress");
    expect(text).toContain("maji/agent");
    expect(text).toContain("\\*強調\\*");
  });
  it("担当がなければ「なし」と出す", () => {
    const i = buildIdIndex({
      tickets: [{ id: "t2", title: "x", status: "todo", assignee: null }],
      iterations: [],
      epics: [],
      plans: [],
    });
    expect(hoverMarkdown(i.get("t2")!)).toContain("担当: なし");
  });
  it("Iteration・Epic・Plan もそれぞれの要約を出す", () => {
    expect(hoverMarkdown(index.get("s1")!)).toContain("sprint1");
    expect(hoverMarkdown(index.get("e1")!)).toContain("1/4");
    expect(hoverMarkdown(index.get("p1")!)).toContain("approved");
  });
});

describe("openIdCommandUri", () => {
  it("コマンド URI の引数に ID が入る", () => {
    const uri = openIdCommandUri("t12", "file:///w");
    expect(uri.startsWith("command:deguboard.openId?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(uri.split("?")[1]!))).toEqual(["t12", "file:///w"]);
  });
});

describe("openIdArgs", () => {
  it("VS Code がばらして渡す (id, folder) と、配列のままの [id, folder] の両方を受ける", () => {
    expect(openIdArgs("t1", "file:///w")).toEqual({ id: "t1", folder: "file:///w" });
    expect(openIdArgs(["t1", "file:///w"])).toEqual({ id: "t1", folder: "file:///w" });
    expect(openIdArgs("t1")).toEqual({ id: "t1" });
  });
  it("ID が文字列でなければ undefined", () => {
    expect(openIdArgs(undefined)).toBeUndefined();
    expect(openIdArgs([1, "x"])).toBeUndefined();
  });
});

describe("linksOf", () => {
  it("存在する ID だけを返す（存在しない ID は外す）", () => {
    const found = linksOf("t1 t999 s1 e1 p1 e9", index).map((f) => f.id);
    expect(found).toEqual(["t1", "s1", "e1", "p1"]);
  });
});

describe("ID_DOCUMENT_SELECTOR", () => {
  it("コミットメッセージの入力欄（vscode-scm）を含む", () => {
    expect(ID_DOCUMENT_SELECTOR.map((s) => s.scheme)).toContain("vscode-scm");
  });
});
