// 左パネルの一覧で、見出しが上に抜けたら上の端に残す 1 行の帯の仕組み（UI-2。バックログ・履歴も同じ仕組みを使う）。
// 見出しの中の目印の要素（カンバンなら進みの帯の行）が帯の下に隠れたかを IntersectionObserver で見て、隠れている間だけ帯を出す。
// スクロールの量で決めないのは、見出しの高さが目標の行数や絞り込みの札で変わるため。
// 帯は高さ 0 の sticky の箱の中に重ねて描くので、出し入れで一覧が動かない（滑り込ませると、細かくスクロールしたときにちらつく）。
// 帯の下に貼り付く見出し（状態の節の見出しなど）は、styles.css の --dg-sticky-band-h の分だけ下げて貼り付ける。
// バックログ（UI-3）は縮めた帯を作らず、1 行の検索の行そのものを上の端に貼り付け（高さは STICKY_SEARCH_PX）、
// 絞っている間だけその下に効いている条件の札の行をこの帯の仕組みで重ねる

import { useEffect, useState, type ReactNode } from "react";

/** 帯の高さ（px）。styles.css の --dg-sticky-band-row-h と同じ値にする */
export const STICKY_BAND_PX = 26;

/** 上の端に貼り付ける検索の行の高さ（px。バックログ）。styles.css の --dg-sticky-search-h と同じ値にする */
export const STICKY_SEARCH_PX = 32;

/**
 * 目印の要素が、一覧（.page）の上の端から offset（既定は帯の高さ）までの所より上へ抜けたか。
 * 返す ref を目印の要素に付ける。抜けていれば past が true で、戻れば false。
 * 下に外れている（まだ見えていない）間は抜けたとしない。IntersectionObserver がない所（テストの jsdom）では常に false
 */
export function useScrolledPast<T extends Element>(
  offset: number = STICKY_BAND_PX,
): {
  ref: (el: T | null) => void;
  past: boolean;
} {
  const [el, setEl] = useState<T | null>(null);
  // 抜けたと見た要素を覚え、目印が替わったら（外れた・別の要素になった）前の結果を使わない
  const [pastOf, setPastOf] = useState<Element | null>(null);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        // rootBounds は rootMargin で帯の高さを除いた後の矩形
        const top = entry.rootBounds?.top ?? 0;
        setPastOf(!entry.isIntersecting && entry.boundingClientRect.bottom <= top ? el : null);
      },
      {
        root: el.closest(".page"),
        rootMargin: `-${offset}px 0px 0px 0px`,
        threshold: 0,
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, offset]);
  return { ref: setEl, past: !!el && pastOf === el };
}

/**
 * 上の端に残す帯。shown の間だけ中身を描く（隠れている間はフォーカスも読み上げも届かない）。
 * 中身は縦に積む（1 行の帯 .sticky-band-bar と、その下に出す絞り込みの札や開いた欄）。積んだ全体を一覧の上に重ねる。
 * 置く場所は、帯を残したい範囲（一覧の全体）を包む要素の先頭
 */
export function StickyBand({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <div className="sticky-band">
      {shown ? <div className="sticky-band-stack">{children}</div> : null}
    </div>
  );
}

/** from を含む一覧（.page）を一番上まで戻す */
export function scrollPageToTop(from: HTMLElement): void {
  const page = from.closest<HTMLElement>(".page");
  if (page) page.scrollTop = 0;
}
