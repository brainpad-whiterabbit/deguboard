// エージェントに頼む入力欄（UI-15・ADR-027）。左パネルとエディタのパネルの下に出し、欄に書いたものがそのまま貼る文になる
// （VS Code の QuickPick と InputBox では指示が 1 行しか書けないので、画面の中に欄を作る）。
// 頼むことの候補・おすすめ・依頼文は core の ask コマンド（読み取りだけ）が決め、ここでは組み立て直さない。定型の文の言語は画面の表示言語を ask に渡して決める。データには書き込まない。
// 一番上が見出しの行（「頼む」・対象の札・閉じる ×）、その下が頼むことの候補の行、欄の頭が頼むことの 1 文（依頼文には入らない）で、
// 候補の行はおすすめ（青い点。RecDot）・選んでいる候補（おすすめと違うとき）・残りを開く「ほか N ▾」の 3 つまでにする（候補が 8 つほどあると
// 全部並べれば 2 段に折り返して小窓の上を取り、選んでいる候補も見分けにくい。小窓は行の吹き出しの一覧で選んでから開くことが多いので、残りは 1 手奥に置く）。
// 頭に Skill の札（枠線だけ。札とボタンのツールチップが Skill の 1 文）、本体が指示、下が全文・形式・空にするのアイコンのボタンとコピー。
// 塗りの色はコピーと送るのボタンだけに使う。コピーと送るの成功はボタンの中で数秒 ✓ に変えて知らせ（文は読み上げにだけ渡す）、小窓の高さを変えない。失敗は文で出す。
// 開いているターミナルがあれば（Webview だけ）、送り先を選んで「送る」でその入力に入れられる。Enter は押さず、ターミナルは起動しない。なければコピーだけ。
// 指示は開くたびに空で始まる（閉じるときの下書きは見た目の状態に残るが、開き直すと消す。再読み込みで開いていた小窓だけ残す）。
// 形式は見た目の状態に残し、閉じて開き直しても消えない。形式は人が切り替えるまで残さず、既定は ask が dg の Skill の有無から決める。
// 閉じるのは Esc・× と、小窓の外を押し始めたとき（下の effect）

import type { TerminalChoice } from "@deguboard/core";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { askKey, parseAskKey } from "../ask-key.js";
import { candidateTitle } from "../ask-candidate.js";
import { ASK_NOTE_KEY, useHost, useUiState } from "../host.js";
import { canSend, resolveSendTarget, sentMessage, switchedMessage } from "../send-target.js";
import { useStore } from "../store.js";
import type { AskAction, AskCandidate, AskFormat, AskView } from "../types.js";
import { language, tr, trCore, msg, type Language } from "../l10n.js";
import { trNode } from "../l10n-node.js";
import { PopupMenu, RecDot } from "./ask-menu.js";

/** 指示を打つ間、依頼文の取り直しを待つ時間（ミリ秒）。打つたびに ask を呼ばない */
export const ASK_NOTE_SETTLE_MS = 150;

/** 見た目の状態に残った形式。ask の形式として正しい値のときだけ返し、それ以外は未選択（undefined）にする */
export function chosenAskFormat(value: unknown): AskFormat | undefined {
  return value === "skill" || value === "text" ? value : undefined;
}

/** 見た目の状態の鍵（ASK_NOTE_KEY は host.tsx） */
export const ASK_FORMAT_KEY = "ask.format";

const COPIED = msg("✓ コピーしました。エージェントの入力欄に貼ってください");

/** コピーと送るのボタンを ✓ にしておく時間（ミリ秒） */
export const ASK_DONE_MS = 2000;

/** ⌘↵（Mac）か Ctrl+↵（ほか）。キーの印で出す。押せるのはどちらでも同じ */
const COPY_KEYS =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? "⌘ ↵"
    : "Ctrl ↵";

/** 知らせ。done はコピーと送るの成功で、ボタンの ✓ で見せ、文は読み上げにだけ渡す（高さを変えない）。ほかは文で出す */
interface AskResult {
  ok: boolean;
  text: string;
  done?: "copy" | "send";
}

/** アイコンのボタンの絵（16 の枠に線で描く） */
function Icon({ d, children }: { d?: string; children?: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {d ? <path d={d} /> : null}
      {children}
    </svg>
  );
}

interface AskInput {
  targets: string[];
  within?: string | undefined;
  place?: string | undefined;
  /** 設定の項目（設定画面の行から開いたとき）。core の ask の key */
  key?: string | undefined;
  action?: AskAction | undefined;
  note?: string | undefined;
  format?: AskFormat | undefined;
  /** 依頼文の定型の文の言語。画面の表示言語を渡す（指示とチケットの中身は書いた言葉のまま） */
  language?: Language | undefined;
}

export function AskComposer({
  targets: initialTargets,
  action: initialAction,
  within,
  place,
  item,
  copyOnOpen = false,
  onClose,
}: {
  targets: readonly string[];
  /** 対象のチケットが入っている Iteration・Epic（詳細の中の行から開いたとき）。外すの候補が出る */
  within?: string | undefined;
  /** 頼む場所（履歴の行・見出しなど）。場所によって候補が変わる */
  place?: string | undefined;
  /** 設定の項目（設定画面の行から開いたとき。commit.mode、retro.perspectives.spec）。対象は空で、候補と依頼文はその項目のものになる */
  item?: string | undefined;
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
  // 「ほか N ▾」の一覧を開いているときの、そのボタン（一覧はその下か上に開く）
  const [moreAt, setMoreAt] = useState<HTMLElement | null>(null);
  // 対象だけで引いた結果（候補と札）。頼むことを選び直しても変わらない
  const [base, setBase] = useState<AskView | null>(null);
  // 頼むこと・指示・形式まで渡して引いた結果（全文）
  const [view, setView] = useState<AskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);
  // ボタンを ✓ にしている成功（コピーか送る）。数秒で戻す。同じ成功が続いても時計を数え直すよう、回ごとに新しいオブジェクトにする
  const [done, setDone] = useState<{ which: "copy" | "send" } | null>(null);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), ASK_DONE_MS);
    return () => clearTimeout(timer);
  }, [done]);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLElement>(null);
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

  // 小窓の外で押し始めたら閉じる。外かどうかは押し始めた場所で決める（中で押して外で離したら閉じない）。
  // 閉じるだけで押した先の操作は止めない（行の詳細を開くなどはそのまま効く）。pointerdown は Webview の中でだけ起きるので、Webview の外へ移っても閉じない。
  // 頼むことの吹き出しや一覧（body に出る）を押すのも外なので閉じ、選んだ先で開き直す（指示は開くたびに空で始まる。host.tsx の AskProvider.open）
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  // 一覧が読み直されたら（Status が変わったかもしれない）候補も引き直す。対象は並びの文字列で見る（同じ並びなら引き直さない）。
  // この 2 つの読み込みは useCommandData を使わない：失敗したら前の結果を消し、エラーを全文の読み込みと 1 つの欄で分け合うため
  const targetsKey = askKey(targets);
  useEffect(() => {
    let alive = true;
    client
      .run<AskView>("ask", {
        targets: parseAskKey(targetsKey).targets,
        within,
        place,
        key: item,
        language: language(),
      } satisfies AskInput)
      .then((r) => alive && (setBase(r.data), setError(null)))
      .catch((e: unknown) => alive && (setBase(null), setError(messageOf(e))));
    return () => {
      alive = false;
    };
  }, [client, targetsKey, within, place, item, store.tickets]);

  // 選んだ頼むことが候補にない（開いた後に Status が変わったなど）ときは、おすすめに戻す
  const action = picked && base?.candidates.some((c) => c.action === picked) ? picked : null;
  useEffect(() => {
    if (!base) return;
    let alive = true;
    const input: AskInput = {
      targets: parseAskKey(targetsKey).targets,
      within,
      place,
      key: item,
      action: action ?? undefined,
      note: settledNote,
      format: chosenFormat ?? undefined,
      language: language(),
    };
    client
      .run<AskView>("ask", input)
      .then((r) => alive && (setView(r.data), setError(null)))
      .catch((e: unknown) => alive && (setView(null), setError(messageOf(e))));
    return () => {
      alive = false;
    };
  }, [client, base, targetsKey, within, place, item, action, settledNote, chosenFormat]);

  const chosen = action ?? base?.candidates[0]?.action ?? null;
  // 出している形式。人が選んでいなければ、形式を渡さずに引いた結果の既定
  const format = chosenFormat ?? base?.format ?? null;
  const candidate = base?.candidates.find((c) => c.action === chosen) ?? null;
  const shown = view && view.action === chosen ? view : null;
  // 行に出す候補はおすすめ（core が先頭に置く）と、それと違えば選んでいる候補。残りは「ほか N ▾」の一覧に元の順で出す
  const candidates = base?.candidates ?? [];
  const onRow = candidates.filter((c, n) => n === 0 || c.action === chosen);
  const rest = candidates.filter((c) => !onRow.includes(c));

  // 選んで開いたときは、開くと同時にコピーする（指示を足さないことが多い）。開いた 1 回だけで、復元（copyOnOpen が false）では勝手にコピーしない。選び直したときのコピーは下の選択の処理にある
  const copiedOnOpen = useRef(false);
  const copySeq = useRef(0);

  /** 依頼文を引き直し、sink に渡して、知らせを出す。並んで走ったときは最後に押した 1 回だけ渡す（古い方が後で上書きしない）。copy と send より前に置き、宣言の前に読まない（react(immutability)） */
  async function deliver(
    which: "copy" | "send",
    pick: AskAction | null,
    sink: (text: string) => Promise<string>,
    failure: string,
  ) {
    const mine = ++copySeq.current;
    setResult(null);
    setDone(null);
    try {
      const r = await client.run<AskView>("ask", {
        targets,
        within,
        place,
        key: item,
        action: pick ?? undefined,
        note,
        format: chosenFormat ?? undefined,
        language: language(),
      } satisfies AskInput);
      if (mine !== copySeq.current) return;
      setView(r.data);
      setError(null);
      const message = await sink(r.data.text);
      if (mine !== copySeq.current) return;
      setResult({ ok: true, text: message, done: which });
      setDone({ which });
    } catch (e) {
      if (mine !== copySeq.current) return;
      setResult({ ok: false, text: `${failure}: ${messageOf(e)}` });
    }
  }

  /** 今の指示で引き直してからコピーする（待っている間に打った分も入れる）。pick は選んだ直後の頼むこと（まだ state に入っていない） */
  async function copy(pick: AskAction | null = action) {
    // 注意：ブラウザ（Safari など）は await の後のクリップボード書き込みを、操作の直後でないとして拒むことがある。拒まれたら下の理由を出す
    await deliver(
      "copy",
      pick,
      async (text) => {
        await host.copy(text);
        return tr(COPIED);
      },
      tr("コピーできない"),
    );
  }

  // 最新の copy を ref で持つ。effect は引き直しのたびに再実行されても、copiedOnOpen で 1 回だけ呼ぶ。copy の宣言の後に置き、宣言の初期化の中で読まない（react(immutability)）
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

  /** 今の指示で引き直してから、選んだターミナルの入力に送る。Enter は押さない */
  async function send() {
    const target = sendTo;
    if (!target || !host.terminals) return;
    const terminalsHost = host.terminals;
    await deliver(
      "send",
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

  function removeTarget(id: string) {
    copySeq.current++;
    setTargets(targets.filter((t) => t !== id));
    // 頼むことの候補は対象で変わるので、おすすめに戻す
    setPicked(null);
    setResult(null);
    setMoreAt(null);
  }

  /** 頼むことを選び直す（行の候補か「ほか N」の一覧から）。選んだら、その依頼文をコピーする */
  function pick(c: AskCandidate) {
    setPicked(c.action);
    setResult(null);
    noteRef.current?.focus();
    void copy(c.action);
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }

  const skillPill = format === "skill" && shown?.kind !== "command" ? candidate?.skill : null;
  const formatName = format === "text" ? tr("形式：文章") : tr("形式：Skill");
  return (
    <section
      ref={rootRef}
      className="ask-composer"
      aria-label={tr("エージェントに頼む")}
      onKeyDown={onKeyDown}
    >
      <div className="ask-heading">
        <span className="ask-heading-label">
          <Icon d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
          {tr("頼む")}
        </span>
        <div className="ask-targets">
          {(base?.targets ?? []).map((t) => (
            <span key={t.id} className="ask-target" title={t.line}>
              <code>{t.id}</code>
              {/* 題のない対象（Plan）は承認の状態を出す。Status は札のツールチップ（line）で読める */}
              <span className="ask-target-title">{"title" in t ? t.title : trCore(t.sub)}</span>
              <button
                type="button"
                aria-label={tr("{0} を外す", t.id)}
                title={tr("{0} を外す", t.id)}
                onClick={() => removeTarget(t.id)}
              >
                ×
              </button>
            </span>
          ))}
          {/* 設定の項目から開いたとき（設定画面の行）は、その項目の key を札に出す（core の ask が返したまま。外せない） */}
          {base?.key ? (
            <span className="ask-target">
              <code>{base.key}</code>
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="ask-icon ask-close"
          aria-label={tr("閉じる")}
          title={tr("閉じる（Esc）")}
          onClick={onClose}
        >
          <Icon d="M4 4l8 8M12 4l-8 8" />
        </button>
      </div>
      <div className="ask-suggestions" role="group" aria-label={tr("頼むこと")}>
        {onRow.map((c) => (
          <button
            key={c.action}
            type="button"
            className="ask-suggestion"
            aria-pressed={c.action === chosen}
            title={candidateTitle(c, tr("Skill を使わない"))}
            onClick={() => pick(c)}
          >
            {c.recommended ? <RecDot /> : null}
            {trCore(c.label)}
          </button>
        ))}
        {rest.length > 0 ? (
          <button
            type="button"
            className="ask-suggestion ask-more"
            aria-haspopup="menu"
            aria-expanded={moreAt !== null}
            title={tr("ほかの頼むことを選ぶ")}
            onClick={(e) => setMoreAt(moreAt ? null : e.currentTarget)}
          >
            {tr("ほか {0}", rest.length)}
            <span aria-hidden="true"> ▾</span>
          </button>
        ) : null}
      </div>
      {/* 一覧は小窓の中に出す（外を押すと小窓が閉じるため）。Esc は一覧だけを閉じ、「ほか N」のボタンに戻る（PopupMenu が止める） */}
      {moreAt && rest.length > 0 ? (
        <PopupMenu
          anchor={moreAt}
          ariaLabel={tr("ほかの頼むこと")}
          label={tr("ほかの頼むこと")}
          ready
          container={moreAt.closest(".ask-composer")}
          onClose={(refocus) => {
            if (refocus) moreAt.focus();
            setMoreAt(null);
          }}
        >
          {rest.map((c) => (
            <button
              key={c.action}
              type="button"
              role="menuitem"
              className="ask-menu-item"
              title={candidateTitle(c, tr("Skill を使わない"))}
              onClick={() => {
                setMoreAt(null);
                pick(c);
              }}
            >
              <span>{trCore(c.label)}</span>
              {c.recommended ? <RecDot /> : null}
            </button>
          ))}
        </PopupMenu>
      ) : null}
      <div className="ask-box">
        {skillPill || candidate?.meaning ? (
          <p className="ask-meaning">
            {skillPill ? (
              <span className="ask-skill" title={candidate?.skill_summary ?? undefined}>
                {skillPill}
              </span>
            ) : null}
            {candidate?.meaning ? (
              <span className="ask-meaning-text">{candidate.meaning}</span>
            ) : null}
          </p>
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
              className={`primary ask-send${done?.which === "send" ? " ask-done" : ""}`}
              aria-label={tr("送る")}
              title={
                done?.which === "send" && result?.done
                  ? result.text
                  : tr("選んだターミナルの入力に依頼文を入れる（Enter は押さない）")
              }
              onClick={() => void send()}
              disabled={!base}
            >
              {done?.which === "send" ? (
                <>
                  <span aria-hidden="true">✓</span>
                  {tr("送った")}
                </>
              ) : (
                tr("送る")
              )}
            </button>
          </div>
        ) : null}
        <div className="ask-foot">
          {/* 全文・形式・空にするはアイコンのボタン。名前は aria-label（読み上げ）と title（ツールチップ）に持つ */}
          <button
            type="button"
            className="ask-icon"
            aria-label={tr("全文を見る")}
            title={tr("全文を見る")}
            aria-expanded={full}
            onClick={() => setFull(!full)}
          >
            <Icon d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z">
              <circle cx="8" cy="8" r="2" />
            </Icon>
          </button>
          <button
            type="button"
            className="ask-icon"
            aria-label={formatName}
            title={tr(
              "{0}（押すと切り替える）。Skill の呼び出しか、Skill を使わない文章だけか。既定は dg の Skill がリポジトリか ~/.claude/skills にあれば Skill、なければ文章",
              formatName,
            )}
            disabled={!format}
            onClick={() => {
              copySeq.current++;
              setFormat(format === "skill" ? "text" : "skill");
            }}
          >
            {/* Skill は呼び出しの印（< >）、文章は行の印 */}
            <Icon
              d={
                format === "text"
                  ? "M2.5 4.5h11M2.5 8h11M2.5 11.5h7"
                  : "M5 4L1.5 8 5 12M11 4l3.5 4L11 12"
              }
            />
          </button>
          <button
            type="button"
            className="ask-icon"
            aria-label={tr("空にする")}
            title={tr("空にする（指示の欄と下書きを消す）")}
            disabled={note === ""}
            onClick={() => {
              // 待っている依頼文の取り直しは捨て、空の指示で引き直す（下の effect が settledNote を見て ask を呼ぶ）
              copySeq.current++;
              setNote("");
              setResult(null);
              noteRef.current?.focus();
            }}
          >
            <Icon d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />
          </button>
          <span className="spacer" />
          <kbd className="ask-keys" title={tr("このキーでもコピーできる")}>
            {COPY_KEYS}
          </kbd>
          {/* 名前は ✓ の間も「コピー」のまま（読み上げには下の知らせの文が入る） */}
          <button
            type="button"
            className={`primary ask-copy${done?.which === "copy" ? " ask-done" : ""}`}
            aria-label={tr("コピー")}
            onClick={() => void copy()}
            disabled={!base}
          >
            {done?.which === "copy" ? (
              <>
                <span aria-hidden="true">✓</span>
                {tr("コピーした")}
              </>
            ) : (
              trNode(
                "{0}コピー",
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
                  <path d="M3.5 10.5h-1v-8h8v1" />
                </svg>,
              )
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
      {/* コピーと送るの成功の文は読み上げにだけ渡し、見た目はボタンの ✓ に任せる（出るたびに小窓の高さが変わらないように） */}
      <p
        className={`ask-result${result && !result.ok ? " error" : ""}${result?.done ? " ask-result-quiet" : ""}`}
        role="status"
        aria-live="polite"
      >
        {result?.text ?? ""}
      </p>
    </section>
  );
}

/** 開いているターミナル。dg serve（host.terminals がない）では常に空。開いた・閉じたの通知で更新する */
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

/** 人が打つコマンドを返した理由。Workflow の governance が人に限る操作と、Workflow が人に限る Status の動き */
function humanReason(view: AskView): string {
  const reasons: string[] = [];
  if (view.human_only.length > 0)
    reasons.push(
      tr("{0} は Workflow が人に限った操作（governance）", view.human_only.join(tr("・"))),
    );
  if (view.workflow_denied.length > 0)
    reasons.push(
      tr("{0} は Workflow が人に限った動き（human_only）", view.workflow_denied.join(tr("・"))),
    );
  return reasons.join(tr("、"));
}
