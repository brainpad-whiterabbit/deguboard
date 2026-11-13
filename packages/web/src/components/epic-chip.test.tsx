// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EpicChipRow, useEpicHighlight } from "./epic-chip.js";

afterEach(cleanup);

type EpicId = `e${number}`;
const epic = (id: EpicId) => ({
  id,
  title: `題 ${id}`,
  progress: {
    done: 0,
    total: 1,
    by_status: { todo: 1, in_progress: 0, review: 0, done: 0, abandoned: 0 },
  },
});

/** 画面の代わり：札の行と、光らせている Epic を出す */
function Screen({ ids }: { ids: EpicId[] }) {
  const { highlight, onHighlight } = useEpicHighlight("");
  return (
    <>
      <output data-testid="highlight">{highlight ?? ""}</output>
      {ids.length > 0 && (
        <EpicChipRow
          epics={ids.map(epic)}
          noEpic={0}
          selected=""
          onSelect={() => {}}
          onHighlight={onHighlight}
        />
      )}
    </>
  );
}
const lit = () => screen.getByTestId("highlight").textContent;
const chip = (id: string) => screen.getByRole("button", { name: `${id} 題 ${id}` });

describe("EpicChipRow と useEpicHighlight", () => {
  it("触れている札が消えると（Epic が閉じるなど）、mouseleave が来なくても光りを消す", () => {
    const { rerender } = render(<Screen ids={["e1", "e2"]} />);
    fireEvent.mouseEnter(chip("e1"));
    expect(lit()).toBe("e1");
    rerender(<Screen ids={["e2"]} />);
    expect(lit()).toBe("");
  });

  it("Tab で止まった札が、札の行ごと消えても光りを消す", () => {
    const { rerender } = render(<Screen ids={["e1"]} />);
    fireEvent.focus(chip("e1"));
    expect(lit()).toBe("e1");
    rerender(<Screen ids={[]} />);
    expect(lit()).toBe("");
  });

  it("触れていない札が消えても、触れている札の光りはそのまま", () => {
    const { rerender } = render(<Screen ids={["e1", "e2"]} />);
    fireEvent.mouseEnter(chip("e1"));
    fireEvent.mouseLeave(chip("e1"));
    fireEvent.mouseEnter(chip("e2"));
    rerender(<Screen ids={["e2"]} />);
    expect(lit()).toBe("e2");
  });
});
