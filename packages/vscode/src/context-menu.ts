// 左パネルのバックログの行の右クリックのメニュー（UI-12）。VS Code の API に触れない部分で、extension.ts から呼ぶ。
// 「詳細を開く」「ID をコピー」だけで、データには書き込まない。エージェントに頼む入口は右クリックに置かない（ADR-010）。
// 行は web が data-vscode-context に webviewSection・ticket を載せ（parts.tsx の BacklogItem）、
// package.json の webview/context が webviewSection を見てメニューを出す。コマンドはその文脈を引数で受け取る

import { WEBVIEW_CONTRACT } from "@deguboard/core";

/** バックログの行の data-vscode-context の webviewSection（core の WEBVIEW_CONTRACT）。package.json の when と合わせる */
export const BACKLOG_ROW_SECTION = WEBVIEW_CONTRACT.backlogRowSection;

/** 右クリックのメニューのコマンド。package.json の contributes.commands と合わせる */
export const BACKLOG_ROW_COMMANDS = {
  open: "deguboard.backlog.openTicket",
  copyId: "deguboard.backlog.copyId",
} as const;

/** 右クリックした行のチケット */
export interface MenuTicket {
  ticket: string;
}

/** コマンドの引数（行の data-vscode-context）からチケットを取る。形が違えば undefined */
export function menuTicketOf(arg: unknown): MenuTicket | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  const v = arg as Record<string, unknown>;
  if (v["webviewSection"] !== BACKLOG_ROW_SECTION) return undefined;
  if (typeof v["ticket"] !== "string") return undefined;
  return { ticket: v["ticket"] };
}

/** 「詳細を開く」でパネルに出すルート */
export function ticketRoute(row: MenuTicket): string {
  return `#/tickets/${row.ticket}`;
}
