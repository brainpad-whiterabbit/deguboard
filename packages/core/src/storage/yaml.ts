// yaml の Document を使った読み書き。人が書いたコメントとキー順を保つために、部分更新は Document に対して行う

import { Document, isScalar, isSeq, parseDocument } from "yaml";

export type YamlDocument = Document;

export function parseYamlDocument(text: string): { doc: YamlDocument; errors: string[] } {
  const doc = parseDocument(text, { prettyErrors: true }) as unknown as YamlDocument;
  return { doc, errors: doc.errors.map((e) => e.message) };
}

/** スカラーだけの配列は `[a, b]` の流れの形で書く（requirements の例に合わせる） */
function toNode(doc: YamlDocument, value: unknown) {
  const node = doc.createNode(value);
  if (isSeq(node) && node.items.every((item) => isScalar(item))) node.flow = true;
  return node;
}

/** 既存のキーは位置を保って置き換え、新しいキーは末尾に足し、undefined のキーは消す */
export function patchYamlDocument(doc: YamlDocument, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      if (doc.has(key)) doc.delete(key);
    } else {
      doc.set(key, toNode(doc, value));
    }
  }
}

/** 新規のファイル用。undefined の値は書かない */
export function newYamlDocument(data: Record<string, unknown>): YamlDocument {
  const doc = new Document({});
  patchYamlDocument(doc, data);
  return doc;
}

export function cloneYamlDocument(doc: YamlDocument): YamlDocument {
  return doc.clone() as unknown as YamlDocument;
}

export function stringifyYaml(doc: YamlDocument): string {
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}
