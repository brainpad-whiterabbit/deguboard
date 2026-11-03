// チケットと Epic の本文（## 概要・## 受け入れ条件）を表示する最小の Markdown。見出し・段落・箇条書き・チェックリスト・インラインコードだけ。
// タスクリストのある節は、見出しに済んだ数とメーターを出す

import type { ReactNode } from "react";
import { ProgressMeter } from "./components/parts.js";

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

/** 節のタスクリストの済んだ数と全体の数 */
export type TaskCount = { done: number; total: number };

/**
 * 見出しごとに、次の見出し（深さを問わない）までのタスクリストを数える。
 * 返す Map の鍵は blocks の中の見出しの位置。見出しの名前には頼らず、タスクリストのない節は入れない
 */
export function sectionTasks(blocks: Block[]): Map<number, TaskCount> {
  const counts = new Map<number, TaskCount>();
  let current: TaskCount | null = null;
  blocks.forEach((b, i) => {
    if (b.kind === "heading") {
      current = { done: 0, total: 0 };
      counts.set(i, current);
    } else if (b.kind === "list" && current) {
      for (const x of b.items) {
        if (x.checked === null) continue;
        current.total += 1;
        if (x.checked) current.done += 1;
      }
    }
  });
  for (const [i, c] of counts) if (c.total === 0) counts.delete(i);
  return counts;
}

/** 見出しの右に出す「済 / 全」と細いメーター */
function TaskMeter({ count }: { count: TaskCount }) {
  return (
    <ProgressMeter
      className="progress task-meter"
      title={`済 ${count.done} / 全 ${count.total}`}
      total={count.total}
      segments={[{ key: "done", className: "status-done", count: count.done }]}
    >
      {count.done} / {count.total}
    </ProgressMeter>
  );
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
  const tasks = sectionTasks(blocks);
  return (
    <div className="markdown">
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          const Tag = `h${Math.min(b.level + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
          const count = tasks.get(i);
          return (
            <Tag key={i}>
              {inline(b.text)}
              {count && <TaskMeter count={count} />}
            </Tag>
          );
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
