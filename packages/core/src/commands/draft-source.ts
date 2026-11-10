// ticket import の下書きの本文（YAML か JSON）を読み、行末コメントで本文が切れる下書きを拒む。CLI は読んだ文字列を渡すだけ（ADR-033）

import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { UsageError } from "../errors.js";

/** 本文になる下書きの項目。引用しない値の「空白＋#」以降はコメントになり、本文が切れる */
const DRAFT_TEXT_KEYS = ["title", "summary", "acceptance", "body"];

/**
 * 下書きの本文を配列にする。配列でも { drafts: [...] } でも受ける。読めない・YAML の誤り・本文の項目の
 * 引用しない値の行末コメントは使い方の誤り（UsageError）。形（項目の型）の検査は呼び出し側が行う
 */
export function parseDraftSource(text: string): unknown {
  const doc = parseDocument(text);
  if (doc.errors.length > 0)
    throw new UsageError("Cannot read the draft as YAML", doc.errors.map(String).join("\n"));
  const root = isMap(doc.contents) ? doc.contents.get("drafts", true) : doc.contents;
  if (isSeq(root)) {
    const cut = root.items.flatMap((draft, i) =>
      cutFields(draft, text).map((key) => `${key} of draft ${i + 1}`),
    );
    if (cut.length > 0)
      throw new UsageError(
        `In an unquoted value of a draft body field, everything after # is treated as a comment (${cut.join(", ")})`,
        "Everything after a space plus # is dropped as a comment, so the body is cut off. Quote a value that contains # or write it with | in body",
      );
  }
  const parsed: unknown = doc.toJS();
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "drafts" in parsed) {
    return (parsed as { drafts: unknown }).drafts;
  }
  return parsed;
}

/**
 * 下書き 1 件のうち、引用しない値の行末にコメントがある本文の項目の名前。yaml は値の次の行の
 * 深く字下げした行だけのコメントも値の comment に付けるので、値の終わりと同じ行に # があるかをソースで見る
 */
function cutFields(draft: unknown, text: string): string[] {
  if (!isMap(draft)) return [];
  return DRAFT_TEXT_KEYS.filter((key) => {
    const value = draft.get(key, true);
    const nodes = isSeq(value) ? value.items : [value];
    return nodes.some(
      (n) =>
        isScalar(n) &&
        n.type === "PLAIN" &&
        n.range !== undefined &&
        n.range !== null &&
        /^[ \t]*#/.test(text.slice(n.range[1])),
    );
  });
}
