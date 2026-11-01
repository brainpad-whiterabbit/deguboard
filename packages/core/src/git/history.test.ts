import { describe, expect, it } from "vitest";
import { buildHistory, parseLog } from "./history.js";

const M = "\x1e";
const S = "\x1f";

describe("経過の読み取り", () => {
  it("frontmatter の行だけを読み、本文の `status:` の行は拾わない。行の増減で frontmatter の範囲を追う", () => {
    const log = [
      `${M}c1${S}2026-01-01T00:00:00Z${S}a${S}t1 を作成`,
      "",
      "diff --git a/tickets/t1.md b/tickets/t1.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/tickets/t1.md",
      "@@ -0,0 +1,5 @@",
      "+---",
      "+id: t1",
      "+status: todo",
      "+---",
      "+status: 本文の行",
      `${M}c2${S}2026-01-02T00:00:00Z${S}a${S}変更をまとめてコミット`,
      "",
      "diff --git a/tickets/t1.md b/tickets/t1.md",
      "--- a/tickets/t1.md",
      "+++ b/tickets/t1.md",
      "@@ -3,0 +4 @@ status: todo",
      "+epic: e1",
      "@@ -6 +7 @@",
      "-status: 本文の行",
      "+status: 本文を直した",
      `${M}c3${S}2026-01-03T00:00:00Z${S}a${S}t1 を done に`,
      "",
      "diff --git a/tickets/t1.md b/tickets/t1.md",
      "--- a/tickets/t1.md",
      "+++ b/tickets/t1.md",
      "@@ -3 +3 @@ id: t1",
      "-status: todo",
      "+status: done",
      "@@ -6 +6 @@",
      "-status: 本文を直した",
      "+status: 本文をまた直した",
      "",
    ].join("\n");
    const result = buildHistory(parseLog(log));
    expect(result.shallow).toBe(false);
    expect(result.events.map((e) => [e.commit, e.type, e.changes])).toEqual([
      ["c1", "created", [{ field: "status", from: null, to: "todo" }]],
      ["c2", "changed", [{ field: "epic", from: null, to: "e1" }]],
      ["c3", "changed", [{ field: "status", from: "todo", to: "done" }]],
    ]);
  });
});
