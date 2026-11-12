// 同期の競合で止まったときの通知の中身（SY-4）。VS Code の API に触れない純粋な処理。extension.ts の syncFolder と notifySync から呼ぶ。
// 型と値の書き方（ResolveSide・ConflictField・ResolvedFile・showValue・fieldLabel）は core のものを使い、写さない

import {
  type ConflictField,
  fieldLabel,
  type ResolvedFile,
  type ResolveSide,
  showValue,
} from "@deguboard/core";
import { t } from "./l10n.js";

/** dg sync の data のうち、通知に使う部分（競合したフィールドと --resolve で解いたフィールド） */
interface SyncData {
  conflict_fields?: ConflictField[];
  resolved?: ResolvedFile[];
}

export interface ResolveChoice {
  side: ResolveSide;
  label: string;
}

/** 同期の結果の通知。warning は警告（choices があればボタン付き）、info は採った値と捨てた値の知らせ */
export interface SyncNotice {
  warning?: { message: string; choices: ResolveChoice[] };
  info?: string;
}

/** 通知に出すボタン。押した側で `dg sync --resolve` を 1 回呼ぶ */
export function resolveChoices(): ResolveChoice[] {
  return [
    { side: "remote", label: t("Take remote") },
    { side: "local", label: t("Take local") },
  ];
}

/**
 * sync の結果から通知を決める。警告があれば警告にする。ぶつかったフィールドがあり --resolve でないときだけボタンを付ける
 * （--resolve の結果にはもう付けない）。--resolve のときは採った値と捨てた値を info にする
 */
export function syncNotice(
  warnings: string[],
  data: unknown,
  resolve: ResolveSide | undefined,
): SyncNotice {
  const notice: SyncNotice = {};
  if (warnings.length > 0) {
    const choices = !resolve && hasResolvableFields(data) ? resolveChoices() : [];
    notice.warning = { message: `deguboard: ${warnings.join(" / ")}`, choices };
  }
  const summary = resolve ? resolvedSummary(resolve, data) : undefined;
  if (summary) notice.info = `deguboard: ${summary}`;
  return notice;
}

/** 押されたボタンの文字列から、その側を返す（押されなかった・知らない文字列なら undefined）。押した側で同期をやり直す */
export function pickedSide(
  choices: readonly ResolveChoice[],
  picked: string | undefined,
): ResolveSide | undefined {
  return choices.find((c) => c.label === picked)?.side;
}

/** dg sync の data から通知に使う部分を取る。data がないときは空 */
function syncDataOf(data: unknown): SyncData {
  return (data ?? {}) as SyncData;
}

/** dg sync の data.conflict_fields が 1 件でもあれば、ボタンを出せる（ドライバの対象のフィールドがぶつかっている） */
export function hasResolvableFields(data: unknown): boolean {
  const fields = syncDataOf(data).conflict_fields;
  return Array.isArray(fields) && fields.length > 0;
}

/** dg sync --resolve の data.resolved を、採った値と捨てた値の通知の文にする。1 件もなければ undefined */
export function resolvedSummary(side: ResolveSide, data: unknown): string | undefined {
  const resolved = syncDataOf(data).resolved;
  if (!Array.isArray(resolved) || resolved.length === 0) return undefined;
  const items = resolved.map((r) =>
    t(
      "{0} {1}: took {2}, discarded {3}",
      r.file,
      fieldLabel(r.field),
      showValue(r.taken),
      showValue(r.discarded),
    ),
  );
  return t("Resolved by taking {0}: {1}", side, items.join("; "));
}
