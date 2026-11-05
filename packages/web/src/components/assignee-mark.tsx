// 左パネルのカンバン（UI-2）とバックログ（UI-3）の行の担当の印。人は頭文字の丸、agent は持ち主の頭文字の丸と agent のアイコンを並べる。
// agent のアイコンは Run の agent（claude-code・codex など）によらず汎用の図形 1 種にする。Run の agent はホバーの文で読む。
// 各社のロゴや商標の画像は使わない（Anthropic の商標の決まりは事前の承認を求めるため）

import { tr } from "../l10n.js";

/** 担当の印に出すもの */
export interface AssigneeMarkView {
  /** 持ち主の人（agent なら持ち主）の頭文字。大文字にする */
  initial: string;
  /** agent の担当なら true */
  agent: boolean;
  /** ホバーで読む文：人は主体 ID、agent は「主体 ID · Run の agent」（Run がなければ「Run なし」） */
  title: string;
}

/**
 * agent の主体 ID の末尾（eiki/agent）。core の model/actor.ts の AGENT_SUFFIX（actorIdOf が付ける）の写し
 * （web は core の実行時のコードを取り込まない）。同じ形であることを assignee-mark.test.tsx で確かめる
 */
const AGENT_SUFFIX = "/agent";

/** 担当の主体 ID（eiki・eiki/agent）と Run の agent から印を決める。担当がなければ null */
export function assigneeMarkOf(
  assignee: string | undefined,
  runAgent: string | null | undefined,
): AssigneeMarkView | null {
  if (!assignee) return null;
  const isAgent = assignee.endsWith(AGENT_SUFFIX);
  const user = isAgent ? assignee.slice(0, -AGENT_SUFFIX.length) : assignee;
  const initial = (Array.from(user)[0] ?? "?").toUpperCase();
  if (!isAgent) return { initial, agent: false, title: assignee };
  return {
    initial,
    agent: true,
    title: `${assignee} · ${runAgent ?? tr("Run なし")}`,
  };
}

/** 汎用のエージェントのアイコン：角の丸い頭と 2 つの目、上のアンテナ（各社のロゴに似せない単純な図形） */
function GenericAgentIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <line x1="6" y1="0.8" x2="6" y2="3" stroke="currentColor" strokeWidth="1.2" />
      <rect
        x="1.6"
        y="3"
        width="8.8"
        height="7.4"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx="4.4" cy="6.6" r="0.95" fill="currentColor" />
      <circle cx="7.6" cy="6.6" r="0.95" fill="currentColor" />
    </svg>
  );
}

/** 担当の印。担当がなければ何も出さない。ホバーで主体 ID と Run の agent を読める（title） */
export function AssigneeMark({
  assignee,
  runAgent,
}: {
  assignee: string | undefined;
  runAgent: string | null | undefined;
}) {
  const view = assigneeMarkOf(assignee, runAgent);
  if (!view) return null;
  return (
    <span className="assignee-mark" role="img" aria-label={view.title} title={view.title}>
      <span className="assignee-initial">{view.initial}</span>
      {view.agent ? (
        <span className="agent-icon">
          <GenericAgentIcon />
        </span>
      ) : null}
    </span>
  );
}
