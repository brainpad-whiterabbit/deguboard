import { describe, expect, it } from "vitest";
import {
  buildIdIndex,
  findIds,
  hoverMarkdown,
  ID_DOCUMENT_SELECTOR,
  kindOfId,
  openIdCommandUri,
  routeOfId,
} from "./ids.js";

const ids = (text: string) => findIds(text).map((f) => f.id);

describe("findIds", () => {
  it("t12・s3・e2・p7 の 4 種類を拾い、位置を返す", () => {
    expect(ids("t12 s3 e2 p7")).toEqual(["t12", "s3", "e2", "p7"]);
    const [f] = findIds("fix (t12)");
    expect(f).toEqual({ id: "t12", start: 5, end: 8 });
  });
  it("文末の句読点・括弧・引用符・# や @ の後ろの ID は拾う", () => {
    expect(ids("t12. t13, (t14) 'e2' #t5 @s3 「p7」")).toEqual([
      "t12",
      "t13",
      "t14",
      "e2",
      "t5",
      "s3",
      "p7",
    ]);
  });
  it("abc12 のような語の中の部分一致は拾わない", () => {
    expect(ids("abc12 test12 Set3 pt12 t12abc 12t3")).toEqual([]);
  });
  it("URL・パス・ブランチ名・ファイル名の一部は拾わない", () => {
    expect(ids("https://example.com/t12")).toEqual([]);
    expect(ids("feat/t12-foo")).toEqual([]);
    expect(ids("t12.md t12-foo t12/x")).toEqual([]);
    expect(ids("a.t12 v1-s3")).toEqual([]);
  });
  it("ゼロ始まりや番号のない形は拾わない", () => {
    expect(ids("t0 t012 t s e")).toEqual([]);
  });
  it("同じ ID が複数あればすべて拾う", () => {
    expect(findIds("t1 and t1").map((f) => f.start)).toEqual([0, 7]);
  });
});

describe("kindOfId", () => {
  it("接頭辞から種類を決め、形が違えば undefined", () => {
    expect(kindOfId("t1")).toBe("ticket");
    expect(kindOfId("s1")).toBe("iteration");
    expect(kindOfId("e1")).toBe("epic");
    expect(kindOfId("p1")).toBe("plan");
    expect(kindOfId("x1")).toBeUndefined();
    expect(kindOfId("t01")).toBeUndefined();
  });
});

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

describe("routeOfId・openIdCommandUri", () => {
  it("チケット・Iteration・Epic は詳細のルートを返し、Plan は返さない", () => {
    expect(routeOfId("t1")).toBe("#/tickets/t1");
    expect(routeOfId("s1")).toBe("#/iterations/s1");
    expect(routeOfId("e1")).toBe("#/epics/e1");
    expect(routeOfId("p1")).toBeUndefined();
    expect(routeOfId("x1")).toBeUndefined();
  });
  it("コマンド URI の引数に ID が入る", () => {
    const uri = openIdCommandUri("t12");
    expect(uri.startsWith("command:deguboard.openId?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(uri.split("?")[1]!))).toEqual(["t12"]);
  });
});

describe("ID_DOCUMENT_SELECTOR", () => {
  it("コミットメッセージの入力欄（vscode-scm）を含む", () => {
    expect(ID_DOCUMENT_SELECTOR.map((s) => s.scheme)).toContain("vscode-scm");
  });
});
