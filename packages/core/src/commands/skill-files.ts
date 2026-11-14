// dg が配る Skill の中身と、入れてある Skill が今の dg のものと違うか・古いかの判定（AG-2）。
// dg skill install（CLI）が書くか残すかを決めるのも、dg hooks check・dg next・dg brief が古い Skill を知らせるのも、
// VS Code 拡張が起動時に古い Skill を更新するのも、ここの skillStateOf を通す（判定を 2 つ持たない）。
// 警告と拡張は、そのうえで印の版を比べ（skillAgeOf）、今の dg より新しい版の dg が書いた Skill を古いと言わず、戻さない（ADR-030）。
// Skill を書くのも、dg skill install と拡張で同じ writeSkillFiles を通す。
// 公開（commands/index.ts）は入口が呼ぶものだけにする。判定の部品（skillStateOf・skillAgeOf・findStaleSkills・staleSkillWarnings）はここのテストが直接引く。
// Skill の組み立て（buildSkills）は guide を読むので、1 回の操作で 1 回にし、組み立てたものを部品に渡して使い回す。
// 名前・説明・引数の案内は guide の frontmatter から、冒頭の 1 文は SKILL_SUMMARY の en から、本文は SKILL_TEMPLATE から作る。
// 雛形をファイルにせず定数にするのは、束ねた配置（拡張の extension.cjs・同梱の dg.mjs）でも置き場所を合わせずに読めるようにするため

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentSkillPlaces, type AgentEnv, type SkillPlace } from "../agents/index.js";
import { coreVersion } from "../bundle-layout.js";
import { resolveRepoPaths } from "../git/index.js";
import { readGuide, readGuideMeta } from "../guide/guide.js";
import { GUIDE_TOPICS, type GuideTopic } from "../guide/topics.js";
import { stringify as stringifyYaml } from "yaml";
import { DG_PATH_NOTE_EN, skillSummary } from "./ask.js";

/** SKILL.md の本文の雛形。Skill は手順を持たず、dg guide を読ませるだけにする（正本は guide-*.md。CL-5） */
const SKILL_TEMPLATE = `# {{title}}

{{summary}}

Run \`dg guide {{topic}}\` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call \`dg\` with \`--json --actor agent\` (for example \`dg --json --actor agent ticket show t12\`). You identify as the agent. If an operation is refused (\`TRANSITION_REJECTED\`), ask a human to do it
- Read and write tickets only with \`dg\`. Do not edit the data files (under \`.git/deguboard/\`) directly
- {{dgPathNote}}

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
`;

/**
 * frontmatter の直後に置く印。書いた dg の版と、本文（印の行を除く）の sha256 を持つ。
 * ハッシュで手を加えたかを、版で今の dg より古いか新しいかを見分ける。版のない印は、版を書く前の dg が書いたもの
 */
const MARKER = /^<!-- dg skill (?:v(\d+\.\d+\.\d+)\S* )?sha256:([0-9a-f]{64}) -->\n/m;

/** 印の版（major.minor.patch）とハッシュ。印がなければ undefined */
function markerOf(text: string): { version: string | undefined; hash: string } | undefined {
  const match = MARKER.exec(text);
  return match ? { version: match[1], hash: match[2]! } : undefined;
}

export interface SkillFile {
  /** Skill の名前（dg<トピック>）。置き場所は <Skill のディレクトリ>/<名前>/SKILL.md */
  name: string;
  topic: GuideTopic;
  /** 印を含む SKILL.md の中身 */
  content: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * frontmatter に description を持つトピックごとに SKILL.md を作る。印に書く版（version）は、省くと core の版。
 * 束ねた VS Code 拡張は core の版を読めないので、ビルドで埋めた版を渡す。読めない版（空など）は印に書かない
 */
export async function buildSkills(version?: string): Promise<SkillFile[]> {
  const mine = version ?? (await coreVersion());
  const tag = /^\d+\.\d+\.\d+\S*$/.test(mine) ? `v${mine} ` : "";
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
    const body = SKILL_TEMPLATE.replaceAll("{{title}}", title)
      .replaceAll("{{topic}}", topic)
      .replaceAll("{{summary}}", skillSummary(name, "en"))
      .replaceAll("{{dgPathNote}}", DG_PATH_NOTE_EN);
    // 整形（mise run format）で変わらない形にする。ハッシュは印の行を除いた中身から求める
    const unmarked = `---\n${frontmatter}---\n\n\n${body}`;
    skills.push({
      name,
      topic,
      content: `---\n${frontmatter}---\n\n<!-- dg skill ${tag}sha256:${sha256(unmarked)} -->\n\n${body}`,
    });
  }
  return skills;
}

/**
 * 入れてある SKILL.md と今の dg の Skill の関係。版は見ない（新旧は skillAgeOf）。
 * missing は入れていない、current は今の dg のものと中身が同じ（印の版だけが違うものも含む）、
 * stale は手を加えていないが今の dg のものと中身が違う（dg skill install が上書きする）、
 * edited は手を加えてあって今の dg のものと違う（dg skill install は残し、--force で上書きする）
 */
export type SkillState = "missing" | "current" | "stale" | "edited";

/** 印があり、印を除いた中身のハッシュが印と一致すれば、手を加えていない */
function isUnmodified(text: string): boolean {
  const marker = markerOf(text);
  return marker !== undefined && sha256(text.replace(MARKER, "")) === marker.hash;
}

/**
 * 入れてある SKILL.md の中身（なければ undefined）を、今の dg の Skill と比べる。
 * 手を加えておらず本文のハッシュが同じなら、印の版が違っても current（版を上げただけで本文の変わらない Skill を、古いと知らせも書き直しもしない）
 */
export function skillStateOf(current: string | undefined, skill: SkillFile): SkillState {
  if (current === undefined) return "missing";
  if (current === skill.content) return "current";
  if (!isUnmodified(current)) return "edited";
  return hasCurrentBody(current, skill) ? "current" : "stale";
}

/** 入れてある SKILL.md の印のハッシュが、今の dg の Skill の印と同じか（手を加えたものなら、今の本文をもとに手を加えたもので、古くはない） */
function hasCurrentBody(current: string, skill: SkillFile): boolean {
  const base = markerOf(current)?.hash;
  return base !== undefined && base === markerOf(skill.content)?.hash;
}

/**
 * 入れてある SKILL.md を書いた dg の版が、今の dg より古いか・同じか・新しいか。major.minor.patch だけを比べる。
 * 印に版のないもの（版を書く前の dg が書いた）と印のないものは older。今の dg の版が読めないときも older（中身の違いだけで見ていた前の扱いに戻る）
 */
export type SkillAge = "older" | "same" | "newer";

export function skillAgeOf(current: string, skill: SkillFile): SkillAge {
  const parts = (text: string) => markerOf(text)?.version?.split(".").map(Number);
  const theirs = parts(current);
  const mine = parts(skill.content);
  if (theirs === undefined || mine === undefined) return "older";
  for (let i = 0; i < 3; i++)
    if (theirs[i] !== mine[i]) return theirs[i]! < mine[i]! ? "older" : "newer";
  return "same";
}

/**
 * 置き場所ごとの、今の dg のものと中身が違う Skill。今の dg より新しい版の dg が書いたものは入れない
 * （古いのは今の dg の方で、知らせても書き換えても、新しい dg と書き換え合うだけになる）
 */
export interface StaleSkills extends SkillPlace {
  /** 古い版の dg が書いた、手を加えていない Skill の名前。dg skill install で更新できる */
  stale: string[];
  /** 古い版の dg が書いた、手を加えてある Skill の名前。dg skill install は残し、--force で上書きする */
  edited: string[];
  /** 今の dg と同じ版の dg が書いたが中身の違う、手を加えていない Skill の名前（版を上げずに Skill を変えた開発中の dg）。どちらが新しいかは分からない */
  sameVersion: string[];
  /** sameVersion のうち、手を加えてあるもの */
  sameVersionEdited: string[];
}

/** 同じディレクトリの置き場所を 1 つにする（先に出たものを残す）。リポジトリがホームディレクトリのときと、個人の置き場所を複数のフォルダから見るとき */
function uniquePlaces(places: readonly SkillPlace[]): SkillPlace[] {
  const seen = new Set<string>();
  return places.filter((p) => {
    if (seen.has(p.dir)) return false;
    seen.add(p.dir);
    return true;
  });
}

/**
 * 置き場所ごとに、入れてある dg の Skill のうち今の dg のもの（skills）と違うものを返す。
 * 違うものがない置き場所は返さない。入れていない Skill は数えない（Skill は任意で、足りないことは知らせない）。
 * 今の本文をもとに手を加えた Skill（印のハッシュが今の dg のものと同じ）も数えない。古くはなく、知らせても毎回同じ警告が出続けるだけになる。
 * 今の dg より新しい版の dg が書いた Skill も数えない。古い版と同じ版は分けて返す（skillAgeOf）。
 * 印を消した Skill はもとの版が分からないので、古いものとして edited に入れる
 */
async function staleSkillsIn(
  places: readonly SkillPlace[],
  skills: readonly SkillFile[],
): Promise<StaleSkills[]> {
  const found: StaleSkills[] = [];
  for (const place of uniquePlaces(places)) {
    const names: Omit<StaleSkills, keyof SkillPlace> = {
      stale: [],
      edited: [],
      sameVersion: [],
      sameVersionEdited: [],
    };
    for (const skill of skills) {
      const current = await readFile(join(place.dir, skill.name, "SKILL.md"), "utf8").catch(
        () => undefined,
      );
      const state = skillStateOf(current, skill);
      if (current === undefined || (state !== "stale" && state !== "edited")) continue;
      if (state === "edited" && hasCurrentBody(current, skill)) continue;
      const age = skillAgeOf(current, skill);
      if (age === "newer") continue;
      const unmodified = state === "stale";
      if (age === "older") (unmodified ? names.stale : names.edited).push(skill.name);
      else (unmodified ? names.sameVersion : names.sameVersionEdited).push(skill.name);
    }
    if (Object.values(names).some((n) => n.length > 0)) found.push({ ...place, ...names });
  }
  return found;
}

/**
 * リポジトリ（topLevel の下）と個人（env の HOME の下）の Skill のディレクトリを見て、入れてある dg の Skill のうち今の dg のものと違うものを返す
 * （数え方は staleSkillsIn）。topLevel を省くと個人の置き場所だけを見る（リポジトリの外）
 */
export async function findStaleSkills(query: {
  topLevel?: string | undefined;
  env: AgentEnv;
}): Promise<StaleSkills[]> {
  return staleSkillsIn(agentSkillPlaces(query), await buildSkills());
}

/** 1 つの Skill のディレクトリに dg の Skill を書いた結果 */
export interface SkillWriteResult {
  /** 新しく書いた Skill の名前 */
  written: string[];
  /** 手を加えていないので最新の中身で上書きした Skill（force で上書きしたものも含む） */
  updated: string[];
  /** すでに最新だった Skill */
  unchanged: string[];
  /** 手を加えてあるので残した Skill。force で上書きする */
  conflicts: string[];
  /** dryRun のときは、書くことになる SKILL.md の絶対パスと中身。それ以外は空の配列 */
  files: Array<{ name: string; path: string; content: string }>;
}

/**
 * dir（Skill のディレクトリ）に dg の Skill を書く。dg skill install（CLI）と、VS Code 拡張が起動時に古い Skill を更新するのが、ここを通す。
 * 手を加えていない Skill は今の dg の中身で上書きし、手を加えたものは force がなければ残す。
 * 版は見ない。dg skill install は人が打つ操作なので、新しい版の dg が書いた Skill も、打った dg のものにする（版で止めるのは、自動で書く拡張だけ）。
 * names を渡すと、その名前の Skill だけを扱う（拡張は入れてある古い Skill だけを渡し、入れていない Skill を足さない）。dryRun なら書かずに中身を返す。
 * skills は呼び出し側がすでに組み立てた Skill（省くとここで組み立てる）
 */
export async function writeSkillFiles(
  dir: string,
  options: {
    force: boolean;
    dryRun?: boolean;
    names?: readonly string[];
    skills?: readonly SkillFile[];
  },
): Promise<SkillWriteResult> {
  const result: SkillWriteResult = {
    written: [],
    updated: [],
    unchanged: [],
    conflicts: [],
    files: [],
  };
  const skills = (options.skills ?? (await buildSkills())).filter(
    (s) => options.names === undefined || options.names.includes(s.name),
  );
  for (const skill of skills) {
    const path = join(dir, skill.name, "SKILL.md");
    const current = await readFile(path, "utf8").catch(() => undefined);
    const state = skillStateOf(current, skill);
    if (state === "current") {
      result.unchanged.push(skill.name);
      continue;
    }
    if (state === "edited" && !options.force) {
      result.conflicts.push(skill.name);
      continue;
    }
    if (options.dryRun) result.files.push({ name: skill.name, path, content: skill.content });
    else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, skill.content, "utf8");
    }
    (state === "missing" ? result.written : result.updated).push(skill.name);
  }
  return result;
}

/** 置き場所ごとの、VS Code 拡張が更新した Skill と、手を加えてあるので残した古い Skill */
export interface RefreshedSkills extends SkillPlace {
  /** 古い版の dg が書いた手を加えていない Skill のうち、今の dg のもので上書きした Skill の名前 */
  updated: string[];
  /** 古い版の dg が書いた、手を加えてある Skill の名前。書き換えず、dg skill install --force で上書きできることを知らせる */
  edited: string[];
}

/** 廃止した Skill と、手を加えていないとみなす中身の sha256。一致すれば消し、違えば残して知らせる */
const RETIRED_SKILLS: Record<string, string[]> = {
  deguboard: ["490a7544e6cb3b3c697b76113bd496fb7b2dd9e531e87762b08b83e5cd4e3606"],
};

/**
 * dir（Skill のディレクトリ）に残っている廃止済みの Skill を片付ける（dg skill install）。
 * 手を加えていないものは消して retired に、手を加えたものは残して retiredKept に返す。dryRun なら消さずに同じ分け方を返す
 */
export async function removeRetiredSkills(
  dir: string,
  options: { dryRun?: boolean } = {},
): Promise<{ retired: string[]; retiredKept: string[] }> {
  const result: { retired: string[]; retiredKept: string[] } = { retired: [], retiredKept: [] };
  for (const [name, hashes] of Object.entries(RETIRED_SKILLS)) {
    const path = join(dir, name, "SKILL.md");
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === undefined) continue;
    if (!hashes.includes(sha256(current))) {
      result.retiredKept.push(name);
      continue;
    }
    if (!options.dryRun) {
      await rm(path);
      // ほかのファイルを置いていればフォルダは残す
      await rmdir(dirname(path)).catch(() => undefined);
    }
    result.retired.push(name);
  }
  return result;
}

/**
 * VS Code 拡張が起動のたびに、開いている作業フォルダ（folders）を渡して呼ぶ。フォルダごとのリポジトリと個人の置き場所を見て、
 * 入れてある dg の Skill のうち、今の dg より古い版の dg が書いたもの（印に版のないものを含む）で中身の違うものを見つけ（staleSkillsIn）、
 * 手を加えていないものを writeSkillFiles（dg skill install と同じ処理）で上書きする。手を加えたものは書き換えずに返す。
 * リポジトリの外のフォルダは個人の置き場所だけを見る。フォルダがなくても個人の置き場所は見る。
 * 個人の置き場所はどのフォルダからも同じで、同じリポジトリのフォルダも重なるので、置き場所（dir）ごとに 1 回だけ見る。
 * 入れていない Skill は足さず、dg の Skill のない置き場所には書かない（Skill は任意で、各自が入れる。AG-2）。
 * 変えるものも知らせるものもない置き場所は返さない。
 * 新しい版の dg が書いた Skill と、同じ版の dg が書いた中身の違う Skill には触れず、知らせもしない。
 * 中身の違いだけで同梱のものに揃えると、PATH の dg（ソースから動かす dg）が拡張より新しいときに、拡張は起動のたびに Skill を古い同梱のものに戻し、
 * dg hooks check・next・brief はそれを古いと警告して、互いに書き換え合う。ソースの dg は版を上げる前に Skill を変えるので、同じ版でも止める。
 * version は印に書く今の dg の版（束ねた拡張はビルドで埋めた版を渡す。省くと core の版）
 */
export async function refreshInstalledSkills(query: {
  folders: readonly string[];
  env: AgentEnv;
  version?: string;
}): Promise<RefreshedSkills[]> {
  const tops: Array<string | undefined> = [];
  for (const folder of query.folders)
    tops.push(
      await resolveRepoPaths(folder).then(
        (p) => p.topLevel,
        () => undefined,
      ),
    );
  if (tops.length === 0) tops.push(undefined);
  const places = tops.flatMap((topLevel) => agentSkillPlaces({ topLevel, env: query.env }));
  const skills = await buildSkills(query.version);
  const refreshed: RefreshedSkills[] = [];
  for (const found of await staleSkillsIn(places, skills)) {
    const updated =
      found.stale.length === 0
        ? []
        : (await writeSkillFiles(found.dir, { force: false, names: found.stale, skills })).updated;
    if (updated.length > 0 || found.edited.length > 0)
      refreshed.push({ scope: found.scope, dir: found.dir, updated, edited: found.edited });
  }
  return refreshed;
}

/**
 * 今の dg のものと違う Skill の警告の文。手を加えていないもの（dg skill install で更新）と、手を加えたもの（--force で上書き）を分けて出す。
 * 「older」と書くのは古い版の dg が書いたものだけ。同じ版の dg が書いたものは新旧が分からないので「differ」と書く
 */
export function staleSkillWarnings(found: readonly StaleSkills[]): string[] {
  return found.flatMap((f) => {
    const install = `dg skill install${f.scope === "personal" ? " --personal" : ""}`;
    const line = (names: readonly string[], text: (list: string) => string) =>
      names.length === 0 ? [] : [text(names.join(", "))];
    return [
      ...line(
        f.stale,
        (list) =>
          `These dg Skills in ${f.dir} are older than this dg (an older version of dg wrote them): ${list}. Update them with ${install}`,
      ),
      ...line(
        f.edited,
        (list) =>
          `These dg Skills in ${f.dir} are older than this dg and were edited by hand, so ${install} keeps them: ${list}. To overwrite them with the current Skills, run ${install} --force`,
      ),
      ...line(
        f.sameVersion,
        (list) =>
          `These dg Skills in ${f.dir} differ from the Skills of this dg, though a dg of the same version wrote them (which is newer is unknown): ${list}. To replace them with the Skills of this dg, run ${install}`,
      ),
      ...line(
        f.sameVersionEdited,
        (list) =>
          `These dg Skills in ${f.dir} differ from the Skills of this dg (a dg of the same version wrote them) and were edited by hand, so ${install} keeps them: ${list}. To overwrite them with the Skills of this dg, run ${install} --force`,
      ),
    ];
  });
}

/**
 * dg hooks check・dg next・dg brief が足す、古い Skill（と、同じ版で中身の違う Skill）の警告。なければ空。
 * 知らせるだけなので、確かめられなかったとき（guide が読めないなど）は呼んだコマンドを止めずに空を返す
 */
export async function staleSkillWarningsOf(
  topLevel: string | undefined,
  env: AgentEnv,
): Promise<string[]> {
  try {
    return staleSkillWarnings(await findStaleSkills({ topLevel, env }));
  } catch {
    return [];
  }
}
