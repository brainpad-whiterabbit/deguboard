// チケットと Epic の本文（## 概要・## 受け入れ条件）を表示する最小の Markdown。見出し・段落・箇条書き・チェックリスト・インラインコードだけ

import type { ReactNode } from "react";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: { checked: boolean | null; text: string }[] };

export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2] ?? "" });
    } else if (item) {
      flush();
      const entry = {
        checked: item[1] === undefined ? null : item[1] !== " ",
        text: item[2] ?? "",
      };
      const last = blocks.at(-1);
      if (last?.kind === "list") last.items.push(entry);
      else blocks.push({ kind: "list", items: [entry] });
    } else if (line.trim() === "") {
      flush();
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

function inline(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`)/)
    .map((part, i) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        <span key={i}>{part}</span>
      ),
    );
}

export function Markdown({ body }: { body: string }) {
  const blocks = parseBlocks(body);
  if (blocks.length === 0) return <p className="muted">（本文なし）</p>;
  return (
    <div className="markdown">
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          const Tag = `h${Math.min(b.level + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
          return <Tag key={i}>{inline(b.text)}</Tag>;
        }
        if (b.kind === "paragraph") return <p key={i}>{inline(b.text)}</p>;
        return (
          <ul key={i} className={b.items.some((x) => x.checked !== null) ? "checklist" : ""}>
            {b.items.map((x, j) => (
              <li key={j}>
                {x.checked !== null && <input type="checkbox" checked={x.checked} readOnly />}
                <span>{inline(x.text)}</span>
              </li>
            ))}
          </ul>
        );
      })}
    </div>
  );
}
