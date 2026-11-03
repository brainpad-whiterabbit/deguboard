// 行・見出しからエージェントに頼む（UI-15・ADR-010）。マウスを載せたときと選んだときに右端へ吹き出しのボタンを出し、
// 押すか Shift+F10 で頼むことの一覧（先頭がおすすめ）を直接出す。選ぶと入力欄（ask-composer.tsx）をその頼むことで開く。
// 同じ候補を右クリックのメニュー（拡張の webview/context のサブメニュー）にも出せるよう、行・見出しの data-vscode-context に
// 対象・候補・おすすめを載せる（キーは core の WEBVIEW_CONTRACT.askContext）。
// 候補は core の ask-menu（読み取りだけ）が組ごとに決め、web では組み立て直さない。画面の頼める場所は AskMenuProvider が
// まとめて 1 回で引き、一覧が読み直されたら（Status が変わったかもしれない）引き直す。Provider の外では一覧を開いたときに引く。
// 部品は場所によらない（左パネルのカンバン・バックログ・履歴と、パネルのチケット・Iteration・Epic の詳細のタイトルと中の行で使う）。
// 詳細のタイトルは幅に余裕があるので、吹き出しをタイトルの横に常に出す（pinned）。詳細の中の行は、チケットが入っている
// Iteration・Epic を within に渡し、「そこから外す」を候補に足す（右クリックで選んだときも、拡張はそのパネルの下に入力欄を開く）。
// 一覧の行は select で複数選べ（selection.tsx）、選んだ行の吹き出し・右クリックは選んだ全件を対象にする。選んでいる間は
// 画面の下に「n 件を選択 ・ 頼む」の帯（SelectionBar）を出す

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { askKey } from "../ask-key.js";
import { WEBVIEW_CONTRACT_COPY } from "../client/webview.js";
import { useCommandData } from "../command-data.js";
import { useAsk, useUiState } from "../host.js";
import { useStore } from "../store.js";
import type { AskCandidate, AskMenu } from "../types.js";
import { SELECT_ATTR, selectKind, useSelection } from "./selection.js";

/**
 * 頼める場所の webviewSection（core の WEBVIEW_CONTRACT.askSections の写し）。サブメニューの when は askActions だけを見るので、
 * これは場所の種類の名前（場所ごとの項目を右クリックに足すときに使う）
 */
export const ASK_SECTIONS = WEBVIEW_CONTRACT_COPY.askSections;
export type AskSection =
  | (typeof ASK_SECTIONS)[keyof typeof ASK_SECTIONS]
  | typeof WEBVIEW_CONTRACT_COPY.backlogRowSection;

/** 初めての案内を消したかの鍵（見た目の状態） */
export const ASK_HINT_KEY = "ask.hintDismissed";

export const ASK_HINT = "行の吹き出しか右クリックでエージェントに頼めます";

interface MenuCache {
  menus: ReadonlyMap<string, AskMenu>;
  /** その組の候補が要る。戻り値で要らなくなったことを伝える */
  want(key: string): () => void;
}

const AskMenuContext = createContext<MenuCache | null>(null);

/**
 * 画面に出ている頼める場所の候補を、まとめて ask-menu で引いて持つ。同じ描画で増えた場所は 1 回の呼び出しにまとめる。
 * 一覧（チケット・Iteration・Epic・Plan・実行中の Run）が読み直されたら、出ている場所の分をすべて引き直す（引き直すまでは前の候補を出す）。
 * useCommandData は使わない：場所ごとの組をまとめて 1 回で引き、まだ引いていない組だけを足していくため
 */
export function AskMenuProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const { client } = store;
  const wanted = useRef(new Map<string, number>());
  // この版の一覧で引いた（引いている）組
  const asked = useRef(new Set<string>());
  const [menus, setMenus] = useState<ReadonlyMap<string, AskMenu>>(() => new Map());
  const [round, setRound] = useState(0);
  // 前に引いたときの一覧。変わっていたら（読み直した）引いた組を忘れて、出ている場所の分をすべて引き直す
  const seen = useRef<readonly unknown[]>([]);
  const { tickets, iterations, epics, plans, runningTickets } = store;

  useEffect(() => {
    const data = [tickets, iterations, epics, plans, runningTickets];
    if (data.some((d, n) => d !== seen.current[n])) {
      seen.current = data;
      asked.current = new Set();
    }
    const keys = [...wanted.current.keys()].filter((k) => !asked.current.has(k));
    if (keys.length === 0) return;
    for (const k of keys) asked.current.add(k);
    const mine = asked.current;
    client
      .run<AskMenu[]>("ask-menu", { sets: keys })
      .then((r) => {
        if (asked.current !== mine) return;
        setMenus((prev) => {
          const next = new Map(prev);
          for (const m of r.data) next.set(m.key, m);
          return next;
        });
      })
      .catch((e: unknown) => {
        // 呼び出しが丸ごと失敗したら、組ごとに理由を出し（Provider の外の経路と同じ）、次に読み直したときに引き直す
        if (asked.current !== mine) return;
        const error = e instanceof Error ? e.message : String(e);
        setMenus((prev) => {
          const next = new Map(prev);
          for (const key of keys) next.set(key, { key, candidates: [], error });
          return next;
        });
      });
  }, [client, round, tickets, iterations, epics, plans, runningTickets]);

  const want = useCallback((key: string) => {
    wanted.current.set(key, (wanted.current.get(key) ?? 0) + 1);
    if (!asked.current.has(key)) setRound((n) => n + 1);
    return () => {
      const n = (wanted.current.get(key) ?? 1) - 1;
      if (n > 0) wanted.current.set(key, n);
      else wanted.current.delete(key);
    };
  }, []);
  const value = useMemo(() => ({ menus, want }), [menus, want]);
  return <AskMenuContext.Provider value={value}>{children}</AskMenuContext.Provider>;
}

/** 組の候補。Provider があればその持ち分、なければ一覧を開いたとき（open が true になったとき）に引く。key が null なら引かない */
function useAskMenu(key: string | null, open: boolean): AskMenu | undefined {
  const cache = useContext(AskMenuContext);
  useEffect(() => (key === null ? undefined : cache?.want(key)), [cache, key]);
  // Provider がなければ自分で引く。失敗は組の理由として出す（Provider の経路と同じ）
  const own = useCommandData<AskMenu[]>(
    "ask-menu",
    cache || !open || key === null ? null : { sets: [key] },
  );
  if (key === null) return undefined;
  if (cache) return cache.menus.get(key);
  return own.error ? { key, candidates: [], error: own.error } : own.data?.[0];
}

export interface AskSpotOptions {
  /** 対象の ID（チケット・Iteration・Epic・Plan。節の見出しなら中のチケット） */
  targets: readonly string[];
  /** 一覧の頭に出す場所の名前（「行 t12」「Iteration の見出し s3」） */
  label: string;
  /** 右クリックの文脈の webviewSection */
  section: AskSection;
  /** 右クリックの文脈に足すもの（バックログの行の ticket） */
  context?: Readonly<Record<string, unknown>> | undefined;
  /** 吹き出しのボタンを置くか。札のように狭い場所は置かず、右クリックと Shift+F10 だけにする */
  bubble?: boolean | undefined;
  /** 吹き出しを右端に重ねず、中身の横に常に出す（詳細のタイトル。styles.css の .ask-bubble.pinned） */
  pinned?: boolean | undefined;
  /** 対象のチケットが入っている Iteration・Epic（詳細の中の行）。候補に「そこから外す」が足される */
  within?: string | undefined;
  /**
   * 一覧の行（対象は targets の 1 件）を Ctrl/⌘・Shift+クリックで選べるようにする（selection.tsx）。
   * 選んだ行が 2 件以上なら、吹き出し・右クリック・Shift+F10 は選んだ全件を対象にする
   */
  select?: boolean | undefined;
}

export interface AskSpot {
  /** 行・見出しの要素に付ける属性（右クリックの文脈・Shift+F10・吹き出しを出し続ける印） */
  props: {
    "data-vscode-context": string;
    "data-ask-spot": "" | "active";
    onKeyDown(e: KeyboardEvent<HTMLElement>): void;
    /** 選べる行だけ：行の ID・選んでいる印と、Ctrl/⌘・Shift+クリックで選ぶ（詳細は開かない） */
    "data-select-id"?: string;
    "data-selected"?: "";
    onClickCapture?(e: MouseEvent<HTMLElement>): void;
    onMouseDown?(e: MouseEvent<HTMLElement>): void;
  };
  /** 要素の中に描くもの：吹き出しのボタンと、開いているときの一覧（body に出す） */
  overlay: ReactNode;
  /** 頼むことの一覧を from の下に開く（選択の帯の「頼む」） */
  open(from: HTMLElement): void;
}

/** 選択のクリックとして扱わない場所（吹き出し・頼むことの一覧・行の中のボタンや入力） */
const NOT_SELECT_CLICK = "button, input, select, textarea, .ask-menu";

/**
 * 行・見出しを頼める場所にする。options が null なら何もしない（props は空の文脈、overlay は null）。
 * 返す props を要素に付け、overlay を要素の中に描く（要素は position: relative になる。styles.css の [data-ask-spot]）
 */
export function useAskSpot(options: AskSpotOptions | null): AskSpot {
  const ask = useAsk();
  const selection = useSelection();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  // 選べる行で、選んだ行が 2 件以上あってこの行も入っていれば、選んだ全件を対象にする
  const rowId = options?.select && selection ? options.targets[0] : undefined;
  const selected = rowId !== undefined && selection!.has(rowId);
  const many = selected && selection!.ids.length > 1;
  const targets = many ? selection!.ids : (options?.targets ?? []);
  const within = many ? selection!.within : options?.within;
  const label = many ? `選んだ ${targets.length} 件` : (options?.label ?? "");
  const key = askKey(targets, within);
  const menu = useAskMenu(options ? key : null, open);
  const candidates = options ? (menu?.candidates ?? null) : null;
  const asking =
    !!options && ask.request !== null && askKey(ask.request.targets, ask.request.within) === key;
  const ctx = WEBVIEW_CONTRACT_COPY.askContext;
  const context = options
    ? JSON.stringify({
        webviewSection: options.section,
        ...options.context,
        [ctx.targets]: askKey(targets),
        ...(within ? { [ctx.within]: within } : {}),
        // 候補を読み終えるまでは載せない（サブメニューを出さない）
        ...(candidates && candidates.length > 0
          ? {
              [ctx.actions]: candidates.map((c) => c.action).join(" "),
              [ctx.recommended]: candidates[0]!.action,
            }
          : {}),
        preventDefaultContextMenuItems: true,
      })
    : "{}";

  const show = (from: HTMLElement) => {
    setAnchor(from);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) anchor?.focus();
  };

  const overlay = options ? (
    <>
      {options.bubble === false ? null : (
        <button
          ref={bubbleRef}
          type="button"
          className={options.pinned ? "ask-bubble pinned" : "ask-bubble"}
          aria-label={`エージェントに頼む（${label}）`}
          aria-haspopup="menu"
          aria-expanded={open}
          title="エージェントに頼む（Shift+F10）"
          // 見出し（summary）の開閉・Plan の行の開閉を起こさない
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (open) close(false);
            else show(e.currentTarget);
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
          </svg>
        </button>
      )}
      {open && anchor ? (
        <AskMenuList
          anchor={anchor}
          label={label}
          menu={menu}
          onPick={(c) => {
            setOpen(false);
            ask.open(targets, c.action, within);
          }}
          onClose={close}
        />
      ) : null}
    </>
  ) : null;

  return {
    props: {
      "data-vscode-context": context,
      "data-ask-spot": open || asking ? "active" : "",
      onKeyDown(e) {
        if (!options) return;
        // VS Code のメニューのキー（Shift+F10）とメニューキーで、吹き出しと同じ一覧を出す
        if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
          e.preventDefault();
          e.stopPropagation();
          show(bubbleRef.current ?? e.currentTarget);
        }
      },
      ...(rowId !== undefined && selection && options
        ? {
            [SELECT_ATTR]: rowId,
            ...(selected ? { "data-selected": "" as const } : {}),
            // 捕捉の段階で受け、選んだら行のリンク（TicketLink）と App のハッシュの受け手に渡さない
            // 修飾キーつきのクリックはブラウザの既定（リンクを新しいタブ・窓に開く）を止めて選択に使う。
            // VS Code の一覧と同じ操作にするためで、詳細は Webview でもブラウザでもふつうのクリックで開ける
            onClickCapture(e: MouseEvent<HTMLElement>) {
              const target = e.target as Element;
              if (e.button !== 0 || target.closest?.(NOT_SELECT_CLICK)) return;
              if (selection.click(rowId, e, { section: options.section, within: options.within })) {
                e.preventDefault();
                e.stopPropagation();
              }
            },
            // Shift+クリックで文字を選ばない
            onMouseDown(e: MouseEvent<HTMLElement>) {
              if (e.button === 0 && selectKind(e) === "range") e.preventDefault();
            },
          }
        : {}),
    },
    overlay,
    open: show,
  };
}

/**
 * 行を選んでいる間に画面の下に出す帯：「n 件を選択 ・ 頼む」と「選択を外す」。「頼む」で選んだ全件の頼むことの一覧を出す。
 * 入力欄を開いている間は出さない（入力欄が同じ場所に出る）。帯の右クリックも選んだ全件を対象にする
 */
export function SelectionBar() {
  const selection = useSelection();
  const ask = useAsk();
  const ids = selection?.ids ?? [];
  const spot = useAskSpot(
    selection && ids.length > 0
      ? {
          targets: ids,
          label: `選んだ ${ids.length} 件`,
          section: selection.section ?? ASK_SECTIONS.boardTicket,
          within: selection.within,
          bubble: false,
        }
      : null,
  );
  if (!selection || ids.length === 0 || ask.request) return null;
  return (
    <div className="selection-bar" role="region" aria-label="選んだ行" {...spot.props}>
      <span className="selection-count" aria-live="polite">
        {ids.length} 件を選択
      </span>
      <span className="muted" aria-hidden="true">
        ・
      </span>
      <button
        type="button"
        className="primary selection-ask"
        aria-haspopup="menu"
        title="選んだ行をまとめてエージェントに頼む"
        onClick={(e) => spot.open(e.currentTarget)}
      >
        頼む
      </button>
      <span className="selection-gap" />
      <button
        type="button"
        className="selection-clear"
        title="選択を外す（Esc）"
        onClick={selection.clear}
      >
        選択を外す
      </button>
      {spot.overlay}
    </div>
  );
}

/** 頼める場所の要素。as の要素に useAskSpot の props と overlay を付ける */
export function AskSpotBox({
  as: Tag = "div",
  className,
  children,
  ...options
}: AskSpotOptions & {
  as?: "div" | "li" | "summary" | "h1" | "header";
  className?: string | undefined;
  children: ReactNode;
}) {
  const spot = useAskSpot(options);
  return (
    <Tag className={className} {...spot.props}>
      {children}
      {spot.overlay}
    </Tag>
  );
}

/**
 * 頼むことの一覧。body に出し（行や見出しの overflow に切られないように）、吹き出しの右端に合わせて下に開く。下に入らなければ上に開く。
 * 先頭の項目にフォーカスを置き、↑↓・Home・End で動き、Esc で閉じて呼んだ場所に戻る。外を押す・スクロールで閉じる
 */
function AskMenuList({
  anchor,
  label,
  menu,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  label: string;
  menu: AskMenu | undefined;
  onPick(candidate: AskCandidate): void;
  onClose(refocus: boolean): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const loaded = menu !== undefined;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const left = Math.max(4, Math.min(a.right - w, vw - w - 4));
    const below = a.bottom + 2;
    const top = below + h <= vh - 4 ? below : Math.max(4, a.top - h - 2);
    setPos({ left, top });
  }, [anchor, loaded, menu]);

  useEffect(() => {
    if (loaded) ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [loaded]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose(false);
    };
    const onScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [anchor, onClose]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      onClose(true);
    } else if (e.key === "Tab") onClose(false);
  }

  return createPortal(
    <div
      ref={ref}
      className="ask-menu"
      role="menu"
      aria-label={`エージェントに頼む（${label}）`}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      onKeyDown={onKeyDown}
      // body に出しても React の上の要素（見出し・Plan の行）へは伝わるので止める
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="ask-menu-label">{label}</div>
      {!menu ? (
        <div className="ask-menu-note muted">読み込み中…</div>
      ) : menu.error ? (
        <div className="ask-menu-note error">{menu.error}</div>
      ) : (
        menu.candidates.map((c) => (
          <button
            key={c.action}
            type="button"
            role="menuitem"
            className="ask-menu-item"
            title={c.skill ?? "Skill を使わない"}
            onClick={() => onPick(c)}
          >
            <span>{c.label}</span>
            {c.recommended ? <span className="ask-menu-rec">おすすめ</span> : null}
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}

/** 初めて左パネルを開いたときに 1 度だけ出す案内。× で消したら見た目の状態に残し、もう出さない */
export function AskHint() {
  const [dismissed, setDismissed] = useUiState(ASK_HINT_KEY, false);
  if (dismissed) return null;
  return (
    <p className="ask-hint" role="note">
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
      </svg>
      <span>{ASK_HINT}</span>
      <button
        type="button"
        className="ask-hint-close"
        aria-label="案内を閉じる"
        title="閉じる（もう出さない）"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </p>
  );
}
