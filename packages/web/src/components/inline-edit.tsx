// その場で直す属性の値（パネルのチケット詳細の右の列）。値を押すと選択か入力欄になり、選ぶか Enter で確定、Esc で取り消す。
// 欄から外れたら取り消す。保存は呼ぶ側（ticket.update に 1 属性だけ渡す）に任せ、ここは値の文字列を返すだけにする

import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

/** 選択の 1 項目 */
export interface Choice {
  value: string;
  label: string;
}

/** 選択の項目を option にする */
export function optionsOf(choices: readonly Choice[]) {
  return choices.map((c) => (
    <option key={c.value} value={c.value}>
      {c.label}
    </option>
  ));
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
  children,
}: {
  /** 属性の名前。編集欄の aria-label と、値のボタンの名前（「〜を変える」）に使う */
  label: string;
  /** 今の値（編集欄の初めの値）。確定した値が同じなら保存せずに閉じる */
  value: string;
  editing: boolean;
  onStart: () => void;
  onCancel: () => void;
  onCommit: (raw: string) => void;
  /** あれば選択、なければ入力欄 */
  choices?: readonly Choice[];
  inputType?: "text" | "number" | "date";
  placeholder?: string;
  /** 見ているときの値 */
  children: ReactNode;
}) {
  const commit = (raw: string) => (raw === value ? onCancel() : onCommit(raw));
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
  const cancelOnEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };
  return choices ? (
    <select
      autoFocus
      defaultValue={value}
      aria-label={label}
      onChange={(e) => commit(e.target.value)}
      onKeyDown={cancelOnEsc}
      onBlur={onCancel}
    >
      {optionsOf(choices)}
    </select>
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
        } else cancelOnEsc(e);
      }}
      onBlur={onCancel}
    />
  );
}
