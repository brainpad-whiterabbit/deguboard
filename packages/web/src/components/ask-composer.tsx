import type { TerminalChoice } from "@deguboard/core";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { askKey, parseAskKey } from "../ask-key.js";
import { useHost, useUiState } from "../host.js";
import { canSend, resolveSendTarget, sentMessage, switchedMessage } from "../send-target.js";
import { useStore } from "../store.js";
import type { AskAction, AskFormat, AskView } from "../types.js";
import { language, tr, trCore, msg } from "../l10n.js";
import { trNode } from "../l10n-node.js";

/** 指示を打つ間、依頼文の取り直しを待つ時間（ミリ秒）。打つたびに ask を呼ばない */
export const ASK_NOTE_SETTLE_MS = 150;

/** 見た目の状態に残った形式。ask の形式として正しい値のときだけ返し、それ以外は未選択（undefined）にする */
export function chosenAskFormat(value: unknown): AskFormat | undefined {
  return value === "skill" || value === "text" ? value : undefined;
}

/** 見た目の状態の鍵 */
export const ASK_NOTE_KEY = "ask.note";
export const ASK_FORMAT_KEY = "ask.format";

const COPIED = msg("✓ コピーしました。エージェントの入力欄に貼ってください");

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

export function AskComposer({
  targets: initialTargets,
  action: initialAction,
  within,
  copyOnOpen = false,
  onClose,
}: {
  targets: readonly string[];
  /** 対象のチケットが入っている Iteration・Epic（詳細の中の行から開いたとき）。外すの候補が出る */
  within?: string | undefined;
  /** 選んで開く頼むこと（行・見出しの吹き出し）。省くか候補になければおすすめ */
  action?: AskAction | undefined;
  /** 開いたときに、選んだ頼むこと（action）の依頼文をそのままコピーする（一覧で選んで開いたとき。復元では false） */
  copyOnOpen?: boolean;
  onClose(): void;
}) {
  const store = useStore();
  const host = useHost();
  const { client } = store;
  const [targets, setTargets] = useState<string[]>(() => [...initialTargets]);
  // null はおすすめ（候補の先頭）
  const [picked, setPicked] = useState<AskAction | null>(initialAction ?? null);
  // null は人が選んでいない。ask に形式を渡さず、Skill が入っていなければ文章の形になる既定に任せる
  const [chosenFormat, setFormat] = useUiState<AskFormat | null>(ASK_FORMAT_KEY, null);
  const [note, setNote] = useUiState<string>(ASK_NOTE_KEY, "");
  const [full, setFull] = useState(false);
  // 対象だけで引いた結果（候補と札）。頼むことを選び直しても変わらない
  const [base, setBase] = useState<AskView | null>(null);
  // 頼むこと・指示・形式まで渡して引いた結果（全文）
  const [view, setView] = useState<AskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const terminals = useTerminals();
  const [terminalId, setTerminalId] = useState<number | null>(null);
  const sendTo = resolveSendTarget(terminals, terminalId);
  // 選んだターミナルが閉じたら、黙って替えず知らせる（描画の中で自分の state を直す。effect で直すと描画が 1 回余る）
  if (terminalId !== null && !terminals.some((t) => t.id === terminalId)) {
    setTerminalId(null);
    const next = resolveSendTarget(terminals, null);
    if (next) setResult({ ok: true, text: switchedMessage(next) });
  }
  const settledNote = useSettled(note, ASK_NOTE_SETTLE_MS);

  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  // 一覧が読み直されたら（Status が変わったかもしれない）候補も引き直す。対象は並びの文字列で見る（同じ並びなら引き直さない）。
  // この 2 つの読み込みは useCommandData を使わない：失敗したら前の結果を消し、エラーを全文の読み込みと 1 つの欄で分け合うため
  const targetsKey = askKey(targets);
  useEffect(() => {
    let alive = true;
    client
      .run<AskView>("ask", { targets: parseAskKey(targetsKey).targets, within } satisfies AskInput)
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
      targets: parseAskKey(targetsKey).targets,
      within,
      action: action ?? undefined,
      note: settledNote,
      format: chosenFormat ?? undefined,
    };
    client
      .run<AskView>("ask", input)
      .then((r) => alive && (setView(r.data), setError(null)))
      .catch((e: unknown) => alive && (setView(null), setError(messageOf(e))));
    return () => {
      alive = false;
    };
  }, [client, base, targetsKey, within, action, settledNote, chosenFormat]);

  const chosen = action ?? base?.candidates[0]?.action ?? null;
  // 出している形式。人が選んでいなければ、形式を渡さずに引いた結果の既定
  const format = chosenFormat ?? base?.format ?? null;
  const candidate = base?.candidates.find((c) => c.action === chosen) ?? null;
  const shown = view && view.action === chosen ? view : null;

  // 選んで開いたときは、開くと同時にコピーする（指示を足さないことが多い）。開いた 1 回だけ
  const copiedOnOpen = useRef(false);
  const copySeq = useRef(0);
  // 最新の copy を ref で持つ。effect は引き直しのたびに再実行されても、copiedOnOpen で 1 回だけ呼ぶ
  const copyRef = useRef<(pick: AskAction | null) => Promise<void>>(async () => {});
  useEffect(() => {
    copyRef.current = copy;
  });
  useEffect(() => {
    // 候補が引けてから、選んだ頼むこと（候補にあれば）でコピーする。候補になければおすすめ
    if (!copyOnOpen || !initialAction || !base || copiedOnOpen.current) return;
    copiedOnOpen.current = true;
    void copyRef.current(
      initialAction && base.candidates.some((c) => c.action === initialAction)
        ? initialAction
        : null,
    );
  }, [base, copyOnOpen, initialAction]);

  /** 今の指示で引き直してからコピーする（待っている間に打った分も入れる）。pick は選んだ直後の頼むこと（まだ state に入っていない） */
  async function copy(pick: AskAction | null = action) {
    // 注意：ブラウザ（Safari など）は await の後のクリップボード書き込みを、操作の直後でないとして拒むことがある。拒まれたら下の理由を出す
    await deliver(
      pick,
      async (text) => {
        await host.copy(text);
        return tr(COPIED);
      },
      tr("コピーできない"),
    );
  }

  /** 今の指示で引き直してから、選んだターミナルの入力に送る。Enter は押さない */
  async function send() {
    const target = sendTo;
    if (!target || !host.terminals) return;
    const terminalsHost = host.terminals;
    await deliver(
      action,
      async (text) => {
        const sent = await terminalsHost.send(target.id, text);
        return sentMessage(target, {
          multiline: text.includes("\n"),
          clipboardKept: sent?.clipboardKept ?? false,
        });
      },
      tr("送れない"),
    );
  }

  /** 依頼文を引き直し、sink に渡して、知らせを出す。並んで走ったときは最後に押した 1 回だけ渡す（古い方が後で上書きしない） */
  async function deliver(
    pick: AskAction | null,
    sink: (text: string) => Promise<string>,
    failure: string,
  ) {
    const mine = ++copySeq.current;
    setResult(null);
    try {
      const r = await client.run<AskView>("ask", {
        targets,
        within,
        action: pick ?? undefined,
        note,
        format: chosenFormat ?? undefined,
      } satisfies AskInput);
      if (mine !== copySeq.current) return;
      setView(r.data);
      setError(null);
      const message = await sink(r.data.text);
      if (mine !== copySeq.current) return;
      setResult({ ok: true, text: message });
    } catch (e) {
      if (mine !== copySeq.current) return;
      setResult({ ok: false, text: `${failure}: ${messageOf(e)}` });
    }
  }

  function removeTarget(id: string) {
    copySeq.current++;
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
    <section className="ask-composer" aria-label={tr("エージェントに頼む")} onKeyDown={onKeyDown}>
      <div className="ask-head">
        <div className="ask-suggestions" role="group" aria-label={tr("頼むこと")}>
          {(base?.candidates ?? []).map((c) => (
            <button
              key={c.action}
              type="button"
              className="ask-suggestion"
              aria-pressed={c.action === chosen}
              title={c.skill ?? tr("Skill を使わない")}
              onClick={() => {
                setPicked(c.action);
                setResult(null);
                noteRef.current?.focus();
                // 選び直したら、その依頼文をコピーする
                void copy(c.action);
              }}
            >
              {c.recommended ? (
                <span className="ask-star" aria-label={tr("おすすめ")}>
                  ★
                </span>
              ) : null}
              {trCore(c.label, c.action)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ask-close"
          aria-label={tr("閉じる")}
          title={tr("閉じる（Esc）")}
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
              <span key={t.id} className="ask-pill ask-pill-target" title={targetLine(t)}>
                {t.id} <small>{trCore(t.sub)}</small>
                <button
                  type="button"
                  aria-label={tr("{0} を外す", t.id)}
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
          aria-label={tr("指示")}
          placeholder={
            candidate && !candidate.skill ? tr("頼むことを書く") : tr("指示を足す（なくてもよい）")
          }
          value={note}
          onChange={(e) => {
            copySeq.current++;
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
        {canSend(terminals) && sendTo ? (
          <div className="ask-send-row">
            <span className="muted">{tr("送り先")}</span>
            <select
              className="ask-terminal"
              aria-label={tr("送り先のターミナル")}
              title={tr("依頼文を入れるターミナル（開いているものから選ぶ。起動はしない）")}
              value={sendTo.id}
              onChange={(e) => {
                setTerminalId(Number(e.target.value));
                setResult(null);
              }}
            >
              {terminals.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ask-send"
              title={tr("選んだターミナルの入力に依頼文を入れる（Enter は押さない）")}
              onClick={() => void send()}
              disabled={!base}
            >
              {tr("送る")}
            </button>
          </div>
        ) : null}
        <div className="ask-foot">
          <button
            type="button"
            className="ask-ghost"
            aria-expanded={full}
            onClick={() => setFull(!full)}
          >
            {tr("全文")}
          </button>
          <button
            type="button"
            className="ask-ghost"
            title={tr(
              "Skill の呼び出しか、Skill を使わない文章だけか。既定は dg の Skill がリポジトリか ~/.claude/skills にあれば Skill、なければ文章",
            )}
            disabled={!format}
            onClick={() => {
              copySeq.current++;
              setFormat(format === "skill" ? "text" : "skill");
            }}
          >
            {format === "text" ? tr("形式：文章") : tr("形式：Skill")}
          </button>
          <span className="spacer" />
          <span className="ask-keys muted">{COPY_KEYS}</span>
          <button
            type="button"
            className="primary ask-copy"
            onClick={() => void copy()}
            disabled={!base}
          >
            {trNode(
              "{0}コピー",
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
                <path d="M3.5 10.5h-1v-8h8v1" />
              </svg>,
            )}
          </button>
        </div>
      </div>
      {shown?.kind === "command" ? (
        <p className="ask-human muted">
          {trNode("{0}なので、人が打つコマンドをコピーする", humanReason(shown))}
        </p>
      ) : null}
      {full && shown ? (
        <pre className="ask-full" aria-label={tr("全文")}>
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

/** 開いているターミナル。ブラウザ（host.terminals がない）では常に空。開いた・閉じたの通知で更新する */
function useTerminals(): TerminalChoice[] {
  const { terminals } = useHost();
  const [list, setList] = useState<TerminalChoice[]>([]);
  useEffect(() => {
    if (!terminals) return;
    let alive = true;
    // 通知が先に届いたら、遅れて返った最初の一覧で上書きしない
    let notified = false;
    const off = terminals.onChange((next) => {
      notified = true;
      if (alive) setList(next);
    });
    terminals
      .list()
      .then((next) => alive && !notified && setList(next))
      .catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }, [terminals]);
  return list;
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

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 人が打つコマンドを返した理由。actor.human_only の操作と、Workflow の by が人に限る遷移 */
function humanReason(view: AskView): string {
  const reasons: string[] = [];
  if (view.human_only.length > 0)
    reasons.push(tr("{0} は人に限った操作（actor.human_only）", view.human_only.join(tr("・"))));
  if (view.workflow_by.length > 0)
    reasons.push(tr("{0} は Workflow が人に限った遷移（by）", view.workflow_by.join(tr("・"))));
  return reasons.join(tr("、"));
}

/**
 * 対象の札のツールチップ。日本語では core の line をそのまま出し、英語では同じ中身（ID・タイトル・Status・Iteration）を
 * 英語の区切りで組む（core の line は日本語の括弧と「Iteration なし」を含むため）。タイトルは訳さない
 */
function targetLine(t: AskView["targets"][number]): string {
  if (language() === "ja") return t.line;
  switch (t.kind) {
    case "ticket":
      return `${t.id} "${t.title}" (${t.status}, ${t.iteration ?? tr("Iteration なし")})`;
    case "iteration":
      return `Iteration ${t.id} "${t.title}" (${t.status})`;
    case "epic":
      return `Epic ${t.id} "${t.title}" (${t.status})`;
    case "plan":
      return `Plan ${t.id} (${[trCore(t.sub), t.tickets.join(" ")].filter(Boolean).join(", ")})`;
  }
}
