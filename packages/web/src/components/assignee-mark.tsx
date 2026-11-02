// 左パネルのカンバンの行の担当の印（UI-2）。人は頭文字の丸、agent は持ち主の頭文字の丸と agent の種類のアイコンを並べる。
// agent の種類はチケットの Run の agent（ticket.list の run_agent。RN-1）から決める。
// アイコンは各社のロゴや商標の画像を使わず、自前の文字の札（C・X）と図形（汎用）で描く（Anthropic の商標の決まりは事前の承認を求めるため）

/** agent のアイコンの種類。claude は Run の agent が claude-code、codex は codex、generic はそれ以外か Run がない */
export type AgentIconKind = "claude" | "codex" | "generic";

/** 担当の印に出すもの */
export interface AssigneeMarkView {
  /** 持ち主の人（agent なら持ち主）の頭文字。大文字にする */
  initial: string;
  /** agent の担当ならアイコンの種類、人の担当なら null */
  agent: AgentIconKind | null;
  /** ホバーで読む文：人は主体 ID、agent は「主体 ID · Run の agent」（Run がなければ「Run なし」） */
  title: string;
}

const AGENT_SUFFIX = "/agent";

/** Run の agent の名前からアイコンの種類を決める */
export function agentIconKind(runAgent: string | null | undefined): AgentIconKind {
  if (runAgent === "claude-code") return "claude";
  if (runAgent === "codex") return "codex";
  return "generic";
}

/** 担当の主体 ID（eiki・eiki/agent）と Run の agent から印を決める。担当がなければ null */
export function assigneeMarkOf(
  assignee: string | undefined,
  runAgent: string | null | undefined,
): AssigneeMarkView | null {
  if (!assignee) return null;
  const isAgent = assignee.endsWith(AGENT_SUFFIX);
  const user = isAgent ? assignee.slice(0, -AGENT_SUFFIX.length) : assignee;
  const initial = (Array.from(user)[0] ?? "?").toUpperCase();
  if (!isAgent) return { initial, agent: null, title: assignee };
  return {
    initial,
    agent: agentIconKind(runAgent),
    title: `${assignee} · ${runAgent ?? "Run なし"}`,
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

/** agent の種類のアイコン。Claude Code は「C」、Codex は「X」の文字の札、それ以外は汎用の図形 */
function AgentIcon({ kind }: { kind: AgentIconKind }) {
  return (
    <span className={`agent-icon agent-${kind}`} data-agent={kind}>
      {kind === "claude" ? "C" : kind === "codex" ? "X" : <GenericAgentIcon />}
    </span>
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
      {view.agent ? <AgentIcon kind={view.agent} /> : null}
    </span>
  );
}
