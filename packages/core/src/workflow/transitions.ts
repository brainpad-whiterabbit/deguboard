// 遷移表の正本（ADR-003）。ワークフローは requires を足すか by を狭めるだけで、表を増減できない

import type { Status } from "../model/common.js";
import type { Actor, Condition } from "../model/workflow.js";

export interface Transition {
  from: Status;
  to: Status;
  by: readonly Actor[];
  requires: readonly Condition[];
}

export const BUILTIN_TRANSITIONS: readonly Transition[] = [
  // claim。依存が done でなければ拒否（ST-3）
  { from: "todo", to: "in_progress", by: ["human", "agent"], requires: ["deps_done"] },
  { from: "in_progress", to: "review", by: ["human", "agent", "reconcile"], requires: [] },
  // 差し戻し
  { from: "review", to: "in_progress", by: ["human"], requires: [] },
  { from: "review", to: "done", by: ["human", "reconcile"], requires: [] },
  // レビューを要しない作業
  { from: "in_progress", to: "done", by: ["human"], requires: [] },
  // やめる。claim を外す（ST-8）
  { from: "todo", to: "abandoned", by: ["human"], requires: [] },
  { from: "in_progress", to: "abandoned", by: ["human"], requires: [] },
  { from: "review", to: "abandoned", by: ["human"], requires: [] },
  // 再開
  { from: "abandoned", to: "todo", by: ["human"], requires: [] },
  { from: "done", to: "todo", by: ["human"], requires: [] },
];

export function findBuiltinTransition(from: Status, to: Status): Transition | undefined {
  return BUILTIN_TRANSITIONS.find((t) => t.from === from && t.to === to);
}
