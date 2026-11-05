import { AskSpotBox, type AskSection } from "./ask-menu.js";
import { TicketRow } from "./parts.js";
import { STATUSES, byPriorityThenNumber, isFinished, type Status, type Ticket } from "../types.js";
import { tr, msg } from "../l10n.js";

/** 一覧の段。未完了は開いたまま、完了と中止は既定で畳む。0 件の段は出さない */
export const TICKET_SECTIONS = [
  { key: "open", label: msg("未完了"), folded: false },
  { key: "done", label: msg("完了"), folded: true },
  { key: "abandoned", label: msg("中止"), folded: true },
] as const;

export type TicketSectionKey = (typeof TICKET_SECTIONS)[number]["key"];

export function sectionOf(status: Status): TicketSectionKey {
  return isFinished(status) ? status : "open";
}

/** 段の中の並び。Status の順（Workflow の並び）、同じ Status なら優先度と番号の順 */
export function sortByStatusThenPriority<T extends Ticket>(tickets: readonly T[]): T[] {
  const order = new Map<string, number>(STATUSES.map((s, i) => [s, i]));
  return [...tickets].sort(
    (a, b) => (order.get(a.status) ?? 0) - (order.get(b.status) ?? 0) || byPriorityThenNumber(a, b),
  );
}

/** チケットを段ごとにまとめる。0 件の段は含めない。段の中は sortByStatusThenPriority の順 */
export function groupBySection<T extends Ticket>(
  tickets: readonly T[],
): { section: (typeof TICKET_SECTIONS)[number]; items: T[] }[] {
  const sorted = sortByStatusThenPriority(tickets);
  return TICKET_SECTIONS.map((section) => ({
    section,
    items: sorted.filter((t) => sectionOf(t.status) === section.key),
  })).filter((g) => g.items.length > 0);
}

/**
 * チケットの一覧。未完了・完了・中止の段ごとに小見出しと件数を付け、行はサイドバーと同じ 1 行（TicketRow）。
 * 行の吹き出しで頼める。within に入っている Epic・Iteration を渡す。Ctrl/⌘・Shift+クリックで複数選べる（UI-15）
 */
export function TicketSections({
  tickets,
  within,
  section: askSection,
}: {
  tickets: readonly Ticket[];
  within: string;
  section: AskSection;
}) {
  return (
    <div className="ticket-sections">
      {groupBySection(tickets).map(({ section, items }) => (
        <details key={section.key} className="fold" open={!section.folded}>
          <summary>
            {section.label} <span className="muted">{items.length}</span>
          </summary>
          <ul className="rows">
            {items.map((t) => (
              <AskSpotBox
                key={t.id}
                as="li"
                targets={[t.id]}
                label={tr("行 {0}", t.id)}
                section={askSection}
                within={within}
                select
              >
                <TicketRow ticket={t} />
              </AskSpotBox>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
