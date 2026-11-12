// 頼む小窓の依頼文を、すでに開いているターミナルの入力へ送る部分のうち、VS Code の API に触れない純粋な処理（UI-15・ADR-027）。
// 拡張はターミナルを起動しない（EX-1）。送り先は vscode.window.terminals の中から人が選ぶ

import type { TerminalChoice } from "@deguboard/core";
import { t } from "./l10n.js";

/**
 * 開いているターミナルを小窓の送り先の一覧にする。同じ名前が並ぶとき（zsh が 2 つなど）は、
 * 2 つ目から「zsh (2)」と番号を足して見分ける。空の名前は「ターミナル」にする。
 * 名前は一覧を作った時点のもの。開閉・アクティブの変化・状態の変化で作り直すが、名前の変化だけを知らせる通知は VS Code にないので、古くなりうる
 */
export function describeTerminals(
  terminals: readonly { id: number; name: string; active?: boolean }[],
): TerminalChoice[] {
  const seen = new Map<string, number>();
  return terminals.map(({ id, name, active }) => {
    const base = name.trim() || t("Terminal");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id, label: n === 1 ? base : `${base} (${n})`, ...(active ? { active: true } : {}) };
  });
}

/** ターミナルへ入れる方法。line は sendText（Enter は押さない）、paste は VS Code の貼り付けコマンドに任せる */
export type TerminalInput = { kind: "line" | "paste"; text: string };

/**
 * 依頼文をターミナルへ入れる方法と文字列を決める。Enter は押さない約束を、複数行でも守るための処理：
 * - 制御文字（ESC など）は取り除く。依頼文の中の ESC[201~ が貼り付けの終わりを偽り、後ろを入力として実行させないため。改行は残す
 * - 1 行は sendText(text, false) で送る。タブは空白にする（補完が動かないように）
 * - 複数行は sendText の改行が Enter（\r）になり、シェルが行ごとに実行するので使わない。クリップボード → terminal.show() →
 *   VS Code の既存コマンド workbench.action.terminal.paste の貼り付けに任せる。VS Code は入力が bracketed paste を有効にしているときだけ
 *   包み、そうでなければ複数行の貼り付けの警告（terminal.integrated.enableMultiLinePasteWarning）を出す。自前で ESC[200~ を付けて包まない。
 *   使うのは既にあるコマンドだけで、ターミナルもエージェントも起動しない（EX-1）
 */
export function terminalInput(text: string): TerminalInput {
  const clean = text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/\t/g, " ");
  return clean.includes("\n") ? { kind: "paste", text: clean } : { kind: "line", text: clean };
}

/**
 * 始め方の画面のボタンがターミナルに入れる 1 行（Enter まで送る）。起動ファイル（launcher.ts）の絶対パスで
 * dg init・dg skill install・dg hooks install を &&（途中で失敗したら続けない）でつなぐ。PATH の dg は使わない。
 * パスはシングルクォートで囲む（空白や ' を含んでも 1 つの引数のまま。sh・bash・zsh・fish で同じに読める）
 */
export function startCommandLine(launcher: string): string {
  const quoted = `'${launcher.replace(/'/g, `'\\''`)}'`;
  return ["init", "skill install", "hooks install"].map((c) => `${quoted} ${c}`).join(" && ");
}

/** 始め方のボタンが開くターミナルの名前（ほかの処理は同じ名前のターミナルを開かない） */
export const START_TERMINAL_NAME = "deguboard";

/**
 * 始め方のボタンが次に何をするかを決める。閉じていない deguboard のターミナル（exitStatus がない）を再利用し、新しく開かない。
 * - running（始めの 1 行を送り、まだ終わっていないと分かっているターミナル）があれば、送らずに見せるだけにする。
 *   1 回目の init が終わる前の 2 回目で init・skill install・hooks install が二重に走り、同時に競うため
 * - running でなければ、開いているもの（前の実行が終わった、または失敗したターミナル）に同じ 1 行を送り直す。
 *   開いたままのターミナルを見せるだけだと、dg init などが失敗した後のやり直しができないため
 * - 開いているものがなければ、terminal は undefined（新しく開く）
 */
export function startTerminalPlan<T extends { name: string; exitStatus?: unknown }>(
  terminals: readonly T[],
  running: ReadonlySet<T>,
): { kind: "show"; terminal: T } | { kind: "send"; terminal: T | undefined } {
  const open = terminals.filter(
    (t) => t.name === START_TERMINAL_NAME && t.exitStatus === undefined,
  );
  const busy = open.find((t) => running.has(t));
  if (busy) return { kind: "show", terminal: busy };
  return { kind: "send", terminal: open[0] };
}
