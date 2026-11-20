// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_VOCABULARY, vocabularyOf, type LabelVocabulary } from "./label-vocab.js";
import {
  LabelFilterOptions,
  RowLabels,
  splitRowLabels,
  type RowLabelsSetting,
} from "./row-labels.js";

afterEach(cleanup);

/** 軸 area（ui）と kind（bug）の語彙 */
const VOCAB: LabelVocabulary = vocabularyOf({
  state: "on",
  axes: [
    {
      name: "area",
      description: "Part",
      labels: [{ name: "ui", description: "画面", created_at: "", count: 0, last_used_at: null }],
    },
    {
      name: "kind",
      description: "Kind",
      labels: [
        { name: "bug", description: "不具合", created_at: "", count: 0, last_used_at: null },
      ],
    },
  ],
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
  const setting = (
    selected = "",
    vocabulary = EMPTY_VOCABULARY,
    hideProcedure = false,
  ): RowLabelsSetting => ({ selected, onSelect: vi.fn(), vocabulary, hideProcedure });

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
      // 語彙のないボードは名前から色を決め、印は付けない
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

  it("語彙があれば軸の色で出し、ツールチップに軸と説明を足す。語彙にない名前は色を付けず「?」の印を付ける（読み上げの名前には入れない）", () => {
    render(<RowLabels labels={["bug", "ui", "misc"]} setting={setting("", VOCAB)} />);
    const ui = screen.getByRole("button", { name: "ui" });
    const bug = screen.getByRole("button", { name: "bug" });
    const misc = screen.getByRole("button", { name: "misc" });
    expect(ui.className).toBe("row-label label-color-0");
    expect(bug.className).toBe("row-label label-color-1");
    expect(ui.title).toBe("ラベル ui で絞る\narea: 画面");
    expect(misc.className).toBe("row-label label-unknown");
    expect(misc.textContent).toBe("misc?");
    expect(misc.title).toBe("ラベル misc で絞る\n語彙にない");
  });

  it("手順のラベルは目立たない見た目で後ろへ回し、語彙になくても印を付けない。隠す設定なら出さず「+N」にも数えない", () => {
    const labels = ["audit-s3", "ui", "release-s3", "bug", "retro-s2", "misc"];
    const { unmount } = render(<RowLabels labels={labels} setting={setting("", VOCAB)} />);
    expect(screen.getAllByRole("button").map((c) => c.textContent)).toEqual(["ui", "bug", "misc?"]);
    expect(document.querySelector(".row-label.more")!.getAttribute("aria-label")).toBe(
      "ほかのラベル audit-s3, release-s3, retro-s2",
    );
    unmount();
    render(<RowLabels labels={["audit-s3"]} setting={setting("", VOCAB)} />);
    const audit = screen.getByRole("button", { name: "audit-s3" });
    expect(audit.className).toBe("row-label label-procedure");
    expect(audit.title).toBe("ラベル audit-s3 で絞る\n手順のラベル");
    cleanup();
    render(<RowLabels labels={labels} setting={setting("", VOCAB, true)} />);
    expect(screen.getAllByRole("button").map((c) => c.textContent)).toEqual(["ui", "bug", "misc?"]);
    expect(document.querySelector(".row-label.more")).toBeNull();
    cleanup();
    const { container } = render(
      <RowLabels labels={["audit-s3"]} setting={setting("", VOCAB, true)} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("ラベルの絞り込みの候補", () => {
  const optionsOf = (names: string[], vocabulary: LabelVocabulary) => {
    render(
      <select aria-label="ラベル">
        <LabelFilterOptions names={names} vocabulary={vocabulary} />
      </select>,
    );
    return [...document.querySelectorAll("optgroup")].map((g) => ({
      label: g.label,
      options: [...g.querySelectorAll("option")].map((o) => o.textContent),
    }));
  };

  it("語彙があれば軸ごとの組に分けて名前の横に説明を出し、語彙にない名前は最後の組にまとめる", () => {
    expect(optionsOf(["bug", "misc", "ui"], VOCAB)).toEqual([
      { label: "area", options: ["ui — 画面"] },
      { label: "kind", options: ["bug — 不具合"] },
      { label: "語彙にない", options: ["misc"] },
    ]);
  });

  it("語彙のないボードは組に分けず名前だけを並べる", () => {
    expect(optionsOf(["bug", "ui"], EMPTY_VOCABULARY)).toEqual([]);
    expect([...document.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "bug",
      "ui",
    ]);
  });
});
