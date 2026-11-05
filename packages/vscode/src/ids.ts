// コード中の ID（t12・s3・e2・p7）へのホバーとリンク（UI-12）。VS Code の API に触れない部分で、extension.ts から呼ぶ。
// 文章から ID を拾う正規表現と、存在する ID の索引（ticket.list などの行から作る）、ホバーの文言、開くルートを決める。
// ID の形は core の用語（接頭辞＋ゼロ埋めなしの連番。t12・s3・e2・p7）に合わせる

import { ticketRoute } from "./context-menu.js";

/** ID の種類 */
export type IdKind = "ticket" | "iteration" | "epic" | "plan";

/** 文章の中で見つけた ID と、その位置（text の先頭からの文字数。end は含まない） */
export interface FoundId {
  id: string;
  start: number;
  end: number;
}

/**
 * ID の形。abc12・feat/t12・v1.t2・t12abc・t12-foo・t12.md のように、語や経路の一部になっているものは拾わない
 * （前は英数字・_・/・.・- でないこと、後ろは英数字・_・/ でなく、- や . のあとに語が続かないこと）。
 * 文末の「t12.」「t12,」や括弧（全角を含む）・引用符・バッククォート・#・@ に続く ID と、日本語に隣り合う「t12を」「はt12」は拾う。
 * 既知の誤検出（仕様）：コードの変数名の `e1`・`t1`、`s3://` の s3、`?id=t12` のように、形が合えば拾う。
 * ただしホバーとリンクは存在する ID にしか付かないので、実害は存在する番号と偶然重なるときだけ
 */
const ID_PATTERN = /(?<![\w/.-])[tsep][1-9]\d*(?![\w/]|[-.]\w)/g;

/** 文章の中の ID を位置つきで拾う（存在するかは確かめない） */
export function findIds(text: string): FoundId[] {
  return [...text.matchAll(ID_PATTERN)].map((m) => ({
    id: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** ID の頭の文字から種類を決める。形が違えば undefined */
export function kindOfId(id: string): IdKind | undefined {
  if (!/^[tsep][1-9]\d*$/.test(id)) return undefined;
  return { t: "ticket", s: "iteration", e: "epic", p: "plan" }[id.charAt(0)] as IdKind;
}

/** 索引に載せる項目。ホバーに出す文言の材料だけを持つ */
export interface IdEntry {
  id: string;
  kind: IdKind;
  /** 見出し（チケット・Epic の title、Iteration の name。Plan にはない） */
  title: string;
  status: string;
  /** 補足の行（担当・進捗・チケット数など） */
  details: string[];
}

/** 一覧の行の一部。ticket.list・iteration.list・epic.list・plan.list の応答のうち、索引に使う項目 */
export interface IdSources {
  tickets: { id: string; title: string; status: string; assignee?: string | null }[];
  iterations: { id: string; name: string; status: string; goal?: string | null }[];
  epics: {
    id: string;
    title: string;
    status: string;
    progress?: { total: number; done: number } | undefined;
  }[];
  plans: { id: string; status: string; tickets: string[] }[];
}

/** 存在する ID の索引 */
export type IdIndex = ReadonlyMap<string, IdEntry>;

/** 一覧の行から索引を作る。ここに載った ID だけにホバーとリンクを付ける（存在しない ID には付けない） */
export function buildIdIndex(src: IdSources): IdIndex {
  const index = new Map<string, IdEntry>();
  for (const t of src.tickets) {
    index.set(t.id, {
      id: t.id,
      kind: "ticket",
      title: t.title,
      status: t.status,
      details: [t.assignee ? `担当: ${t.assignee}` : "担当: なし"],
    });
  }
  for (const i of src.iterations) {
    index.set(i.id, {
      id: i.id,
      kind: "iteration",
      title: i.name,
      status: i.status,
      details: i.goal ? [`目標: ${i.goal}`] : [],
    });
  }
  for (const e of src.epics) {
    index.set(e.id, {
      id: e.id,
      kind: "epic",
      title: e.title,
      status: e.status,
      details: e.progress ? [`進捗: ${e.progress.done}/${e.progress.total}`] : [],
    });
  }
  for (const p of src.plans) {
    index.set(p.id, {
      id: p.id,
      kind: "plan",
      title: "",
      status: p.status,
      details: [`チケット: ${p.tickets.join(" ")}`],
    });
  }
  return index;
}

/** ホバーに出す Markdown。1 行目に ID・Status と見出し、続けて補足。タイトルは Markdown として解釈させない */
export function hoverMarkdown(entry: IdEntry): string {
  const label = { ticket: "チケット", iteration: "Iteration", epic: "Epic", plan: "Plan" }[
    entry.kind
  ];
  const head = `**${entry.id}**（${label}・${entry.status}）${entry.title ? ` ${escapeMarkdown(entry.title)}` : ""}`;
  return [head, ...entry.details.map(escapeMarkdown)].join("\n\n");
}

/** Markdown の記号を文字として出す */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}

/**
 * Ctrl/⌘+クリックで開く詳細のルート。チケット・Iteration・Epic・Plan の詳細がパネルを持つ。
 * チケットは context-menu.ts の ticketRoute と同じ。形の違う ID は undefined
 */
export function routeOfId(id: string): string | undefined {
  switch (kindOfId(id)) {
    case "ticket":
      return ticketRoute({ ticket: id });
    case "iteration":
      return `#/iterations/${id}`;
    case "epic":
      return `#/epics/${id}`;
    case "plan":
      return `#/plans/${id}`;
    default:
      return undefined;
  }
}

/** リンクを押したときのコマンド。引数は [ID, フォルダの URI]（extension.ts が登録する） */
export const OPEN_ID_COMMAND = "deguboard.openId";

/** DocumentLink の target にする command: の URI。引数は [ID, フォルダの URI] の JSON を URI エンコードして渡す（VS Code の command URI の形） */
export function openIdCommandUri(id: string, folder: string): string {
  return `command:${OPEN_ID_COMMAND}?${encodeURIComponent(JSON.stringify([id, folder]))}`;
}

/** 1 行の中でリンクを付ける ID。索引にある（存在する）もので、詳細のパネルがある種類に絞る */
export function linksOf(line: string, index: IdIndex): FoundId[] {
  return findIds(line).filter((f) => index.has(f.id) && routeOfId(f.id) !== undefined);
}

/**
 * Provider を付ける文書。コミットメッセージの入力欄は scheme が vscode-scm の文書なので、languages だけの selector では漏れる。scheme で指定する。
 * vscode-scm は公開の API には出ていない。VS Code のソースの src/vs/base/common/network.ts が
 * `Schemas.vscodeSourceControl = 'vscode-scm'` を定め、mainThreadSCM.ts が言語 scminput のモデルをこの scheme で作って拡張ホストに同期する。
 * 将来変わりうるので、実機で確かめる。通常のファイルは file、保存前の文書は untitled
 */
export const ID_DOCUMENT_SELECTOR = [
  { scheme: "file" },
  { scheme: "untitled" },
  { scheme: "vscode-scm" },
] as const;
