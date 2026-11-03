// 左パネルのバックログの行の右クリックのメニュー（UI-12）。VS Code の API に触れない部分で、extension.ts から呼ぶ。
// 行は web が data-vscode-context に webviewSection・ticket・iteration・project を載せ（parts.tsx の TicketTable）、
// package.json の webview/context が webviewSection を見てメニューを出す。コマンドはその文脈を引数で受け取る。
// 移す先の候補は core の iteration.list に閉じていない Iteration だけを頼み、移すのはドラッグと同じ ticket.update を呼ぶだけにする。
// 閉じた Iteration に移せないことは ticket.update が拒否して決める（ここでは判断しない）

import { WEBVIEW_CONTRACT, type CommandClient, type Iteration } from "@deguboard/core";

/** バックログの行の data-vscode-context の webviewSection（core の WEBVIEW_CONTRACT）。package.json の when と合わせる */
export const BACKLOG_ROW_SECTION = WEBVIEW_CONTRACT.backlogRowSection;

/** 右クリックのメニューのコマンド。package.json の contributes.commands と合わせる */
export const BACKLOG_ROW_COMMANDS = {
  move: "deguboard.backlog.moveIteration",
  open: "deguboard.backlog.openTicket",
  copyId: "deguboard.backlog.copyId",
} as const;

/** 右クリックした行のチケット。iteration は今の所属（なければ null） */
export interface MenuTicket {
  ticket: string;
  iteration: string | null;
  project: string;
}

/** コマンドの引数（行の data-vscode-context）からチケットを取る。形が違えば undefined */
export function menuTicketOf(arg: unknown): MenuTicket | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  const v = arg as Record<string, unknown>;
  if (v["webviewSection"] !== BACKLOG_ROW_SECTION) return undefined;
  if (typeof v["ticket"] !== "string" || typeof v["project"] !== "string") return undefined;
  const iteration = typeof v["iteration"] === "string" ? v["iteration"] : null;
  return { ticket: v["ticket"], iteration, project: v["project"] };
}

/** QuickPick の 1 項目。iteration は移す先（null は「Iteration なし」） */
interface IterationPick {
  label: string;
  description?: string;
  iteration: string | null;
}

/**
 * 移す先の候補を core に頼んで並べる。閉じた Iteration は iteration.list の status で外す（チケットの Project のものだけ）。
 * 末尾に「Iteration なし」を置く。今の所属には印を付ける
 */
export async function iterationPicks(
  client: CommandClient,
  row: MenuTicket,
): Promise<IterationPick[]> {
  const { data } = await client.run<Iteration[]>("iteration.list", {
    project: row.project,
    status: ["active", "planned"],
  });
  const current = (iteration: string | null) =>
    iteration === row.iteration ? { description: "今の所属" } : {};
  return [
    ...data.map((it) => ({
      label: `${it.id} ${it.name}`,
      ...current(it.id),
      iteration: it.id,
    })),
    { label: "Iteration なし", ...current(null), iteration: null },
  ];
}

/**
 * 選んだ Iteration に移す。ドラッグと同じく ticket.update を呼ぶだけで、今の所属と同じなら何もしない。
 * 拒否（閉じた Iteration など）は core の失敗のまま投げる。移したら true
 */
export async function moveToIteration(
  client: CommandClient,
  row: MenuTicket,
  pick: IterationPick,
): Promise<boolean> {
  if (pick.iteration === row.iteration) return false;
  await client.run("ticket.update", { ticket: row.ticket, iteration: pick.iteration });
  return true;
}

/** 「詳細を開く」でパネルに出すルート */
export function ticketRoute(row: MenuTicket): string {
  return `#/tickets/${row.ticket}`;
}
