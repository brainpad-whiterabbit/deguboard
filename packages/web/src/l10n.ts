// 画面の文言を表示言語で切り替える口（UI-11・t383）。鍵は日本語の文そのもので、英語の訳は l10n-en.ts に置く。
// React に依らない（client/http.ts からも使う）。文の途中に要素を挟む trNode は l10n-node.tsx に置く。
// 日本語では鍵をそのまま出すので、日本語の表示は訳の表がなくても前と同じになり、ブラウザ（dg serve）は日本語のまま動く。
// 表示言語は拡張ホストが <html data-language> で渡し（vscode.env.language）、main.tsx が起動のときに setLanguage で決める。
// 付いていなければ（dg serve）日本語、ja で始まれば日本語、ほかは英語（拡張ホストの文言と同じ決め方）。
// 鍵は tr("...")・trNode("...")（l10n-node.tsx）・msg("...") の文字列リテラルで書く（l10n.test.ts がソースから鍵を拾い、訳の表と突き合わせる）。
// t でなく tr と呼ぶのは、画面のコードでチケットを t と書くことが多く、名前がぶつかるため。
// 表のように描く前に決める文言は msg で鍵として印を付け、描くときに tr(値) で訳す。{0}・{1} の位置に引数を埋める

import { CORE_EN, EN, EN_ONE } from "./l10n-en.js";

export type Language = "ja" | "en";

let current: Language = "ja";

/** <html data-language> の値（vscode.env.language）から画面の言語を決める。なければ（dg serve）日本語 */
export function languageOf(value: string | undefined): Language {
  if (value === undefined || value === "") return "ja";
  return /^ja\b/i.test(value) ? "ja" : "en";
}

/** 画面の言語を決める。起動のとき（main.tsx）と、テストで切り替えるときに呼ぶ */
export function setLanguage(language: Language): void {
  current = language;
}

/** 今の画面の言語 */
export function language(): Language {
  return current;
}

/**
 * 鍵（日本語の文）を今の言語の文にする。英語の訳がなければ鍵のまま出す。英語で数の引数が 1 なら単数の形（EN_ONE）にする。
 * {0} は埋めない（tr と l10n-node.tsx の trNode が埋める）
 */
export function message(key: string, args: readonly unknown[] = []): string {
  if (current === "ja") return key;
  const one = EN_ONE[key];
  if (one && Number(args[one.arg]) === 1) return one.text;
  return EN[key] ?? key;
}

/** {0}・{1} を引数で埋める（テンプレートリテラルの `${x}` と同じく String で文字にする）。引数のない番号はそのまま残す */
export function format(text: string, args: readonly unknown[]): string {
  return text.replace(/\{(\d+)\}/g, (whole, n: string) =>
    Number(n) < args.length ? String(args[Number(n)]) : whole,
  );
}

/** 文言を今の言語で返す。日本語では鍵の {0} を埋めただけのもの */
export function tr(key: string, ...args: unknown[]): string {
  return format(message(key, args), args);
}

/** 描く前に決める文言（表など）の鍵に印を付ける。訳さずに鍵を返すので、描くときに tr(値) で訳す */
export function msg(key: string): string {
  return key;
}

/** core が返す決まった文の中の ID（t12・s3・e2・p7）と、外す場所の既定の「Iteration・Epic」 */
const CORE_ARG = /\b[tsep]\d+\b|Iteration・Epic/g;

/**
 * core が返す決まった短い文（エージェントに頼むの候補の名前、札の添え字の Plan の承認の状態）を今の言語の文にする。
 * 文の中の ID を {0}・{1} に置き換えた形を鍵にして CORE_EN を引き、訳がなければ core の文のまま出す。
 * scope（候補の頼むこと）を渡すと「scope:鍵」を先に引く（同じ文でも頼むことによって訳が違うもの）。
 * 依頼文とエラーの文は訳さない（依頼文はエージェントに渡す core の出力、エラーは core の言語のまま。UI-11）
 */
export function trCore(text: string, scope?: string): string {
  if (current === "ja") return text;
  const args: string[] = [];
  const key = text.replace(CORE_ARG, (m) => `{${args.push(m) - 1}}`);
  const found = (scope === undefined ? undefined : CORE_EN[`${scope}:${key}`]) ?? CORE_EN[key];
  if (found === undefined) return text;
  return format(
    found,
    args.map((a) => CORE_EN[a] ?? a),
  );
}
