// その場で直す属性の値（パネルのチケット詳細の右の列）。値を押すと選択か入力欄になり、Enter（選択は一覧から選んでも）で確定、Esc で取り消す。
// 閉じた選択で ↑↓ を押すと値だけが変わり、保存しない（Enter で確定する）。欄から外れたら取り消す。
// 保存は呼ぶ側（ticket.update に 1 属性だけ渡す）に任せ、ここは値の文字列を返して結果を待ち、失敗なら欄を開いたままにする。
// Enter・Esc・選んで閉じたら、フォーカスを値のボタンに戻す。
// 値がリンク（Epic・Iteration）なら、リンクと値のボタンを入れ子にせず並べ、ボタンは鉛筆の印だけにする

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/** 選択の 1 項目 */
export interface Choice {
  value: string;
  label: string;
  disabled?: boolean;
}

/** 選択の項目を option にする */
export function optionsOf(choices: readonly Choice[]) {
  return choices.map((c) => (
    <option key={c.value} value={c.value} disabled={c.disabled}>
      {c.label}
    </option>
  ));
}

/** 一覧から選んだ後、Esc の keyup を待つ時間（ミリ秒）。この間に Esc が来なければ確定する */
export const PICK_SETTLE_MS = 300;

/** 閉じた選択の値を変えるキー（Chromium は keydown の既定の動作の中で同期して change を出す）。Space と Alt+↑↓ は一覧を開くので含めない */
function changesClosedSelect(e: KeyboardEvent): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  return (
    [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(e.key) ||
    (e.key.length === 1 && e.key !== " ")
  );
}

/**
 * Enter かマウスで選んだときだけ確定する選択。
 * - 閉じた選択の上のキー操作（↑↓・頭文字）で変わった値は確定せずに持ち、Enter で確定する。そのキーの keydown の中で出た change をキー操作とみなす
 * - 一覧（マウス・Space・Alt+↓ で開く）から選んだ change は、続く keyup が Enter なら確定、Esc なら取り消す。
 *   Chromium は一覧で強調した値を Esc で閉じても change を出し、一覧の中の keydown はページに届かないため。
 *   keyup が来なければ（マウスで選んだとき）PICK_SETTLE_MS 後に確定する
 * - 一度もマウスやキーで触れずに出た change（支援技術など）はすぐ確定する
 */
export function ConfirmSelect({
  label,
  value,
  choices,
  className,
  hint,
  onConfirm,
  onCancel,
  onBlur,
}: {
  label: string;
  value: string;
  choices: readonly Choice[];
  className?: string;
  /** 選んでいる値の下に出す説明（優先度の判断基準など）。渡さなければ出さない */
  hint?: ((value: string) => ReactNode) | undefined;
  onConfirm: (value: string) => void;
  /** Esc で閉じる */
  onCancel: () => void;
  /** 欄から外れたとき */
  onBlur: () => void;
}) {
  const [current, setCurrent] = useState(value);
  // 外から値が変わったら選択も合わせる。effect で合わせると古い値で 1 度描くので、描画中に合わせる（react/set-state-in-effect）
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setCurrent(value);
  }
  const keying = useRef(false);
  const touched = useRef(false);
  // 一覧から選んで keyup か時間切れを待っている値
  const pending = useRef<{ value: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const clearPending = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    const v = pending.current?.value;
    pending.current = null;
    return v;
  };
  useEffect(() => () => void clearPending(), []);
  const cancel = () => {
    clearPending();
    setCurrent(value);
    onCancel();
  };
  return (
    <>
      <select
        autoFocus
        className={className}
        value={current}
        aria-label={label}
        onMouseDown={() => {
          touched.current = true;
        }}
        onKeyDown={(e) => {
          touched.current = true;
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if (e.key === "Enter") {
            e.preventDefault();
            clearPending();
            onConfirm(e.currentTarget.value);
          } else if (changesClosedSelect(e)) {
            // keyup に頼らない（一覧が開くと keyup はページに届かない）
            keying.current = true;
            setTimeout(() => {
              keying.current = false;
            });
          }
        }}
        onKeyUp={(e) => {
          if (!pending.current) return;
          if (e.key === "Escape") cancel();
          else onConfirm(clearPending()!);
        }}
        onChange={(e) => {
          const v = e.target.value;
          setCurrent(v);
          if (keying.current) return;
          if (!touched.current) return onConfirm(v);
          clearPending();
          pending.current = {
            value: v,
            timer: setTimeout(() => onConfirm(clearPending()!), PICK_SETTLE_MS),
          };
        }}
        onBlur={() => {
          clearPending();
          onBlur();
        }}
      >
        {optionsOf(choices)}
      </select>
      {hint ? <div className="inline-hint muted">{hint(current)}</div> : null}
    </>
  );
}

export function InlineEdit({
  label,
  value,
  editing,
  onStart,
  onCancel,
  onCommit,
  choices,
  hint,
  inputType = "text",
  placeholder,
  normalize = (raw) => raw,
  link,
  children,
}: {
  /** 属性の名前。編集欄の aria-label と、値のボタンの名前（「〜を変える」）に使う */
  label: string;
  /** 今の値（編集欄の初めの値）。確定した値が同じなら保存せずに閉じる */
  value: string;
  editing: boolean;
  onStart: () => void;
  onCancel: () => void;
  /** 確定した値を保存する。失敗なら false を返し、欄を開いたままにする（閉じるのは呼ぶ側） */
  onCommit: (raw: string) => Promise<boolean>;
  /** あれば選択、なければ入力欄 */
  choices?: readonly Choice[];
  /** 選択の下に出す説明（優先度の判断基準など）。choices のときだけ使う */
  hint?: ((value: string) => ReactNode) | undefined;
  inputType?: "text" | "number" | "date";
  placeholder?: string;
  /** 今の値と比べる前に入力を揃える（ラベルの区切りの空白など） */
  normalize?: (raw: string) => string;
  /** 値をリンクで出すとき。ボタンの外に置き、ボタンには children の代わりに鉛筆の印を出す */
  link?: ReactNode;
  /** 見ているときの値 */
  children: ReactNode;
}) {
  const button = useRef<HTMLSpanElement>(null);
  // Enter・Esc・選んで閉じたときだけ値のボタンにフォーカスを戻す（欄から外れて閉じたときは、移った先に任せる）
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      button.current?.focus();
    }
  }, [editing]);
  const close = () => {
    restoreFocus.current = true;
    onCancel();
  };
  const commit = (raw: string) => {
    if (normalize(raw) === normalize(value)) return close();
    restoreFocus.current = true;
    void onCommit(raw).then((ok) => {
      if (!ok) restoreFocus.current = false;
    });
  };
  if (!editing) {
    const valueButton = (
      <span
        ref={button}
        className={link ? "inline-edit inline-edit-icon" : "inline-edit"}
        role="button"
        tabIndex={0}
        aria-label={`${label}を変える`}
        title="押して変える"
        onClick={onStart}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onStart();
          }
        }}
      >
        {link ? (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M10.5 2.5l3 3-8 8h-3v-3z" />
          </svg>
        ) : (
          children
        )}
      </span>
    );
    return link ? (
      <span className="inline-edit-linked">
        {link}
        {valueButton}
      </span>
    ) : (
      valueButton
    );
  }
  return choices ? (
    <ConfirmSelect
      label={label}
      value={value}
      choices={choices}
      hint={hint}
      onConfirm={commit}
      onCancel={close}
      onBlur={onCancel}
    />
  ) : (
    <input
      autoFocus
      type={inputType}
      defaultValue={value}
      placeholder={placeholder}
      aria-label={label}
      onKeyDown={(e) => {
        // 日本語の変換を確定する Enter では保存しない
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          commit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
      onBlur={onCancel}
    />
  );
}
