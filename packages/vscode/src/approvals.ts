// 承認待ちの件数と通知（UI-12）。承認待ちの Plan（pending）と review のチケットを数え、前に見た集合と比べて増えた分を知らせる。
// VS Code の API に触れない部分で、extension.ts から呼ぶ

import { routeOfId } from "./ids.js";
import { t } from "./l10n.js";

/** 承認待ちの 1 件。Plan は承認待ち、チケットは review */
export interface ApprovalItem {
  kind: "plan" | "ticket";
  id: string;
  /** チケットのタイトル。Plan にはタイトルがない */
  title?: string;
}

/** 承認待ちの Plan と review のチケットの ID を並べる（Plan が先）。数えるだけで、状態の判定は呼び出し側の絞り込みに任せる */
export function approvalItems(
  plans: { id: string }[],
  tickets: { id: string; title?: string }[],
): ApprovalItem[] {
  return [
    ...plans.map((p): ApprovalItem => ({ kind: "plan", id: p.id })),
    ...tickets.map((t): ApprovalItem => ({
      kind: "ticket",
      id: t.id,
      ...(t.title ? { title: t.title } : {}),
    })),
  ];
}

/**
 * 前に見た ID の集合になかったものを返す。通知の元になる。
 * 前の集合がない（起動して初めて読めたとき）は、今あるものを知らせず基準にするだけなので空を返す。
 * 件数でなく ID で比べるので、1 件減って別の 1 件が増えたときも知らせ、読み直しで同じものを重ねて知らせない
 */
export function newApprovals(previous: ReadonlySet<string> | undefined, now: ApprovalItem[]) {
  if (previous === undefined) return [];
  return now.filter((i) => !previous.has(i.id));
}

/**
 * サイドバーのビューのタイトル。承認待ちがあれば「承認待ち 3」、なければ "deguboard"（Activity Bar のバッジは未 push・未取り込み用なので使わない）。
 * コンテナとビューが 1 つずつのとき VS Code は見出しを「コンテナ名: ビュー名」にするので、件数のときは名前を重ねない
 */
export function viewTitle(count: number): string {
  return count > 0 ? t("Awaiting Approval/Review {0}", count) : "deguboard";
}

/** 通知の文。複数なら先頭の 2 件の ID と残りの数を出す */
export function approvalMessage(items: ApprovalItem[]): string {
  const label = (i: ApprovalItem): string => (i.kind === "plan" ? `Plan ${i.id}` : i.id);
  const [first, second] = items.slice(0, 2).map(label);
  const head = second === undefined ? (first ?? "") : t("{0}, {1}", first ?? "", second);
  const ids = items.length > 2 ? t("{0} and {1} more", head, items.length - 2) : head;
  const kinds = new Set(items.map((i) => i.kind));
  // 種類ごとに文を分ける（語順が言語で違うので、「何が」だけを差し込まない）
  const text =
    kinds.size === 2
      ? t("New items awaiting approval or review ({0})", ids)
      : kinds.has("plan")
        ? t("New plans awaiting approval ({0})", ids)
        : t("New tickets awaiting review ({0})", ids);
  return `deguboard: ${text}`;
}

/** 通知から開く詳細のルート。形の違う ID は undefined */
export function approvalRoute(item: ApprovalItem): string | undefined {
  return routeOfId(item.id);
}
