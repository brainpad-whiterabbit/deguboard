// ラベルの軸を消す判定（model/label-axes.ts）。ファイルも git も読まない。
// コマンドを通す経路（ロックの前に入力を弾く・判定の誤りをそのまま返す・書いた軸を返す）は commands/label.test.ts

import { describe, expect, it } from "vitest";
import { judgeLabelAxisRemove, judgeLabelAxisRemoveInput, labelsOfAxis } from "./label-axes.js";
import type { LabelEntry } from "./labels.js";

const at = "2026-11-01T00:00:00Z";
const entry = (axis: string, description: string, more: Partial<LabelEntry> = {}): LabelEntry => ({
  axis,
  description,
  created_at: at,
  ...more,
});
const area = { name: "area", description: "Which part" };
const kind = { name: "kind", description: "What kind" };
const impact = { name: "impact", description: "What reaches users" };

describe("軸を消す判定（judgeLabelAxisRemove・judgeLabelAxisRemoveInput・labelsOfAxis）", () => {
  const vocabulary = new Map([
    ["ui", entry("area", "The board")],
    ["core", entry("area", "The core")],
    ["bug", entry("kind", "A defect")],
    // 統合の記録だけの軸（impact）は語彙が残っていないとみなす
    ["old", entry("impact", "Old", { merged_into: "ui", merged_at: at })],
  ]);

  it("名前と all は片方だけを受け、それ以外は軸を読まずに同じ文で拒む", () => {
    const invalid = {
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Give either the name of an axis or --all",
      detail:
        "dg label axis remove <name> removes one axis, and dg label axis remove --all removes every axis",
    };
    for (const input of [{}, { all: false }, { name: "area", all: true }]) {
      expect(judgeLabelAxisRemoveInput(input)).toEqual(invalid);
      expect(judgeLabelAxisRemove(input, [area], new Map())).toEqual(invalid);
    }
    for (const input of [{ name: "area" }, { name: "area", all: false }, { all: true }])
      expect(judgeLabelAxisRemoveInput(input)).toBeUndefined();
  });

  it("軸にない名前は、書いていないボードと空の一覧も含めて、今の軸を添えて拒む", () => {
    expect(judgeLabelAxisRemove({ name: "area" }, undefined, new Map())).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "No label axis area",
      detail: "Axes: (none)",
    });
    expect(judgeLabelAxisRemove({ name: "area" }, [], new Map())).toMatchObject({
      code: "NOT_FOUND",
      detail: "Axes: (none)",
    });
    expect(judgeLabelAxisRemove({ name: "audience" }, [area, kind], new Map())).toMatchObject({
      code: "NOT_FOUND",
      detail: "Axes: area, kind",
    });
  });

  it("語彙の残る軸は、名前でも all でも拒み、残る語彙を軸ごとに名前の順で示す", () => {
    expect(judgeLabelAxisRemove({ name: "area" }, [area, kind], vocabulary)).toEqual({
      ok: false,
      code: "REJECTED",
      message: "The label axis area still has labels, so it cannot be removed",
      detail: "area: core, ui. Remove the labels first with dg label remove",
    });
    expect(judgeLabelAxisRemove({ all: true }, [area, kind, impact], vocabulary)).toEqual({
      ok: false,
      code: "REJECTED",
      message: "The label axes area, kind still have labels, so they cannot be removed",
      detail: "area: core, ui; kind: bug. Remove the labels first with dg label remove",
    });
    // 語彙の残る軸が 1 つだけなら、all でも単数の文
    expect(judgeLabelAxisRemove({ all: true }, [kind, impact], vocabulary)).toMatchObject({
      message: "The label axis kind still has labels, so it cannot be removed",
    });
  });

  it("通れば消した後の一覧を返す。最後の軸を消すと []、all は書いていないボードにも [] を返す", () => {
    expect(judgeLabelAxisRemove({ name: "impact" }, [area, impact, kind], vocabulary)).toEqual({
      ok: true,
      axes: [area, kind],
    });
    expect(judgeLabelAxisRemove({ name: "kind" }, [kind], new Map())).toEqual({
      ok: true,
      axes: [],
    });
    expect(judgeLabelAxisRemove({ all: true }, [area, kind], new Map())).toEqual({
      ok: true,
      axes: [],
    });
    expect(judgeLabelAxisRemove({ all: true }, undefined, vocabulary)).toEqual({
      ok: true,
      axes: [],
    });
  });

  it("labelsOfAxis は軸に残る語彙を名前の順に返し、統合の記録は数えない", () => {
    expect(labelsOfAxis(vocabulary, "area")).toEqual(["core", "ui"]);
    expect(labelsOfAxis(vocabulary, "kind")).toEqual(["bug"]);
    expect(labelsOfAxis(vocabulary, "impact")).toEqual([]);
  });
});
