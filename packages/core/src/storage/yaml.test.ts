import { afterEach, describe, expect, it, vi } from "vitest";
import { parseYamlDocument, parseYamlValue } from "./yaml.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseYamlValue", () => {
  it("読めた値は parseYamlDocument の toJS と同じになる（parse で読み、Doc は Document を持たない）", () => {
    const text = "id: t1 # 行末\nlabels: [a, b]\nnested:\n  - x: 1\n";
    expect(parseYamlValue(text)).toEqual({
      value: { id: "t1", labels: ["a", "b"], nested: [{ x: 1 }] },
      errors: [],
    });
    expect(parseYamlValue(text).value).toEqual(parseYamlDocument(text).doc.toJS());
  });

  it("空の文字列は null の値になる（呼び出し側が空の対象にそろえる）", () => {
    expect(parseYamlValue("")).toEqual({ value: null, errors: [] });
  });

  it("読めないときの文言は parseYamlDocument と同じになる（Issue の detail を変えない）", () => {
    for (const text of ["title: [\n", "a: 1\n---\nb: 2\n"]) {
      const { errors } = parseYamlValue(text);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors).toEqual(parseYamlDocument(text).errors);
    }
  });

  it("警告は標準エラーに出さない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    expect(parseYamlValue("a: !foo 1\n").errors).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
