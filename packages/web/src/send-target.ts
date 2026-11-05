// 頼む小窓の「送る」（UI-15）の判断のうち、画面に依らない純粋な部分。
// 送り先は開いているターミナルの中から選ぶだけで、ターミナルは起動しない（EX-1）

import type { TerminalChoice } from "@deguboard/core";

/** 「送る」を出すか。開いているターミナルが 1 つでもあるときだけ（なければコピーだけ） */
export function canSend(terminals: readonly TerminalChoice[]): boolean {
  return terminals.length > 0;
}

/**
 * 選んでいるターミナル。未選択（null）か、選んだものが閉じていたら、アクティブなターミナル、なければ先頭。1 つもなければ null。
 * 選んだものが閉じた場合の切り替えは黙ってしない（呼ぶ側が switchedMessage で知らせる）
 */
export function resolveSendTarget(
  terminals: readonly TerminalChoice[],
  chosen: number | null,
): TerminalChoice | null {
  return (
    terminals.find((t) => t.id === chosen) ??
    terminals.find((t) => t.active) ??
    terminals[0] ??
    null
  );
}

/** 選んだターミナルが閉じて、別のターミナルに切り替えたときの知らせ */
export function switchedMessage(to: TerminalChoice): string {
  return `選んでいたターミナルが閉じたので、${to.label} に切り替えました`;
}

/**
 * 送った後に出す知らせ。Enter を押していないので、人が確かめて押すことを添える。
 * 複数行は VS Code の貼り付けに任せるので、確認の小窓で取り消されたかは分からない。clipboardKept は、貼り付けに使ったクリップボードを戻せなかったとき
 */
export function sentMessage(
  target: TerminalChoice,
  {
    multiline = false,
    clipboardKept = false,
  }: { multiline?: boolean; clipboardKept?: boolean } = {},
): string {
  if (!multiline)
    return `✓ ${target.label} の入力に送りました。内容を確かめて Enter を押してください`;
  const note = clipboardKept ? "。クリップボードを通して貼り付けました" : "";
  return `✓ ${target.label} に送りました（貼り付けの確認が出たら選んでください）${note}。内容を確かめて Enter を押してください`;
}
