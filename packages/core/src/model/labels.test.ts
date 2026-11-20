// ラベルの語彙の形の検査と、一覧を作る判定（model/labels.ts）。ファイルも git も読まない

import { describe, expect, it } from "vitest";
import {
  judgeLabelAdd,
  judgeLabelRemove,
  judgeLabelUpdate,
  labelListView,
  labelsOfAxis,
  parseVocabulary,
  type LabelEntry,
} from "./labels.js";

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

  it("名前の規則（小文字・空白とカンマと _ なし・先頭が - でない）に合わない項目は、中身が正しくても外して誤りにする。マージドライバがフィールドの名前で選ぶ規則に当たる名前（どれも _ を含む）を語彙にしない。日本語の名前は読む", () => {
    const names = [
      "updated_at",
      "closed_at",
      "started_at",
      "approved_at",
      "UI",
      "-ui",
      "a b",
      "a　b",
      "a,b",
      "",
    ];
    const parsed = parseVocabulary({
      ui: entry("area", "The board"),
      画面: entry("area", "日本語の名前"),
      "ui.v2": entry("area", "記号も使える"),
      ...Object.fromEntries(names.map((name) => [name, entry("area", "x")])),
    });
    expect(parsed.entries).toEqual([
      ["ui", entry("area", "The board")],
      ["画面", entry("area", "日本語の名前")],
      ["ui.v2", entry("area", "記号も使える")],
    ]);
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

describe("語彙を書く操作の判定（judgeLabelAdd・judgeLabelUpdate・judgeLabelRemove・labelsOfAxis）", () => {
  const axes = [
    { name: "area", description: "Which part" },
    { name: "kind", description: "What kind" },
  ];
  const now = "2026-11-20T00:00:00Z";
  const vocabulary = new Map([
    ["ui", { ...entry("area", "The board"), color: "blue" }],
    ["bug", entry("kind", "A defect")],
    ["web", entry("area", "Old", { merged_into: "ui", merged_at: at })],
  ]);
  const add = (name: string, axis = "area", description = "説明", given = axes) =>
    judgeLabelAdd({ name, axis, description }, given, vocabulary, now);

  it("add は名前を小文字にそろえ、軸と説明と今の時刻の項目を返す。日本語の名前も足せる", () => {
    expect(add("Core", "area", "  The core package ")).toEqual({
      ok: true,
      name: "core",
      entry: { axis: "area", description: "The core package", created_at: now },
    });
    expect(add("画面")).toMatchObject({ ok: true, name: "画面" });
    // 接頭辞と同じ綴りを途中に持つ名前は足せる
    expect(add("pre-release-notes")).toMatchObject({ ok: true, name: "pre-release-notes" });
  });

  it("add は、空白・カンマ・_ を含む名前、先頭が - の名前、手順の接頭辞の名前、説明のない語彙を拒む", () => {
    for (const name of ["a b", "a,b", "updated_at", "-ui", "", "a\tb"])
      expect(add(name)).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    for (const name of ["audit-s3", "retro-s3", "release-s3", "Audit-S3"])
      expect(add(name)).toMatchObject({
        ok: false,
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("starts with"),
      });
    for (const description of ["", "   "])
      expect(add("core", "area", description)).toMatchObject({
        ok: false,
        code: "VALIDATION_FAILED",
        message: "A label needs a description (--description)",
      });
  });

  it("add は、labels.axes にない軸（軸を決めていない・使わないボードも）を拒む", () => {
    expect(add("core", "impact")).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "No label axis impact",
      detail: expect.stringContaining("Axes: area, kind"),
    });
    for (const given of [undefined, []])
      expect(
        judgeLabelAdd({ name: "core", axis: "area", description: "d" }, given, vocabulary, now),
      ).toMatchObject({ ok: false, detail: expect.stringContaining("Axes: (none)") });
  });

  it("add は、もうある名前（同じ軸・ほかの軸）と統合済みの名前を拒む", () => {
    expect(add("UI")).toMatchObject({
      ok: false,
      code: "ALREADY_EXISTS",
      message: "The label ui already exists",
    });
    expect(add("ui", "kind")).toMatchObject({
      ok: false,
      code: "ALREADY_EXISTS",
      message: "The label ui already exists on the axis area",
    });
    expect(add("web")).toMatchObject({
      ok: false,
      code: "REJECTED",
      message: "web was merged into ui, so it cannot be added again",
    });
  });

  it("update は説明だけを替えてほかの項目を残し、語彙にない名前・統合の記録・空の説明を拒む", () => {
    expect(judgeLabelUpdate({ name: "UI", description: " 画面 " }, vocabulary)).toEqual({
      ok: true,
      name: "ui",
      entry: { ...entry("area", "画面"), color: "blue" },
    });
    expect(judgeLabelUpdate({ name: "none", description: "d" }, vocabulary)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(judgeLabelUpdate({ name: "web", description: "d" }, vocabulary)).toMatchObject({
      ok: false,
      code: "REJECTED",
    });
    expect(judgeLabelUpdate({ name: "ui", description: " " }, vocabulary)).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
    });
  });

  it("remove は、チケットが使っている語彙（done・abandoned も）・語彙にない名前・統合の記録を拒み、使われていなければ消す項目を返す", () => {
    const tickets = [
      { id: "t1", labels: ["ui", "tooling"] },
      { id: "t2", labels: ["ui"] },
      { id: "t3", labels: [] },
    ];
    expect(judgeLabelRemove({ name: "ui" }, vocabulary, tickets)).toMatchObject({
      ok: false,
      code: "REJECTED",
      message: "2 tickets carry the label ui, so it cannot be removed",
      detail: expect.stringContaining("t1, t2"),
    });
    expect(judgeLabelRemove({ name: "Bug" }, vocabulary, tickets)).toEqual({
      ok: true,
      name: "bug",
      entry: entry("kind", "A defect"),
    });
    expect(judgeLabelRemove({ name: "tooling" }, vocabulary, tickets)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(judgeLabelRemove({ name: "web" }, vocabulary, [])).toMatchObject({
      ok: false,
      code: "REJECTED",
    });
  });

  it("labelsOfAxis は軸に残る語彙を名前の順に返し、統合の記録は数えない", () => {
    const more = new Map([...vocabulary, ["core", entry("area", "The core")]]);
    expect(labelsOfAxis(more, "area")).toEqual(["core", "ui"]);
    expect(labelsOfAxis(more, "kind")).toEqual(["bug"]);
    expect(labelsOfAxis(more, "impact")).toEqual([]);
  });
});
