// エージェントに頼む入力欄（UI-15・ADR-010）。左パネルとエディタのパネル（ブラウザでも）の下に出し、欄に書いたものがそのまま貼る文になる。
// 頼むことの候補・おすすめ・依頼文は core の ask コマンド（読み取りだけ）が決め、ここでは組み立て直さない。データには書き込まない。
// 上の 1 行が頼むことの候補（★ がおすすめ）、欄の頭が Skill と対象の札、本体が指示、下が全文・形式・コピー。
// 指示の下書きと形式は見た目の状態に残し、閉じて開き直しても消えない

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useHost, useUiState } from "../host.js";
import { useStore } from "../store.js";
import type { AskAction, AskFormat, AskTarget, AskView } from "../types.js";

/** 指示を打つ間、依頼文の取り直しを待つ時間（ミリ秒）。打つたびに ask を呼ばない */
export const ASK_NOTE_SETTLE_MS = 150;

/** 見た目の状態の鍵 */
export const ASK_NOTE_KEY = "ask.note";
export const ASK_FORMAT_KEY = "ask.format";

const COPIED = "✓ コピーしました。エージェントの入力欄に貼ってください";

/** ⌘↵（Mac）か Ctrl+↵（ほか）。押せるのはどちらでも同じ */
const COPY_KEYS =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? "⌘↵"
    : "Ctrl+↵";

interface AskInput {
  targets: string[];
  within?: string | undefined;
  action?: AskAction | undefined;
  note?: string | undefined;
  format?: AskFormat | undefined;
}

/** 札の小さな添え字。チケット・Iteration・Epic は Status、Plan は承認の状態 */
function subOf(t: AskTarget): string {
  if (t.kind === "plan")
    return t.status === "pending_approval"
      ? "承認待ち"
      : t.status === "closed"
        ? "閉じた"
        : "承認済み";
  return t.status;
}

export function AskComposer({
  targets: initialTargets,
  action: initialAction,
  within,
  onClose,
}: {
  targets: readonly string[];
  /** 対象のチケットが入っている Iteration・Epic（詳細の中の行から開いたとき）。外すの候補が出る */
  within?: string | undefined;
  /** 選んで開く頼むこと（行・見出しの吹き出しと右クリック）。省くか候補になければおすすめ */
  action?: AskAction | undefined;
  onClose(): void;
}) {
  const store = useStore();
  const host = useHost();
  const { client } = store;
  const [targets, setTargets] = useState<string[]>(() => [...initialTargets]);
  // null はおすすめ（候補の先頭）
  const [picked, setPicked] = useState<AskAction | null>(initialAction ?? null);
  const [format, setFormat] = useUiState<AskFormat>(ASK_FORMAT_KEY, "skill");
  const [note, setNote] = useUiState<string>(ASK_NOTE_KEY, "");
  const [full, setFull] = useState(false);
  // 対象だけで引いた結果（候補と札）。頼むことを選び直しても変わらない
  const [base, setBase] = useState<AskView | null>(null);
  // 頼むこと・指示・形式まで渡して引いた結果（全文）
  const [view, setView] = useState<AskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const settledNote = useSettled(note, ASK_NOTE_SETTLE_MS);

  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  // 一覧が読み直されたら（Status が変わったかもしれない）候補も引き直す。対象は並びの文字列で見る（同じ並びなら引き直さない）
  const targetsKey = targets.join(" ");
  useEffect(() => {
    let alive = true;
    client
      .run<AskView>("ask", { targets: splitKey(targetsKey), within } satisfies AskInput)
      .then((r) => alive && (setBase(r.data), setError(null)))
      .catch((e: unknown) => alive && (setBase(null), setError(messageOf(e))));
    return () => {
      alive = false;
    };
  }, [client, targetsKey, within, store.tickets]);

  // 選んだ頼むことが候補にない（開いた後に Status が変わったなど）ときは、おすすめに戻す
  const action = picked && base?.candidates.some((c) => c.action === picked) ? picked : null;
  useEffect(() => {
    if (!base) return;
    let alive = true;
    const input: AskInput = {
      targets: splitKey(targetsKey),
      within,
      action: action ?? undefined,
      note: settledNote,
      format,
    };
    client
      .run<AskView>("ask", input)
      .then((r) => alive && (setView(r.data), setError(null)))
      .catch((e: unknown) => alive && (setView(null), setError(messageOf(e))));
    return () => {
      alive = false;
    };
  }, [client, base, targetsKey, within, action, settledNote, format]);

  const chosen = action ?? base?.candidates[0]?.action ?? null;
  const candidate = base?.candidates.find((c) => c.action === chosen) ?? null;
  const shown = view && view.action === chosen ? view : null;

  /** 今の指示で引き直してからコピーする（待っている間に打った分も入れる） */
  async function copy() {
    setResult(null);
    try {
      const r = await client.run<AskView>("ask", {
        targets,
        within,
        action: action ?? undefined,
        note,
        format,
      } satisfies AskInput);
      setView(r.data);
      setError(null);
      await host.copy(r.data.text);
      setResult({ ok: true, text: COPIED });
    } catch (e) {
      setResult({ ok: false, text: `コピーできない: ${messageOf(e)}` });
    }
  }

  function removeTarget(id: string) {
    setTargets(targets.filter((t) => t !== id));
    // 頼むことの候補は対象で変わるので、おすすめに戻す
    setPicked(null);
    setResult(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }

  const skillPill = format === "skill" && shown?.kind !== "command" ? candidate?.skill : null;
  return (
    <section className="ask-composer" aria-label="エージェントに頼む" onKeyDown={onKeyDown}>
      <div className="ask-head">
        <div className="ask-suggestions" role="group" aria-label="頼むこと">
          {(base?.candidates ?? []).map((c) => (
            <button
              key={c.action}
              type="button"
              className="ask-suggestion"
              aria-pressed={c.action === chosen}
              title={c.skill ?? "Skill を使わない"}
              onClick={() => {
                setPicked(c.action);
                setResult(null);
                noteRef.current?.focus();
              }}
            >
              {c.recommended ? (
                <span className="ask-star" aria-label="おすすめ">
                  ★
                </span>
              ) : null}
              {c.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ask-close"
          aria-label="閉じる"
          title="閉じる（Esc）"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="ask-box">
        {skillPill || (base?.targets.length ?? 0) > 0 ? (
          <div className="ask-pills">
            {skillPill ? <span className="ask-pill ask-pill-skill">{skillPill}</span> : null}
            {(base?.targets ?? []).map((t) => (
              <span key={t.id} className="ask-pill ask-pill-target" title={t.line}>
                {t.id} <small>{subOf(t)}</small>
                <button
                  type="button"
                  aria-label={`${t.id} を外す`}
                  onClick={() => removeTarget(t.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={noteRef}
          rows={2}
          aria-label="指示"
          placeholder={
            candidate && !candidate.skill ? "頼むことを書く" : "指示を足す（なくてもよい）"
          }
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setResult(null);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void copy();
            }
          }}
        />
        <div className="ask-foot">
          <button
            type="button"
            className="ask-ghost"
            aria-expanded={full}
            onClick={() => setFull(!full)}
          >
            全文
          </button>
          <button
            type="button"
            className="ask-ghost"
            title="Skill の呼び出しか、Skill を使わない文章だけか"
            onClick={() => setFormat(format === "skill" ? "text" : "skill")}
          >
            {format === "skill" ? "形式：Skill" : "形式：文章"}
          </button>
          <span className="spacer" />
          <span className="ask-keys muted">{COPY_KEYS}</span>
          <button
            type="button"
            className="primary ask-copy"
            onClick={() => void copy()}
            disabled={!base}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
              <path d="M3.5 10.5h-1v-8h8v1" />
            </svg>
            コピー
          </button>
        </div>
      </div>
      {shown?.kind === "command" ? (
        <p className="ask-human muted">
          {shown.human_only.join("・")}{" "}
          は人に限った操作（actor.human_only）なので、人が打つコマンドをコピーする
        </p>
      ) : null}
      {full && shown ? (
        <pre className="ask-full" aria-label="全文">
          {shown.text}
        </pre>
      ) : null}
      {error ? <p className="ask-error error">{error}</p> : null}
      <p
        className={`ask-result${result && !result.ok ? " error" : ""}`}
        role="status"
        aria-live="polite"
      >
        {result?.text ?? ""}
      </p>
    </section>
  );
}

/** value が wait ミリ秒変わらなくなってからの値。最初の値はすぐ返す */
function useSettled<T>(value: T, wait: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), wait);
    return () => clearTimeout(timer);
  }, [value, wait]);
  return settled;
}

function splitKey(key: string): string[] {
  return key ? key.split(" ") : [];
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
