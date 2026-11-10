import { describe, expect, it } from "vitest";
import type { Status } from "./common.js";
import type { TicketId } from "./id.js";
import {
  acceptanceSection,
  BODY_HEADINGS,
  bodyHeadingPattern,
  hasBodySection,
  parseAcceptance,
  pendingDeps,
  progressOf,
  replaceAcceptance,
  setAcceptance,
  ticketBodyTemplate,
} from "./ticket.js";

describe("チケットの本文", () => {
  it("雛形は英語の名前の節（Summary・Acceptance criteria）を持ち、項目がなければ空の - [ ] を 1 行置く", () => {
    expect(ticketBodyTemplate("入力の検査")).toBe(
      "## Summary\n\n入力の検査\n\n## Acceptance criteria\n\n- [ ] \n",
    );
    expect(ticketBodyTemplate()).toBe("## Summary\n\n\n\n## Acceptance criteria\n\n- [ ] \n");
  });

  it("受け入れ条件の項目を 1 行ずつチェックリストにし、前後の空白を落とす", () => {
    expect(ticketBodyTemplate("s", [" a, b ", "c"])).toBe(
      "## Summary\n\ns\n\n## Acceptance criteria\n\n- [ ] a, b\n- [ ] c\n",
    );
  });

  it("節の名前は英語と日本語のどちらも同じ節と読み、英語は大文字と小文字を区別しない", () => {
    for (const body of ["## Summary\n\ns\n", "## 概要\n\ns\n", "## summary  \n\ns\n"])
      expect(hasBodySection(body, "summary"), body).toBe(true);
    expect(hasBodySection("## Summaries\n\ns\n", "summary")).toBe(false);
    expect(hasBodySection("## References\n\n- a.ts\n", "references")).toBe(true);
    expect(hasBodySection("## 参考\n\n- a.ts\n", "references")).toBe(true);
    expect(hasBodySection("## 参考文献\n", "references")).toBe(false);
    expect(bodyHeadingPattern("acceptance").test("## Acceptance criteria")).toBe(true);
    expect(bodyHeadingPattern("acceptance").test("## 受け入れ条件")).toBe(true);
    expect(BODY_HEADINGS.acceptance).toEqual({ en: "Acceptance criteria", ja: "受け入れ条件" });
  });

  it("英語の名前の受け入れ条件の節も、切り出し・置き換え・読み・印の書き換えをする", () => {
    const body =
      "## Summary\n\ns\n\n## Acceptance criteria\n\n- [x] done\n- [ ] gone\n\n## References\n\n- a.ts\n";
    expect(acceptanceSection(body)).toBe("\n\n- [x] done\n- [ ] gone\n\n");
    expect(parseAcceptance(body)).toEqual([
      { index: 1, text: "done", checked: true },
      { index: 2, text: "gone", checked: false },
    ]);
    expect(setAcceptance(body, [2], true)).toBe(body.replace("- [ ] gone", "- [x] gone"));
    expect(replaceAcceptance(body, ["new", "done"])).toBe(
      "## Summary\n\ns\n\n## Acceptance criteria\n\n- [ ] new\n- [x] done\n\n## References\n\n- a.ts\n",
    );
  });

  it("受け入れ条件の節を、見出しの次から次の見出しの手前まで切り出す", () => {
    expect(acceptanceSection("## 概要\n\n- [ ] x\n")).toBeUndefined();
    expect(acceptanceSection("## 受け入れ条件")).toBe("");
    // 概要にチェックリストがあっても、受け入れ条件の節は空のまま
    expect(acceptanceSection("## 概要\n\n- [ ] x\n\n## 受け入れ条件\n\n- [ ] \n")).toBe(
      "\n\n- [ ] \n",
    );
    expect(acceptanceSection("## 受け入れ条件\n\n- [ ] a\n\n## 備考\n\n- [ ] b\n")).toBe(
      "\n\n- [ ] a\n\n",
    );
  });

  it("受け入れ条件の節だけを置き換え、同じ文の済みの印は保ち、他の節は変えない", () => {
    const body = "## 概要\n\ns\n\n## 受け入れ条件\n\n- [x] 済み\n- [ ] 消える\n\n## 備考\n\nメモ\n";
    expect(replaceAcceptance(body, ["新しい", " 済み "])).toBe(
      "## 概要\n\ns\n\n## 受け入れ条件\n\n- [ ] 新しい\n- [x] 済み\n\n## 備考\n\nメモ\n",
    );
    // 節が末尾のとき
    expect(replaceAcceptance(ticketBodyTemplate("s"), ["a"])).toBe(
      "## Summary\n\ns\n\n## Acceptance criteria\n\n- [ ] a\n",
    );
  });

  it("受け入れ条件の節がなければ末尾に英語の名前で足し、日本語の ## 概要 の本文には日本語の名前で足す", () => {
    expect(replaceAcceptance("## 概要\n\ns\n", ["a"])).toBe(
      "## 概要\n\ns\n\n## 受け入れ条件\n\n- [ ] a\n",
    );
    expect(replaceAcceptance("## Summary\n\ns\n", ["a"])).toBe(
      "## Summary\n\ns\n\n## Acceptance criteria\n\n- [ ] a\n",
    );
    expect(replaceAcceptance("本文だけ", ["a"])).toBe(
      "本文だけ\n\n## Acceptance criteria\n\n- [ ] a\n",
    );
    expect(replaceAcceptance("", ["a"])).toBe("## Acceptance criteria\n\n- [ ] a\n");
  });

  const checklist =
    "## 概要\n\n- [ ] 概要の項目\n\n## 受け入れ条件\n\n- [ ] \n- [x] a\n- [X] b  \n- [ ] c\n\n## 備考\n\n- [ ] d\n";

  it("受け入れ条件の項目を 1 始まりの番号・文・印で読み、空の項目行と他の節は数えず、節がなければ undefined", () => {
    expect(parseAcceptance(checklist)).toEqual([
      { index: 1, text: "a", checked: true },
      { index: 2, text: "b", checked: true },
      { index: 3, text: "c", checked: false },
    ]);
    expect(parseAcceptance("## 概要\n\n- [ ] x\n")).toBeUndefined();
    // 雛形のまま（空の項目行だけ）は節はあるが項目がない
    expect(parseAcceptance(ticketBodyTemplate("s"))).toEqual([]);
  });

  it("番号の項目の印だけを書き換え、他の行・空の項目行・他の節は変えない", () => {
    expect(setAcceptance(checklist, [3, 1], true)).toBe(
      "## 概要\n\n- [ ] 概要の項目\n\n## 受け入れ条件\n\n- [ ] \n- [x] a\n- [X] b  \n- [x] c\n\n## 備考\n\n- [ ] d\n",
    );
    expect(setAcceptance(checklist, [2], false)).toBe(
      "## 概要\n\n- [ ] 概要の項目\n\n## 受け入れ条件\n\n- [ ] \n- [x] a\n- [ ] b  \n- [ ] c\n\n## 備考\n\n- [ ] d\n",
    );
    // 範囲外の番号と節のない本文は変えない
    expect(setAcceptance(checklist, [99], true)).toBe(checklist);
    expect(setAcceptance("本文だけ", [1], true)).toBe("本文だけ");
  });

  it("CRLF の本文も項目を読み、印を書き換えても行末の \\r を保つ", () => {
    const crlf = "## 受け入れ条件\r\n\r\n- [ ] a\r\n- [x] b\r\n";
    expect(parseAcceptance(crlf)).toEqual([
      { index: 1, text: "a", checked: false },
      { index: 2, text: "b", checked: true },
    ]);
    expect(setAcceptance(crlf, [1, 2], true)).toBe("## 受け入れ条件\r\n\r\n- [x] a\r\n- [x] b\r\n");
  });

  it("受け入れ条件の節が 2 つあれば最初の節の項目だけを読む（web の番号付けも同じ）", () => {
    expect(
      parseAcceptance(
        "## 受け入れ条件\n\n- [ ] a\n\n## メモ\n\n- [ ] x\n\n## 受け入れ条件\n\n- [ ] b\n",
      ),
    ).toEqual([{ index: 1, text: "a", checked: false }]);
  });
});

describe("進み（progressOf）", () => {
  it("進みは done の件数と abandoned を除く件数、Status ごとの件数を数える", () => {
    const p = progressOf([
      { status: "done" },
      { status: "todo" },
      { status: "in_progress" },
      { status: "abandoned" },
    ]);
    expect(p.done).toBe(1);
    expect(p.total).toBe(3);
    expect(p.by_status).toMatchObject({ todo: 1, in_progress: 1, review: 0, done: 1 });
  });
});

describe("depends_on の待ち（pendingDeps）", () => {
  it("done・abandoned でない依存先と見つからない依存先を depends_on の順で返す", () => {
    const statuses: Partial<Record<TicketId, Status>> = {
      t1: "done",
      t2: "review",
      t3: "abandoned",
      t4: "todo",
    };
    const ticket = { depends_on: ["t4", "t1", "t9", "t2", "t3"] as TicketId[] };
    expect(pendingDeps(ticket, (id) => statuses[id])).toEqual(["t4", "t9", "t2"]);
    expect(pendingDeps({ depends_on: [] }, () => undefined)).toEqual([]);
  });
});
