// チケット詳細（UI-4）。本文（概要・受け入れ条件）、属性、Epic、依存先と依存元、作業ブランチ、Run の一覧と、経過（deguboard ブランチの履歴）。
// 属性と本文を編集でき、Status は ticket.move と同じ検査を通る。
// Status の選択・表示名と任意フィールドは、チケット自身の Workflow（なければ Project の既定）で決める。
// VS Code のパネルでは、タイトルの下に Status・優先度・Iteration・担当・PR の 1 行と編集のボタンを置いてスクロールしても上に残す。
// パネルでは依存先が終わっていなければ本文の上の帯で知らせる。
// 右の列（属性）は、パネルが components/ticket-props-panel.tsx（値を押してその場で直す）、ブラウザが components/ticket-props-browser.tsx。
// パネルの編集のボタンはタイトルと本文だけを入力欄にし、ブラウザでは編集のボタンでタイトル・本文・属性をまとめて直す。
// 本文の受け入れ条件のチェックボックスは、押すとその項目だけを ticket.check で付け外しする（読んだ本文を base に渡し、間に書き込みがあれば拒否されて戻す）

import { useEffect, useState } from "react";
import { useCommandData } from "../command-data.js";
import { ASK_SECTIONS, AskSpotBox } from "../components/ask-menu.js";
import { StatusDot, PriorityMark, TicketLink } from "../components/parts.js";
import { attrPatchOf, BrowserProps } from "../components/ticket-props-browser.js";
import { PanelProps } from "../components/ticket-props-panel.js";
import { draftOf, PrLink, type Draft } from "../components/ticket-props.js";
import { TicketRuns } from "../components/ticket-runs.js";
import { TicketTimeline } from "../components/timeline.js";
import { useHost } from "../host.js";
import { Markdown, type AcceptanceToggle } from "../markdown.js";
import { hrefOf } from "../router.js";
import { useStore, type Store } from "../store.js";
import type { Status, TicketDetail, WorkflowView } from "../types.js";

/**
 * チケットの Workflow。チケットの workflow、なければ Project の既定で、core の requireWorkflowFor と同じ解決にする。
 * 一覧が読んだ Project の既定（store.workflow）と同じなら引き直さない。別の Workflow は読み終えるまで null。
 * 読めなければ理由を通知に出し、null のまま（パネルの Status の選択は今の Status だけで、任意フィールドも出さない）。
 * useCommandData は使わない：失敗を画面のエラーでなく通知に出し、一覧の読み直しでは引き直さない（Workflow の定義はチケットの書き込みで変わらない）
 */
function useTicketWorkflow(store: Store, ticket: TicketDetail | null): WorkflowView | null {
  const id = ticket
    ? (ticket.workflow ?? store.projects.find((p) => p.id === ticket.project)?.workflow)
    : undefined;
  const other = id !== undefined && id !== store.project?.workflow ? id : null;
  const [loaded, setLoaded] = useState<{ id: string; view: WorkflowView } | null>(null);
  const { client, notify } = store;
  useEffect(() => {
    if (!other) return;
    let alive = true;
    client
      .run<WorkflowView>("workflow.show", { workflow: other })
      .then((r) => alive && setLoaded({ id: other, view: r.data }))
      .catch(
        (e: unknown) =>
          alive &&
          notify({
            kind: "error",
            text: `Workflow ${other} を読めない`,
            detail: e instanceof Error ? e.message : String(e),
          }),
      );
    return () => {
      alive = false;
    };
  }, [other, client, notify]);
  if (!other) return store.workflow;
  return loaded?.id === other ? loaded.view : null;
}

export function TicketPage({ id }: { id: string }) {
  const store = useStore();
  const host = useHost();
  const panel = host.surface === "panel";
  // 一覧（store.tickets）が読み直されたら本文も読み直す
  const {
    data: ticket,
    error,
    setData: setTicket,
  } = useCommandData<TicketDetail>("ticket.show", { ticket: id });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingCheck, setPendingCheck] = useState<AcceptanceToggle["pending"]>(null);
  const workflow = useTicketWorkflow(store, ticket);
  const fields = workflow?.definition.fields ?? [];
  /** このチケットの Status の表示名（依存先・依存元はそれぞれの一覧の表示名のまま） */
  const labelOf = (s: Status) => workflow?.labels[s] ?? store.labelOf(s);

  if (error) return <p className="error">{error}</p>;
  if (!ticket) return <p className="muted">読み込み中…</p>;

  // パネルの編集はタイトルと本文だけ。ブラウザは属性もまとめて渡す
  const save = async () => {
    if (!draft) return;
    const r = await store.run("ticket.update", {
      ticket: ticket.id,
      title: draft.title,
      body: draft.body,
      ...(panel ? {} : attrPatchOf(draft, fields)),
    });
    if (r.ok) setDraft(null);
  };

  // 押した印を先に出して保存を待つ。拒否されたら印を戻し（理由は store.run が通知に出す）、今の本文を読み直す
  const toggleCheck = async (index: number, checked: boolean) => {
    setPendingCheck({ index, checked });
    const r = await store.run<{ body: string; updated_at: string }>("ticket.check", {
      ticket: ticket.id,
      items: [index],
      undo: !checked,
      base: ticket.body,
    });
    if (r.ok) {
      const { body, updated_at } = r.data;
      setTicket((prev) => (prev ? { ...prev, body, updated_at } : prev));
    }
    setPendingCheck(null);
    if (!r.ok) await store.reload();
  };

  const editButtons = draft ? (
    <>
      <button type="button" className="primary" onClick={() => void save()}>
        保存
      </button>
      <button type="button" onClick={() => setDraft(null)}>
        取り消し
      </button>
    </>
  ) : (
    <button
      type="button"
      title={panel ? "タイトルと本文を編集" : undefined}
      onClick={() => setDraft(draftOf(ticket, fields))}
    >
      編集
    </button>
  );

  // タイトルの横の吹き出しで、このチケットをエージェントに頼む（UI-15）。題を直している間は吹き出しを出さない
  const header = (
    <AskSpotBox
      as="header"
      className="ask-title"
      targets={[ticket.id]}
      label={`タイトル ${ticket.id}`}
      section={ASK_SECTIONS.detailTitle}
      pinned
      bubble={!draft}
    >
      <code>{ticket.id}</code>
      {draft ? (
        <input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          aria-label="タイトル"
          style={{ flex: 1 }}
        />
      ) : (
        <h1>{ticket.title}</h1>
      )}
    </AskSpotBox>
  );

  return (
    <section className="detail">
      <div className="detail-main">
        {panel ? (
          // 見出しの帯。表示だけで、Status を変えるのは右の列の選択
          <div className="detail-head">
            {header}
            <div className="detail-meta">
              <span className="detail-meta-status">
                <StatusDot status={ticket.status} label={labelOf(ticket.status)} />
                {labelOf(ticket.status)}
              </span>
              <PriorityMark priority={ticket.priority} />
              {ticket.iteration ? (
                <a href={hrefOf({ page: "iterations", id: ticket.iteration })}>
                  {ticket.iteration}
                </a>
              ) : null}
              {ticket.assignee ? <span>{ticket.assignee}</span> : null}
              {ticket.pr ? <PrLink pr={ticket.pr} webUrl={store.status?.web_url} /> : null}
              <div className="actions header-actions">{editButtons}</div>
            </div>
          </div>
        ) : (
          header
        )}
        {panel && ticket.pending_deps.length > 0 ? (
          <p className="notice info deps-band" role="status">
            <span>
              依存先が終わっていない：
              {ticket.pending_deps.map((d) => (
                <span key={d.id} className="deps-band-item">
                  {d.status ? <StatusDot status={d.status} /> : null}
                  <TicketLink id={d.id}>
                    <code>{d.id}</code>
                  </TicketLink>
                  {d.status ? store.labelOf(d.status) : null}
                </span>
              ))}
            </span>
          </p>
        ) : null}
        {draft ? (
          <textarea
            className="body"
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            aria-label="本文"
          />
        ) : (
          <Markdown
            body={ticket.body}
            toggle={{ onToggle: (i, c) => void toggleCheck(i, c), pending: pendingCheck }}
          />
        )}
        {panel ? null : <div className="actions">{editButtons}</div>}
        <TicketRuns id={ticket.id} />
        <TicketTimeline id={ticket.id} />
      </div>
      <aside>
        {panel ? (
          <PanelProps
            store={store}
            ticket={ticket}
            fields={fields}
            workflow={workflow}
            labelOf={labelOf}
            setTicket={setTicket}
          />
        ) : (
          <BrowserProps
            store={store}
            ticket={ticket}
            fields={fields}
            labelOf={labelOf}
            draft={draft}
            setDraft={setDraft}
          />
        )}
      </aside>
    </section>
  );
}
