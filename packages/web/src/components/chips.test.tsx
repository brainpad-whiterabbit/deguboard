// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chip, ChipRow } from "./chips.js";

// jsdom は配置をしないので、1 行に perRow 個並ぶとして位置を返す
let perRow = 3;
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")!;
beforeEach(() => {
  perRow = 3;
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      const row = this.parentElement;
      if (!row?.classList.contains("chip-row")) return 0;
      return Math.floor([...row.children].indexOf(this) / perRow) * 20;
    },
  });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(HTMLElement.prototype, "offsetTop", original);
});

function row(titles: string[]) {
  return (
    <ChipRow label="絞る" contentKey={titles.join("|")}>
      {titles.map((t, i) => (
        <Chip key={i} pressed={false} onClick={() => {}}>
          {t}
        </Chip>
      ))}
    </ChipRow>
  );
}
const shown = () => [...document.querySelectorAll(".chip")].map((c) => c.textContent);

describe("ChipRow", () => {
  it("数が同じでもチップの中身が変われば数え直し、収まれば「ほか N」を外す", async () => {
    const { rerender } = render(row(["a", "b", "c", "d", "e", "f", "g"]));
    await waitFor(() => expect(shown()).toEqual(["a", "b", "c", "d", "e", "ほか 2"]));
    // 中身が短くなって 1 行に 4 つ並ぶようになった
    perRow = 4;
    rerender(row(["a", "b", "c", "d", "e", "f", "h"]));
    await waitFor(() => expect(shown()).toEqual(["a", "b", "c", "d", "e", "f", "h"]));
    expect(screen.queryByRole("button", { name: /あと/ })).toBeNull();
  });
});
