// Markdown の frontmatter と本文の分割・結合。本文は 1 バイトも変えない

export interface Frontmatter {
  yaml: string;
  body: string;
}

const OPEN = /^﻿?---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*$/;

/** 先頭の `---` から次の単独の `---` までを YAML として切り出す。frontmatter がなければ undefined */
export function splitFrontmatter(text: string): Frontmatter | undefined | "unterminated" {
  const open = OPEN.exec(text);
  if (!open) return undefined;
  const rest = text.slice(open[0].length);
  const lines = rest.split("\n");
  let offset = 0;
  for (const line of lines) {
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (CLOSE.test(bare)) {
      const yaml = rest.slice(0, offset);
      const afterClose = offset + line.length + 1; // 閉じ行の改行まで
      return { yaml, body: rest.slice(Math.min(afterClose, rest.length)) };
    }
    offset += line.length + 1;
  }
  return "unterminated";
}

export function joinFrontmatter(yaml: string, body: string): string {
  const y = yaml.endsWith("\n") ? yaml : `${yaml}\n`;
  return `---\n${y}---\n${body}`;
}
