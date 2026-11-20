// ラベルの語彙の形の検査と、一覧を作る判定（model/labels.ts）。ファイルも git も読まない

import { describe, expect, it } from "vitest";
import { labelListView, parseVocabulary, type LabelEntry } from "./labels.js";

const at = "2026-11-01T00:00:00Z";
const entry = (axis: string, description: string, more: Partial<LabelEntry> = {}): LabelEntry => ({
  axis,
  description,
  created_at: at,
  ...more,
});

describe("語彙の形の検査（parseVocabulary）", () => {
  it("ファイルがない・空は語彙なしで、最上位がマッピングでなければ全体を誤りにする", () => {
    expect(parseVocabulary(undefined)).toEqual({ entries: [], errors: [] });
    expect(parseVocabulary(null)).toEqual({ entries: [], errors: [] });
    for (const raw of [["ui"], "ui", 3]) {
      const parsed = parseVocabulary(raw);
      expect(parsed.entries).toEqual([]);
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0]?.name).toBeUndefined();
    }
  });

  it("axis・description・created_at を持つ項目と統合の記録を読み、スキーマにない項目は残す", () => {
    const merged = entry("area", "Old name", { merged_into: "ui", merged_at: at });
    const parsed = parseVocabulary({
      ui: { ...entry("area", "The board and its panels"), color: "blue" },
      "audit-s3": entry("kind", "数字とハイフンも使える"),
      web: merged,
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toEqual([
      ["ui", { ...entry("area", "The board and its panels"), color: "blue" }],
      ["audit-s3", entry("kind", "数字とハイフンも使える")],
      ["web", merged],
    ]);
  });

  it("名前が slug（小文字・数字・ハイフン）でない項目は、中身が正しくても外して誤りにする。マージドライバがフィールドの名前で選ぶ規則に当たる名前を語彙にしない", () => {
    const names = ["updated_at", "closed_at", "started_at", "UI", "日本語", "-ui", "a b", ""];
    const parsed = parseVocabulary({
      ui: entry("area", "The board"),
      ...Object.fromEntries(names.map((name) => [name, entry("area", "x")])),
    });
    expect(parsed.entries).toEqual([["ui", entry("area", "The board")]]);
    expect(parsed.errors.map((e) => e.name)).toEqual(names);
    for (const e of parsed.errors) expect(e.detail).toContain("name: ");
  });

  it("読めない項目はその項目だけを外して名前つきの誤りにし、ほかの語彙は読む", () => {
    const parsed = parseVocabulary({
      ui: entry("area", "The board"),
      "no-axis": { description: "x", created_at: at },
      "bad-axis": entry("Area!", "x"),
      "no-description": { axis: "area", created_at: at },
      "empty-description": entry("area", ""),
      "bad-time": { axis: "area", description: "x", created_at: "yesterday" },
      "half-merged": entry("area", "x", { merged_into: "ui" }),
      "half-merged-at": entry("area", "x", { merged_at: at }),
      "self-merged": entry("area", "x", { merged_into: "self-merged", merged_at: at }),
      scalar: "area",
      nothing: null,
    });
    expect(parsed.entries).toEqual([["ui", entry("area", "The board")]]);
    expect(parsed.errors.map((e) => e.name)).toEqual([
      "no-axis",
      "bad-axis",
      "no-description",
      "empty-description",
      "bad-time",
      "half-merged",
      "half-merged-at",
      "self-merged",
      "scalar",
      "nothing",
    ]);
    for (const e of parsed.errors) expect(e.detail).not.toBe("");
  });
});

describe("語彙の一覧（labelListView）", () => {
  const axes = [
    { name: "area", description: "Which part" },
    { name: "kind", description: "What kind" },
  ];
  const ticket = (labels: string[], created_at: string) => ({ labels, created_at });

  it("軸を labels.axes の順に、語彙を名前の順に並べ、件数と最後に使われた時刻（付いたチケットの起票の最も新しいもの）を添える。語彙のない軸も出す", () => {
    const vocabulary = new Map([
      ["web", entry("area", "The web UI")],
      ["core", entry("area", "The core package")],
    ]);
    const view = labelListView(axes, vocabulary, [
      ticket(["core"], "2026-11-03T00:00:00Z"),
      ticket(["core", "web"], "2026-11-05T00:00:00Z"),
      // 時刻の書き方（オフセット）が違っても、時刻として比べる
      ticket(["core"], "2026-11-04T23:00:00-09:00"),
      // 同じチケットに 2 回付いていても 1 件に数える
      ticket(["web", "web"], "2026-11-02T00:00:00Z"),
    ]);
    expect(view).toEqual({
      state: "on",
      axes: [
        {
          name: "area",
          description: "Which part",
          labels: [
            {
              name: "core",
              description: "The core package",
              created_at: at,
              count: 3,
              last_used_at: "2026-11-04T23:00:00-09:00",
            },
            {
              name: "web",
              description: "The web UI",
              created_at: at,
              count: 2,
              last_used_at: "2026-11-05T00:00:00Z",
            },
          ],
        },
        { name: "kind", description: "What kind", labels: [] },
      ],
    });
  });

  it("付いたチケットのない語彙は 0 件で last_used_at が null。labels.axes にない軸を指す語彙は、後ろに軸の名前の順で description を null にして出す", () => {
    const vocabulary = new Map([
      ["ios", entry("platform", "iOS")],
      ["bug", entry("kind", "A defect")],
      ["users", entry("audience", "End users")],
    ]);
    const view = labelListView(axes, vocabulary, []);
    const unused = { created_at: at, count: 0, last_used_at: null };
    expect(view.axes).toEqual([
      { name: "area", description: "Which part", labels: [] },
      {
        name: "kind",
        description: "What kind",
        labels: [{ name: "bug", description: "A defect", ...unused }],
      },
      {
        name: "audience",
        description: null,
        labels: [{ name: "users", description: "End users", ...unused }],
      },
      {
        name: "platform",
        description: null,
        labels: [{ name: "ios", description: "iOS", ...unused }],
      },
    ]);
  });

  it("軸を書いていない・[] のボードでも語彙を出し、state で軸の状態を返す", () => {
    const vocabulary = new Map([["bug", entry("kind", "A defect")]]);
    for (const [value, state] of [
      [undefined, "undecided"],
      [[], "off"],
    ] as const) {
      const view = labelListView(value, vocabulary, []);
      expect(view.state).toBe(state);
      expect(view.axes.map((a) => [a.name, a.description, a.labels.length])).toEqual([
        ["kind", null, 1],
      ]);
    }
  });

  it("統合の記録は語彙に入れず、merged を付けたときだけ名前の順に出す", () => {
    const vocabulary = new Map([
      ["web", entry("area", "Old", { merged_into: "ui", merged_at: "2026-11-09T00:00:00Z" })],
      ["ui", entry("area", "The UI")],
      ["frontend", entry("area", "Older", { merged_into: "ui", merged_at: at })],
    ]);
    const plain = labelListView(axes, vocabulary, [ticket(["web"], at)]);
    expect(plain.axes[0]?.labels.map((l) => l.name)).toEqual(["ui"]);
    expect(plain).not.toHaveProperty("merged");
    expect(plain).not.toHaveProperty("undefined");
    expect(labelListView(axes, vocabulary, [], { merged: true }).merged).toEqual([
      { name: "frontend", axis: "area", description: "Older", merged_into: "ui", merged_at: at },
      {
        name: "web",
        axis: "area",
        description: "Old",
        merged_into: "ui",
        merged_at: "2026-11-09T00:00:00Z",
      },
    ]);
  });

  it("undefined を付けると、チケットに付いているが語彙にない名前を件数つきで名前の順に出す。統合済みの名前も語彙にない名前に数える", () => {
    const vocabulary = new Map([
      ["ui", entry("area", "The UI")],
      ["web", entry("area", "Old", { merged_into: "ui", merged_at: at })],
    ]);
    const view = labelListView(
      axes,
      vocabulary,
      [ticket(["ui", "web", "audit-s3"], at), ticket(["tooling", "web"], at), ticket([], at)],
      { undefined: true },
    );
    expect(view.undefined).toEqual([
      { name: "audit-s3", count: 1 },
      { name: "tooling", count: 1 },
      { name: "web", count: 2 },
    ]);
    // 語彙がなければ、付いている名前はすべて語彙にない名前
    expect(
      labelListView(undefined, new Map(), [ticket(["a"], at)], { undefined: true }).undefined,
    ).toEqual([{ name: "a", count: 1 }]);
    expect(labelListView(axes, vocabulary, [], { undefined: true }).undefined).toEqual([]);
  });
});
