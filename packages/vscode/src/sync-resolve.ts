// 同期の競合で止まったときの通知の選択肢（SY-4）。VS Code の API に触れない純粋な処理。extension.ts の syncFolder から呼ぶ

import { t } from "./l10n.js";

/** dg sync --resolve の側 */
export type ResolveSide = "remote" | "local";

/** sync --resolve の結果のうち、通知に使う形（dg sync の data.resolved の 1 件） */
interface ResolvedView {
  file: string;
  field: string;
  taken: unknown;
  discarded: unknown;
}

/** 通知に出す値の上限の字数。全体は dg sync の data にある */
const VALUE_LIMIT = 80;

function showValue(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}…` : text;
}

/** 通知に出すボタン。押した側で `dg sync --resolve` を 1 回呼ぶ */
export function resolveChoices(): Array<{ side: ResolveSide; label: string }> {
  return [
    { side: "remote", label: t("Take remote") },
    { side: "local", label: t("Take local") },
  ];
}

/** dg sync の data.conflict_fields が 1 件でもあれば、ボタンを出せる（ドライバの対象のフィールドがぶつかっている） */
export function hasResolvableFields(data: unknown): boolean {
  const fields = (data as { conflict_fields?: unknown } | null)?.conflict_fields;
  return Array.isArray(fields) && fields.length > 0;
}

/** dg sync --resolve の data.resolved を、採った値と捨てた値の通知の文にする。1 件もなければ undefined */
export function resolvedSummary(side: ResolveSide, data: unknown): string | undefined {
  const resolved = (data as { resolved?: unknown } | null)?.resolved;
  if (!Array.isArray(resolved) || resolved.length === 0) return undefined;
  const items = (resolved as ResolvedView[]).map((r) =>
    t(
      "{0} {1}: took {2}, discarded {3}",
      r.file,
      r.field,
      showValue(r.taken),
      showValue(r.discarded),
    ),
  );
  return t("Resolved by taking {0}: {1}", side, items.join("; "));
}
