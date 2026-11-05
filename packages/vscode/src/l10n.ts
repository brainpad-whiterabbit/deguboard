// 拡張ホストの文言を VS Code の表示言語で切り替える口（UI-11）。VS Code の API に触れない部分からも呼べるよう、
// 訳す関数を差し替えられるようにし、extension.ts の activate で vscode.l10n.t を差し込む。
// 鍵は英語の文そのもの（VS Code の作法）。英語以外の表示言語で訳がないときは鍵がそのまま出るので、日本語だけでなく
// ほかの言語の利用者にも英語が出る。日本語の訳は l10n/bundle.l10n.ja.json、鍵の一覧は l10n/bundle.l10n.json に置く。
// 鍵は t("...") の文字列リテラルで書く（l10n.test.ts がソースから鍵を拾い、bundle と突き合わせる）。差し込み口は {0} の位置の引数だけを使う

/** 文言を訳す関数。vscode.l10n.t の位置の引数の形と同じ */
export type Translate = (message: string, ...args: Array<string | number | boolean>) => string;

/** 訳の表（鍵 → 訳）。l10n/bundle.l10n.*.json の形 */
export type Bundle = Readonly<Record<string, string>>;

/** {0}・{1} を引数で埋める。引数のない番号はそのまま残す（vscode.l10n.t と同じ） */
export function format(message: string, args: ReadonlyArray<string | number | boolean>): string {
  return message.replace(/\{(\d+)\}/g, (whole, n: string) => {
    const value = args[Number(n)];
    return value === undefined ? whole : String(value);
  });
}

/** 訳の表から訳す関数を作る。表にない鍵は鍵のまま出す。テストで日本語の文言を確かめるのに使う */
export function bundleTranslator(bundle: Bundle): Translate {
  return (message, ...args) => format(bundle[message] ?? message, args);
}

/** 差し込む前（テスト）は鍵（英語）をそのまま出す */
let current: Translate = (message, ...args) => format(message, args);

/** 文言を今の表示言語で返す */
export function t(message: string, ...args: Array<string | number | boolean>): string {
  return current(message, ...args);
}

/** 訳す関数を差し替える。extension.ts が vscode.l10n.t を、テストが bundleTranslator を渡す */
export function setTranslator(translate: Translate): void {
  current = translate;
}
