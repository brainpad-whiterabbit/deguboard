// 「チケットへ移動」の QuickPick の項目（UI-12）。VS Code の API に触れない部分で、extension.ts から呼ぶ。
// 項目は ids.ts の ID の索引から作る（毎回 dg を呼ばない）。文言と並びを決める。絞り込みは VS Code の QuickPick が、label（ID とタイトル）・description（種類と Status）・detail に対して行う

import type { IdKind } from "@deguboard/core";
import { type IdEntry, type IdIndex, kindLabel } from "./ids.js";
import { t } from "./l10n.js";

/** コマンド ID（package.json の commands と keybindings に同じ名前を書く） */
export const GOTO_COMMAND = "deguboard.gotoTicket";

/** 種類の並びの順（チケットを先頭に） */
const KIND_ORDER: IdKind[] = ["ticket", "iteration", "epic", "plan"];

/** QuickPick の 1 項目 */
export interface GotoItem {
  /** 選ぶと開く ID */
  id: string;
  /** 1 行目：ID と見出し（Plan は見出しがないので ID だけ） */
  label: string;
  /** 右に薄く出す説明：種類と Status。abandoned・closed などはここで見分ける */
  description: string;
  /** 2 行目：補足（担当・進捗・Plan のチケットなど） */
  detail: string;
}

/** ID の番号部分（t12 → 12）。無効な形は 0 */
function numberOf(id: string): number {
  return Number(id.slice(1)) || 0;
}

/** 索引から項目を作る。チケット・Iteration・Epic・Plan の順で、それぞれ番号の新しい順（新しい ID を探すことが多い） */
export function gotoItems(index: IdIndex): GotoItem[] {
  const entries = [...index.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || numberOf(b.id) - numberOf(a.id),
  );
  return entries.map(toItem);
}

function toItem(e: IdEntry): GotoItem {
  return {
    id: e.id,
    label: e.title ? `${e.id}  ${e.title}` : e.id,
    description: t("{0} · {1}", kindLabel(e.kind), e.status),
    detail: e.details.join(" "),
  };
}
