// 左パネルの「表示」ボタンとメニュー（UI-2・UI-3）。バックログは検索欄の漏斗の隣、カンバンは見出しの漏斗の隣に置き、
// 行の見た目（今はラベルを出すか）を切り替える。値は人ごとの見た目なので host.state に残し（useUiState）、2 つのタブで同じ値を使う。
// 既定と違う間はボタンを色付きにする（styles.css の .view-toggle.active）。メニューの項目は ViewMenuCheck を足して増やす

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useUiState } from "../host.js";
import { tr } from "../l10n.js";

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

/** 行の見た目のメニュー（バックログとカンバンで同じ）。項目を足すときはここに ViewMenuCheck などを並べる */
export function RowViewMenu({
  view,
  onChange,
}: {
  view: RowView;
  onChange: (patch: Partial<RowView>) => void;
}) {
  return (
    <ViewMenu changed={rowViewChanged(view)}>
      <ViewMenuCheck checked={view.labels} onToggle={() => onChange({ labels: !view.labels })}>
        {tr("ラベルを出す")}
      </ViewMenuCheck>
    </ViewMenu>
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
