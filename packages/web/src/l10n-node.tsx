// 文の途中に要素（リンク・コードなど）を挟む文言（l10n.ts の tr の React 版）。鍵の決まりは l10n.ts

import { Fragment, type ReactNode } from "react";
import { message } from "./l10n.js";

/** 文の途中に要素（リンク・コードなど）を挟む文言。{0} の位置に args の要素を置く */
export function trNode(key: string, ...args: ReactNode[]): ReactNode {
  const parts = message(key).split(/(\{\d+\})/);
  return parts.map((part, i) => {
    const m = /^\{(\d+)\}$/.exec(part);
    const node = m && Number(m[1]) < args.length ? args[Number(m[1])] : part;
    return <Fragment key={i}>{node}</Fragment>;
  });
}
