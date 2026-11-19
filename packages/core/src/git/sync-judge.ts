// 同期状態（syncStatus）の、数えた結果と追跡 ref の有無から次にすることを決める判定。git を読まない。
// 値を読むのは sync.ts で、読んだ値をここへ渡す。組み合わせは sync-judge.test.ts が git なしで確かめ、
// git を通すテスト（git.test.ts）は経路の代表だけを見る

/** 追跡 ref と比べて数えた、未 push（ahead）と未取り込み（behind）のコミット数 */
export interface SyncCounts {
  ahead: number;
  behind: number;
}

/** 1 回数えた結果。数えられなかったときは、そのときの失敗（E）を持つ */
export type SyncCountAttempt<E> = { ok: true; counts: SyncCounts } | { ok: false; error: E };

/** syncStatus が読んだこと。読んでいないものは undefined */
export interface SyncCountFacts<E> {
  /** 1 回目に数えた結果 */
  first: SyncCountAttempt<E>;
  /** 1 回目に数えられなかった後に聞いた、追跡 ref があるか */
  refExists?: boolean | undefined;
  /** 追跡 ref があると分かった後に数え直した結果 */
  second?: SyncCountAttempt<E> | undefined;
}

/**
 * 次にすること。ask_ref は追跡 ref があるかを聞く、recount は数え直す、no_ref は追跡 ref がない扱い
 * （手元のコミットをすべて未 push と数える）、counted は数えた結果で確定、failed は error を投げる
 */
export type SyncCountStep<E> =
  | { kind: "counted"; counts: SyncCounts }
  | { kind: "ask_ref" }
  | { kind: "recount" }
  | { kind: "no_ref" }
  | { kind: "failed"; error: E };

/**
 * 読んだことから次にすることを決める。syncStatus は書き込みのロックの外でも走るので、1 回目に数えてから追跡 ref が
 * あるかを聞くまでの間に、同時の書き込みの fetch・push が追跡 ref を作ることがある。そのとき 1 回目の失敗は
 * 「ref がなかった」という古い事実なので投げず、1 回だけ数え直す。数え直しても数えられないときは、追跡 ref が
 * あるのに数えられない別の失敗なので、数え直したときの（今の）失敗を投げる。数え直しは 1 回までで、繰り返さない（t1119）
 */
export function nextSyncCountStep<E>(facts: SyncCountFacts<E>): SyncCountStep<E> {
  if (facts.first.ok) return { kind: "counted", counts: facts.first.counts };
  if (facts.refExists === undefined) return { kind: "ask_ref" };
  if (!facts.refExists) return { kind: "no_ref" };
  if (facts.second === undefined) return { kind: "recount" };
  if (facts.second.ok) return { kind: "counted", counts: facts.second.counts };
  return { kind: "failed", error: facts.second.error };
}
