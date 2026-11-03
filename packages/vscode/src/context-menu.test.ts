import { readFileSync } from "node:fs";
import { ASK_ACTIONS, askCandidates, WEBVIEW_CONTRACT } from "@deguboard/core";
import { describe, expect, it } from "vitest";
import {
  ASK_SUBMENU,
  askCommandId,
  askMenuContributions,
  BACKLOG_ROW_COMMANDS,
  BACKLOG_ROW_SECTION,
  menuAskOf,
  menuTicketOf,
  ticketRoute,
} from "./context-menu.js";

interface Contributes {
  commands: { command: string; title: string; category?: string; icon?: string }[];
  submenus?: { id: string; label: string }[];
  menus: Record<string, { command?: string; submenu?: string; when?: string; group?: string }[]>;
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  contributes: Contributes;
};

describe("package.json の右クリックのメニュー", () => {
  const { commands, menus } = pkg.contributes;
  const ids = Object.values(BACKLOG_ROW_COMMANDS);

  it("「詳細を開く」「ID をコピー」をこの順で、バックログの行の webview/context に出す（「Iteration を移す」は置かない。ADR-010）", () => {
    const items = menus["webview/context"]!.filter((m) => m.command);
    expect(items.map((m) => m.command)).toEqual([
      BACKLOG_ROW_COMMANDS.open,
      BACKLOG_ROW_COMMANDS.copyId,
    ]);
    for (const item of items) {
      expect(item.when).toBe(
        `webviewId == 'deguboard.screens' && webviewSection == '${BACKLOG_ROW_SECTION}'`,
      );
    }
    expect(ids.map((id) => commands.find((c) => c.command === id)?.title)).toEqual([
      "詳細を開く",
      "ID をコピー",
    ]);
    expect(commands.some((c) => c.command === "deguboard.backlog.moveIteration")).toBe(false);
  });

  it("行の文脈が要るので、コマンドパレットには出さない", () => {
    for (const id of ids) {
      expect(menus["commandPalette"]).toContainEqual({ command: id, when: "false" });
    }
  });
});

describe("package.json のビューのタイトル行", () => {
  const { commands, menus } = pkg.contributes;

  it("吹き出し（エージェントに頼む）・同期・歯車（設定画面の切り替え）の順に並べる", () => {
    const items = menus["view/title"]!;
    expect(items.map((m) => [m.command, m.group])).toEqual([
      ["deguboard.askInSidebar", "navigation@0"],
      ["deguboard.sync", "navigation@1"],
      ["deguboard.config", "navigation@2"],
    ]);
    for (const item of items) expect(item.when).toBe("view == deguboard.screens");
    expect(commands.find((c) => c.command === "deguboard.config")).toMatchObject({
      title: "設定",
      icon: "$(gear)",
    });
  });

  it("「エージェントに頼む」はコマンドパレットに「deguboard: エージェントに頼む」で出し、タイトル行の吹き出しはパレットに重ねて出さない（UI-15）", () => {
    for (const id of ["deguboard.ask", "deguboard.askInSidebar"])
      expect(commands.find((c) => c.command === id)).toMatchObject({
        title: "エージェントに頼む",
        category: "deguboard",
        icon: "$(comment-discussion)",
      });
    const palette = menus["commandPalette"]!;
    expect(palette.some((m) => m.command === "deguboard.ask")).toBe(false);
    expect(palette).toContainEqual({ command: "deguboard.askInSidebar", when: "false" });
  });
});

describe("メニューの引数", () => {
  it("行の data-vscode-context からチケット・今の Iteration・Project を取る", () => {
    expect(
      menuTicketOf({
        webviewSection: BACKLOG_ROW_SECTION,
        ticket: "t12",
        iteration: "s3",
        project: "default",
        preventDefaultContextMenuItems: true,
      }),
    ).toEqual({ ticket: "t12", iteration: "s3", project: "default" });
    expect(
      menuTicketOf({
        webviewSection: BACKLOG_ROW_SECTION,
        ticket: "t12",
        iteration: null,
        project: "default",
      }),
    ).toEqual({ ticket: "t12", iteration: null, project: "default" });
  });

  it("バックログの行でない・形が違う引数は undefined", () => {
    expect(menuTicketOf(undefined)).toBeUndefined();
    expect(menuTicketOf({ webviewSection: "other", ticket: "t1", project: "default" })).toBe(
      undefined,
    );
    expect(menuTicketOf({ webviewSection: BACKLOG_ROW_SECTION, project: "default" })).toBe(
      undefined,
    );
  });

  it("「詳細を開く」はチケット詳細のルートを開く", () => {
    expect(ticketRoute({ ticket: "t12", iteration: null, project: "default" })).toBe(
      "#/tickets/t12",
    );
  });
});

describe("行・見出しの「エージェントに頼む ›」のサブメニュー（UI-15）", () => {
  const { commands, menus, submenus } = pkg.contributes;
  const expected = askMenuContributions();

  it("package.json の submenus・webview/context・サブメニューの項目・コマンド・パレットの除外は context-menu.ts の形と同じ", () => {
    expect(submenus).toEqual([expected.submenu]);
    // 右クリックのメニューの先頭に置き、候補（askActions）を載せた行・見出しだけに出す
    expect(menus["webview/context"]![0]).toEqual(expected.context);
    // 左パネル（ビューの ID）とパネル（viewType）の両方に出す
    expect(expected.context.when).toBe(
      "(webviewId == 'deguboard.screens' || webviewId == 'deguboard') && askActions",
    );
    expect(menus[ASK_SUBMENU]).toEqual(expected.items);
    for (const c of expected.commands) expect(commands).toContainEqual(c);
    for (const p of expected.palette) expect(menus["commandPalette"]).toContainEqual(p);
    // 頼むことはすべてコマンドにある
    expect(expected.commands.map((c) => c.command)).toEqual(ASK_ACTIONS.map(askCommandId));
  });

  it("when の文脈のキーは core の WEBVIEW_CONTRACT.askContext と同じ", () => {
    expect(WEBVIEW_CONTRACT.askContext).toEqual({
      targets: "askTargets",
      actions: "askActions",
      recommended: "askRecommended",
      within: "askWithin",
    });
  });

  /** VS Code の when の == と =~ だけを写した評価（このテストのための最小の写し） */
  function shown(context: Record<string, string>): string[] {
    const holds = (clause: string) =>
      clause.split(" && ").every((part) => {
        const eq = /^(\w+) (==|!=) '([^']*)'$/.exec(part);
        if (eq) return (context[eq[1]!] === eq[3]) === (eq[2] === "==");
        const re = /^(\w+) =~ \/(.*)\/$/.exec(part);
        if (re) return new RegExp(re[2]!).test(context[re[1]!] ?? "");
        throw new Error(`評価できない when: ${part}`);
      });
    return expected.items
      .filter((item) => holds(item.when))
      .sort((a, b) => a.group.localeCompare(b.group, "en", { numeric: true }))
      .map((item) => item.command.replace("deguboard.ask.", ""));
  }

  it("おすすめを先頭の節に 1 つだけ出し、残りの候補を次の節に出す。候補にない頼むことは出さない（done と undo_done、create と create_iteration を取り違えない）", () => {
    const candidates = askCandidates([
      {
        kind: "ticket",
        id: "t1",
        title: "A",
        status: "done",
        iteration: "s1",
        iteration_status: "closed",
        epic: null,
        deps_done: true,
        running: false,
      },
    ]).map((c) => c.action);
    expect(candidates).toEqual(["create", "undo_done", "free"]);
    const order = shown({ askActions: candidates.join(" "), askRecommended: "create" });
    expect(order[0]).toBe("create");
    expect(new Set(order)).toEqual(new Set(candidates));
    expect(order).toHaveLength(candidates.length);
    expect(shown({ askActions: "done fix check free", askRecommended: "done" })).toEqual([
      "done",
      "fix",
      "check",
      "free",
    ]);
  });

  it("コマンドの引数（data-vscode-context）から対象を取る。候補にない頼むことや形の違う引数は受けない", () => {
    const arg = {
      webviewSection: "boardHeading",
      askTargets: "t1 t2",
      askActions: "plan assign check free",
      askRecommended: "plan",
    };
    expect(menuAskOf(arg, "plan")).toEqual({
      targets: ["t1", "t2"],
      action: "plan",
      panel: false,
    });
    expect(menuAskOf({ ...arg, askTargets: "" }, "check")).toEqual({
      targets: [],
      action: "check",
      panel: false,
    });
    expect(menuAskOf(arg, "work")).toBeUndefined();
    expect(menuAskOf({ webviewSection: "boardTicket" }, "plan")).toBeUndefined();
    expect(menuAskOf(null, "plan")).toBeUndefined();
  });

  it("パネルの詳細の行の右クリックは、場所（askWithin）とパネルから開いたこと（引数の webview が viewType）を取る", () => {
    const arg = {
      webview: "deguboard",
      webviewSection: "detailTicket",
      askTargets: "t1",
      askWithin: "s1",
      askActions: "work fix remove free",
      askRecommended: "work",
    };
    expect(menuAskOf(arg, "remove")).toEqual({
      targets: ["t1"],
      action: "remove",
      within: "s1",
      panel: true,
    });
    expect(menuAskOf({ ...arg, webview: "deguboard.screens" }, "remove")).toMatchObject({
      panel: false,
    });
    // 外すはおすすめでなければ次の節に出る
    expect(shown({ askActions: arg.askActions, askRecommended: "work" })).toEqual([
      "work",
      "fix",
      "remove",
      "free",
    ]);
  });
});
