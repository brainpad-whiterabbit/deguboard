// サイドバーの行のキー操作（roving tabindex）。カンバン・バックログ・履歴の行（a.ticket-row）を、↑↓・Home・End で移り、Enter で詳細を開く。
// Tab で入れる行は今の 1 行だけ（tabindex=0。ほかは -1）で、Tab 1 回で一覧を抜けられる。今の行は最後にフォーカスした行
// （なければ先頭）。フォーカスの枠は styles.css の :focus-visible（VS Code の focusBorder）が出す。
// 選んだ状態（data-selected）は、見た目（左端の線）と「n 件を選択」の aria-live の件数で伝え、行そのものの aria（aria-selected は role の要る属性）は付けない。
// Space（選ぶ）と a（頼む）は行ごとの useAskSpot（ask-menu.tsx）が受ける。
// 行は React が描き直すので、tabindex は MutationObserver で整え直す（React は tabindex を持たない）。畳んだ節の中の行は移る先に含めない

import { useCallback, useEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";

/** 移る先の行（行の主リンク） */
const ROW = "a.ticket-row";

function visibleRows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(ROW)].filter(
    (el) => !el.closest("details:not([open])"),
  );
}

/** 今の行だけ tabindex=0 にする。current がなければ今 0 の行（まだあれば）か先頭 */
function syncRoving(root: HTMLElement, current?: HTMLElement) {
  const rows = visibleRows(root);
  const cur =
    current && rows.includes(current)
      ? current
      : (rows.find((el) => el.getAttribute("tabindex") === "0") ?? rows[0]);
  for (const el of rows) {
    const want = el === cur ? "0" : "-1";
    if (el.getAttribute("tabindex") !== want) el.setAttribute("tabindex", want);
  }
  // 選べる行の中の、行の主リンク以外（吹き出しのボタン、履歴の 2 段目の Iteration・Epic のリンク）は Tab で止めない。
  // 止めると行ごとに Tab が止まり、1 回で一覧を抜けられない。吹き出しは a と Shift+F10 で開ける。マウスでは今までどおり押せる
  for (const b of root.querySelectorAll<HTMLElement>(
    "[data-select-id] button, [data-select-id] a:not(.ticket-row)",
  )) {
    if (b.getAttribute("tabindex") !== "-1") b.setAttribute("tabindex", "-1");
  }
}

/** 行の主リンクにフォーカスがあるときだけ受ける。修飾キーつきは VS Code や行の選択に任せる */
function rowTarget(e: KeyboardEvent<HTMLElement>): HTMLElement | null {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const t = e.target as HTMLElement;
  return t.matches?.(ROW) ? t : null;
}

/**
 * 行のキー操作の props と ref を返す。enabled でなければ何もしない（サイドバーだけで使う）。
 * ref と onKeyDown・onFocus を行を含む要素に付ける
 */
export function useRowNav(enabled: boolean) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return;
    syncRoving(root);
    const observer = new MutationObserver(() => syncRoving(root));
    // 節を畳む・開く（details の open）でも、見えている先頭の行へ tabindex=0 を移す
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, [enabled]);

  const onFocus = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const t = e.target as HTMLElement;
      if (enabled && ref.current && t.matches?.(ROW)) syncRoving(ref.current, t);
    },
    [enabled],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const root = ref.current;
      if (!enabled || !root || e.defaultPrevented) return;
      const row = rowTarget(e);
      if (!row) return;
      if (e.key === "Enter") {
        // リンクの既定の Enter に頼らず、クリックと同じ経路（TicketLink が host.open でエディタのパネルに開く）で開く
        e.preventDefault();
        row.click();
        return;
      }
      const rows = visibleRows(root);
      const at = rows.indexOf(row);
      const to =
        e.key === "ArrowDown"
          ? at + 1
          : e.key === "ArrowUp"
            ? at - 1
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? rows.length - 1
                : null;
      if (to === null) return;
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (next && next !== row) next.focus();
    },
    [enabled],
  );

  return { ref, onKeyDown, onFocus };
}
