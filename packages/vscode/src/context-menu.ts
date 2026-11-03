// 左パネルとパネルの右クリックのメニュー（UI-12・UI-15）。VS Code の API に触れない部分で、extension.ts から呼ぶ。
// 行・見出しの「エージェントに頼む ›」のサブメニューは、web が data-vscode-context に載せた対象・候補・おすすめ（WEBVIEW_CONTRACT.askContext）を
// package.json の when が見て、頼むことごとのコマンドを出す（先頭の節がおすすめ、次の節が残りの候補）。選ぶと右クリックした画面
// （左パネルかパネル）の下の入力欄をその頼むことで開く。
// 以下はバックログの行の「詳細を開く」「ID をコピー」。データには書き込まない（ADR-010）。
// 行は web が data-vscode-context に webviewSection・ticket を載せ（parts.tsx の BacklogItem）、
// package.json の webview/context が webviewSection を見てメニューを出す。コマンドはその文脈を引数で受け取る

import { ASK_ACTIONS, parseAskMenuKey, WEBVIEW_CONTRACT, type AskAction } from "@deguboard/core";

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

/** 行・見出しの「エージェントに頼む ›」のサブメニュー（package.json の contributes.submenus） */
export const ASK_SUBMENU = "deguboard.askMenu";

/**
 * サブメニューの頼むことの文言。メニューの文言は package.json に固定するので、対象で変わる文言（「起票して s3 に入れる」など）は
 * 一般の形にする。どの頼むことを出すかと順（おすすめが先頭）は web が載せた候補で決まる
 */
export const ASK_MENU_TITLES: Readonly<Record<AskAction, string>> = {
  create: "起票する",
  create_iteration: "Iteration を作る",
  create_epic: "Epic を作る",
  fix: "直す",
  split: "分ける",
  remove: "Iteration・Epic から外す",
  edit: "題・名前を直す",
  assign: "割り当てる",
  plan: "計画を立てる",
  approve: "承認する",
  work: "進める",
  resume: "再開する",
  all: "最後まで進める",
  done: "確かめて片付ける",
  check: "点検する",
  release: "リリースする",
  close: "閉じる",
  reopen: "再開する（閉じたもの）",
  abandon: "やめる",
  undo_done: "done を取り消す",
  status: "様子を聞く",
  retro: "振り返る",
  free: "自由に",
};

/** 頼むことのコマンドの ID */
export function askCommandId(action: AskAction): string {
  return `deguboard.ask.${action}`;
}

const CTX = WEBVIEW_CONTRACT.askContext;
/** 左パネルのビューの ID と、エディタのパネルの viewType。右クリックの引数の webview もこの値になる */
export const SIDEBAR_VIEW_ID = "deguboard.screens";
export const PANEL_VIEW_TYPE = "deguboard";
const ASK_WHEN = `(webviewId == '${SIDEBAR_VIEW_ID}' || webviewId == '${PANEL_VIEW_TYPE}')`;

/**
 * package.json の menus と contributes.commands に置く項目。package.json はこの形と同じであることを context-menu.test.ts で確かめる。
 * おすすめは 1_recommended の節に 1 つだけ、残りの候補は 2_more の節に ASK_ACTIONS の順で出す（同じコマンドを when を分けて 2 か所に置く）
 */
export function askMenuContributions() {
  return {
    commands: ASK_ACTIONS.map((action) => ({
      command: askCommandId(action),
      title: ASK_MENU_TITLES[action],
      category: "deguboard",
    })),
    submenu: { id: ASK_SUBMENU, label: "エージェントに頼む" },
    context: {
      submenu: ASK_SUBMENU,
      when: `${ASK_WHEN} && ${CTX.actions}`,
      group: "0_ask@1",
    },
    items: ASK_ACTIONS.flatMap((action, n) => [
      {
        command: askCommandId(action),
        when: `${CTX.recommended} == '${action}'`,
        group: "1_recommended@1",
      },
      {
        command: askCommandId(action),
        when: `${CTX.actions} =~ /\\b${action}\\b/ && ${CTX.recommended} != '${action}'`,
        group: `2_more@${n + 1}`,
      },
    ]),
    palette: ASK_ACTIONS.map((action) => ({ command: askCommandId(action), when: "false" })),
  };
}

/**
 * サブメニューで選んだ頼むことの対象。targets は ID（空なら対象なし）、within は対象のチケットが入っている Iteration・Epic（詳細の中の行）。
 * panel は右クリックした画面がエディタのパネルか（VS Code が引数の webview に載せる viewType で見る）
 */
export interface MenuAsk {
  targets: string[];
  action: AskAction;
  within?: string;
  panel: boolean;
}

/** 頼むことのコマンドの引数（行・見出しの data-vscode-context）から対象を取る。候補にない頼むことや形が違えば undefined */
export function menuAskOf(arg: unknown, action: AskAction): MenuAsk | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  const v = arg as Record<string, unknown>;
  const targets = v[CTX.targets];
  const actions = v[CTX.actions];
  if (typeof targets !== "string" || typeof actions !== "string") return undefined;
  if (!actions.split(/\s+/).includes(action)) return undefined;
  const within = v[CTX.within];
  return {
    targets: parseAskMenuKey(targets).refs,
    action,
    ...(typeof within === "string" && within ? { within } : {}),
    panel: v["webview"] === PANEL_VIEW_TYPE,
  };
}
