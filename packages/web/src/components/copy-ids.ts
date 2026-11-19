// 選んだ行のチケットをコピーする文字を作る（UI-15。選択の帯 SelectionBar の「ID をコピー」と ▾ のメニュー、Ctrl/⌘+C）。
// 描画から分け、形（ID・ID とタイトル・Markdown のリスト）と並びの順をここで決める。
// 並びは一覧で見えている順（選んだ後に並び順を変えても、コピーするときの画面の並びに揃える）。
// ID は半角の空白で区切る（/dgplan t12 t13 のようにそのまま引数に貼れる）。タイトルを付ける形は 1 行に 1 件

import { msg } from "../l10n.js";

/** コピーの形 */
export type CopyFormat = "ids" | "titled" | "markdown";

/** メニューに並べる順の形と、メニューの項目の名前（l10n の鍵） */
export const COPY_FORMATS: readonly { format: CopyFormat; name: string }[] = [
  { format: "ids", name: msg("ID") },
  { format: "titled", name: msg("ID とタイトル") },
  { format: "markdown", name: msg("Markdown のリスト") },
];

/** コピーする 1 件（タイトルが分からなければ ID だけを出す） */
export interface CopyItem {
  id: string;
  title?: string | undefined;
}

/**
 * ids を見えている順（shown）に並べる。shown にないもの（畳んだ節の中など）は、元の順のまま後ろに置く。重なりは 1 つにする
 */
export function inShownOrder(ids: readonly string[], shown: readonly string[]): string[] {
  const want = new Set(ids);
  const head = shown.filter((id) => want.has(id));
  const seen = new Set(head);
  return [...new Set([...head, ...ids.filter((id) => !seen.has(id))])];
}

/** 1 件の行（ids の形は ID だけ） */
function line(format: CopyFormat, item: CopyItem): string {
  if (format === "ids") return item.id;
  const text = item.title ? `${item.id} ${item.title}` : item.id;
  return format === "markdown" ? `- ${text}` : text;
}

/** コピーする文字。ID は半角の空白で区切り、タイトルを付ける形は 1 行に 1 件（末尾に改行は付けない） */
export function copyText(format: CopyFormat, items: readonly CopyItem[]): string {
  return items.map((item) => line(format, item)).join(format === "ids" ? " " : "\n");
}

/** メニューの項目に出す見本（先頭の 1 件の行）。選んだものがなければ空 */
export function copySample(format: CopyFormat, items: readonly CopyItem[]): string {
  const first = items[0];
  return first ? line(format, first) : "";
}

/** コピーした後に帯に出す文言の鍵（{0} は件数） */
export function copiedMessage(format: CopyFormat): string {
  if (format === "ids") return msg("{0} 件の ID をコピーしました");
  if (format === "titled") return msg("{0} 件の ID とタイトルをコピーしました");
  return msg("{0} 件を Markdown のリストでコピーしました");
}
