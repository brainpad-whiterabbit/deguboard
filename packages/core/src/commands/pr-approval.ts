// フックの速い経路でも読むため、依存を持たず承認で越えられない条件の案内を共有する。
export const NEVER_OVERRIDDEN = "pr, mergeable, and head are never overridden";

/**
 * 人がマージを承認したとき（dg pr merge --approved-by）に、満たさなくても越える品質ゲートの条件。Core に固定で、設定では変えられない
 * （workflow/resolve.ts の CORE_FIXED の merge_over_gate、WF-7）。PR が開いていること（pr）・衝突（mergeable）・判定した先端（head）は
 * 入れない：越えると gh がマージできないか、判定していないコミットをマージすることになる
 */
export const APPROVAL_OVERRIDES = ["check", "review", "fix_rounds", "acceptance"] as const;
