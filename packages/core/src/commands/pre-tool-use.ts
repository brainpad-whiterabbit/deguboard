// ツールを使う前（PreToolUse。t532・t545・t555・t546、AG-10）の判定と記録。dg hook の tool_requested と、2 つの入口（bin/dg.js と
// 同梱の dg.mjs の入口 bundle.ts）の速い経路（fast-hook.ts）の両方がここを呼ぶ。ツールのたびに呼ばれるので、node の組み込みと依存のないファイルのほかを読まない
// （zod・yaml・commander とコマンドの定義を読むと、起動だけで 200 ms を超える。t768。読むファイルは fast-hook.test.ts が確かめる）

import path from "node:path";
import type { HookEvent, HookSupport } from "../agents/define.js";
import { toIsoDateTime } from "../model/time.js";
import { recordAroundHook } from "./hook-records.js";

/** .git/deguboard の語（区切りは / と \。.git/deguboard-local も含む） */
const DATA_DIR_WORD = /\.git[\\/]+deguboard/;

/**
 * Bash のコマンドがデータ（.git/deguboard/）に触れるか（t546、AG-10）。字句を読まず、生のコマンドに .git/deguboard の語が
 * どこかにあれば（読むだけのものも、引用符・コメントの中も）触れるとみなし、dg の読み書きのコマンドへ案内する。
 * 語として現れない形（cd .git && rm deguboard/x・変数・ファイルに書いたスクリプト・任意の言語のコード）は通る。
 * 取りこぼした書き込みは、dg が次にコマンドを実行するときと Stop のフックで、dg の外の変更として見つける（git/outside.ts）
 */
export function touchesDataDir(command: string): boolean {
  return DATA_DIR_WORD.test(command);
}

/** gh api で PR をマージ・ready にする手がかり（REST の pulls/<n>/merge と GraphQL の mutation 名） */
const GH_API_ADVANCE =
  /pulls\/[^/\s]+\/merge\b|mergePullRequest|markPullRequestReadyForReview|enablePullRequestAutoMerge/;
/**
 * 正しい道の dg pr ready・dg pr merge（mise run dg -- pr merge・dg.js も）。区切り（; & | 改行）と gh の語を越えない。
 * 同じ区切りの中で前に gh の語があるもの（gh -R o/dg pr merge）は、gh の引数の dg なので除かない（advancesPrOutsideDg）
 */
const DG_PR = /\bdg(?:\.js)?\b(?:(?!\bgh\b)[^;&|\n])*?\bpr\s+(?:ready|merge)\b/g;
/** 取り消しの gh pr ready --undo（-- の後の --undo はフラグでなく引数なので、-- を越えない。--undo=false も除かない） */
const GH_READY_UNDO = /\bgh\s+pr\s+ready\b(?:(?!\s--(?:\s|$))[^;&|\n])*\s--undo(?=\s|$)/g;
/** 語に分ける区切り（英数字・_・.・/・- のほかすべて。引用符・\・=・括弧・任意の言語の配列の記号も区切る） */
const WORD_SPLIT = /[^\w./-]+/;
/** gh の語（/usr/bin/gh・フラグに接した -Ogh も） */
const isGh = (w: string) => /(^|\/|^-[A-Za-z]*)gh$/.test(w);

/**
 * Bash のコマンドが、dg を経由せずに PR を ready にするかマージするか（gh pr ready・gh pr merge・gh api の同じ操作。t545・t555、AG-10）。
 * 字句を読まず、生のコマンドで粗く見る：正しい道の dg pr ready・dg pr merge と gh pr ready --undo を除いた残りに、
 * gh の語があり、pr の語と merge・ready の語がどこかにあれば（語は隣り合わなくてよい。2>&1・$PR・python -c の中・1 要素ずつ改行した配列も）、
 * gh api の同じ操作（GH_API_ADVANCE）があれば止める。引用符・ヒアドキュメント・コメントの中も伏せない（本文の語も止める。
 * そのときは拒む文が、ファイルに書いて --body-file・git commit -F で渡す道を案内する）。
 * わざと隠した形は個々に見ない。$(which gh)・GH=gh; $GH pr merge のように語が現れれば止まるが、
 * 語として現れない形（g\h・"mer""ge"・gh pr $OP・gh のエイリアス・ファイルに書いたスクリプトなど）は通る。
 * 見分けは書き間違いを防ぐ手がかりで、すり抜けは事後の検査（t546）で補う
 */
export function advancesPrOutsideDg(command: string): boolean {
  const text = command.replace(/\\\n/g, " ");
  const words = (t: string) => t.split(WORD_SPLIT).filter((w) => w !== "");
  const rest = text
    .replace(DG_PR, (m: string, at: number) =>
      words(
        text
          .slice(0, at)
          .split(/[;&|\n]/)
          .pop()!,
      ).some(isGh)
        ? m
        : " ",
    )
    .replace(GH_READY_UNDO, " ");
  const all = words(rest);
  if (!all.some(isGh)) return false;
  // GraphQL の mutation は括弧を含むので、語に分けずに全体で見る
  if (GH_API_ADVANCE.test(rest)) return true;
  return all.includes("pr") && all.some((w) => w === "merge" || w === "ready");
}

/** dg を経由しない gh pr ready・merge を拒む文（t545・t555） */
export const GH_PR_DENIED =
  "Mark a PR ready and merge it with dg commands: dg pr ready <ticket> and dg pr merge <ticket> (they call gh only when the quality gate dg gate is met, and otherwise return the conditions and reasons). " +
  "Going ahead without meeting the gate (a reviewer cannot be launched, the fix loop went over its limit, or a person set the count) is a human decision, so ask a person to run gh pr ready or gh pr merge (dg guide review). If the level of the ticket does not fit the change, change it with dg ticket update <id> --gate <level> (lowering it is a person's instruction), then run dg pr ready or dg pr merge again. " +
  "This hook does not mask quotes, heredocs, or comments, and stops when the words gh, pr, and merge or ready appear anywhere. " +
  "To write those words in a body, write it to a file with Write and pass it with gh pr create --body-file <file> or git commit -F <file>. If it stopped because you ran it together with other commands, run them separately";

/** 書くツールが .git/deguboard/ の下に書くのを拒む文 */
const DATA_WRITE_DENIED =
  "Do not write the deguboard data (.git/deguboard/) files directly; read and write them with dg commands";

/** .git/deguboard の語を含む Bash を拒む文（t546） */
const DATA_BASH_DENIED =
  "Do not touch the deguboard data (.git/deguboard/) with Bash; read and write it with dg commands (read with dg ticket show, dg ticket list, dg plan show, and so on; write with dg ticket update and so on). " +
  "This hook stops on the word .git/deguboard anywhere, even in read-only commands, quotes, and comments. To search for the word in documents or code, use the Grep tool. " +
  "To write the word in a body, write it to a file with Write and pass it with --body-file or git commit -F. A change that gets through anyway is found the next time dg runs as a change made outside dg, and dg stops writing (dg adopt --help)";

type ToolRequested = Extract<HookEvent, { kind: "tool_requested" }>;

/**
 * 拒む理由。通すなら undefined。書くツールの .git/deguboard/ の下への書き込みと、.git/deguboard の語を含む Bash
 * （touchesDataDir。読むだけのものも粗く止める）を拒み、dg を経由しない gh pr ready・gh pr merge を拒んで dg pr ready・dg pr merge へ案内する
 * （advancesPrOutsideDg。字句を読まずに粗く止める）。取りこぼしは事後の検査（dg の外の変更。SY-7）が見つける。
 * ストアを開かずに、repo の場所（topLevel・dataDir）と入力だけで決める（t554）
 */
function toolDenyReason(
  event: ToolRequested,
  repo: { topLevel: string; dataDir: string },
): string | undefined {
  if (event.tool === "write") {
    if (!event.path) return undefined;
    const target = path.resolve(event.cwd ?? repo.topLevel, event.path);
    const inside = (dir: string) => {
      const rel = path.relative(dir, target);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    return inside(repo.dataDir) || /(^|[\\/])\.git[\\/]deguboard([\\/]|$)/.test(target)
      ? DATA_WRITE_DENIED
      : undefined;
  }
  const command = event.command ?? "";
  if (touchesDataDir(command)) return DATA_BASH_DENIED;
  return advancesPrOutsideDg(command) ? GH_PR_DENIED : undefined;
}

/** PreToolUse の結果。入口は done を `dg hook: ` を付けて標準エラーに、output を標準出力に、warnings を標準エラーに書く */
export interface ToolRequestedView {
  /** 行ったこと（1 件 1 行） */
  done: string[];
  /** フックが標準出力に書く文（ツールの使用を拒むときの製品の形。Adapter の denyOutput が作る） */
  output?: string;
  warnings: string[];
}

/**
 * PreToolUse の全体：入力の項目の有無（hook-inputs/）とセッションに届いたこと（hook-sessions/）を残し、拒むか決め、
 * 出た警告をセッションに残す（t542・t697・t756）。記録の失敗と判定の失敗は警告にし、例外を投げない（フックで作業を止めない）。
 * eventName は製品のイベント名で、拒む文にそのまま返す（AG-5）
 */
export async function runToolRequested(args: {
  hooks: Pick<HookSupport, "events" | "inputFields" | "denyOutput">;
  eventName: string;
  payload: Record<string, unknown>;
  event: ToolRequested;
  repo: { topLevel: string; dataDir: string; localDir: string };
  now: () => Date;
}): Promise<ToolRequestedView> {
  const { hooks, eventName, payload, repo } = args;
  const view: ToolRequestedView = { done: [], warnings: [] };
  view.warnings = await recordAroundHook({
    localDir: repo.localDir,
    eventName,
    ...(hooks.events.some((e) => e.event === eventName)
      ? { inputFields: () => hooks.inputFields(eventName, payload) }
      : {}),
    payload,
    event: args.event,
    at: toIsoDateTime(args.now()),
    body: async (event) => {
      const reason = toolDenyReason(event, repo);
      if (reason !== undefined) {
        view.output = hooks.denyOutput(eventName, reason);
        view.done.push(`Denied: ${reason}`);
      }
    },
  });
  return view;
}
