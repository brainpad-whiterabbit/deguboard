// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HostProvider, type Host } from "../host.js";
import { createUiState, memoryBackend } from "../ui-state.js";
import { BACKLOG_SORT_KEYS, DEFAULT_ROW_SORT, useRowSort } from "./row-sort.js";
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
  it("既定はラベルも手順のラベルも出す。残した値がない・壊れている・項目がないときは既定で読む", () => {
    expect(DEFAULT_ROW_VIEW).toEqual({ labels: true, procedureLabels: true });
    expect(rowViewOf(undefined)).toEqual(DEFAULT_ROW_VIEW);
    expect(rowViewOf("x")).toEqual(DEFAULT_ROW_VIEW);
    expect(rowViewOf({})).toEqual(DEFAULT_ROW_VIEW);
    expect(rowViewOf({ labels: "no" })).toEqual(DEFAULT_ROW_VIEW);
    // 手順のラベルの項目を足す前に残した値も読める
    expect(rowViewOf({ labels: false, other: 1 })).toEqual({
      labels: false,
      procedureLabels: true,
    });
    expect(rowViewOf({ labels: true, procedureLabels: false })).toEqual({
      labels: true,
      procedureLabels: false,
    });
  });

  it("既定と違うときだけ変えたことにする", () => {
    expect(rowViewChanged({ labels: true, procedureLabels: true })).toBe(false);
    expect(rowViewChanged({ labels: false, procedureLabels: true })).toBe(true);
    expect(rowViewChanged({ labels: true, procedureLabels: false })).toBe(true);
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
      <span data-testid="procedure">{String(view.procedureLabels)}</span>
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
    expect(host.state.get(ROW_VIEW_KEY)).toEqual({ labels: false, procedureLabels: true });
    const changed = screen.getByRole("button", { name: "表示（既定と違う）" });
    expect(changed.classList.contains("active")).toBe(true);

    // Esc で閉じてボタンへフォーカスを戻す
    fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(changed);
  });

  it("並び順を渡すと、基準を ↑↓ で移れる項目に並べ、選んでいる基準に ✓ と向きを出す。「既定に戻す」はラベルの表示と並び順をどちらも既定にし、フォーカスを最初の項目へ移す", () => {
    const host = hostOf();
    host.state.set(ROW_VIEW_KEY, { labels: false });
    function SortMenu() {
      const [view, setView] = useRowView();
      const [sort, setSort] = useRowSort("backlog");
      return (
        <RowViewMenu
          view={view}
          onChange={setView}
          sort={{ sort, keys: BACKLOG_SORT_KEYS, onChange: setSort }}
        />
      );
    }
    render(
      <HostProvider host={host}>
        <SortMenu />
      </HostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "表示（既定と違う）" }));
    const group = screen.getByRole("group", { name: "並び順" });
    const priority = within(group).getByRole("menuitemradio", { name: "優先度 ↓" });
    expect(priority.getAttribute("aria-checked")).toBe("true");
    expect(priority.textContent).toBe("✓優先度↓");
    // ラベルを切っている間の「手順のラベルを出す」は選べないが、↑↓ では止まる
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemcheckbox", { name: "手順のラベルを出す" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(priority);

    fireEvent.click(within(group).getByRole("menuitemradio", { name: "番号" }));
    expect(host.state.get("backlog.sort")).toEqual({ key: "number", dir: "asc" });
    expect(
      within(group).getByRole("menuitemradio", { name: "番号 ↑" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(priority.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("menuitem", { name: "既定に戻す" }));
    expect(host.state.get(ROW_VIEW_KEY)).toEqual(DEFAULT_ROW_VIEW);
    expect(host.state.get("backlog.sort")).toEqual(DEFAULT_ROW_SORT);
    expect(screen.queryByRole("menuitem", { name: "既定に戻す" })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemcheckbox", { name: "ラベルを出す" }),
    );
    expect(screen.getByRole("button", { name: "表示" }).classList.contains("active")).toBe(false);
  });

  it("「手順のラベルを出す」で手順のラベルを隠す・出す。ラベルを切っている間は選べず、押しても変わらない", () => {
    const host = hostOf();
    render(
      <HostProvider host={host}>
        <Menu />
      </HostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "表示" }));
    const item = screen.getByRole("menuitemcheckbox", { name: "手順のラベルを出す" });
    expect(item.getAttribute("aria-checked")).toBe("true");
    expect(item.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(item);
    expect(item.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("procedure").textContent).toBe("false");
    expect(host.state.get(ROW_VIEW_KEY)).toEqual({ labels: true, procedureLabels: false });
    expect(screen.getByRole("button", { name: "表示（既定と違う）" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "ラベルを出す" }));
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(item);
    expect(screen.getByTestId("procedure").textContent).toBe("false");
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
