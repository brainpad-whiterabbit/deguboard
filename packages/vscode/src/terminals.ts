// 頼む小窓の依頼文を、すでに開いているターミナルの入力へ送る部分のうち、VS Code の API に触れない純粋な処理（UI-15・ADR-010）。
// 拡張はターミナルを起動しない（EX-1）。送り先は vscode.window.terminals の中から人が選ぶ

import type { TerminalChoice } from "@deguboard/core";

/**
 * 開いているターミナルを小窓の送り先の一覧にする。同じ名前が並ぶとき（zsh が 2 つなど）は、
 * 2 つ目から「zsh (2)」と番号を足して見分ける。空の名前は「ターミナル」にする
 */
export function describeTerminals(
  terminals: readonly { id: number; name: string }[],
): TerminalChoice[] {
  const seen = new Map<string, number>();
  return terminals.map(({ id, name }) => {
    const base = name.trim() || "ターミナル";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id, label: n === 1 ? base : `${base} (${n})` };
  });
}

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

/**
 * ターミナルの入力へ入れる文字列にする。Enter は押さない約束（terminal.sendText の第 2 引数 false）を、複数行でも守るための処理：
 * - 制御文字（ESC など）は取り除く。依頼文の中の ESC[201~ が貼り付けの終わりを偽り、その後ろを入力として実行させないため。改行とタブは残す
 * - 1 行ならそのまま送る
 * - 複数行は bracketed paste（ESC[200~ … ESC[201~）で包む。VS Code は sendText の改行を Enter（\r）に直すので、包まないとシェルが
 *   行ごとに実行する。bracketed paste に対応する入力（zsh・bash 5.1 以降の readline・Claude Code などのエージェント）は
 *   中の改行を入力の改行として受け、Enter では実行しない。対応しない入力へは、包みの印が見えるうえ行ごとに実行されうる（実機で確かめる項目）
 */
export function terminalPayload(text: string): string {
  const clean = text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  return clean.includes("\n") ? `${BRACKETED_PASTE_START}${clean}${BRACKETED_PASTE_END}` : clean;
}
