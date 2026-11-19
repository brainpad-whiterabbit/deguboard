// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LABEL_COLOR_COUNT,
  RowLabels,
  labelColorIndex,
  splitRowLabels,
  type RowLabelsSetting,
} from "./row-labels.js";

afterEach(cleanup);

describe("ラベルの色（名前から決める）", () => {
  it("同じ名前はいつも同じ色で、色は 6 色のどれか", () => {
    for (const name of ["web", "docs", "gate", "ui", "日本語のラベル", "", "a".repeat(200)]) {
      const index = labelColorIndex(name);
      expect(index).toBe(labelColorIndex(name));
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(LABEL_COLOR_COUNT);
    }
  });

  it("決め方（FNV-1a を 6 で割った余り）を変えない。変えると、人の見慣れたラベルの色が入れ替わる", () => {
    // 空の名前は FNV-1a の初期値 0x811c9dc5 の余り
    expect(labelColorIndex("")).toBe(0x811c9dc5 % 6);
    expect(["a", "ab", "web", "docs", "gate", "ui", "release"].map(labelColorIndex)).toEqual([
      4, 0, 1, 0, 2, 5, 4,
    ]);
  });

  it("似た名前を 1 色に寄せず、6 色をどれも使う", () => {
    const names = Array.from({ length: 24 }, (_, i) => `label-${i}`);
    expect(new Set(names.map(labelColorIndex)).size).toBe(LABEL_COLOR_COUNT);
  });
});

describe("行に出すラベルと「+N」の分け方", () => {
  it("3 つまではすべて出し、残りはまとめる", () => {
    expect(splitRowLabels([])).toEqual({ shown: [], rest: [] });
    expect(splitRowLabels(["a", "b", "c"])).toEqual({ shown: ["a", "b", "c"], rest: [] });
    expect(splitRowLabels(["a", "b", "c", "d", "e"])).toEqual({
      shown: ["a", "b", "c"],
      rest: ["d", "e"],
    });
  });
});

describe("行のラベルの札", () => {
  const setting = (selected = ""): RowLabelsSetting => ({ selected, onSelect: vi.fn() });

  it("ラベルがなければ何も出さない", () => {
    const { container } = render(<RowLabels labels={[]} setting={setting()} />);
    expect(container.innerHTML).toBe("");
  });

  it("3 つまで札で出し、残りは「+N」にまとめて、触れると全部の名前を出す。札は Tab で止めない", () => {
    render(<RowLabels labels={["cli", "flow", "docs", "agent", "ux"]} setting={setting()} />);
    const chips = screen.getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["cli", "flow", "docs"]);
    for (const chip of chips) {
      expect(chip.tabIndex).toBe(-1);
      expect(chip.className).toMatch(/label-color-[0-5]/);
    }
    const more = document.querySelector(".row-label.more")!;
    expect(more.textContent).toBe("+2");
    expect(more.getAttribute("title")).toBe("cli, flow, docs, agent, ux");
    expect(more.getAttribute("aria-label")).toBe("ほかのラベル agent, ux");
  });

  it("押すとそのラベルを渡し、絞っているラベルは押した見た目とツールチップで外せることを示す", () => {
    const s = setting("web");
    render(<RowLabels labels={["web", "docs"]} setting={s} />);
    const web = screen.getByRole("button", { name: "web" });
    const docs = screen.getByRole("button", { name: "docs" });
    expect(web.getAttribute("aria-pressed")).toBe("true");
    expect(web.title).toBe("ラベル web の絞り込みを外す");
    expect(docs.getAttribute("aria-pressed")).toBe("false");
    expect(docs.title).toBe("ラベル docs で絞る");
    fireEvent.click(docs);
    expect(s.onSelect).toHaveBeenCalledWith("docs");
  });
});
