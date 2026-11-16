// guide の本文（guide-*.md・同じフォルダ）の読み込み（ADR-030）。frontmatter の分離・{{choices}} と推薦の指標の表（{{recommended_metrics}}）の差し込み・config の値の埋め込み・
// guide.notes の文書の差し込みと、節の本文の取り出しと、独自の段階の手順の文書の読み込みを Core が行う。dg guide（CLI）・dg next・dg brief・dg flow next はここを写す。
// 読む場所は import.meta.url からの相対。ビルドでは core の dist/ に guide-*.md をコピーし（root の package.json の build）、
// 束ねた拡張（VS Code）は bundle（dist/extension.cjs）の隣に置く（packages/vscode/package.json の build）。ずれると読めないので両方を直す。
// 拡張に同梱した CLI（dist/cli/dg.mjs）は、同じ dist/ の本文を bundleLayout の guideDir から読む（二重に入れない）

import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { bundleLayout } from "../bundle-layout.js";
import { UsageError } from "../errors.js";
import { type Config } from "../model/config.js";
import { recommendedRetroMetricsTable } from "../model/retro-recommended.js";
import { findGuideSection } from "./sections.js";
import { GUIDE_TOPICS, type GuideTopic } from "./topics.js";

/** guide の frontmatter。Skill の説明と引数の案内の正本 */
export interface GuideMeta {
  description?: string;
  "argument-hint"?: string;
}

function isGuideTopic(topic: string): topic is GuideTopic {
  return (GUIDE_TOPICS as readonly string[]).includes(topic);
}

/** `{{git.base_branch}}` のような項目を config の値で埋める。配列は `, ` でつなぎ、空の配列と空の文字列は none（英語の guide に日本語を混ぜない） */
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
    if (Array.isArray(value)) return value.length === 0 ? "none" : value.map(String).join(", ");
    if (value === "") return "none";
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
    throw new UsageError(`No guide topic ${topic}. Use one of: ${GUIDE_TOPICS.join(" / ")}`);
  }
  return splitFrontmatter(await readFile(guideFile(`guide-${topic}.md`), "utf8"));
}

/** guide の本文のファイル。束ねた CLI では guideDir、そうでなければこのモジュールの隣 */
function guideFile(name: string): URL {
  const dir = bundleLayout()?.guideDir;
  return dir === undefined
    ? new URL(`./${name}`, import.meta.url)
    : pathToFileURL(resolve(dir, name));
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
 * 本文を返す。notes があれば題名の直後に差し込み、`{{choices}}` の行は共通の "Asking with choices" の節（guide-choices.md）に置き換える。
 * `{{recommended_metrics}}` の行は、core が持つ振り返りの推薦の指標の表に置き換える（表を guide に写さず、データから作る）。
 * notes は readGuideNotes の text（既定は差し込まない）
 */
export async function readGuide(topic: string, notes = ""): Promise<string> {
  const { body: raw } = await readGuideFile(topic);
  const body = insertNotes(raw, notes).replace(/^\{\{recommended_metrics\}\}$/m, () =>
    recommendedRetroMetricsTable(),
  );
  if (!/^\{\{choices\}\}$/m.test(body)) return body;
  const choices = (await readFile(guideFile("guide-choices.md"), "utf8")).trim();
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

/** リポジトリの文書を読んだ結果。読めなければ、理由（problem）と直し方（hint）を返す */
type RepoDocument = { content: string } | { problem: string; hint?: string };

/**
 * リポジトリの文書（guide.notes の文書と、独自の段階の手順の文書）を読む。パスはリポジトリの最上位（repoTop）からの相対パスで、
 * リポジトリの外・読めないファイル・通常のファイルでないもの・大きすぎるファイルは読まず、理由を返す。
 * 外かどうかは symlink をたどった先の実体パスで判定する（リポジトリ内の symlink から外の秘密を読ませないため。config・workflow.yaml と symlink は Git で共有される）
 */
async function readRepoDocument(rel: string, repoTop: string): Promise<RepoDocument> {
  if (isAbsolute(rel)) {
    return {
      problem: `${rel} is outside the repository`,
      hint: "write a path relative to the repository",
    };
  }
  const unreadable = { problem: `file ${rel} cannot be read` };
  const top = await realpath(repoTop).catch(() => resolve(repoTop));
  const real = await realpath(resolve(top, rel)).catch(() => undefined);
  if (real === undefined) return unreadable;
  const inside = relative(top, real);
  if (inside === "") {
    return { problem: `${rel} is the repository root`, hint: "write a file path" };
  }
  if (inside.split(sep)[0] === ".." || isAbsolute(inside)) {
    return {
      problem: `${rel} is outside the repository`,
      hint: "write a path relative to the repository; symlink targets are checked too",
    };
  }
  const info = await stat(real).catch(() => undefined);
  if (info === undefined) return unreadable;
  if (!info.isFile()) return { problem: `file ${rel} is not a regular file` };
  if (info.size > NOTES_MAX_BYTES) {
    return { problem: `file ${rel} is over ${NOTES_MAX_BYTES / 1024} KiB` };
  }
  const content = await readFile(real, "utf8").catch(() => undefined);
  return content === undefined ? unreadable : { content };
}

/** 読めなかった文書の警告。key は設定の場所、consequence は読めなかった結果（差し込まない・手順なしで返す） */
function documentWarning(
  key: string,
  doc: { problem: string; hint?: string },
  consequence: string,
): string {
  return `${key} ${doc.problem}, so ${consequence}${doc.hint === undefined ? "" : ` (${doc.hint})`}`;
}

/**
 * config の guide.notes.<topic> のファイルを読む。読めないファイル（readRepoDocument）と見出し（#）を含むファイルは差し込まず、警告を返す（guide は出す）
 */
export async function readGuideNotes(
  topic: string,
  config: Config,
  repoTop: string,
): Promise<GuideNotes> {
  const rel = (config.guide.notes as Record<string, string | undefined>)[topic] ?? "";
  if (rel.trim() === "") return { text: "", warnings: [] };
  const key = `guide.notes.${topic}`;
  const doc = await readRepoDocument(rel, repoTop);
  if (!("content" in doc)) {
    return { text: "", warnings: [documentWarning(key, doc, "it is not inserted")] };
  }
  if (hasHeadingOutsideCode(doc.content)) {
    return {
      text: "",
      warnings: [`${key} file ${rel} has a heading (#), so it is not inserted. Remove the heading`],
    };
  }
  return { text: doc.content.trim(), warnings: [] };
}

/**
 * 独自の段階（workflow.yaml の flow の decide・after・guide）の手順の文書を読む（dg flow next が本文として返す）。
 * 文書は書いたまま返す（見出しがあってよく、config の値は埋めない。利用者の文書の `{{…}}` を書き換えない）。
 * 読めなければ本文を空にして警告を返し、段階は返す（guide.notes と同じ扱い。段階を落とすと、関所を通さずに次へ進んでしまう）
 */
export async function readStageGuide(
  stage: { id: string; guide: string },
  repoTop: string,
): Promise<GuideNotes> {
  const doc = await readRepoDocument(stage.guide, repoTop);
  if ("content" in doc) return { text: doc.content.trim(), warnings: [] };
  return {
    text: "",
    warnings: [
      documentWarning(
        `flow.${stage.id}.guide`,
        doc,
        "the stage is returned without its steps. Fix the path in workflow.yaml or add the file",
      ),
    ],
  };
}

export async function readGuideMeta(topic: string): Promise<GuideMeta> {
  return (await readGuideFile(topic)).meta;
}

/**
 * composeGuide の結果。sections は指した節ごとの見出しの文言（トピック全体のときは空）。
 * section はその先頭（dg guide --json の互換のため）、トピック全体のときは null
 */
export interface GuideText {
  topic: GuideTopic;
  section: string | null;
  sections: string[];
  /** 本文。guide.notes の文書と config の値（`{{…}}` の項目）を埋めてある */
  text: string;
  /** guide.notes の文書を差し込めなかった理由（guide は差し込まずに出す） */
  warnings: string[];
}

/**
 * guide の本文を組む唯一の処理（dg guide・dg next・dg brief・dg flow next がこれを使い、写すだけにする）。
 * sections を省くか空ならトピック全体。節を 1 つか並べて指すと、その節の本文だけ（見出しの文言か「（…）」を除いた名前）を
 * 指した順に空行でつなぐ（dg guide --section の重ね指定と dg flow next）。
 * guide.notes の文書は、トピック全体では題名の直後、節では最初の節の見出しの直後に 1 度だけ差し込む（節だけ出しても判断の基準が付く）。
 * repoTop は作業ツリーの最上位（guide.notes のパスの基準）。初期化前の dg guide は既定の config と cwd を渡す
 */
export async function composeGuide(
  topic: string,
  config: Config,
  repoTop: string,
  sections: string | readonly string[] = [],
): Promise<GuideText> {
  const wanted = typeof sections === "string" ? [sections] : sections;
  const notes = await readGuideNotes(topic, config, repoTop);
  if (wanted.length === 0) {
    const body = await readGuide(topic, notes.text);
    return {
      topic: topic as GuideTopic,
      section: null,
      sections: [],
      text: fillPlaceholders(body, config).trimEnd(),
      warnings: notes.warnings,
    };
  }
  const body = await readGuide(topic);
  const picked = wanted.map((s) => findGuideSection(topic, body, s));
  const joined = picked.map((p) => p.text).join("\n\n");
  const [heading = "", ...rest] = joined.split("\n");
  const withNotes = notes.text === "" ? joined : [heading, "", notes.text, ...rest].join("\n");
  return {
    topic: topic as GuideTopic,
    section: picked[0]!.heading,
    sections: picked.map((p) => p.heading),
    text: fillPlaceholders(withNotes, config).trimEnd(),
    warnings: notes.warnings,
  };
}
