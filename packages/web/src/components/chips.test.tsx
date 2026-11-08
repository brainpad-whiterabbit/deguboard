// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("「ほか N」を押すとすべて出し、「畳む」で戻す。選んだチップは隠さず、出す分の最後に回す", async () => {
    const titles = ["a", "b", "c", "d", "e", "f", "g"];
    const chipRow = (pressedTitle: string) => (
      <ChipRow label="絞る" contentKey={titles.join("|")}>
        {titles.map((t) => (
          <Chip key={t} pressed={t === pressedTitle} onClick={() => {}}>
            {t}
          </Chip>
        ))}
      </ChipRow>
    );
    render(chipRow("f"));
    // 2 行に収まる数まで減らし、選んだ f は隠さず出す分の最後に回す
    await waitFor(() => expect(shown()).toEqual(["a", "b", "c", "d", "f", "ほか 2"]));
    // 畳んでいる間の「ほか N」は aria-expanded が false
    const more = screen.getByRole("button", { name: /あと 2 個/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(shown()).toEqual(["a", "b", "c", "d", "e", "f", "g", "畳む"]);
    // 開いている間の「畳む」は aria-expanded が true
    const less = screen.getByRole("button", { name: "畳む" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(less);
    await waitFor(() => expect(shown()).toEqual(["a", "b", "c", "d", "f", "ほか 2"]));
    // 畳んだ後も、選んだ f は残り、押した状態のまま出る
    expect(document.querySelector('.chip[aria-pressed="true"]')!.textContent).toBe("f");
  });
});
