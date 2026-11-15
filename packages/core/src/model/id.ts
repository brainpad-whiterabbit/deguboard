// ID の解析・整形・採番（requirements.md 5.2、ADR-034）。
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
  .regex(idPattern("ticket"), "An ID like t12") as unknown as z.ZodType<TicketId>;
export const epicIdSchema = z
  .string()
  .regex(idPattern("epic"), "An ID like e3") as unknown as z.ZodType<EpicId>;
export const iterationIdSchema = z
  .string()
  .regex(idPattern("iteration"), "An ID like s3") as unknown as z.ZodType<IterationId>;
export const planIdSchema = z
  .string()
  .regex(idPattern("plan"), "An ID like p7") as unknown as z.ZodType<PlanId>;

/** `t12` でも `12` でも受け付ける（DT-6）。ゼロ埋めや別の接頭辞は受け付けない */
export function parseId<K extends IdKind>(input: string, kind: K): IdOf<K> | undefined {
  const text = input.trim();
  if (NUMBER.test(text)) return `${ID_PREFIX[kind]}${text}` as IdOf<K>;
  if (idPattern(kind).test(text)) return text as IdOf<K>;
  return undefined;
}

export function formatId<K extends IdKind>(kind: K, n: number): IdOf<K> {
  if (!Number.isInteger(n) || n < 1)
    throw new RangeError(`The number must be an integer of 1 or more: ${n}`);
  return `${ID_PREFIX[kind]}${n}` as IdOf<K>;
}

/** ID から番号を取り出す。形が違えば NaN */
export function idNumber(id: string): number {
  const m = /^[tesp]([1-9]\d*)$/.exec(id);
  return m ? Number(m[1]) : Number.NaN;
}

/** 文章の中で見つけた ID と、その位置（text の先頭からの文字数。end は含まない） */
export interface FoundId {
  id: string;
  start: number;
  end: number;
}

/**
 * 文章の中の ID の形（VS Code 拡張のホバーとリンク、UI-12）。abc12・feat/t12・v1.t2・t12abc・t12-foo・t12.md のように、
 * 語や経路の一部になっているものは拾わない（前は英数字・_・/・.・- でないこと、後ろは英数字・_・/ でなく、- や . のあとに語が続かないこと）。
 * 文末の「t12.」「t12,」や括弧（全角を含む）・引用符・バッククォート・#・@ に続く ID と、日本語に隣り合う「t12を」「はt12」は拾う。
 * 既知の誤検出（仕様）：コードの変数名の `e1`・`t1`、`s3://` の s3、`?id=t12` のように、形が合えば拾う。
 * 使う側は存在する ID にしか印を付けないので、実害は存在する番号と偶然重なるときだけ。
 * web の目標の ID のリンク（packages/web/src/components/parts.tsx の TEXT_ID）は同じ規則を写している。
 * web は core を `import type` でしか読まない（ADR-033）ため。変えるときは両方を直す
 */
const ID_IN_TEXT = /(?<![\w/.-])[tsep][1-9]\d*(?![\w/]|[-.]\w)/g;

/** 文章の中の ID を位置つきで拾う（存在するかは確かめない） */
export function findIdsInText(text: string): FoundId[] {
  return [...text.matchAll(ID_IN_TEXT)].map((m) => ({
    id: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
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
