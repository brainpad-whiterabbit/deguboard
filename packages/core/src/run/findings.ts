// 見直しの指摘の一覧から、手直しの文と PR の本文に入れる指摘を選ぶ（純粋な関数。t600）。
// 一覧は record.ts の readReviewFindings が読む（deguboard-local に置く。理由は record.ts のコメント）。

import type { ReviewFinding } from "../model/run.js";

/** 重い指摘（reviewOfFindings と同じ判定）：severity が heavy か、category がリポジトリの重いとみなす種類 */
export function isHeavyFinding(f: ReviewFinding, heavyCategories: readonly string[]): boolean {
  return f.severity === "heavy" || heavyCategories.includes(f.category);
}

/**
 * 受け入れ条件の文言に当たる指摘（category に「受け入れ条件」か "acceptance"（大文字小文字は問わない）を含むもの）。
 * 一覧には印がなく、見直し役は受け入れ条件の欠けを category の名（「受け入れ条件の漏れ」や "missing acceptance criteria" など）で書く（the "Return" section of `dg guide review`）。
 * 英語の guide を読んだ見直し役も同じ語で書くので、guide の言語によらず見分ける（t489）。
 * category で決めるので、どの回の一覧でも同じ規則で決まり、dg が後から印を付け直さなくてすむ
 */
export function isAcceptanceFinding(f: ReviewFinding): boolean {
  return /受け入れ条件|acceptance/i.test(f.category);
}

/**
 * 一覧を直す指摘と、直さなかった軽い指摘に分ける。
 * fix は重い指摘と、受け入れ条件の文言に当たる軽い指摘（手直しの文に入れる。the "Findings to fix" section of `dg guide review`）。
 * unfixedLight は残りの軽い指摘（参考節との食い違いを含む）。親が手直しに渡す軽い指摘は run handoff で dg に伝える（t639）ので、
 * dg pr ready は伝えられなかった残りを PR の本文に書く（「直さなかった軽い指摘」。直す役が直したかは見分けられないので、渡したものは直したかによらず外す）
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

/**
 * 指摘の同一性（手直しに渡した指摘と見直しの一覧の照合に使う）。severity は見ない（親が写した JSON の severity の揺れで外れないように）
 */
export function findingKey(f: ReviewFinding): string {
  return JSON.stringify([f.file, f.line, f.category, f.reason, f.fix]);
}

/**
 * 手直しに渡す指摘の一覧を、見直しの一覧と照合する。一覧にない指摘は unmatched に返す（dg run handoff は使い方の誤りにする）
 */
export function matchFindings(
  list: readonly ReviewFinding[],
  handed: readonly ReviewFinding[],
): { matched: ReviewFinding[]; unmatched: ReviewFinding[] } {
  const keys = new Set(handed.map(findingKey));
  const listed = new Set(list.map(findingKey));
  return {
    matched: list.filter((f) => keys.has(findingKey(f))),
    unmatched: handed.filter((f) => !listed.has(findingKey(f))),
  };
}

/** 見直しの 1 回分の、指摘の部分（record.ts の ReviewRound のうち読む側が使う形） */
export interface ReviewRoundLike {
  at: string;
  findings: readonly ReviewFinding[] | null;
  /** 親が手直しに渡した軽い指摘（dg run handoff。なければ空） */
  handed?: readonly ReviewFinding[] | undefined;
}

/**
 * 作業ブランチ（branch_at 以降。since がなければすべて）の見直しの回のうち、最新の回を返す。
 * 一覧なしの回（findings が null）は、それが最新なら一覧がないものとして扱う（前の回の一覧は使わない）
 */
export function latestRoundSince<T extends ReviewRoundLike>(
  rounds: readonly T[],
  since: string | undefined,
): T | undefined {
  const round = rounds.filter((r) => r.at >= (since ?? "")).at(-1);
  return round && round.findings !== null ? round : undefined;
}

/**
 * 作業ブランチの見直しの回すべてから、直さなかった軽い指摘（手直しに渡さなかったもの）の文を集める。
 * 回の順に、同じ文は 1 つにする（同じ指摘が次の回にも出るため）。一覧なしの回は何も足さない。
 * 手直しに渡した指摘（どの回の handed でも、作業ブランチの回のうち）は、直したかによらず外す（直さずに返したものは親が報告に書く）
 */
export function unfixedLightLines(
  rounds: readonly ReviewRoundLike[],
  since: string | undefined,
  heavyCategories: readonly string[],
): string[] {
  const inBranch = rounds.filter((r) => r.at >= (since ?? ""));
  const handed = new Set(inBranch.flatMap((r) => (r.handed ?? []).map(findingKey)));
  const lines = new Set<string>();
  for (const round of inBranch) {
    if (round.findings === null) continue;
    const { unfixedLight } = splitFindings(round.findings, heavyCategories);
    for (const f of unfixedLight) if (!handed.has(findingKey(f))) lines.add(findingText(f, "ja"));
  }
  return [...lines];
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
