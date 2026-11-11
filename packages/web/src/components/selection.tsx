// 一覧の行の複数選択（UI-15）。VS Code の一覧と同じく、Ctrl/⌘+クリックで 1 行ずつ足し外し、Shift+クリックで前に押した行からの範囲を選ぶ。
// 行の左端の帯（styles.css の [data-select-id]::before）を押しても 1 行ずつ足し外しする（ask-menu.tsx の onClickCapture）。
// 帯を押したままなぞると、通った行の範囲をまとめて選ぶ（始めの行が選んであれば外す）。なぞるのはマウスとペンだけで、
// タッチは一覧のスクロールのまま（pointerType で決める）。一覧の端で自動スクロールする（sweepStart）。
// ふつうのクリックは今までどおり詳細を開き、選択を外す（次の Shift+クリックの起点になる）。Esc でも外す。
// 選択は画面の見た目の状態として SelectionProvider が持つ（データには書かない。画面を替えたら外す）。
// 行は useAskSpot の select で選べるようになり（ask-menu.tsx）、選んだ行の吹き出しは選んだ全件を対象にする。
// 選んでいる間は画面の下に「n 件を選択 ・ 頼む」の帯（SelectionBar）を出し、「頼む」で選んだ全件の頼むことの一覧を出す。
// 範囲は画面に出ている行（data-select-id）の並びで決め、選んだ ID もその並びで持つ

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { AskSection } from "./ask-menu.js";

/** 選べる行に付ける属性の名前（範囲を画面の並びで決めるため） */
export const SELECT_ATTR = "data-select-id";
/** 選べる行の場所の印（なぞりは同じ場所の行だけを数える。場所の違う行を混ぜない） */
export const SCOPE_ATTR = "data-select-scope";

/** 行の場所の印の値（場所の種類と、詳細の中の行なら入っている Iteration・Epic） */
export function scopeOf(section: AskSection, within: string | undefined): string {
  return JSON.stringify([section, within ?? null]);
}

/** なぞりの始まりに要る、押したときの pointer の情報 */
export type SweepPress = Pick<
  PointerEvent,
  | "pointerId"
  | "pointerType"
  | "button"
  | "altKey"
  | "ctrlKey"
  | "metaKey"
  | "shiftKey"
  | "clientX"
  | "clientY"
>;

/** なぞりを始めるまでの動き（px）。これより小さい動きは、ふつうのクリックとして扱う */
const SWEEP_START_PX = 4;
/** 一覧の端からこの距離（px）の中に来たら自動でスクロールする */
const EDGE_PX = 32;
/** 自動スクロールの 1 フレームの最大（px） */
const MAX_STEP_PX = 20;

interface SelectionState {
  ids: readonly string[];
  /** Shift+クリックの起点（最後に押した行） */
  anchor: string | null;
  /** 選んだ行の場所（場所の種類と、詳細の中の行なら入っている Iteration・Epic） */
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
  /**
   * 左端の帯を押したとき（修飾キーなし・マウスかペン）。動いたら、通った行の範囲をまとめて選ぶ・外すを追う。
   * 押した行が選んであれば外す。動かずに離したら何もしない（ふつうのクリックが 1 件を足し外しする）
   */
  sweepStart(
    id: string,
    press: SweepPress,
    el: HTMLElement,
    place: { section: AskSection; within?: string | undefined },
  ): void;
  clear(): void;
}

/** なぞりの途中の状態 */
interface Sweep {
  pointerId: number;
  startId: string;
  place: { section: AskSection; within?: string | undefined };
  /** 行の場所の印と、行の列（左端の位置）。同じ場所・同じ列の行だけを数える */
  scope: string;
  column: number;
  /** なぞる前に選んでいた ID（同じ場所のときだけ） */
  base: readonly string[];
  /** 始めの行を足すなぞりか（外すなぞりは false） */
  adding: boolean;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** 動きが始まったか（始まるまでは click として扱う） */
  active: boolean;
  scroller: HTMLElement | null;
  frame: number | null;
  stop(): void;
}

const EMPTY: SelectionState = { ids: [], anchor: null, section: null, within: undefined };

const SelectionContext = createContext<RowSelection | null>(null);

/**
 * 画面に出ている選べる行の ID（並び順）。畳んだ節（閉じた details）の中の行は見えないので除く
 * （Shift+クリックの範囲が閉じた節をまたいでも、見えない行を選ばない）
 */
function shownIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>(`[${SELECT_ATTR}]`)]
    .filter((el) => !el.closest("details:not([open])"))
    .map((el) => el.getAttribute(SELECT_ATTR)!);
}

/**
 * なぞりで通れる行（同じ場所・同じ列の、見えている行。並びは画面の順）。
 * 列は左端の位置で揃える（ボードは列ごとに並ぶので、列をまたいで範囲を取らない）。
 * 見えていない行（画面の外）も位置は取れるので、一覧の中ならスクロールした先の行も数える
 */
function sweepRows(scope: string, column: number): { id: string; top: number }[] {
  return [...document.querySelectorAll<HTMLElement>(`[${SELECT_ATTR}]`)]
    .filter((el) => el.getAttribute(SCOPE_ATTR) === scope && !el.closest("details:not([open])"))
    .map((el) => ({ id: el.getAttribute(SELECT_ATTR)!, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.height > 0 && Math.abs(r.left - column) < 1)
    .map(({ id, r }) => ({ id, top: r.top }));
}

/** 指している y の行の位置（その行より上の行の先頭に来たら、いちばん近い上の行。一覧の上なら先頭） */
function rowAt(rows: readonly { top: number }[], y: number): number {
  let at = 0;
  rows.forEach((row, i) => {
    if (row.top <= y) at = i;
  });
  return at;
}

/** 押した行から上にたどって、縦にスクロールできる一覧（なければ null で画面全体） */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** 指が一覧の端のどれだけ内側にあるかで、1 フレームにスクロールする量（上は負）を決める */
function edgeStep(y: number, top: number, bottom: number): number {
  const up = top + EDGE_PX - y;
  if (up > 0) return -Math.min(MAX_STEP_PX, Math.max(1, Math.round(up / 2)));
  const down = y - (bottom - EDGE_PX);
  if (down > 0) return Math.min(MAX_STEP_PX, Math.max(1, Math.round(down / 2)));
  return 0;
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

  // 押したときの選択を base に取るため、最新の選択を持つ（描いたあとに effect で写す。押すのは描いたあとなので足りる）
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);
  const sweepRef = useRef<Sweep | null>(null);
  // なぞりで選び終えた直後の click を 1 回捨てる（離した場所によっては行の click が届き、選び方を二重に変えるため）
  const sweptRef = useRef(false);

  useEffect(() => {
    const onDown = () => {
      sweptRef.current = false;
    };
    const onClick = (e: Event) => {
      if (!sweptRef.current) return;
      sweptRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onClick, true);
    };
  }, []);

  /** 通った行の範囲で選び直す（base に範囲を足す・外す）。押した行から指の今の行までの範囲 */
  const sweepTo = useCallback((sw: Sweep) => {
    const rows = sweepRows(sw.scope, sw.column);
    const start = rows.findIndex((row) => row.id === sw.startId);
    if (start < 0) return;
    const at = rowAt(rows, sw.y);
    const range = rows.slice(Math.min(start, at), Math.max(start, at) + 1).map((row) => row.id);
    setState((s) => {
      const next = new Set(
        sw.adding ? [...sw.base, ...range] : sw.base.filter((id) => !range.includes(id)),
      );
      const ids = inShownOrder(next);
      return {
        ids,
        anchor: s.anchor,
        section: ids.length > 0 ? sw.place.section : null,
        within: ids.length > 0 ? sw.place.within : undefined,
      };
    });
  }, []);

  const sweepStart = useCallback<RowSelection["sweepStart"]>(
    (id, press, el, place) => {
      // タッチは選ばない（一覧のスクロールに任せる）。左のボタン以外と修飾キーつきは、ふつうのクリックの選び方に任せる
      if (press.pointerType === "touch" || press.button !== 0) return;
      if (press.altKey || selectKind(press)) return;
      if (sweepRef.current) return;
      const cur = latest.current;
      const same = cur.section === place.section && cur.within === place.within;
      const base = same ? cur.ids : [];
      const sw: Sweep = {
        pointerId: press.pointerId,
        startId: id,
        place,
        scope: el.getAttribute(SCOPE_ATTR) ?? "",
        column: el.getBoundingClientRect().left,
        base,
        adding: !base.includes(id),
        startX: press.clientX,
        startY: press.clientY,
        x: press.clientX,
        y: press.clientY,
        active: false,
        scroller: scrollerOf(el),
        frame: null,
        stop: () => {},
      };
      sweepRef.current = sw;
      // 押した行で捕捉する。画面の外へ出ても動きと離すを受け、捕捉が外れたら lostpointercapture で終える
      try {
        el.setPointerCapture(press.pointerId);
      } catch {
        // 捕捉できないときは、下の window の動き・離す・ぼけで終える
      }

      const finish = () => {
        sw.stop();
        if (sweepRef.current === sw) sweepRef.current = null;
      };
      // 端に来ている間は、動かなくても一覧を送り続ける（行を 1 つ動くたびに選び直す）
      const frame = () => {
        const rect = sw.scroller?.getBoundingClientRect() ?? {
          top: 0,
          bottom: window.innerHeight,
        };
        const step = edgeStep(sw.y, rect.top, rect.bottom);
        if (step !== 0) {
          if (sw.scroller) sw.scroller.scrollTop += step;
          else window.scrollBy(0, step);
          sweepTo(sw);
        }
        sw.frame = requestAnimationFrame(frame);
      };
      const onMove = (ev: Event) => {
        const m = ev as PointerEvent;
        if (m.pointerId !== sw.pointerId) return;
        // マウスのボタンを離したのを、画面の外で離したときは window で拾えないので、ここで終える
        if (m.pointerType === "mouse" && m.buttons === 0) {
          if (sw.active) sweptRef.current = true;
          finish();
          return;
        }
        sw.x = m.clientX;
        sw.y = m.clientY;
        if (!sw.active) {
          if (Math.hypot(sw.x - sw.startX, sw.y - sw.startY) < SWEEP_START_PX) return;
          sw.active = true;
          frame();
        }
        sweepTo(sw);
      };
      // 終える。動いていたら、通った行の選びを残して押した行を起点にする
      const endSweep = () => {
        if (sw.active) {
          sweptRef.current = true;
          setState((s) => ({ ...s, anchor: sw.startId }));
        }
        finish();
      };
      const onUp = (ev: Event) => {
        if ((ev as PointerEvent).pointerId !== sw.pointerId) return;
        endSweep();
      };
      // 捕捉が外れたとき（画面の外で離して pointerup が届かないときを含む）と、ウィンドウがぼけたときも終える
      const onLost = (ev: Event) => {
        if ((ev as PointerEvent).pointerId !== sw.pointerId) return;
        endSweep();
      };
      const onBlur = () => endSweep();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("blur", onBlur);
      el.addEventListener("lostpointercapture", onLost);
      sw.stop = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("blur", onBlur);
        el.removeEventListener("lostpointercapture", onLost);
        try {
          if (el.hasPointerCapture(sw.pointerId)) el.releasePointerCapture(sw.pointerId);
        } catch {
          // 捕捉を外せないときは、ブラウザがすでに外したあとなので何もしない
        }
        if (sw.frame !== null) cancelAnimationFrame(sw.frame);
        sw.frame = null;
      };
    },
    [sweepTo],
  );

  const value = useMemo<RowSelection>(
    () => ({
      ids: state.ids,
      section: state.section,
      within: state.within,
      has: (id) => state.ids.includes(id),
      click,
      sweepStart,
      clear,
    }),
    [state, click, sweepStart, clear],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** 行の選択。Provider の外（テストの部品だけの描画など）では null で、行は選べない */
export function useSelection(): RowSelection | null {
  return useContext(SelectionContext);
}
