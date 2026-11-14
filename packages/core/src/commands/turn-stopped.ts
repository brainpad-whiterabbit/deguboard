// エージェントが応答を終えたとき（Stop。t546・t770）の確かめと記録。dg hook の turn_stopped と、2 つの入口（bin/dg.js と
// 同梱の dg.mjs の入口 bundle.ts）の速い経路（fast-hook.ts。t786）の両方がここを呼ぶ。応答のたびに呼ばれるので、node の組み込みと
// 依存のないファイルのほかを静的に読まない（読むファイルは cli の fast-hook.test.ts が確かめる）

import type { HookEvent, HookSupport } from "../agents/define.js";
import { checkOutside, describeOutside, outsideRemedy } from "../git/outside.js";
import type { GitRepo } from "../git/repo.js";
import { toIsoDateTime } from "../model/time.js";
import { recordAroundHook, type HookRunView } from "./hook-records.js";

type TurnStopped = Extract<HookEvent, { kind: "turn_stopped" }>;

/**
 * Stop の全体：記録の流れは PreToolUse と同じ recordAroundHook（入力の項目の有無・セッションに届いたこと・警告）。
 * データのリポジトリに dg の外の変更（SY-7）があれば、止まらずに続けさせてファイルと戻し方を伝える。
 * 続けさせた後の Stop（continued）では伝えない（直せないときに続けさせ続けない。次の dg のコマンドが書き込みを止めて同じことを伝える）。
 * ストアを開かない（t770）。remote はデータのリモートの追跡 ref（refs/remotes/<リモート>/<データのブランチ>）の読み方で、省けば repo から（checkOutside の opts.remote）。
 * 失敗は警告にし、例外を投げない（フックで作業を止めない）
 */
export async function runTurnStopped(args: {
  hooks: Pick<HookSupport, "events" | "inputFields" | "continueOutput">;
  eventName: string;
  payload: Record<string, unknown>;
  event: TurnStopped;
  repo: GitRepo;
  remote?: () => Promise<string | null>;
  now: () => Date;
}): Promise<HookRunView> {
  const { hooks, eventName, payload, repo } = args;
  const view: HookRunView = { done: [], warnings: [] };
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
      if (event.continued) return;
      const check = await checkOutside(repo, args.remote ? { remote: args.remote } : {});
      if (check.kind !== "found") return;
      const reason =
        `The deguboard data repository has changes made outside dg (${describeOutside(check.changes)}). ` +
        `${outsideRemedy(check.changes)}. If you wrote them yourself, tell a person and confirm whether to adopt or discard them`;
      view.output = hooks.continueOutput(eventName, reason);
      view.done.push(`Reported changes made outside dg: ${describeOutside(check.changes)}`);
    },
  });
  return view;
}
