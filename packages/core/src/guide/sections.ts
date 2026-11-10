// guide の本文を節（## の見出し）に分け、名前で 1 節を引く。節の名前は check-docs の guideSectionNames と同じ決め方で、
// 見出しの文言と、その末尾の「（…）」の補足を除いた名前の両方で引ける。読み込み（ファイル・choices・config の埋め込み）は guide.ts の composeGuide が行う

import { UsageError } from "../errors.js";

export interface GuideSection {
  /** 見出しの文言（「（…）」の補足を含む） */
  heading: string;
  /** 補足を除いた名前（一覧に出す名前） */
  name: string;
  /** 見出しの行から次の ## か # の見出しの手前まで（### の小節は含む） */
  text: string;
}

/** 末尾の補足（全角「（…）」か、半角の空白に続く「 (…)」）を除く。check-docs の guideSectionNames と同じ正規表現 */
export function guideSectionName(heading: string): string {
  return heading.replace(/（[^（）]*）$| \([^()]*\)$/, "");
}

/** ## の見出しで節に分ける。コードブロックの中の # は見出しにしない。最初の見出し（# の題名）より前は節にしない */
export function guideSections(body: string): GuideSection[] {
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | undefined;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? undefined : /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      // # の見出しは節を閉じる。## は次の節を始める
      current = undefined;
      if (heading[1] === "##") {
        current = { heading: heading[2]!, lines: [line] };
        sections.push(current);
      }
      continue;
    }
    current?.lines.push(line);
  }
  return sections.map((s) => ({
    heading: s.heading,
    name: guideSectionName(s.heading),
    text: s.lines.join("\n").trimEnd(),
  }));
}

/**
 * 名前で 1 節を引く。見出しの文言か補足を除いた名前が一致する最初の節を返す。
 * ない節は使い方の誤りとして一覧を添えて失敗する（UsageError。CL-5）
 */
export function findGuideSection(topic: string, body: string, name: string): GuideSection {
  const sections = guideSections(body);
  const wanted = name.trim();
  const found = sections.find((s) => s.heading === wanted || s.name === wanted);
  if (found) return found;
  const names = sections.map((s) => s.name);
  throw new UsageError(
    `guide ${topic} に節 ${wanted} はない。節は ${names.length > 0 ? names.join(" / ") : "ない"}`,
  );
}
