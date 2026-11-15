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
  DEFAULT_VALUES,
  type CoreTextTable,
} from "./l10n-core.js";
import { EN, EN_ONE } from "./l10n-en.js";
import type { RetroPerspective, Status, WorkflowView } from "./types.js";

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
 * 設定画面の項目の文（core の config.show の fields の description・summary・empty・option_descriptions の値）を今の言語の文にする。
 * どの言語でも core の文を鍵に CONFIG_DESCRIPTIONS を引き、今の言語の訳がなければ core の文のまま出す
 */
export function configDescription(description: string): string {
  return lookup(CONFIG_DESCRIPTIONS, description) ?? description;
}

/** 既定の文（core が持つ文）の今の言語の訳。文字列でないか、表に今の言語の訳がなければ undefined */
function defaultTranslation(defaultValue: unknown): string | undefined {
  return typeof defaultValue === "string" ? lookup(DEFAULT_VALUES, defaultValue) : undefined;
}

/**
 * dg の既定の値（config の既定・Workflow の雛形）を画面に出すときの口（UI-11・CL-8）。既定そのものを添えるときだけ比べない shownDefaultText を使う。
 * 振り返りの推薦の指標は英語で持つだけで、ここを通さず画面では訳さない（dg guide retro の表で出す）。
 * 値が既定（core が返す既定。config.show の defaults と fields の default）と同じ文のときだけ既定のままとみなし、
 * DEFAULT_VALUES に今の言語の訳があれば訳で出す。書き換えた値・訳のない既定・文字列でない値は値のまま出す。
 * 古い版の既定の写し（今の既定と違う文）も、人が書いた値と見分けられないので書いたまま出す。
 * 訳して出す既定を足すときは DEFAULT_VALUES に鍵を足し、ここと storedDefault は変えない。読むのは store（判断基準）と設定画面と shownWorkflow
 * （チケット詳細の Workflow も、store と同じく core が返したままを持ち、返すときに shownWorkflow で訳す）
 */
export function shownDefault(value: unknown, defaultValue: unknown): unknown {
  return value === defaultValue ? shownDefaultText(defaultValue) : value;
}

/**
 * 既定の値そのものを画面に出すときの文（比べない）。今の言語の訳があれば訳、なければ既定の値のまま。
 * 書き換えた値の横に「既定は …」と既定を添えるときのように、出すのが値でなく既定と決まっているときに使う
 */
export function shownDefaultText(defaultValue: unknown): unknown {
  return defaultTranslation(defaultValue) ?? defaultValue;
}

/**
 * 振り返りの観点が既定（config.show の defaults の同じ ID の観点）のままか。名前と問いの両方が同じときだけ既定のままとみなす
 * （指標は既定が空なので比べない）。既定のままの観点だけを訳し（設定画面の shownRetroPerspectives）、違う観点に「変更あり」を付ける（retroChanges）
 */
export function isDefaultPerspective(
  perspective: Pick<RetroPerspective, "name" | "question">,
  defaultPerspective: Pick<RetroPerspective, "name" | "question">,
): boolean {
  return (
    perspective.name === defaultPerspective.name &&
    perspective.question === defaultPerspective.question
  );
}

/**
 * Workflow の名前と、step・任意フィールドのラベルを画面に出す形にする（UI-11）。workflow.show が添える同じ id の雛形（template）の、
 * 名前・同じ id の step と項目のラベルを既定として shownDefault に渡すので、雛形と同じ文のときだけ訳す。
 * 書き換えた文・雛形にない step と項目・雛形のない Workflow は書いたまま。雛形の文は core が返したものだけで比べ、画面は写しを持たない。
 * Status の表示名（labels）は、workflow.show の default_labels（雛形の labels と core の既定）と同じ文のときだけ訳す。
 * 雛形のない Workflow も、labels を書いていない Status は core の既定なので訳す。訳は DEFAULT_VALUES に置き、step のラベルと同じ文は同じ訳になる
 */
export function shownWorkflow(view: WorkflowView): WorkflowView {
  const { definition, template, default_labels: defaultLabels } = view;
  const labels = Object.fromEntries(
    Object.entries(view.labels).map(([s, label]) => [
      s,
      String(shownDefault(label, defaultLabels?.[s as Status])),
    ]),
  ) as Record<Status, string>;
  if (!template) return { ...view, labels };
  type Labeled = { id: string; label?: string | undefined };
  const shown = <T extends Labeled>(item: T, from: readonly Labeled[] | undefined): T => {
    if (item.label === undefined) return item;
    const defaultLabel = from?.find((i) => i.id === item.id)?.label;
    return { ...item, label: String(shownDefault(item.label, defaultLabel)) };
  };
  return {
    ...view,
    labels,
    definition: {
      ...definition,
      name: String(shownDefault(definition.name, template.name)),
      fields: definition.fields.map((f) => shown(f, template.fields)),
      ...(definition.steps && { steps: definition.steps.map((s) => shown(s, template.steps)) }),
    },
  };
}

/**
 * 入力欄の文を保存する値に戻す。shownDefault が出した訳の文なら、既定の値に戻す（逆の写し）。
 * 訳と同じ文を欄に打って離れると、既定の値（core の文）として保存される。
 * 欄を書き換えず離れたときは呼ばない（config の画面の onBlur が値をそのまま渡す）
 */
export function storedDefault(text: unknown, defaultValue: unknown): unknown {
  const translation = defaultTranslation(defaultValue);
  return translation !== undefined && text === translation ? defaultValue : text;
}

/** core が返す決まった文の中の ID（t12・s3・e2・p7）と、外す場所の既定の「Iteration/Epic」 */
const CORE_ARG = /\b[tsep]\d+\b|Iteration\/Epic/g;

/**
 * core が返す決まった短い英語の文（エージェントに頼むの候補の名前、札の添え字の Plan の承認の状態）を今の言語の文にする。
 * どの言語でも、文の中の ID を {0}・{1} に置き換えた形を鍵にして CORE_LABELS を引き、表にない文は core の文のまま出す。
 * 表にあっても今の言語の訳がなければ鍵（core の文の形）に ID を戻して出す（core の文と同じになる）。
 * 依頼文は訳さない（エージェントに渡す core の出力）。エラー・警告の文は trCoreMessage が訳す
 */
export function trCore(text: string): string {
  const args: string[] = [];
  const key = text.replace(CORE_ARG, (m) => `{${args.push(m) - 1}}`);
  if (!Object.hasOwn(CORE_LABELS, key)) return text;
  return format(
    CORE_LABELS[key]![current] ?? key,
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
