// 見直しの指摘の一覧から、手直しの文と PR の本文に入れる指摘を選ぶ（純粋な関数。t600）。
// 一覧は record.ts の readReviewFindings が読む（deguboard-local に置く。理由は record.ts のコメント）。

import type { ReviewFinding } from "../model/run.js";

/** 重い指摘（reviewOfFindings と同じ判定）：severity が heavy か、category がリポジトリの重いとみなす種類 */
export function isHeavyFinding(f: ReviewFinding, heavyCategories: readonly string[]): boolean {
  return f.severity === "heavy" || heavyCategories.includes(f.category);
}

/**
 * 受け入れ条件の文言に当たる指摘（category に「受け入れ条件」を含むもの）。
 * 一覧には印がなく、見直し役は受け入れ条件の欠けを category の名（「受け入れ条件の漏れ」など）で書く（guide-review の「返す」）。
 * category で決めるので、どの回の一覧でも同じ規則で決まり、dg が後から印を付け直さなくてすむ
 */
export function isAcceptanceFinding(f: ReviewFinding): boolean {
  return f.category.includes("受け入れ条件");
}

/**
 * 一覧を直す指摘と、直さなかった軽い指摘に分ける。
 * fix は重い指摘と、受け入れ条件の文言に当たる軽い指摘（手直しの文に入れる。guide-review の「直す指摘」）。
 * unfixedLight は残りの軽い指摘（参考節との食い違いを含む）。直す役が直すかを決めるが、dg は決めた結果を知らないので、
 * dg pr ready は手直しの後にも残りを PR の本文に書く（「直さなかった軽い指摘」。直す役が直した分は見分けられない）
 */
export function splitFindings(
  findings: readonly ReviewFinding[],
  heavyCategories: readonly string[],
): { fix: ReviewFinding[]; unfixedLight: ReviewFinding[] } {
  const fix: ReviewFinding[] = [];
  const unfixedLight: ReviewFinding[] = [];
  for (const f of findings) {
    if (isHeavyFinding(f, heavyCategories) || isAcceptanceFinding(f)) fix.push(f);
    else unfixedLight.push(f);
  }
  return { fix, unfixedLight };
}

/**
 * 指摘の 1 件を 1 行の文にする（箇条書きの記号は付けない）。場所・種類・理由・直し方を入れる。
 * 改行は空白にそろえ、1 件が 1 行に収まるようにする
 */
export function findingText(f: ReviewFinding, lang: "ja" | "en"): string {
  const sev =
    lang === "en"
      ? f.severity === "heavy"
        ? "heavy"
        : "light"
      : f.severity === "heavy"
        ? "重い"
        : "軽い";
  const loc = f.file === null ? undefined : f.line === null ? f.file : `${f.file}:${f.line}`;
  const head = loc ? `[${sev}] ${loc} (${f.category})` : `[${sev}] ${f.category}`;
  const fixPart = f.fix === null ? "" : lang === "en" ? ` Fix: ${f.fix}` : `。直し方：${f.fix}`;
  const sep = lang === "en" ? ": " : "：";
  return `${head}${sep}${f.reason}${fixPart}`.replace(/\s*\n\s*/g, " ");
}

/** PR の本文に書き足す節の印。dg pr ready が書き直すときは、この印の間を入れ替える（もとの本文は残す） */
export const UNFIXED_LIGHT_BEGIN = "<!-- dg:unfixed-light-findings:begin -->";
export const UNFIXED_LIGHT_END = "<!-- dg:unfixed-light-findings:end -->";

/**
 * PR の本文に「直さなかった軽い指摘」の節を書き足した本文を返す。もとの本文は残し、前に書いた節（印の間）だけ置き換える。
 * lines が空なら節を外す（前の回の節が残らないように）。節がなく lines も空なら、もとの本文をそのまま返す
 */
export function withUnfixedLight(body: string, lines: readonly string[]): string {
  const begin = body.indexOf(UNFIXED_LIGHT_BEGIN);
  const end = begin < 0 ? -1 : body.indexOf(UNFIXED_LIGHT_END, begin);
  const hadSection = begin >= 0 && end >= 0;
  const kept = (
    hadSection ? body.slice(0, begin) + body.slice(end + UNFIXED_LIGHT_END.length) : body
  ).trimEnd();
  if (lines.length === 0) return hadSection ? (kept ? `${kept}\n` : "") : body;
  const section = [
    UNFIXED_LIGHT_BEGIN,
    "## 直さなかった軽い指摘",
    "",
    ...lines.map((l) => `- ${l}`),
    UNFIXED_LIGHT_END,
  ].join("\n");
  return `${kept ? `${kept}\n\n` : ""}${section}\n`;
}
