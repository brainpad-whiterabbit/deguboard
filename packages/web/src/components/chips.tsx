// 絞り込みのチップ。押した状態は aria-pressed で伝え、選んだチップは塗る（styles.css の .chip）。
// ChipRow はチップを折り返して並べ、2 行を超えるときは 2 行で止めて残りを「ほか N」にまとめる（押すとすべて出し、「畳む」で戻す）。
// 行は描画した位置（offsetTop）で数え、チップの数か幅が変わったら数え直す

import { Children, useLayoutEffect, useRef, useState, type ReactNode } from "react";

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

/** チップを折り返して並べ、2 行を超える分を「ほか N」にまとめる。label は読み上げの名前 */
export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  const items = Children.toArray(children);
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // 出すチップの数と、測ったときのチップの数・幅。数か幅が変われば測り直す（limit は null に戻り、すべて出して測る）
  const [fit, setFit] = useState<{ limit: number; count: number; width: number } | null>(null);
  const [width, setWidth] = useState(0);
  const limit = fit && fit.count === items.length && fit.width === width ? fit.limit : null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
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
    if (next >= 0) setFit({ limit: next, count: items.length, width });
  });

  const hidden = !expanded && limit !== null ? items.length - limit : 0;
  return (
    <div ref={ref} className="chip-row" role="group" aria-label={label}>
      {hidden > 0 ? items.slice(0, limit!) : items}
      {hidden > 0 ? (
        <button type="button" className="chip more" onClick={() => setExpanded(true)}>
          ほか {hidden}
        </button>
      ) : null}
      {expanded ? (
        <button
          type="button"
          className="chip more"
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
