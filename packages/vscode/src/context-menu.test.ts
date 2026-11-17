import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WEBVIEW_CONTRACT } from "@deguboard/core";
import {
  attentionCommands,
  attentionValue,
  SETUP_ATTENTION,
  SYNC_ATTENTION,
  syncAttentionCounts,
} from "./attention.js";
import { MENU_COMMANDS, MENU_SECTION, menuItemOf } from "./context-menu.js";

interface Contributes {
  commands: {
    command: string;
    title: string;
    category?: string;
    icon?: string | { light: string; dark: string };
  }[];
  submenus?: unknown;
  menus: Record<string, { command?: string; submenu?: string; when?: string; group?: string }[]>;
}

// manifest の %鍵% は、表示言語が日本語のときの文言（package.nls.ja.json）で埋めて読む
const nlsJa = JSON.parse(
  readFileSync(new URL("../package.nls.ja.json", import.meta.url), "utf8"),
) as Record<string, string>;
const nlsEn = JSON.parse(
  readFileSync(new URL("../package.nls.json", import.meta.url), "utf8"),
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
  const ids = Object.values(MENU_COMMANDS);

  it("「詳細を開く」「ID をコピー」をこの順で、core の WEBVIEW_CONTRACT の 1 つの webviewSection の webview/context に出す（「Iteration を移す」は置かない。UI-7）", () => {
    const items = menus["webview/context"]!.filter((m) => m.command);
    expect(items.map((m) => m.command)).toEqual([MENU_COMMANDS.open, MENU_COMMANDS.copyId]);
    expect(MENU_SECTION).toBe(WEBVIEW_CONTRACT.menuSection);
    for (const item of items) {
      expect(item.when).toBe(
        `webviewId == 'deguboard.screens' && webviewSection == '${WEBVIEW_CONTRACT.menuSection}'`,
      );
    }
    expect(ids.map((id) => commands.find((c) => c.command === id)?.title)).toEqual([
      "詳細を開く",
      "ID をコピー",
    ]);
    expect(commands.some((c) => c.command === "deguboard.backlog.moveIteration")).toBe(false);
  });

  it("コマンド名は場所によらない（バックログなどの場所の名前を含まない）", () => {
    expect(ids).toEqual(["deguboard.openDetail", "deguboard.copyId"]);
    expect(commands.filter((c) => c.command.startsWith("deguboard.backlog."))).toEqual([]);
  });

  it("エージェントに頼むサブメニューと deguboard.ask.<頼むこと> のコマンドは置かない（頼む入口は画面の吹き出し・Shift+F10・選択の帯。UI-15）", () => {
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
  const attention = attentionCommands(SETUP_ATTENTION);
  const syncAttention = attentionCommands(SYNC_ATTENTION);

  it("セットアップ（導入のチェックリストの切り替え）・吹き出し（エージェントに頼む）・同期・歯車（設定画面の切り替え）の順に並べる", () => {
    // 点付きのアイコンの差し替え用のコマンドは、元のコマンドと同じ場所に出す（下の検査で確かめる）
    const items = menus["view/title"]!.filter(
      (m) => !attention.includes(m.command!) && !syncAttention.includes(m.command!),
    );
    expect(items.map((m) => [m.command, m.group])).toEqual([
      ["deguboard.setup", "navigation@0"],
      ["deguboard.askInSidebar", "navigation@1"],
      ["deguboard.sync", "navigation@2"],
      ["deguboard.config", "navigation@3"],
    ]);
    for (const item of [items[1]!, items[3]!]) expect(item.when).toBe("view == deguboard.screens");
    expect(commands.find((c) => c.command === "deguboard.config")).toMatchObject({
      title: "設定",
      icon: "$(gear)",
    });
  });

  it("セットアップはチェックリストのアイコンで左端に置き、コマンドパレットにも「deguboard: セットアップ」で出す", () => {
    expect(commands.find((c) => c.command === "deguboard.setup")).toMatchObject({
      title: "セットアップ",
      category: "deguboard",
      icon: "$(checklist)",
    });
    expect(menus["commandPalette"]!.some((m) => m.command === "deguboard.setup")).toBe(false);
  });

  it("項目が欠けている間は、context key の件数で、件数をツールチップに出す点付きのアイコンのコマンドに差し替える（0 か未設定なら元のアイコン）", () => {
    const { command, contextKey, max } = SETUP_ATTENTION;
    const view = "view == deguboard.screens";
    const titleItems = menus["view/title"]!;
    expect(titleItems.find((m) => m.command === command)?.when).toBe(`${view} && !${contextKey}`);
    expect(attention).toEqual([
      "deguboard.setup.attention1",
      "deguboard.setup.attention2",
      "deguboard.setup.attention3",
    ]);
    expect(max).toEqual([3]);
    attention.forEach((id, i) => {
      expect(titleItems.find((m) => m.command === id)).toEqual({
        command: id,
        when: `${view} && ${contextKey} == ${i + 1}`,
        group: "navigation@0",
      });
      expect(commands.find((c) => c.command === id)).toEqual({
        command: id,
        title: `セットアップ（${i + 1} 件が欠けています）`,
        category: "deguboard",
        icon: {
          light: "media/setup-attention-light.svg",
          dark: "media/setup-attention-dark.svg",
        },
      });
      // 差し替え用なので、コマンドパレットには出さない
      expect(menus["commandPalette"]).toContainEqual({ command: id, when: "false" });
    });
    // 英語の文言も件数ごとに持つ
    expect(attention.map((id) => nlsEn[`command.${id.replace("deguboard.", "")}.title`])).toEqual([
      "Setup (1 item missing)",
      "Setup (2 items missing)",
      "Setup (3 items missing)",
    ]);
  });

  it("context key に入れる値は件数で、0 は点なし、上限より多い件数は上限のコマンドにまとめる", () => {
    expect(attentionValue(SETUP_ATTENTION, [0])).toBe(0);
    expect(attentionValue(SETUP_ATTENTION, [2])).toBe("2");
    expect(attentionValue(SETUP_ATTENTION, [7])).toBe("3");
  });

  it("人の同期が要る間は、context key の未 push と未取り込みの件数の組で、件数をツールチップに出す点付きの同期のアイコンのコマンドに差し替える（UI-6）", () => {
    const { command, contextKey, max } = SYNC_ATTENTION;
    const view = "view == deguboard.screens";
    const titleItems = menus["view/title"]!;
    expect(titleItems.find((m) => m.command === command)?.when).toBe(`${view} && !${contextKey}`);
    expect(max).toEqual([3, 3]);
    // 未 push は 1 から、未取り込みは 0 から、どちらも 3（3 以上）まで
    const combos = [1, 2, 3].flatMap((a) => [0, 1, 2, 3].map((b) => [a, b] as const));
    expect(syncAttention).toEqual(combos.map(([a, b]) => `deguboard.sync.attention${a}_${b}`));
    const many = (n: number) => (n === 3 ? "3+" : String(n));
    combos.forEach(([a, b], i) => {
      const id = syncAttention[i]!;
      expect(titleItems.find((m) => m.command === id)).toEqual({
        command: id,
        when: `${view} && ${contextKey} == ${a}_${b}`,
        group: "navigation@2",
      });
      expect(commands.find((c) => c.command === id)).toEqual({
        command: id,
        title: `同期（未 push ${many(a)}${b > 0 ? ` / 未取り込み ${many(b)}` : ""}）`,
        category: "deguboard",
        icon: {
          light: "media/sync-attention-light.svg",
          dark: "media/sync-attention-dark.svg",
        },
      });
      expect(nlsEn[`command.sync.attention${a}_${b}.title`]).toBe(
        `Sync (${many(a)} unpushed${b > 0 ? ` / ${many(b)} to pull` : ""})`,
      );
      // 差し替え用なので、コマンドパレットには出さない
      expect(menus["commandPalette"]).toContainEqual({ command: id, when: "false" });
    });
  });

  it("同期のボタンの点は未 push があるときだけ出し、未取り込みだけ（自動で取り込める）とすべて同期済みでは出さない", () => {
    const value = (ahead: number, behind: number) =>
      attentionValue(SYNC_ATTENTION, syncAttentionCounts({ ahead, behind }));
    expect(value(0, 0)).toBe(0);
    expect(value(0, 4)).toBe(0);
    expect(value(1, 0)).toBe("1_0");
    expect(value(2, 1)).toBe("2_1");
    // 上限より多い件数は「3+」のコマンドにまとめる
    expect(value(12, 5)).toBe("3_3");
  });

  it("点付きのアイコンはライトとダークで、線をテーマのアイコンの色、点を警告の色で描く", () => {
    for (const name of ["setup", "sync"])
      for (const [theme, stroke, dot] of [
        ["light", "#424242", "#BF8803"],
        ["dark", "#C5C5C5", "#CCA700"],
      ] as const) {
        const svg = readFileSync(
          new URL(`../media/${name}-attention-${theme}.svg`, import.meta.url),
          "utf8",
        );
        expect(svg).toContain(`stroke="${stroke}"`);
        expect(svg).toContain(`fill="${dot}"`);
      }
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
  const contextOf = (id: string) => ({
    webviewSection: MENU_SECTION,
    id,
    preventDefaultContextMenuItems: true,
  });

  it("行・見出しの data-vscode-context から ID を取り、「ID をコピー」はその ID を、「詳細を開く」はその ID の詳細（チケット・Iteration・Epic）のルートを使う", () => {
    expect(menuItemOf(contextOf("t12"))).toEqual({ id: "t12", route: "#/tickets/t12" });
    expect(menuItemOf(contextOf("s3"))).toEqual({ id: "s3", route: "#/iterations/s3" });
    expect(menuItemOf(contextOf("e2"))).toEqual({ id: "e2", route: "#/epics/e2" });
  });

  it("文脈の名前が違う・ID がない・詳細を開けない ID の引数は undefined", () => {
    expect(menuItemOf(undefined)).toBeUndefined();
    expect(menuItemOf({ webviewSection: "other", id: "t1" })).toBeUndefined();
    // 前の名前（バックログの行だけの文脈）は受けない
    expect(menuItemOf({ webviewSection: "backlogTicket", ticket: "t1" })).toBeUndefined();
    expect(menuItemOf({ webviewSection: MENU_SECTION })).toBeUndefined();
    expect(menuItemOf(contextOf("x1"))).toBeUndefined();
    expect(menuItemOf(contextOf("t01"))).toBeUndefined();
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
