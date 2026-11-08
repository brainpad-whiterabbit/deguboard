// 参照の整合（存在しない依存先・Epic・Iteration・Project・Workflow・Run のチケット）を指摘する。dg validate が使う

import { idNumber } from "../model/id.js";
import type { Issue } from "./issue.js";
import type { Store } from "./store.js";
import { cyclePath, eachCycle, type WaitEdge } from "./wait-cycle.js";

export function checkReferences(store: Store): Issue[] {
  const issues: Issue[] = [];
  const push = (path: string, id: string, code: string, message: string) =>
    issues.push({ severity: "error", code, path, id, message });

  for (const doc of store.projects.values()) {
    if (!store.workflows.has(doc.data.workflow)) {
      push(doc.path, doc.id, "workflow_missing", `既定の Workflow ${doc.data.workflow} がない`);
    }
  }
  for (const doc of store.tickets.values()) {
    const t = doc.data;
    if (!store.projects.has(t.project))
      push(doc.path, t.id, "project_missing", `Project ${t.project} がない`);
    if (!store.workflowFor(t))
      push(
        doc.path,
        t.id,
        "workflow_missing",
        `Workflow ${t.workflow ?? "(Project の既定)"} がない`,
      );
    for (const dep of t.depends_on) {
      if (dep === t.id) push(doc.path, t.id, "depends_on_self", "自分自身に依存している");
      else if (!store.tickets.has(dep))
        push(doc.path, t.id, "depends_on_missing", `依存先 ${dep} がない`);
    }
    if (t.epic) {
      const epic = store.epics.get(t.epic);
      if (!epic) push(doc.path, t.id, "epic_missing", `Epic ${t.epic} がない`);
      else if (epic.data.project !== t.project)
        push(doc.path, t.id, "epic_project", `Epic ${t.epic} は別の Project`);
    }
    if (t.iteration) {
      const it = store.iterations.get(t.iteration);
      if (!it) push(doc.path, t.id, "iteration_missing", `Iteration ${t.iteration} がない`);
      else if (it.data.project !== t.project)
        push(doc.path, t.id, "iteration_project", `Iteration ${t.iteration} は別の Project`);
    }
  }
  for (const doc of store.epics.values()) {
    if (!store.projects.has(doc.data.project))
      push(doc.path, doc.id, "project_missing", `Project ${doc.data.project} がない`);
  }
  for (const doc of store.iterations.values()) {
    if (!store.projects.has(doc.data.project))
      push(doc.path, doc.id, "project_missing", `Project ${doc.data.project} がない`);
  }
  for (const doc of store.runs.values()) {
    const t = doc.data.ticket;
    // 消したチケット（墓標）の Run は実績として残すので指摘しない
    if (!store.tickets.has(t) && !store.deletedTicketNumbers.has(idNumber(t)))
      push(doc.path, doc.id, "ticket_missing", `チケット ${t} がない`);
  }
  issues.push(...findDependencyCycles(store));
  return issues;
}

/** depends_on の循環（TK-2）。たどり方は Plan の待ちの循環と同じ（wait-cycle.ts）で、見つかった循環ごとに 1 件 */
function findDependencyCycles(store: Store): Issue[] {
  const issues: Issue[] = [];
  const edgesOf = (id: string) =>
    (store.tickets.get(id as `t${number}`)?.data.depends_on ?? []).map((to): WaitEdge => ({
      to,
      via: "depends_on",
    }));
  eachCycle(store.tickets.keys(), edgesOf, (cycle) => {
    issues.push({
      severity: "error",
      code: "depends_on_cycle",
      path: store.tickets.get(cycle.start as `t${number}`)?.path ?? "",
      id: cycle.start,
      message: `依存が循環している: ${cyclePath(cycle, false)}`,
    });
  });
  return issues;
}

/** depends_on に to を足したとき循環になるか（作成・更新時の拒否に使う） */
export function wouldCreateCycle(
  store: Store,
  ticketId: string,
  dependsOn: readonly string[],
): boolean {
  const seen = new Set<string>();
  const queue = [...dependsOn];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === ticketId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(store.tickets.get(id as `t${number}`)?.data.depends_on ?? []));
  }
  return false;
}
