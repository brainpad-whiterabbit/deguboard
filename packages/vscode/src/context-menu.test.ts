import { readFileSync } from "node:fs";
import type { CommandClient, CommandResult } from "@deguboard/core";
import { OperationError } from "@deguboard/core";
import { describe, expect, it } from "vitest";
import {
  BACKLOG_ROW_COMMANDS,
  BACKLOG_ROW_SECTION,
  iterationPicks,
  menuTicketOf,
  moveToIteration,
  ticketRoute,
  type MenuTicket,
} from "./context-menu.js";

interface Contributes {
  commands: { command: string; title: string }[];
  menus: Record<string, { command: string; when?: string; group?: string }[]>;
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  contributes: Contributes;
};

describe("package.json の右クリックのメニュー", () => {
  const { commands, menus } = pkg.contributes;
  const ids = Object.values(BACKLOG_ROW_COMMANDS);

  it("「Iteration を移す」「詳細を開く」「ID をコピー」をこの順で、バックログの行の webview/context に出す", () => {
    const items = menus["webview/context"]!;
    expect(items.map((m) => m.command)).toEqual([
      BACKLOG_ROW_COMMANDS.move,
      BACKLOG_ROW_COMMANDS.open,
      BACKLOG_ROW_COMMANDS.copyId,
    ]);
    for (const item of items) {
      expect(item.when).toBe(
        `webviewId == 'deguboard.screens' && webviewSection == '${BACKLOG_ROW_SECTION}'`,
      );
    }
    expect(ids.map((id) => commands.find((c) => c.command === id)?.title)).toEqual([
      "Iteration を移す",
      "詳細を開く",
      "ID をコピー",
    ]);
  });

  it("行の文脈が要るので、コマンドパレットには出さない", () => {
    for (const id of ids) {
      expect(menus["commandPalette"]).toContainEqual({ command: id, when: "false" });
    }
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

/** iteration.list と ticket.update だけを持つ CommandClient。ticket.update は閉じた s9 を core と同じく拒否する */
function fakeClient(): CommandClient & { calls: { name: string; input: unknown }[] } {
  const calls: { name: string; input: unknown }[] = [];
  return {
    calls,
    async run<O>(name: string, input?: unknown): Promise<CommandResult<O>> {
      calls.push({ name, input });
      if (name === "iteration.list") {
        const data = [
          { id: "s3", project: "default", name: "三", status: "active", goal: "" },
          { id: "s4", project: "default", name: "四", status: "planned", goal: "" },
        ];
        return { data, warnings: [] } as unknown as CommandResult<O>;
      }
      if (name === "ticket.update" && (input as { iteration: unknown }).iteration === "s9")
        throw new OperationError("REJECTED", "Iteration s9 は閉じている");
      return { data: {}, warnings: [] } as unknown as CommandResult<O>;
    },
    async status() {
      throw new Error("使わない");
    },
  };
}

const row: MenuTicket = { ticket: "t12", iteration: "s3", project: "default" };

describe("Iteration を移す", () => {
  it("候補は core の iteration.list に閉じていない Iteration だけを頼み、末尾に「Iteration なし」を置いて今の所属に印を付ける", async () => {
    const client = fakeClient();
    expect(await iterationPicks(client, row)).toEqual([
      { label: "s3 三", description: "今の所属", iteration: "s3" },
      { label: "s4 四", iteration: "s4" },
      { label: "Iteration なし", iteration: null },
    ]);
    expect(client.calls).toEqual([
      { name: "iteration.list", input: { project: "default", status: ["active", "planned"] } },
    ]);
  });

  it("選んだ先へはドラッグと同じ ticket.update を呼ぶだけで、今の所属と同じなら呼ばない", async () => {
    const client = fakeClient();
    expect(await moveToIteration(client, row, { label: "s4 四", iteration: "s4" })).toBe(true);
    expect(await moveToIteration(client, row, { label: "Iteration なし", iteration: null })).toBe(
      true,
    );
    expect(await moveToIteration(client, row, { label: "s3 三", iteration: "s3" })).toBe(false);
    expect(client.calls).toEqual([
      { name: "ticket.update", input: { ticket: "t12", iteration: "s4" } },
      { name: "ticket.update", input: { ticket: "t12", iteration: null } },
    ]);
  });

  it("閉じた Iteration への移動は core の拒否をそのまま投げる", async () => {
    await expect(
      moveToIteration(fakeClient(), row, { label: "s9", iteration: "s9" }),
    ).rejects.toMatchObject({ code: "REJECTED" });
  });
});
