// その場で直す属性の値（パネルのチケット詳細の右の列）。値を押すと選択か入力欄になり、Enter（選択はマウスで選んでも）で確定、Esc で取り消す。
// 閉じた選択で ↑↓ を押すと値だけが変わり、保存しない（Enter で確定する）。欄から外れたら取り消す。
// 保存は呼ぶ側（ticket.update に 1 属性だけ渡す）に任せ、ここは値の文字列を返して結果を待ち、失敗なら欄を開いたままにする。
// Enter・Esc・選んで閉じたら、フォーカスを値のボタンに戻す

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

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

/**
 * Enter かマウスで選んだときだけ確定する選択。閉じた選択の上のキー操作（↑↓・頭文字）で変わった値は確定せずに持つ。
 * Chromium は閉じた選択の ↑↓ で keydown の中で change を出すので、keydown から keyup までの change はキー操作とみなす
 */
export function ConfirmSelect({
  label,
  value,
  choices,
  className,
  onConfirm,
  onCancel,
  onBlur,
}: {
  label: string;
  value: string;
  choices: readonly Choice[];
  className?: string;
  onConfirm: (value: string) => void;
  /** Esc で閉じる */
  onCancel: () => void;
  /** 欄から外れたとき */
  onBlur: () => void;
}) {
  const [current, setCurrent] = useState(value);
  const keying = useRef(false);
  return (
    <select
      autoFocus
      className={className}
      value={current}
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter") {
          e.preventDefault();
          onConfirm(e.currentTarget.value);
        } else keying.current = true;
      }}
      onKeyUp={() => {
        keying.current = false;
      }}
      onChange={(e) => {
        setCurrent(e.target.value);
        if (!keying.current) onConfirm(e.target.value);
      }}
      onBlur={onBlur}
    >
      {optionsOf(choices)}
    </select>
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
  inputType = "text",
  placeholder,
  normalize = (raw) => raw,
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
  inputType?: "text" | "number" | "date";
  placeholder?: string;
  /** 今の値と比べる前に入力を揃える（ラベルの区切りの空白など） */
  normalize?: (raw: string) => string;
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
    // 値の中のリンク（Epic・Iteration）は押せばそのまま移る
    const start = (e: MouseEvent) => {
      if (!(e.target as Element).closest("a")) onStart();
    };
    const key = (e: KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        onStart();
      }
    };
    return (
      <span
        ref={button}
        className="inline-edit"
        role="button"
        tabIndex={0}
        aria-label={`${label}を変える`}
        title="押して変える"
        onClick={start}
        onKeyDown={key}
      >
        {children}
      </span>
    );
  }
  return choices ? (
    <ConfirmSelect
      label={label}
      value={value}
      choices={choices}
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
