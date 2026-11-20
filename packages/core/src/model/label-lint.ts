// dg lint のラベルの指摘：語彙（labels.yaml）・軸（labels.axes）・チケットのラベルのずれ（requirements.md TK-3、ADR-037）。
// 意味が重なるかはエージェントが点検で判断するので、ここは数えて指摘するだけにする。git もファイルも読まない（読むのは commands/setup.ts の lint）

import type { LabelAxis } from "./config.js";
import { labelListView, type Vocabulary } from "./labels.js";

/**
 * 手順が付けるラベルの接頭辞（dg guide audit の audit-<S>、retro の retro-<S>、release の release-<S>）。
 * 手順が読み書きする印で、軸に沿う語彙ではないので、語彙にない名前として指摘しない
 */
export const PROCEDURE_LABEL_PREFIXES = ["audit-", "retro-", "release-"] as const;

/** 手順が付けるラベルか。対象のない見直しは接頭辞のない audit を付ける（dg guide audit）ので、それも含める */
export function isProcedureLabel(name: string): boolean {
  return name === "audit" || PROCEDURE_LABEL_PREFIXES.some((p) => name.startsWith(p));
}

/** ラベルの指摘の 1 件。ticket があるものはそのチケットの指摘、ないものは語彙（labels.yaml）の指摘 */
export interface LabelFinding {
  code:
    | "lint_label_undefined"
    | "lint_label_unused"
    | "lint_label_case"
    | "lint_label_axis_unknown"
    | "lint_label_axis_multiple"
    | "lint_label_merged";
  ticket?: string;
  message: string;
}

/** 軸を 2 つ以上付けてはいけない（作業の途中の）Status。done・abandoned は終わったチケットなので直さない */
const OPEN_STATUSES = new Set(["todo", "in_progress", "review"]);

/**
 * 軸・語彙・チケット・Iteration から、ラベルのずれの指摘を出す。軸が書いていない・`[]` のボードは仕組みがオフなので何も出さない。
 * - 語彙にない名前は、名前ごとに 1 件、付いたチケットの数を添える（軸を初めて書いた直後に、チケットごとの指摘で膨らまないように）。
 *   手順が付けるラベルと、統合済みの名前（別の指摘で出す）は除く
 * - 使われていない語彙：付いたチケットがないもの。1 件にしか付いていないものは、語彙の created_at より後に閉じた Iteration が
 *   1 つ以上あるものだけ（足したばかりで育つ途中の語彙は指摘しない）
 * - 大文字と小文字だけが違う名前（語彙と、チケットに付いた名前をあわせて見る。統合の記録は除く）
 * - どの軸にもない語彙（labels.axes にない軸を指す）
 * - todo・in_progress・review のチケットで、同じ軸の語彙が 2 個以上付いたもの
 * - 統合済みの名前が付いたチケット（統合はチケットを書き換えるので、done・abandoned も残っていれば指摘する）
 */
export function labelLintFindings(
  axes: readonly LabelAxis[] | undefined,
  vocabulary: Vocabulary,
  tickets: Iterable<{ id: string; status: string; labels: readonly string[]; created_at: string }>,
  iterations: Iterable<{ closed_at?: string | undefined }>,
): LabelFinding[] {
  if (axes === undefined || axes.length === 0) return [];
  const list = [...tickets];
  const view = labelListView(axes, vocabulary, list, { undefined: true });
  const findings: LabelFinding[] = [];
  const mergedInto = (name: string) => vocabulary.get(name)?.merged_into;

  for (const u of view.undefined ?? []) {
    if (isProcedureLabel(u.name) || mergedInto(u.name) !== undefined) continue;
    findings.push({
      code: "lint_label_undefined",
      message: `The label ${u.name} is not in the vocabulary, but ${u.count} ticket(s) carry it`,
    });
  }

  const closedAt = [...iterations].flatMap((i) =>
    i.closed_at === undefined ? [] : [Date.parse(i.closed_at)],
  );
  for (const axis of view.axes) {
    if (axis.description === null)
      for (const l of axis.labels)
        findings.push({
          code: "lint_label_axis_unknown",
          message: `The label ${l.name} belongs to the axis ${axis.name}, which is not in labels.axes`,
        });
    for (const l of axis.labels) {
      if (l.count === 0)
        findings.push({
          code: "lint_label_unused",
          message: `No ticket carries the label ${l.name}`,
        });
      else if (l.count === 1) {
        const created = Date.parse(l.created_at);
        const since = closedAt.filter((c) => c > created).length;
        if (since > 0)
          findings.push({
            code: "lint_label_unused",
            message: `Only 1 ticket carries the label ${l.name}, and ${since} Iteration(s) closed after it was added`,
          });
      }
    }
  }

  // 大文字と小文字だけが違う名前。統合の記録は語彙として使わないので見ない（付いていれば統合済みの名前の指摘になる）
  const names = new Set<string>();
  for (const [name, e] of vocabulary) if (e.merged_into === undefined) names.add(name);
  for (const t of list) for (const name of t.labels) names.add(name);
  const folded = new Map<string, string[]>();
  for (const name of names) {
    const key = name.toLowerCase();
    folded.set(key, [...(folded.get(key) ?? []), name]);
  }
  for (const group of folded.values())
    if (group.length >= 2)
      findings.push({
        code: "lint_label_case",
        message: `The labels ${group.sort().join(", ")} differ only in case`,
      });

  for (const t of list) {
    const labels = [...new Set(t.labels)];
    if (OPEN_STATUSES.has(t.status)) {
      const byAxis = new Map<string, string[]>();
      for (const name of labels) {
        const e = vocabulary.get(name);
        if (e === undefined || e.merged_into !== undefined) continue;
        byAxis.set(e.axis, [...(byAxis.get(e.axis) ?? []), name]);
      }
      for (const [axis, carried] of byAxis)
        if (carried.length >= 2)
          findings.push({
            code: "lint_label_axis_multiple",
            ticket: t.id,
            message: `Carries ${carried.length} labels of the axis ${axis} (${carried.join(", ")})`,
          });
    }
    for (const name of labels) {
      const into = mergedInto(name);
      if (into !== undefined)
        findings.push({
          code: "lint_label_merged",
          ticket: t.id,
          message: `Carries the label ${name}, which was merged into ${into}`,
        });
    }
  }
  return findings;
}
