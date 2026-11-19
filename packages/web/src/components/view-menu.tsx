// 左パネルの「表示」ボタンとメニュー（UI-2・UI-3）。バックログは検索欄の漏斗の隣、カンバンは見出しの漏斗の隣に置き、
// 行の見た目（ラベルを出すか）と並び順（components/row-sort.ts）を切り替える。値は人ごとの見た目なので host.state に残す（useUiState）。
// ラベルを出すかは 2 つのタブで同じ値、並び順はタブごとの値。
// 既定と違う間はボタンを色付きにする（styles.css の .view-toggle.active）。メニューの項目は ViewMenuCheck を足して増やす。
// メニューは上の端の帯には入れない（並びが既定と違うことは帯の札 RowSortChip で知らせ、× で戻せる）

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useUiState } from "../host.js";
import { tr } from "../l10n.js";
import {
  DEFAULT_ROW_SORT,
  pickRowSort,
  ROW_SORT_LABELS,
  rowSortArrow,
  rowSortChanged,
  type RowSort,
  type RowSortKey,
} from "./row-sort.js";

/** 行の見た目の選び方。項目を足すときは DEFAULT_ROW_VIEW と rowViewOf も直す */
export interface RowView {
  /** 行のタイトルの下にラベルを出すか */
  labels: boolean;
}

export const DEFAULT_ROW_VIEW: RowView = { labels: true };

/** host.state の鍵。バックログとカンバンで同じ鍵を読む */
export const ROW_VIEW_KEY = "rows.view";

/** 残した値から行の見た目を読む。壊れた値・ない項目は既定にする（項目を足しても前の値が読める） */
export function rowViewOf(stored: unknown): RowView {
  const v =
    typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  return {
    labels: typeof v.labels === "boolean" ? v.labels : DEFAULT_ROW_VIEW.labels,
  };
}

/** 既定と違う見た目を選んでいるか（「表示」ボタンを色付きにする） */
export function rowViewChanged(view: RowView): boolean {
  return view.labels !== DEFAULT_ROW_VIEW.labels;
}

/** 行の見た目と、その一部を変える関数 */
export function useRowView(): [RowView, (patch: Partial<RowView>) => void] {
  const [stored, setStored] = useUiState<unknown>(ROW_VIEW_KEY, undefined);
  const view = rowViewOf(stored);
  return [view, (patch) => setStored({ ...view, ...patch })];
}

/** メニューの並び順の欄に渡すもの。keys はそのタブで選べる基準（components/row-sort.ts） */
export interface RowSortMenu {
  sort: RowSort;
  keys: readonly RowSortKey[];
  onChange: (sort: RowSort) => void;
}

/**
 * 行の見た目のメニュー（バックログとカンバンで同じ）。項目を足すときはここに ViewMenuCheck などを並べる。
 * sort を渡すと、その下に並び順の基準を並べる（選んでいる基準は ✓ と向きの矢印。もう一度押すと向きを入れ替える。pickRowSort）。
 * 見た目か並びが既定と違う間は、最後に「既定に戻す」を出す（ラベルの表示と並び順をどちらも既定にする）
 */
export function RowViewMenu({
  view,
  onChange,
  sort,
}: {
  view: RowView;
  onChange: (patch: Partial<RowView>) => void;
  sort?: RowSortMenu | undefined;
}) {
  const sorted = !!sort && rowSortChanged(sort.sort);
  const changed = rowViewChanged(view) || sorted;
  return (
    <ViewMenu changed={changed}>
      <ViewMenuCheck checked={view.labels} onToggle={() => onChange({ labels: !view.labels })}>
        {tr("ラベルを出す")}
      </ViewMenuCheck>
      {sort ? (
        <div className="view-menu-group" role="group" aria-label={tr("並び順")}>
          <div className="view-menu-head" aria-hidden="true">
            {tr("並び順")}
          </div>
          {sort.keys.map((key) => {
            const on = sort.sort.key === key;
            const name = tr(ROW_SORT_LABELS[key]);
            return (
              <button
                key={key}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                aria-label={on ? `${name} ${rowSortArrow(sort.sort.dir)}` : name}
                title={on ? tr("向きを入れ替える") : tr("{0} で並べる", name)}
                className="view-menu-item"
                onClick={() => sort.onChange(pickRowSort(sort.sort, key))}
              >
                <span className="view-menu-check" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
                {name}
                {on ? (
                  <span className="view-menu-dir" aria-hidden="true">
                    {rowSortArrow(sort.sort.dir)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {changed ? (
        <button
          type="button"
          role="menuitem"
          className="view-menu-item view-menu-reset"
          onClick={(e) => {
            // 戻すとこの項目は消えるので、フォーカスをメニューの最初の項目へ移す（メニューの外へ落とさない）
            e.currentTarget
              .closest('[role="menu"]')
              ?.querySelector<HTMLElement>('[role^="menuitem"]')
              ?.focus();
            if (rowViewChanged(view)) onChange(DEFAULT_ROW_VIEW);
            if (sorted) sort?.onChange(DEFAULT_ROW_SORT);
          }}
        >
          <span className="view-menu-check" aria-hidden="true" />
          {tr("既定に戻す")}
        </button>
      ) : null}
    </ViewMenu>
  );
}

/** 並びが既定と違う間に出す札（「並び 更新日 ↓」）。× で既定に戻す。バックログの絞り込みの行・カンバンの見出しの下と、上の端の帯で使う */
export function RowSortChip({ sort, onReset }: { sort: RowSort; onReset: () => void }) {
  const text = tr("並び {0} {1}", tr(ROW_SORT_LABELS[sort.key]), rowSortArrow(sort.dir));
  return (
    <span className="filter-chip sort-chip" title={text}>
      <span className="filter-chip-text">{text}</span>
      <button type="button" aria-label={tr("{0} を既定に戻す", text)} onClick={onReset}>
        ×
      </button>
    </span>
  );
}

/**
 * 「表示」ボタンと、押すと下に開くメニュー。開くと最初の項目にフォーカスし、↑↓で項目を移る。
 * 外を押すか Esc（ボタンへフォーカスを戻す）・Tab で閉じる。項目を押しても閉じない（続けて切り替えられる）
 */
function ViewMenu({ changed, children }: { changed: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const onPointer = (e: PointerEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [open]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      toggle.current?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };
  const label = changed ? tr("表示（既定と違う）") : tr("表示");
  return (
    <span className="view-menu" ref={box}>
      <button
        ref={toggle}
        type="button"
        className={`view-toggle${changed ? " active" : ""}${open ? " open" : ""}`}
        aria-label={label}
        title={tr("表示を切り替える")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ViewIcon />
      </button>
      {open ? (
        <div className="view-menu-list" role="menu" aria-label={tr("表示")} onKeyDown={onKeyDown}>
          {children}
        </div>
      ) : null}
    </span>
  );
}

/** メニューの入り切りの項目。入っている間は ✓ を出す */
function ViewMenuCheck({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className="view-menu-item"
      onClick={onToggle}
    >
      <span className="view-menu-check" aria-hidden="true">
        {checked ? "✓" : ""}
      </span>
      {children}
    </button>
  );
}

/** 表示の印（長さの違う横線と下向きの矢印）。線は currentColor */
function ViewIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    >
      <path d="M2 4h7M2 8h5M2 12h3M12.5 3v10M10.5 11l2 2 2-2" />
    </svg>
  );
}
