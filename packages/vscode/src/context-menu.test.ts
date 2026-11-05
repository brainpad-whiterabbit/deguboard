import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BACKLOG_ROW_COMMANDS,
  BACKLOG_ROW_SECTION,
  menuTicketOf,
  ticketRoute,
} from "./context-menu.js";

interface Contributes {
  commands: { command: string; title: string; category?: string; icon?: string }[];
  submenus?: unknown;
  menus: Record<string, { command?: string; submenu?: string; when?: string; group?: string }[]>;
}

// manifest の %鍵% は、表示言語が日本語のときの文言（package.nls.ja.json）で埋めて読む
const nlsJa = JSON.parse(
  readFileSync(new URL("../package.nls.ja.json", import.meta.url), "utf8"),
) as Record<string, string>;
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  (_key, value: unknown) => {
    const m = typeof value === "string" ? /^%([\w.-]+)%$/.exec(value) : null;
    return m ? (nlsJa[m[1]!] ?? value) : value;
  },
) as {
  contributes: Contributes;
  capabilities?: {
    untrustedWorkspaces?: { supported?: unknown; description?: string };
    virtualWorkspaces?: { supported?: unknown } | boolean;
  };
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

  it("エージェントに頼むサブメニューと deguboard.ask.<頼むこと> のコマンドは置かない（頼む入口は画面の吹き出し・Shift+F10・選択の帯。ADR-010）", () => {
    expect(commands.filter((c) => c.command.startsWith("deguboard.ask."))).toEqual([]);
    expect(pkg.contributes.submenus).toBeUndefined();
    expect(menus["webview/context"]!.some((m) => m.submenu)).toBe(false);
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
  it("行の data-vscode-context からチケットを取る", () => {
    expect(
      menuTicketOf({
        webviewSection: BACKLOG_ROW_SECTION,
        ticket: "t12",
        preventDefaultContextMenuItems: true,
      }),
    ).toEqual({ ticket: "t12" });
  });

  it("バックログの行でない・形が違う引数は undefined", () => {
    expect(menuTicketOf(undefined)).toBeUndefined();
    expect(menuTicketOf({ webviewSection: "other", ticket: "t1" })).toBeUndefined();
    expect(menuTicketOf({ webviewSection: BACKLOG_ROW_SECTION })).toBeUndefined();
  });

  it("「詳細を開く」はチケット詳細のルートを開く", () => {
    expect(ticketRoute({ ticket: "t12" })).toBe("#/tickets/t12");
  });
});

describe("package.json の capabilities", () => {
  it("制限モード（信頼していないフォルダー）では動かないことを、理由つきで明示する", () => {
    const u = pkg.capabilities?.untrustedWorkspaces;
    expect(u?.supported).toBe(false);
    expect(u?.description).toContain("git の設定");
  });

  it("仮想ワークスペースでは動かないことを明示する", () => {
    const v = pkg.capabilities?.virtualWorkspaces;
    expect(typeof v === "object" ? v.supported : v).toBe(false);
  });
});
