// 一覧の行の複数選択（UI-15）。VS Code の一覧と同じく、Ctrl/⌘+クリックで 1 行ずつ足し外し、Shift+クリックで前に押した行からの範囲を選ぶ。
// ふつうのクリックは今までどおり詳細を開き、選択を外す（次の Shift+クリックの起点になる）。Esc でも外す。
// 選択は画面の見た目の状態として SelectionProvider が持つ（データには書かない。画面を替えたら外す）。
// 行は useAskSpot の select で選べるようになり（ask-menu.tsx）、選んだ行の吹き出し・右クリックは選んだ全件を対象にする。
// 選んでいる間は画面の下に「n 件を選択 ・ 頼む」の帯（SelectionBar）を出し、「頼む」で選んだ全件の頼むことの一覧を出す。
// 範囲は画面に出ている行（data-select-id）の並びで決め、選んだ ID もその並びで持つ

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { AskSection } from "./ask-menu.js";

/** 選べる行に付ける属性の名前（範囲を画面の並びで決めるため） */
export const SELECT_ATTR = "data-select-id";

interface SelectionState {
  ids: readonly string[];
  /** Shift+クリックの起点（最後に押した行） */
  anchor: string | null;
  /** 選んだ行の場所（右クリックの文脈の webviewSection と、詳細の中の行なら入っている Iteration・Epic） */
  section: AskSection | null;
  within: string | undefined;
}

export interface RowSelection {
  /** 選んでいる ID（画面の並び） */
  ids: readonly string[];
  section: AskSection | null;
  within: string | undefined;
  has(id: string): boolean;
  /** 行を押したとき。修飾キーで選び方を決め、選んだら true（詳細は開かない） */
  click(
    id: string,
    e: MouseEvent,
    place: { section: AskSection; within?: string | undefined },
  ): boolean;
  clear(): void;
}

const EMPTY: SelectionState = { ids: [], anchor: null, section: null, within: undefined };

const SelectionContext = createContext<RowSelection | null>(null);

/** 画面に出ている選べる行の ID（並び順） */
function shownIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>(`[${SELECT_ATTR}]`)].map((el) =>
    el.getAttribute(SELECT_ATTR)!,
  );
}

/** ids を画面の並びに揃える（画面にないものは後ろに残す） */
function inShownOrder(ids: ReadonlySet<string>): string[] {
  const shown = shownIds().filter((id) => ids.has(id));
  const rest = [...ids].filter((id) => !shown.includes(id));
  return [...new Set([...shown, ...rest])];
}

/** Ctrl/⌘+クリックと Shift+クリックの選び方。ほかの修飾キー（Alt）は選ばない */
export function selectKind(e: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">) {
  if (e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return "toggle";
  if (e.shiftKey) return "range";
  return null;
}

/**
 * 行の選択を持つ。scope が替わったら（画面を替えたら）外す。Esc で外す（入力欄・頼むことの一覧の中の Esc は向こうが受ける）
 */
export function SelectionProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [state, setState] = useState<SelectionState>(EMPTY);
  const [seenScope, setSeenScope] = useState(scope);
  // 画面を替えたら外す（描画の中で前の scope と比べる。effect で外すと 1 回前の選択で描いてしまう）
  if (seenScope !== scope) {
    setSeenScope(scope);
    setState(EMPTY);
  }
  const clear = useCallback(() => setState((s) => ({ ...EMPTY, anchor: s.anchor })), []);
  const selecting = state.ids.length > 0;

  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as Element | null;
      if (t?.closest?.("input, textarea, select, .ask-composer")) return;
      clear();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selecting, clear]);

  const click = useCallback<RowSelection["click"]>((id, e, place) => {
    const kind = selectKind(e);
    if (!kind) {
      setState((s) => (s.ids.length === 0 && s.anchor === id ? s : { ...EMPTY, anchor: id }));
      return false;
    }
    setState((s) => {
      // 場所の違う行（別の Iteration の詳細など）を混ぜない
      const same = s.section === place.section && s.within === place.within;
      let next: Set<string>;
      if (kind === "toggle") {
        next = new Set(same ? s.ids : []);
        if (next.has(id)) next.delete(id);
        else next.add(id);
      } else {
        const shown = shownIds();
        const from = s.anchor ? shown.indexOf(s.anchor) : -1;
        const to = shown.indexOf(id);
        const range =
          from < 0 || to < 0 ? [id] : shown.slice(Math.min(from, to), Math.max(from, to) + 1);
        // VS Code の一覧と同じく、起点からの範囲で選び直す
        next = new Set(range);
      }
      const ids = inShownOrder(next);
      return {
        ids,
        // 範囲の起点は動かさない（続けて Shift+クリックすると、同じ起点から選び直す VS Code の動きに近づける）
        anchor: kind === "range" && s.anchor ? s.anchor : id,
        section: ids.length > 0 ? place.section : null,
        within: ids.length > 0 ? place.within : undefined,
      };
    });
    return true;
  }, []);

  const value = useMemo<RowSelection>(
    () => ({
      ids: state.ids,
      section: state.section,
      within: state.within,
      has: (id) => state.ids.includes(id),
      click,
      clear,
    }),
    [state, click, clear],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** 行の選択。Provider の外（テストの部品だけの描画など）では null で、行は選べない */
export function useSelection(): RowSelection | null {
  return useContext(SelectionContext);
}
