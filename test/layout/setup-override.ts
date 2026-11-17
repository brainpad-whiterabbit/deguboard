// 準備で境目の条件（requires）を越えるための、人の強制の理由（ticket.move・ticket.claim の override）。
// 配置のテストは画面に出す状態（PR なしの done、依存先が終わっていない作業中）を作るだけで、PR もマージもしない。
// 既定の Workflow は todo → done に pr_merged、着手に deps_done を求めるので、理由を付けて越える（人だけが使える。ST-2）。
// 理由はコミットの文に残るだけで、確かめる画面には出ない
export const SETUP_OVERRIDE = "layout test setup";
