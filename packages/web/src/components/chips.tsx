// 絞り込みのチップ。押した状態は aria-pressed で伝え、選んだチップは塗る（styles.css の .chip）。
// ChipRow はチップを折り返して並べ、2 行を超えるときは 2 行で止めて残りを「ほか N」にまとめる（押すとすべて出し、「畳む」で戻す）。
// 行は描画した位置（offsetTop）で数え、チップの並び・中身（contentKey）・幅・選んだチップが変わったら数え直す。
// 選んだチップ（pressed）は「ほか N」に隠さず、出す分の最後に回す

import { Children, isValidElement, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function Chip({
  pressed,
  onClick,
  title,
  className,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className ? `chip ${className}` : "chip"}
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * チップを折り返して並べ、2 行を超える分を「ほか N」にまとめる。label は読み上げの名前。
 * contentKey はチップの中身（題など）を表す文字列で、変われば数え直す。
 * moreLabel・lessLabel は「ほか N」「畳む」の読み上げの名前
 */
export function ChipRow({
  label,
  contentKey = "",
  moreLabel = (n) => `あと ${n} 個出す`,
  lessLabel = "畳む",
  children,
}: {
  label: string;
  contentKey?: string;
  moreLabel?: (hidden: number) => string;
  lessLabel?: string;
  children: ReactNode;
}) {
  const items = Children.toArray(children);
  const keys = items.map((c) => (isValidElement(c) ? String(c.key) : ""));
  const pressed = items.findIndex(
    (c) => isValidElement<{ pressed?: boolean }>(c) && c.props.pressed === true,
  );
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(0);
  // 出すチップの数と、測ったときの条件。条件が変われば limit は null に戻り、すべて出して測り直す
  const measureKey = `${keys.join(",")}|${contentKey}|${width}|${pressed}`;
  const [fit, setFit] = useState<{ limit: number; key: string } | null>(null);
  const limit = fit && fit.key === measureKey ? fit.limit : null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 描く前に幅を合わせ、最初に全部を一瞬出さないようにする
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // 3 行目に落ちたチップを隠す。「ほか N」が 3 行目に落ちたら 1 つずつ減らす
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const kids = [...el.children] as HTMLElement[];
    const tops = [...new Set(kids.map((k) => k.offsetTop))].sort((a, b) => a - b);
    if (tops.length <= 2) return;
    const third = tops[2]!;
    const next = limit === null ? kids.findIndex((k) => k.offsetTop >= third) : limit - 1;
    if (next >= 1) setFit({ limit: next, key: measureKey });
  });

  const collapsed = !expanded && limit !== null && limit < items.length;
  let shown = items;
  if (collapsed) {
    shown =
      pressed >= limit! ? [...items.slice(0, limit! - 1), items[pressed]!] : items.slice(0, limit!);
  }
  const hidden = items.length - shown.length;
  return (
    <div ref={ref} className="chip-row" role="group" aria-label={label}>
      {shown}
      {collapsed ? (
        <button
          type="button"
          className="chip more"
          aria-expanded={false}
          aria-label={moreLabel(hidden)}
          onClick={() => setExpanded(true)}
        >
          ほか {hidden}
        </button>
      ) : null}
      {expanded ? (
        <button
          type="button"
          className="chip more"
          aria-expanded={true}
          aria-label={lessLabel}
          onClick={() => {
            setExpanded(false);
            setFit(null);
          }}
        >
          畳む
        </button>
      ) : null}
    </div>
  );
}
