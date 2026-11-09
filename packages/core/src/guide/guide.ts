// guide の本文（guide-*.md・同じフォルダ）の読み込み（ADR-030）。frontmatter の分離・{{choices}} の差し込み・config の値の埋め込み・
// guide.notes の文書の差し込みと、節の本文の取り出しを Core が行う。dg guide（CLI）・dg next・dg brief・dg flow next はここを写す。
// 読む場所は import.meta.url からの相対。ビルドでは core の dist/ に guide-*.md をコピーし（root の package.json の build）、
// 束ねた拡張（VS Code）は bundle（dist/extension.cjs）の隣に置く（packages/vscode/package.json の build）。ずれると読めないので両方を直す

import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { UsageError } from "../errors.js";
import { type Config } from "../model/config.js";
import { findGuideSection } from "./sections.js";

/** 流れの順に並べる。frontmatter に description を持つトピックは dg<トピック> の Skill として配る（AG-2）。overview・run・parallel・review は Skill を持たず、ほかのトピックから読む */
export const GUIDE_TOPICS = [
  "overview",
  "import",
  "assign",
  "check",
  "plan",
  "work",
  "run",
  "parallel",
  "review",
  "audit",
  "release",
  "done",
  "all",
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

/** guide の frontmatter。Skill の説明と引数の案内の正本 */
export interface GuideMeta {
  description?: string;
  "argument-hint"?: string;
}

function isGuideTopic(topic: string): topic is GuideTopic {
  return (GUIDE_TOPICS as readonly string[]).includes(topic);
}

/** `{{git.base_branch}}` のような項目を config の値で埋める。配列は `, ` でつなぎ、空の配列と空の文字列は「なし」 */
export function fillPlaceholders(text: string, config: Config): string {
  return text.replace(/\{\{([a-z_.]+)\}\}/g, (whole, key: string) => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (cur, k) =>
          cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined,
        config,
      );
    if (value === undefined || value === null) return whole;
    if (Array.isArray(value)) return value.length === 0 ? "なし" : value.map(String).join(", ");
    if (value === "") return "なし";
    return String(value);
  });
}

/** 先頭の frontmatter を外し、メタデータと本文に分ける */
function splitFrontmatter(raw: string): { meta: GuideMeta; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n+/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  return { meta: (parseYaml(match[1]!) ?? {}) as GuideMeta, body: raw.slice(match[0].length) };
}

async function readGuideFile(topic: string): Promise<{ meta: GuideMeta; body: string }> {
  if (!isGuideTopic(topic)) {
    throw new UsageError(`guide のトピック ${topic} はない。${GUIDE_TOPICS.join(" / ")} のどれか`);
  }
  return splitFrontmatter(await readFile(new URL(`./guide-${topic}.md`, import.meta.url), "utf8"));
}

/** guide.notes.<topic> の文書の読み込み結果。読めなければ差し込まず、理由を warnings に入れて guide は出す */
export interface GuideNotes {
  text: string;
  warnings: string[];
}

/** 題名（# の行）の直後に文書を差し込む。題名がなければ先頭に置く */
function insertNotes(body: string, notes: string): string {
  if (notes === "") return body;
  const lines = body.split("\n");
  const title = lines.findIndex((line) => line.startsWith("# "));
  lines.splice(title < 0 ? 0 : title + 1, 0, "", notes);
  return lines.join("\n");
}

/**
 * 本文を返す。notes があれば題名の直後に差し込み、`{{choices}}` の行は共通の「選択肢で聞く」の節（guide-choices.md）に置き換える。
 * notes は readGuideNotes の text（既定は差し込まない）
 */
export async function readGuide(topic: string, notes = ""): Promise<string> {
  const { body: raw } = await readGuideFile(topic);
  const body = insertNotes(raw, notes);
  if (!/^\{\{choices\}\}$/m.test(body)) return body;
  const choices = (await readFile(new URL("./guide-choices.md", import.meta.url), "utf8")).trim();
  return body.replace(/^\{\{choices\}\}$/m, () => choices);
}

/** guide.notes の文書の大きさの上限。guide は毎回読むので、長い文書は差し込まず警告を返す */
const NOTES_MAX_BYTES = 64 * 1024;

/** 見出し（# の行）があるか。コードブロックの中の # は見出しとして数えない（シェルのコメントなど） */
function hasHeadingOutsideCode(content: string): boolean {
  let fence: string | undefined;
  for (const line of content.split("\n")) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined) {
      if (mark !== undefined) fence = mark;
      else if (/^#{1,6}\s/.test(line)) return true;
    } else if (
      mark !== undefined &&
      mark[0] === fence[0] &&
      mark.length >= fence.length &&
      line.trim() === mark
    ) {
      fence = undefined;
    }
  }
  return false;
}

/**
 * config の guide.notes.<topic> のファイルを読む。パスはリポジトリの最上位（repoTop）からの相対パスで、
 * リポジトリの外・読めないファイル・通常のファイルでないもの・大きすぎるファイル・見出し（#）を含むファイルは差し込まず、警告を返す（guide は出す）。
 * 外かどうかは symlink をたどった先の実体パスで判定する（リポジトリ内の symlink から外の秘密を読ませないため。config と symlink は Git で共有される）
 */
export async function readGuideNotes(
  topic: string,
  config: Config,
  repoTop: string,
): Promise<GuideNotes> {
  const rel = (config.guide.notes as Record<string, string | undefined>)[topic] ?? "";
  if (rel.trim() === "") return { text: "", warnings: [] };
  const key = `guide.notes.${topic}`;
  const warn = (message: string): GuideNotes => ({ text: "", warnings: [`${key} ${message}`] });
  if (isAbsolute(rel)) {
    return warn(
      `の ${rel} はリポジトリの外を指すので差し込まない（リポジトリからの相対パスで書く）`,
    );
  }
  const top = await realpath(repoTop).catch(() => resolve(repoTop));
  const real = await realpath(resolve(top, rel)).catch(() => undefined);
  if (real === undefined) return warn(`のファイル ${rel} を読めないので差し込まない`);
  const inside = relative(top, real);
  if (inside === "") {
    return warn(`の ${rel} はリポジトリの最上位を指すので差し込まない（ファイルのパスで書く）`);
  }
  if (inside.split(sep)[0] === ".." || isAbsolute(inside)) {
    return warn(
      `の ${rel} はリポジトリの外を指すので差し込まない（リポジトリからの相対パスで書く。symlink の先も見る）`,
    );
  }
  const info = await stat(real).catch(() => undefined);
  if (info === undefined) return warn(`のファイル ${rel} を読めないので差し込まない`);
  if (!info.isFile()) return warn(`のファイル ${rel} は通常のファイルでないので差し込まない`);
  if (info.size > NOTES_MAX_BYTES) {
    return warn(`のファイル ${rel} は ${NOTES_MAX_BYTES / 1024} KiB を超えるので差し込まない`);
  }
  const content = await readFile(real, "utf8").catch(() => undefined);
  if (content === undefined) return warn(`のファイル ${rel} を読めないので差し込まない`);
  if (hasHeadingOutsideCode(content)) {
    return warn(`のファイル ${rel} に見出し（#）があるので差し込まない。見出しを外す`);
  }
  return { text: content.trim(), warnings: [] };
}

export async function readGuideMeta(topic: string): Promise<GuideMeta> {
  return (await readGuideFile(topic)).meta;
}

/** composeGuide の結果。section は節を指したときだけ見出しの文言、トピック全体のときは null */
export interface GuideText {
  topic: GuideTopic;
  section: string | null;
  /** 本文。guide.notes の文書と config の値（`{{…}}` の項目）を埋めてある */
  text: string;
  /** guide.notes の文書を差し込めなかった理由（guide は差し込まずに出す） */
  warnings: string[];
}

/**
 * guide の本文を組む唯一の処理（dg guide・dg next・dg brief・dg flow next がこれを使い、写すだけにする）。
 * section を省くとトピック全体。指定すると、その節の本文だけ（見出しの文言か「（…）」を除いた名前）。
 * guide.notes の文書は、トピック全体では題名の直後、節では節の見出しの直後に差し込む（節だけ出しても判断の基準が付く）。
 * repoTop は作業ツリーの最上位（guide.notes のパスの基準）。初期化前の dg guide は既定の config と cwd を渡す
 */
export async function composeGuide(
  topic: string,
  config: Config,
  repoTop: string,
  section?: string,
): Promise<GuideText> {
  const notes = await readGuideNotes(topic, config, repoTop);
  if (section === undefined) {
    const body = await readGuide(topic, notes.text);
    return {
      topic: topic as GuideTopic,
      section: null,
      text: fillPlaceholders(body, config).trimEnd(),
      warnings: notes.warnings,
    };
  }
  const picked = findGuideSection(topic, await readGuide(topic), section);
  const [heading = "", ...rest] = picked.text.split("\n");
  const withNotes = notes.text === "" ? picked.text : [heading, "", notes.text, ...rest].join("\n");
  return {
    topic: topic as GuideTopic,
    section: picked.heading,
    text: fillPlaceholders(withNotes, config).trimEnd(),
    warnings: notes.warnings,
  };
}
