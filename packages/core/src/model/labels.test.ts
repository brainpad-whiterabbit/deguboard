// ラベルの語彙の形の検査と、一覧を作る判定（model/labels.ts）。ファイルも git も読まない

import { describe, expect, it } from "vitest";
import {
  isProcedureLabel,
  judgeLabelAdd,
  judgeLabelMerge,
  judgeLabelRemove,
  judgeLabelUpdate,
  labelListView,
  labelRenameWarnings,
  mergedLabelTarget,
  normalizeLabelNames,
  parseVocabulary,
  releaseLabeled,
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

describe("語彙を書く操作の判定（judgeLabelAdd・judgeLabelUpdate・judgeLabelRemove）", () => {
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
    // 接頭辞と同じ綴りを途中に持つ名前と、接頭辞の手前までの名前は足せる
    for (const name of ["pre-release-notes", "auditor", "retro", "release"])
      expect(add(name)).toMatchObject({ ok: true, name });
  });

  it("手順のラベルは audit と、audit-・retro-・release- で始まる名前", () => {
    for (const name of ["audit", "audit-s3", "retro-s2", "release-s10"])
      expect(isProcedureLabel(name)).toBe(true);
    for (const name of ["auditor", "retro", "release", "pre-release-s1"])
      expect(isProcedureLabel(name)).toBe(false);
  });

  it("リリースの手順のチケットは、その Iteration の release-<S> を持つものだけ。Iteration がなければどれも違う（releaseLabeled）", () => {
    const of = (...labels: string[]) => ({ labels });
    expect(releaseLabeled("s3")(of("core", "release-s3"))).toBe(true);
    for (const t of [of("release-s30"), of("release-s2"), of("release"), of("audit-s3"), of()])
      expect(releaseLabeled("s3")(t)).toBe(false);
    expect(releaseLabeled(null)(of("release-s3"))).toBe(false);
  });

  it("add は、空白・カンマ・_ を含む名前、先頭が - の名前、手順のラベルの名前（点検と同じ isProcedureLabel）、説明のない語彙を拒む", () => {
    for (const name of ["a b", "a,b", "updated_at", "-ui", "", "a\tb"])
      expect(add(name)).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    for (const name of ["audit", "Audit", "audit-s3", "retro-s3", "release-s3", "Audit-S3"])
      expect(add(name)).toMatchObject({
        ok: false,
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("the steps of an Iteration attach"),
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
});

describe("統合の判定（judgeLabelMerge）", () => {
  const axes = [
    { name: "area", description: "Which part" },
    { name: "kind", description: "What kind" },
  ];
  const now = "2026-11-20T00:00:00Z";
  const ui = { ...entry("area", "The board"), color: "blue" };
  const frontend = entry("area", "The front end");
  const web = entry("area", "The web UI");
  // old は前に web へ統合した記録、gone は前に ui へ統合した記録
  const old = entry("area", "Old", { merged_into: "web", merged_at: at });
  const gone = entry("area", "Gone", { merged_into: "ui", merged_at: at });
  const vocabulary = new Map<string, LabelEntry>([
    ["ui", ui],
    ["frontend", frontend],
    ["web", web],
    ["bug", entry("kind", "A defect")],
    ["old", old],
    ["gone", gone],
  ]);
  const tickets = [
    { id: "t1", labels: ["web", "bug"] },
    { id: "t2", labels: ["bug", "frontend", "ui", "web"] },
    { id: "t3", labels: ["bug"] },
    { id: "t4", labels: ["ui"] },
    { id: "t5", labels: [] },
  ];
  const merge = (
    names: string[],
    more: { axis?: string; description?: string } = {},
    given: typeof tickets = tickets,
  ) =>
    judgeLabelMerge(
      { from: names.slice(0, -1), to: names.at(-1) ?? "", ...more },
      axes,
      vocabulary,
      given,
      now,
    );

  it("元を持つチケットだけを行き先に書き換え、同じチケットで重なった名前は最初の場所に 1 つだけ残す。元は統合の記録になる", () => {
    expect(merge(["Web", "frontend", "web", "UI"])).toEqual({
      ok: true,
      to: "ui",
      entry: ui,
      created: false,
      merged: ["web", "frontend"],
      repointed: ["old"],
      entries: [
        // スキーマにない項目は残す。created_at は元のまま
        ["web", { ...web, merged_into: "ui", merged_at: now }],
        ["frontend", { ...frontend, merged_into: "ui", merged_at: now }],
        // 行き先が元だった記録は行き先へ付け替え、統合した時刻は変えない
        ["old", { ...old, merged_into: "ui" }],
      ],
      tickets: [
        { id: "t1", labels: ["ui", "bug"] },
        { id: "t2", labels: ["bug", "ui"] },
      ],
    });
  });

  it("行き先が語彙になければ axis と description で足し、改名は 1 つの名前を新しい名前へ統合することになる。足す名前には add の規則が効く", () => {
    const renamed = merge(["web", "Site"], { axis: "area", description: " The site " });
    expect(renamed).toMatchObject({
      ok: true,
      to: "site",
      entry: { axis: "area", description: "The site", created_at: now },
      created: true,
      merged: ["web"],
      repointed: ["old"],
      tickets: [
        { id: "t1", labels: ["site", "bug"] },
        { id: "t2", labels: ["bug", "frontend", "ui", "site"] },
      ],
    });
    expect(renamed.ok && renamed.entries.map(([name]) => name)).toEqual(["site", "web", "old"]);
    // 片方だけでも、どちらもなくても拒む
    for (const more of [{}, { axis: "area" }, { description: "d" }])
      expect(merge(["web", "site"], more)).toMatchObject({
        ok: false,
        code: "VALIDATION_FAILED",
        message: "No label site to merge into",
      });
    for (const [to, more] of [
      ["a_b", { axis: "area", description: "d" }],
      ["audit-s3", { axis: "area", description: "d" }],
      ["site", { axis: "impact", description: "d" }],
      ["site", { axis: "area", description: " " }],
    ] as const)
      expect(merge(["web", to], more)).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
  });

  it("拒む：自分への統合、元のない呼び出し、語彙にない元、ほかの名前への統合の記録、統合の記録の行き先、ある行き先への axis・description", () => {
    expect(merge(["ui", "UI"])).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(merge(["ui"])).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    // チケットに付いていても、語彙にない名前は統合の元にできない
    expect(
      merge(["tooling", "ui"], {}, [...tickets, { id: "t6", labels: ["tooling"] }]),
    ).toMatchObject({ ok: false, code: "NOT_FOUND", message: "No label tooling" });
    expect(merge(["old", "ui"])).toMatchObject({
      ok: false,
      code: "REJECTED",
      message: "old is a record of a merge into web, not a label of the vocabulary",
    });
    expect(merge(["web", "gone"])).toMatchObject({
      ok: false,
      code: "REJECTED",
      detail: "Merge into ui",
    });
    // 行き先の統合先が元に入っているときは、その名前を勧めない
    const undo = merge(["ui", "gone"]);
    expect(undo).toMatchObject({ ok: false, code: "REJECTED" });
    expect(undo).not.toHaveProperty("detail");
    for (const more of [{ axis: "area" }, { description: "d" }])
      expect(merge(["web", "ui"], more)).toMatchObject({
        ok: false,
        code: "VALIDATION_FAILED",
        message: "The label ui already exists, so --axis and --description cannot be given",
      });
  });

  it("行き先への統合の記録だった名前は受け、記録は書き換えずに、その名前の残るチケットだけを書き換える。書くものがなければ空で通る", () => {
    const left = [
      { id: "t1", labels: ["gone", "ui"] },
      { id: "t2", labels: ["bug"] },
    ];
    expect(merge(["gone", "ui"], {}, left)).toMatchObject({
      ok: true,
      created: false,
      merged: [],
      repointed: [],
      entries: [],
      tickets: [{ id: "t1", labels: ["ui"] }],
    });
    expect(merge(["gone", "ui"], {}, [])).toMatchObject({ ok: true, entries: [], tickets: [] });
  });
});

describe("統合済みの名前の読み替え（mergedLabelTarget・normalizeLabelNames）", () => {
  const record = (to: string) => entry("area", "Old name", { merged_into: to, merged_at: at });
  const vocabulary = new Map<string, LabelEntry>([
    ["ui", entry("area", "The board")],
    ["frontend", record("ui")],
    ["web", record("ui")],
    ["docs", entry("kind", "Documents")],
  ]);

  it("統合の記録の名前は統合先へ置き換え、語彙の名前と語彙にない名前はそのまま。読み替えた名前を 1 回ずつ返す", () => {
    expect(normalizeLabelNames(["frontend", "docs", "stray", "frontend"], vocabulary)).toEqual({
      labels: ["ui", "docs", "stray"],
      renamed: [{ from: "frontend", to: "ui" }],
    });
  });

  it("読み替えて重なった名前は最初の場所に 1 つ残し、読み替えのない並びは重なりも含めてそのまま返す", () => {
    expect(normalizeLabelNames(["web", "docs", "ui", "frontend"], vocabulary)).toEqual({
      labels: ["ui", "docs"],
      renamed: [
        { from: "web", to: "ui" },
        { from: "frontend", to: "ui" },
      ],
    });
    expect(normalizeLabelNames(["docs", "docs"], vocabulary)).toEqual({
      labels: ["docs", "docs"],
      renamed: [],
    });
    expect(normalizeLabelNames([], new Map())).toEqual({ labels: [], renamed: [] });
  });

  it("手で書き換えた記録の連鎖は記録でない名前までたどり、循環は元の名前に戻れば読み替えない", () => {
    const chain = new Map<string, string>([
      ["a", "b"],
      ["b", "c"],
      ["x", "y"],
      ["y", "x"],
      ["p", "q"],
      ["q", "r"],
      ["r", "q"],
    ]);
    const into = (name: string) => chain.get(name);
    expect(mergedLabelTarget("a", into)).toBe("c");
    expect(mergedLabelTarget("c", into)).toBeUndefined();
    expect(mergedLabelTarget("x", into)).toBeUndefined();
    // 元の名前を含まない循環は、たどれたところで止める
    expect(mergedLabelTarget("p", into)).toBe("q");
  });

  it("警告は読み替えた名前ごとに 1 つで、統合先を使うよう添える", () => {
    expect(labelRenameWarnings([{ from: "web", to: "ui" }], "written")).toEqual([
      "The label web was merged into ui, so ui is written instead. Use ui from now on",
    ]);
    expect(labelRenameWarnings([], "written")).toEqual([]);
  });
});
