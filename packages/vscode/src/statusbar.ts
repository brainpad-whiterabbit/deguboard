// ステータスバーの項目（UI-12）。今の worktree のブランチに紐づくチケットの ID・Status と、Run が実行中かを出す。
// VS Code の API に触れない部分で、extension.ts から呼ぶ。ブランチは git で読み、チケットの branch と照らす

import { execFile } from "node:child_process";

/** ステータスバーの項目を決めるのに要るチケットの項目（ticket.list の行の一部） */
export interface BranchTicket {
  id: string;
  status: string;
  branch: string | null;
}

/** 項目を押したときのコマンド。package.json の contributes.commands と合わせる */
export const STATUSBAR_COMMAND = "deguboard.openCurrentTicket";

/** 今のブランチ名。デタッチ HEAD やリポジトリでないフォルダでは undefined */
export function currentBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["branch", "--show-current"], { cwd, timeout: 5_000 }, (error, stdout) => {
      const name = error ? "" : stdout.trim();
      resolve(name === "" ? undefined : name);
    });
  });
}

/** この worktree の HEAD の置き場所（絶対パス）。チェックアウトでブランチが変わるとこのファイルが変わる。取れなければ undefined */
export function headFile(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--absolute-git-dir"],
      { cwd, timeout: 5_000 },
      (error, stdout) => {
        const dir = error ? "" : stdout.trim();
        resolve(dir === "" ? undefined : `${dir}/HEAD`);
      },
    );
  });
}

/** ブランチが branch に一致するチケット。なければ undefined（そのブランチではステータスバーに出さない） */
export function ticketOfBranch(
  tickets: readonly BranchTicket[],
  branch: string | undefined,
): BranchTicket | undefined {
  if (branch === undefined) return undefined;
  return tickets.find((t) => t.branch === branch);
}

/** ステータスバーの文言。実行中の Run があれば回るアイコンを付ける */
export function statusBarText(ticket: BranchTicket, running: boolean): string {
  return `${running ? "$(sync~spin)" : "$(tasklist)"} ${ticket.id} ${ticket.status}`;
}

/** ホバーの文言 */
export function statusBarTooltip(ticket: BranchTicket, running: boolean): string {
  const run = running ? "。Run が実行中" : "";
  return `deguboard: ${ticket.id}（${ticket.status}）${run}。押すと詳細を開く`;
}
