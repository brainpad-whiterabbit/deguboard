// 左パネルの右クリックのメニュー（UI-12）。VS Code の API に触れない部分で、extension.ts から呼ぶ。
// 「詳細を開く」「ID をコピー」だけで、データには書き込まない。エージェントに頼む入口は右クリックに置かない（文言が package.json の定義に固定されて対象に合わせられない。ADR-027）。
// 左パネルのボード・バックログ・履歴のチケットの行と Iteration・Epic の見出しが、web の data-vscode-context に
// 場所によらない 1 つの webviewSection と ID を載せ（ask-menu.tsx の useAskSpot の menu）、
// package.json の webview/context がその webviewSection を見てメニューを出す。コマンドはその文脈を引数で受け取る。
// エディタのパネル（詳細）の行とタイトル、Plan の見出し、ID のない見出しは載せないので、メニューは出ない

import { WEBVIEW_CONTRACT, detailRouteOf } from "@deguboard/core";

/** 右クリックの文脈の webviewSection（core の WEBVIEW_CONTRACT）。package.json の when と合わせる */
export const MENU_SECTION = WEBVIEW_CONTRACT.menuSection;

/** 右クリックのメニューのコマンド。場所によらない名前で、package.json の contributes.commands と合わせる */
export const MENU_COMMANDS = {
  open: "deguboard.openDetail",
  copyId: "deguboard.copyId",
} as const;

/** 右クリックした行・見出しの対象 */
export interface MenuItem {
  /** チケット・Iteration・Epic の ID */
  id: string;
  /** 「詳細を開く」でパネルに出す詳細のルート（core の detailRouteOf） */
  route: string;
}

/** コマンドの引数（行・見出しの data-vscode-context）から対象を取る。形が違う・詳細を開けない ID なら undefined */
export function menuItemOf(arg: unknown): MenuItem | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  const v = arg as Record<string, unknown>;
  if (v["webviewSection"] !== MENU_SECTION) return undefined;
  const id = v["id"];
  if (typeof id !== "string") return undefined;
  const route = detailRouteOf(id);
  return route ? { id, route } : undefined;
}
