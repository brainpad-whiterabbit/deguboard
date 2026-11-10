// 画面の文言を表示言語で切り替える口（UI-11・t383）。画面のコードの文言は鍵が日本語の文そのもので、英語の訳は l10n-en.ts に置く。
// React に依らない（client/http.ts からも使う）。文の途中に要素を挟む trNode は l10n-node.tsx に置く。
// 画面のコードの文言は、日本語では鍵をそのまま出すので、日本語の表示は訳の表がなくても前と同じになる。
// core が返す文は、core の文を鍵に表示言語ごとの訳を持つ表（l10n-core.ts）をどの言語でも引き、訳がなければ core の文のまま出す
// （core の文の言語と表示言語が違っても訳せるように。t649）。
// 表示言語は拡張ホストが <html data-language> で渡し（vscode.env.language）、main.tsx が起動のときに setLanguage で決める。
// 付いていなければ（dg serve）日本語、ja で始まれば日本語、ほかは英語（拡張ホストの文言と同じ決め方）。
// 鍵は tr("...")・trNode("...")（l10n-node.tsx）・msg("...") の文字列リテラルで書く（l10n.test.ts がソースから鍵を拾い、訳の表と突き合わせる）。
// t でなく tr と呼ぶのは、画面のコードでチケットを t と書くことが多く、名前がぶつかるため。
// 表のように描く前に決める文言は msg で鍵として印を付け、描くときに tr(値) で訳す。{0}・{1} の位置に引数を埋める

import {
  CONFIG_DESCRIPTIONS,
  CORE_LABELS,
  CORE_MESSAGES,
  type CoreTextTable,
} from "./l10n-core.js";
import { EN, EN_ONE, PRIORITY_CRITERIA_EN } from "./l10n-en.js";

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

/** core の文を鍵に表から今の言語の訳を引く。鍵か今の言語の訳がなければ undefined */
function lookup(table: CoreTextTable, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key]![current] : undefined;
}

/**
 * 設定画面の項目の説明（core のスキーマの describe）を今の言語の文にする。
 * どの言語でも core の説明を鍵に CONFIG_DESCRIPTIONS を引き、今の言語の訳がなければ core の説明のまま出す
 */
export function configDescription(description: string): string {
  return lookup(CONFIG_DESCRIPTIONS, description) ?? description;
}

/** 優先度の判断基準の項目（priority.high など）の鍵。PRIORITY_CRITERIA_EN の鍵と同じ */
const PRIORITY_KEY = /^priority\.(high|medium|low)$/;

/**
 * 設定の値を今の言語で出す。優先度の判断基準の既定のままの値（core の既定と同じ文）は、英語の表示で英語の訳にする（UI-11）。
 * 書き換えた値・日本語の表示・優先度以外の項目は値のまま。読むのは store（判断基準）と設定画面（入力欄・既定の表示）
 */
export function shownConfigValue(key: string, value: unknown, defaultValue: unknown): unknown {
  const level = PRIORITY_KEY.exec(key)?.[1] as keyof typeof PRIORITY_CRITERIA_EN | undefined;
  if (current === "ja" || level === undefined || value !== defaultValue) return value;
  return PRIORITY_CRITERIA_EN[level];
}

/**
 * 入力欄の文を保存する値に戻す。shownConfigValue が出した訳の文なら、既定の値に戻す（逆の写し）。
 * 英語の表示で訳と同じ文を欄に打って離れると、既定の値（日本語）として保存される。
 * 欄を書き換えず離れたときは呼ばない（config の画面の onBlur が値をそのまま渡す）
 */
export function storedConfigValue(key: string, text: unknown, defaultValue: unknown): unknown {
  const level = PRIORITY_KEY.exec(key)?.[1] as keyof typeof PRIORITY_CRITERIA_EN | undefined;
  if (current === "ja" || level === undefined) return text;
  return text === PRIORITY_CRITERIA_EN[level] ? defaultValue : text;
}

/** core が返す決まった文の中の ID（t12・s3・e2・p7）と、外す場所の既定の「Iteration・Epic」 */
const CORE_ARG = /\b[tsep]\d+\b|Iteration・Epic/g;

/**
 * core が返す決まった短い文（エージェントに頼むの候補の名前、札の添え字の Plan の承認の状態）を今の言語の文にする。
 * どの言語でも、文の中の ID を {0}・{1} に置き換えた形を鍵にして CORE_LABELS を引き、表にない文は core の文のまま出す。
 * 表にあっても今の言語の訳がなければ鍵（core の文の形）に ID を戻して出す（core の文と同じになる）。
 * scope（候補の頼むこと）を渡すと「scope:鍵」を先に引く（同じ文でも頼むことによって訳が違うもの）。
 * 依頼文は訳さない（エージェントに渡す core の出力）。エラー・警告の文は trCoreMessage が訳す
 */
export function trCore(text: string, scope?: string): string {
  const args: string[] = [];
  const key = text.replace(CORE_ARG, (m) => `{${args.push(m) - 1}}`);
  const found = [scope === undefined ? undefined : `${scope}:${key}`, key].find(
    (k) => k !== undefined && Object.hasOwn(CORE_LABELS, k),
  );
  if (found === undefined) return text;
  const entry = CORE_LABELS[found]!;
  return format(
    entry[current] ?? key,
    args.map((a) => lookup(CORE_LABELS, a) ?? a),
  );
}

/** CORE_MESSAGES の鍵を、{0}・{1} を可変の部分（1 文字以上）として拾う正規表現にしたもの。初めて使うときに作る */
let coreMessagePatterns: { pattern: RegExp; key: string }[] | undefined;

function patternsOfCoreMessages(): { pattern: RegExp; key: string }[] {
  coreMessagePatterns ??= Object.keys(CORE_MESSAGES).map((key) => ({
    pattern: new RegExp(
      `^${key
        .split(/\{\d+\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("([\\s\\S]+?)")}$`,
    ),
    key,
  }));
  return coreMessagePatterns;
}

/**
 * core が返すエラー・警告の文（設定の保存の拒否・Plan と Run の警告など）を今の言語の文にする（UI-11）。
 * どの言語でも、可変の部分を {0}・{1} にした形で CORE_MESSAGES を引き、可変の部分も同じように訳す（「Run r1: 〜」の中の文）。
 * 今の言語の訳がなければ鍵（core の文の形）に訳した可変の部分を戻して出す。
 * 表にない文（git の出力・スキーマの検査の詳細など）は core の文のまま出す。画面のクライアントが受けたところで呼ぶ
 */
export function trCoreMessage(text: string): string {
  for (const { pattern, key } of patternsOfCoreMessages()) {
    const m = pattern.exec(text);
    // 鍵は {0}・{1} を現れる順に書く約束なので、拾った順がそのまま番号になる（l10n.test.ts が確かめる）
    if (m) return format(CORE_MESSAGES[key]![current] ?? key, m.slice(1).map(trCoreMessage));
  }
  return text;
}
