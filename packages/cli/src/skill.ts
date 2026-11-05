// dg skill install：dg guide を読む薄い Claude Code の Skill を段階ごとに置く（AG-2）。Skill は手順を持たず、正本は guide-*.md（CL-5）。
// 名前・説明・引数の案内は guide の frontmatter から、本文は隣の skill.md から作る。ビルドでは dist/ にコピーする（package.json の build）

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveRepoPaths } from "@deguboard/core";
import { stringify as stringifyYaml } from "yaml";
import { GUIDE_TOPICS, readGuide, readGuideMeta, type GuideTopic } from "./guide.js";

/** 廃止した Skill と、手を加えていないとみなす中身の sha256。一致すれば消し、違えば残して知らせる */
const RETIRED_SKILLS: Record<string, string[]> = {
  deguboard: ["490a7544e6cb3b3c697b76113bd496fb7b2dd9e531e87762b08b83e5cd4e3606"],
};

/** frontmatter の直後に置く印。本文（印の行を除く）の sha256 で、手を加えたかを見分ける */
const MARKER = /^<!-- dg skill sha256:([0-9a-f]{64}) -->\n/m;

export interface SkillFile {
  /** Skill の名前（dg<トピック>）。置き場所は <基点>/.claude/skills/<名前>/SKILL.md */
  name: string;
  topic: GuideTopic;
  /** 印を含む SKILL.md の中身 */
  content: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** frontmatter に description を持つトピックごとに SKILL.md を作る */
export async function buildSkills(): Promise<SkillFile[]> {
  const template = await readFile(new URL("./skill.md", import.meta.url), "utf8");
  const skills: SkillFile[] = [];
  for (const topic of GUIDE_TOPICS) {
    const meta = await readGuideMeta(topic);
    if (!meta.description) continue;
    const name = `dg${topic}`;
    const title = /^# (.+)$/m.exec(await readGuide(topic))?.[1] ?? name;
    const frontmatter = stringifyYaml(
      { name, description: meta.description, "argument-hint": meta["argument-hint"] ?? "" },
      { lineWidth: 0 },
    );
    const body = template.replaceAll("{{title}}", title).replaceAll("{{topic}}", topic);
    // 整形（mise run format）で変わらない形にする。ハッシュは印の行を除いた中身から求める
    const unmarked = `---\n${frontmatter}---\n\n\n${body}`;
    skills.push({
      name,
      topic,
      content: `---\n${frontmatter}---\n\n<!-- dg skill sha256:${sha256(unmarked)} -->\n\n${body}`,
    });
  }
  return skills;
}

/** 印があり、印を除いた中身のハッシュが印と一致すれば、手を加えていない */
function isUnmodified(text: string): boolean {
  const match = MARKER.exec(text);
  return match !== null && sha256(text.replace(MARKER, "")) === match[1];
}

export interface SkillInstallResult {
  /** project（リポジトリの .claude/skills）か personal（~/.claude/skills）。Claude Code の呼び名に合わせる */
  scope: "project" | "personal";
  /** Skill を置いた .claude/skills の絶対パス */
  dir: string;
  /** 新しく書いた Skill の名前 */
  written: string[];
  /** 手を加えていないので最新の中身で上書きした Skill（--force で上書きしたものも含む） */
  updated: string[];
  /** すでに最新だった Skill */
  unchanged: string[];
  /** 手を加えてあるので残した Skill。--force で上書きする */
  conflicts: string[];
  /** 消した廃止済みの Skill */
  retired: string[];
  /** 手を加えてあるので残した廃止済みの Skill */
  retiredKept: string[];
  /** --dry-run のとき true。書かず消さずに、書く（書いた・更新した）ことになる Skill の置き先と中身を files に返す */
  dryRun: boolean;
  /** --dry-run のときだけ入る。書くことになる SKILL.md の絶対パスと中身 */
  files: Array<{ name: string; path: string; content: string }>;
}

async function readIfExists(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

/**
 * Skill を書く。scope が project なら cwd を含むリポジトリの最上位、personal ならホームディレクトリの下に置く。
 * 手を加えていない Skill は最新の中身で上書きし、手を加えたものは force がなければ残す
 */
export async function installSkill(options: {
  cwd: string;
  scope: "project" | "personal";
  home: string;
  force: boolean;
  /** true なら何も書かず消さず、書く先と中身だけを返す */
  dryRun?: boolean;
}): Promise<SkillInstallResult> {
  const base =
    options.scope === "personal" ? options.home : (await resolveRepoPaths(options.cwd)).topLevel;
  const dir = join(base, ".claude", "skills");
  const dryRun = options.dryRun ?? false;
  const result: SkillInstallResult = {
    scope: options.scope,
    dir,
    written: [],
    updated: [],
    unchanged: [],
    conflicts: [],
    retired: [],
    retiredKept: [],
    dryRun,
    files: [],
  };
  for (const skill of await buildSkills()) {
    const path = join(dir, skill.name, "SKILL.md");
    const current = await readIfExists(path);
    if (current === skill.content) {
      result.unchanged.push(skill.name);
      continue;
    }
    if (current !== undefined && !options.force && !isUnmodified(current)) {
      result.conflicts.push(skill.name);
      continue;
    }
    if (dryRun) result.files.push({ name: skill.name, path, content: skill.content });
    else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, skill.content, "utf8");
    }
    (current === undefined ? result.written : result.updated).push(skill.name);
  }
  for (const [name, hashes] of Object.entries(RETIRED_SKILLS)) {
    const path = join(dir, name, "SKILL.md");
    const current = await readIfExists(path);
    if (current === undefined) continue;
    if (!hashes.includes(sha256(current))) {
      result.retiredKept.push(name);
      continue;
    }
    if (!dryRun) {
      await rm(path);
      // ほかのファイルを置いていればフォルダは残す
      await rmdir(dirname(path)).catch(() => undefined);
    }
    result.retired.push(name);
  }
  return result;
}

/** 結果の警告。手を加えたので残した Skill を知らせる */
export function skillInstallWarnings(result: SkillInstallResult): string[] {
  return [
    ...result.conflicts.map(
      (name) => `${name}: 手を加えてあるので上書きしなかった。上書きするなら --force を付ける`,
    ),
    ...result.retiredKept.map(
      (name) => `${name}: 廃止した Skill だが、手を加えてあるので消さなかった。要らなければ消す`,
    ),
  ];
}
