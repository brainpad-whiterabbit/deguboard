// dg skill install：dg guide を読む薄い Claude Code の Skill を段階ごとに置く（AG-2）。Skill は手順を持たず、正本は guide-*.md（CL-5）。
// 名前・説明・引数の案内は guide の frontmatter から、冒頭の 1 文は core の SKILL_SUMMARY の en から、本文は隣の skill.md から作る。ビルドでは dist/ にコピーする（package.json の build）。
// VS Code 拡張に同梱する dg.mjs の隣（dist/cli/）にも置く（packages/vscode/package.json の build）

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  DG_PATH_NOTE_EN,
  resolveRepoPaths,
  skillDirsOf,
  skillSummary,
  type AgentEnv,
} from "@deguboard/core";
import { stringify as stringifyYaml } from "yaml";
import { ensureIgnoreLines, trackedFiles } from "./gitignore.js";
import { GUIDE_TOPICS, readGuide, readGuideMeta, type GuideTopic } from "./guide.js";

/** 廃止した Skill と、手を加えていないとみなす中身の sha256。一致すれば消し、違えば残して知らせる */
const RETIRED_SKILLS: Record<string, string[]> = {
  deguboard: ["490a7544e6cb3b3c697b76113bd496fb7b2dd9e531e87762b08b83e5cd4e3606"],
};

/** frontmatter の直後に置く印。本文（印の行を除く）の sha256 で、手を加えたかを見分ける */
const MARKER = /^<!-- dg skill sha256:([0-9a-f]{64}) -->\n/m;

export interface SkillFile {
  /** Skill の名前（dg<トピック>）。置き場所は <Skill のディレクトリ>/<名前>/SKILL.md */
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
    const body = template
      .replaceAll("{{title}}", title)
      .replaceAll("{{topic}}", topic)
      .replaceAll("{{summary}}", skillSummary(name, "en"))
      .replaceAll("{{dgPathNote}}", DG_PATH_NOTE_EN);
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
  /** --dry-run のときは、書くことになる SKILL.md の絶対パスと中身。それ以外は空の配列 */
  files: Array<{ name: string; path: string; content: string }>;
  /** この実行で dg の Skill を無視する行を足した .gitignore の絶対パス。足さなかった（すでにある・personal・--dry-run）なら null */
  ignoreFile: string | null;
  /** git が追跡している dg の Skill のファイル（リポジトリの最上位からの相対パス）。無視の行が効かないので警告する。personal は空 */
  tracked: string[];
}

async function readIfExists(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

/**
 * Skill を書く。置き場所は claude-code の Adapter の skillDirs が決め、ask が Skill の有無を見る先と同じになる（AG-5）。
 * scope が project なら cwd を含むリポジトリの最上位、personal ならホームディレクトリ（env の HOME、空か未設定なら OS のホーム）の下。
 * 手を加えていない Skill は最新の中身で上書きし、手を加えたものは force がなければ残す。
 * project では、Skill は各自が入れるものなので、実行のたびに .claude/.gitignore に dg が入れる Skill ごとの無視の行（skills/<名前>/）がなければ足す（--dry-run では書かない）。
 * 無視の行と追跡済みの検出は dg が入れる Skill の名前だけを見る。dg で始まる名前で括ると、利用者が自分で作った dg で始まる Skill まで無視し、git rm --cached を案内してしまう（t804）。
 * 廃止した Skill（RETIRED_SKILLS）の行は足さない。新しく入れることはなく、残っていれば消すか利用者に任せる
 */
export async function installSkill(options: {
  cwd: string;
  scope: "project" | "personal";
  env: AgentEnv;
  force: boolean;
  /** true なら何も書かず消さず、書く先と中身だけを返す */
  dryRun?: boolean;
}): Promise<SkillInstallResult> {
  const dirs = skillDirsOf("claude-code");
  if (!dirs) throw new Error("The claude-code Adapter has no Skill directory");
  const topLevel =
    options.scope === "personal" ? undefined : (await resolveRepoPaths(options.cwd)).topLevel;
  const dir = topLevel === undefined ? dirs.personal(options.env) : dirs.project(topLevel);
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
    ignoreFile: null,
    tracked: [],
  };
  const skills = await buildSkills();
  if (topLevel !== undefined) {
    const ignoreFile = join(dirname(dir), ".gitignore");
    const lines = skills.map((s) => `${basename(dir)}/${s.name}/`);
    if (!dryRun && (await ensureIgnoreLines(ignoreFile, lines))) result.ignoreFile = ignoreFile;
    const names = new Set(skills.map((s) => s.name));
    const prefix = `${relative(topLevel, dir).split(sep).join("/")}/`;
    result.tracked = (await trackedFiles(topLevel, dir)).filter((p) => {
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      return p.startsWith(prefix) && slash !== -1 && names.has(rest.slice(0, slash));
    });
  }
  for (const skill of skills) {
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

/** 結果の警告。手を加えたので残した Skill と、追跡されていて無視の行が効かない Skill を知らせる */
export function skillInstallWarnings(result: SkillInstallResult): string[] {
  // tracked は <Skill のディレクトリ>/<Skill の名前>/... の形（最上位からの相対パス）。Skill のディレクトリは result.dir の末尾と一致する頭なので、
  // その次の段まで（<Skill のディレクトリ>/<Skill の名前>）を Skill ごとに 1 つ案内する
  const dirPath = result.dir.split(sep).join("/");
  const skillDirOf = (p: string) => {
    const segs = p.split("/");
    for (let k = 1; k < segs.length - 1; k++)
      if (dirPath.endsWith(`/${segs.slice(0, k).join("/")}`)) return segs.slice(0, k + 1).join("/");
    return p;
  };
  const trackedDirs = [...new Set(result.tracked.map(skillDirOf))].sort();
  return [
    ...(trackedDirs.length === 0
      ? []
      : [
          `${result.tracked.length} dg Skill file(s) are tracked by git, so the ignore lines in .gitignore do not apply to them. ` +
            `Each person installs the Skills with dg skill install. Stop tracking them at the repository root with git rm -r --cached ${trackedDirs.join(" ")} and commit (the files stay on disk)`,
        ]),
    ...result.conflicts.map(
      (name) =>
        `${name}: it was edited by hand, so it ${result.dryRun ? "will not be" : "was not"} overwritten. To overwrite it, add --force. ` +
        `Move the text you added out of SKILL.md into a document and insert it with dg config set guide.notes.${name.replace(/^dg/, "")} <path> (guide and the Skill keep receiving updates)`,
    ),
    ...result.retiredKept.map(
      (name) =>
        `${name}: this Skill is retired, but it was edited by hand, so it ${result.dryRun ? "will not be" : "was not"} removed. Remove it yourself if you do not need it`,
    ),
  ];
}
