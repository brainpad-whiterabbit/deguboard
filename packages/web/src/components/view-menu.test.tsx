// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HostProvider, type Host } from "../host.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import {
  DEFAULT_ROW_VIEW,
  ROW_VIEW_KEY,
  RowViewMenu,
  rowViewChanged,
  rowViewOf,
  useRowView,
} from "./view-menu.js";

afterEach(cleanup);

describe("行の見た目の値", () => {
  it("既定はラベルを出す。残した値がない・壊れている・項目がないときは既定で読む", () => {
    expect(DEFAULT_ROW_VIEW).toEqual({ labels: true });
    expect(rowViewOf(undefined)).toEqual(DEFAULT_ROW_VIEW);
    expect(rowViewOf("x")).toEqual(DEFAULT_ROW_VIEW);
    expect(rowViewOf({})).toEqual(DEFAULT_ROW_VIEW);
    expect(rowViewOf({ labels: "no" })).toEqual(DEFAULT_ROW_VIEW);
    expect(rowViewOf({ labels: false, other: 1 })).toEqual({ labels: false });
  });

  it("既定と違うときだけ変えたことにする", () => {
    expect(rowViewChanged({ labels: true })).toBe(false);
    expect(rowViewChanged({ labels: false })).toBe(true);
  });
});

function hostOf(): Host {
  return {
    surface: "sidebar",
    open: () => {},
    show: () => {},
    copy: async () => {},
    state: createUiState(memoryBackend()),
  };
}

function Menu() {
  const [view, setView] = useRowView();
  return (
    <>
      <RowViewMenu view={view} onChange={setView} />
      <span data-testid="labels">{String(view.labels)}</span>
    </>
  );
}

describe("「表示」ボタンとメニュー", () => {
  it("押すとメニューを開いて最初の項目にフォーカスし、「ラベルを出す」で入り切りする。値は host.state に残り、既定と違う間はボタンを色付きにする", () => {
    const host = hostOf();
    render(
      <HostProvider host={host}>
        <Menu />
      </HostProvider>,
    );
    const toggle = screen.getByRole("button", { name: "表示" });
    expect(toggle.getAttribute("aria-haspopup")).toBe("menu");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.classList.contains("active")).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const item = screen.getByRole("menuitemcheckbox", { name: "ラベルを出す" });
    expect(document.activeElement).toBe(item);
    expect(item.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(item);
    // 項目を押してもメニューは閉じない
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(item.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("labels").textContent).toBe("false");
    expect(host.state.get(ROW_VIEW_KEY)).toEqual({ labels: false });
    const changed = screen.getByRole("button", { name: "表示（既定と違う）" });
    expect(changed.classList.contains("active")).toBe(true);

    // Esc で閉じてボタンへフォーカスを戻す
    fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(changed);
  });

  it("メニューの外を押すと閉じ、残した値で開き直す", () => {
    const host = hostOf();
    host.state.set(ROW_VIEW_KEY, { labels: false });
    render(
      <HostProvider host={host}>
        <Menu />
        <p>外</p>
      </HostProvider>,
    );
    expect(screen.getByTestId("labels").textContent).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "表示（既定と違う）" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("外"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
