// 頼む小窓の「送る」（UI-15）の判断のうち、画面に依らない純粋な部分。
// 送り先は開いているターミナルの中から選ぶだけで、ターミナルは起動しない（EX-1）

import type { TerminalChoice } from "@deguboard/core";

/** 「送る」を出すか。開いているターミナルが 1 つでもあるときだけ（なければコピーだけ） */
export function canSend(terminals: readonly TerminalChoice[]): boolean {
  return terminals.length > 0;
}

/** 選んでいるターミナル。選んだものが閉じていたら先頭に戻す。1 つもなければ null */
export function resolveSendTarget(
  terminals: readonly TerminalChoice[],
  chosen: number | null,
): TerminalChoice | null {
  return terminals.find((t) => t.id === chosen) ?? terminals[0] ?? null;
}

/** 送った後に出す知らせ。Enter を押していないので、人が確かめて押すことを添える */
export function sentMessage(target: TerminalChoice): string {
  return `✓ ${target.label} の入力に送りました。内容を確かめて Enter を押してください`;
}
