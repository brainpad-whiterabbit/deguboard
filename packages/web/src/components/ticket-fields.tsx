// チケットの任意フィールド（Workflow の fields）の部品。値の文字列・型に合わせた変換・選択の項目・入力欄の型と、表示。
// チケット詳細の右の列（値を押してその場で直す。ticket-props-panel.tsx）で使う

import type { FieldDefinition } from "../types.js";
import type { Choice } from "./inline-edit.js";
import { tr } from "../l10n.js";

/** 任意フィールドの値の文字列（入力欄の値）。未設定は空 */
export function fieldText(value: unknown): string {
  return value === undefined ? "" : String(value);
}

/** 任意フィールドの入力を Workflow の型に合わせる。空は未指定 */
export function parseFieldValue(def: FieldDefinition, raw: string): unknown {
  const text = raw.trim();
  if (text === "") return undefined;
  if (def.type === "number") return Number(text);
  if (def.type === "boolean") return text === "true";
  return text;
}

/** 任意フィールドの選択の項目。enum と boolean だけで、ほかは入力欄（undefined） */
export function fieldChoices(def: FieldDefinition): Choice[] | undefined {
  if (def.type !== "enum" && def.type !== "boolean") return undefined;
  const options = def.type === "boolean" ? ["true", "false"] : (def.options ?? []);
  return [{ value: "", label: tr("未設定") }, ...options.map((o) => ({ value: o, label: o }))];
}

/** 任意フィールドの入力欄の型 */
export function fieldInputType(def: FieldDefinition): "text" | "number" | "date" {
  return def.type === "number" ? "number" : def.type === "date" ? "date" : "text";
}

/** 任意フィールドの値。未設定は「未設定」 */
export function FieldView({ value }: { value: unknown }) {
  return value === undefined ? <span className="muted">{tr("未設定")}</span> : <>{String(value)}</>;
}
