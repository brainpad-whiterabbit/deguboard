// ID の解析・整形・採番（requirements.md 5.2、ADR-002）。
// ID は接頭辞＋連番で、ファイル名もそのまま。ゼロ埋めしない。

import { z } from "zod";

const ID_KINDS = ["ticket", "epic", "iteration", "plan"] as const;
export type IdKind = (typeof ID_KINDS)[number];

const ID_PREFIX = { ticket: "t", epic: "e", iteration: "s", plan: "p" } as const;

/** ID の頭の文字から種類を決める（t12 は ticket、s3 は iteration）。形は確かめないので、parseId と合わせて使う */
export function idKindOf(ref: string): IdKind | undefined {
  const head = ref.trim().charAt(0);
  return ID_KINDS.find((k) => ID_PREFIX[k] === head);
}

export type TicketId = `t${number}`;
export type EpicId = `e${number}`;
export type IterationId = `s${number}`;
export type PlanId = `p${number}`;
export type IdOf<K extends IdKind> = K extends "ticket"
  ? TicketId
  : K extends "epic"
    ? EpicId
    : K extends "iteration"
      ? IterationId
      : PlanId;

const NUMBER = /^[1-9]\d*$/;

function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIX[kind]}[1-9]\\d*$`);
}

export const ticketIdSchema = z
  .string()
  .regex(idPattern("ticket"), "t12 の形の ID") as unknown as z.ZodType<TicketId>;
export const epicIdSchema = z
  .string()
  .regex(idPattern("epic"), "e3 の形の ID") as unknown as z.ZodType<EpicId>;
export const iterationIdSchema = z
  .string()
  .regex(idPattern("iteration"), "s3 の形の ID") as unknown as z.ZodType<IterationId>;
export const planIdSchema = z
  .string()
  .regex(idPattern("plan"), "p7 の形の ID") as unknown as z.ZodType<PlanId>;

/** `t12` でも `12` でも受け付ける（DT-6）。ゼロ埋めや別の接頭辞は受け付けない */
export function parseId<K extends IdKind>(input: string, kind: K): IdOf<K> | undefined {
  const text = input.trim();
  if (NUMBER.test(text)) return `${ID_PREFIX[kind]}${text}` as IdOf<K>;
  if (idPattern(kind).test(text)) return text as IdOf<K>;
  return undefined;
}

export function formatId<K extends IdKind>(kind: K, n: number): IdOf<K> {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`番号は 1 以上の整数: ${n}`);
  return `${ID_PREFIX[kind]}${n}` as IdOf<K>;
}

/** ID から番号を取り出す。形が違えば NaN */
export function idNumber(id: string): number {
  const m = /^[tesp]([1-9]\d*)$/.exec(id);
  return m ? Number(m[1]) : Number.NaN;
}

/** 番号順に並べる比較関数（辞書順では t100 が t2 より前に来るため） */
export function compareIds(a: string, b: string): number {
  return idNumber(a) - idNumber(b);
}

/** 採番は「使われている番号の最大 + 1」。使われていなければ 1 */
export function nextNumber(used: Iterable<number>): number {
  let max = 0;
  for (const n of used) if (n > max) max = n;
  return max + 1;
}

/** ファイル名（`t12.md` など）から ID を取り出す。形が違えば undefined */
export function idFromFileName(fileName: string, kind: IdKind): IdOf<IdKind> | undefined {
  const stem = fileName.replace(/\.(md|yaml)$/, "");
  return idPattern(kind).test(stem) ? (stem as IdOf<IdKind>) : undefined;
}
