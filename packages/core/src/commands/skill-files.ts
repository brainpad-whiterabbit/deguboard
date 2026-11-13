// dg が配る Skill の中身と、入れてある Skill が今の dg のものと違うかの判定（AG-2）。
// dg skill install（CLI）が書くか残すかを決めるのも、dg hooks check・dg next・dg brief が古い Skill を知らせるのも、
// VS Code 拡張が同じことを確かめるのも、ここの skillStateOf を通す（判定を 2 つ持たない）。
// 名前・説明・引数の案内は guide の frontmatter から、冒頭の 1 文は SKILL_SUMMARY の en から、本文は SKILL_TEMPLATE から作る。
// 雛形をファイルにせず定数にするのは、束ねた配置（拡張の extension.cjs・同梱の dg.mjs）でも置き場所を合わせずに読めるようにするため

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentSkillPlaces, type AgentEnv, type SkillPlace } from "../agents/index.js";
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
      content: `---\n${frontmatter}---\n\n<!-- dg skill sha256:${sha256(unmarked)} -->\n\n${body}`,
    });
  }
  return skills;
}

/**
 * 入れてある SKILL.md と今の dg の Skill の関係。
 * missing は入れていない、current は今の dg のものと同じ、stale は手を加えていないが今の dg のものと違う（古い。dg skill install が上書きする）、
 * edited は手を加えてあって今の dg のものと違う（dg skill install は残し、--force で上書きする）
 */
export type SkillState = "missing" | "current" | "stale" | "edited";

/** 印があり、印を除いた中身のハッシュが印と一致すれば、手を加えていない */
function isUnmodified(text: string): boolean {
  const match = MARKER.exec(text);
  return match !== null && sha256(text.replace(MARKER, "")) === match[1];
}

/** 入れてある SKILL.md の中身（なければ undefined）を、今の dg の Skill と比べる */
export function skillStateOf(current: string | undefined, skill: SkillFile): SkillState {
  if (current === undefined) return "missing";
  if (current === skill.content) return "current";
  return isUnmodified(current) ? "stale" : "edited";
}

/** 手を加えた SKILL.md の印が、今の dg の Skill の印と同じか（今の版をもとに手を加えたもので、古くはない） */
function editedFromCurrent(current: string, skill: SkillFile): boolean {
  const base = MARKER.exec(current)?.[1];
  return base !== undefined && base === MARKER.exec(skill.content)?.[1];
}

/** 置き場所ごとの、今の dg のものと違う Skill */
export interface StaleSkills extends SkillPlace {
  /** 手を加えていない古い Skill の名前。dg skill install で更新できる */
  stale: string[];
  /** 手を加えてある古い Skill の名前。dg skill install は残し、--force で上書きする */
  edited: string[];
}

/**
 * リポジトリ（topLevel の下）と個人（env の HOME の下）の Skill のディレクトリを見て、入れてある dg の Skill のうち今の dg のものと違うものを返す。
 * 違うものがない置き場所は返さない。入れていない Skill は数えない（Skill は任意で、足りないことは知らせない）。
 * 今の版をもとに手を加えた Skill（印が今の dg のものと同じ）も数えない。古くはなく、知らせても毎回同じ警告が出続けるだけになる。
 * 印を消した Skill はもとの版が分からないので edited に入れる。
 * topLevel を省くと個人の置き場所だけを見る（リポジトリの外）
 */
export async function findStaleSkills(query: {
  topLevel?: string | undefined;
  env: AgentEnv;
}): Promise<StaleSkills[]> {
  const skills = await buildSkills();
  const found: StaleSkills[] = [];
  for (const place of agentSkillPlaces(query)) {
    // リポジトリがホームディレクトリのときは同じ場所を 2 回見ない
    if (found.some((f) => f.dir === place.dir)) continue;
    const stale: string[] = [];
    const edited: string[] = [];
    for (const skill of skills) {
      const current = await readFile(join(place.dir, skill.name, "SKILL.md"), "utf8").catch(
        () => undefined,
      );
      const state = skillStateOf(current, skill);
      if (state === "stale") stale.push(skill.name);
      else if (state === "edited" && !editedFromCurrent(current!, skill)) edited.push(skill.name);
    }
    if (stale.length > 0 || edited.length > 0) found.push({ ...place, stale, edited });
  }
  return found;
}

/** 古い Skill の警告の文。手を加えていないもの（dg skill install で更新）と、手を加えたもの（--force で上書き）を分けて出す */
export function staleSkillWarnings(found: readonly StaleSkills[]): string[] {
  return found.flatMap((f) => {
    const install = `dg skill install${f.scope === "personal" ? " --personal" : ""}`;
    return [
      ...(f.stale.length === 0
        ? []
        : [
            `These dg Skills in ${f.dir} are older than this dg (they differ from the Skills bundled with it): ${f.stale.join(", ")}. Update them with ${install}`,
          ]),
      ...(f.edited.length === 0
        ? []
        : [
            `These dg Skills in ${f.dir} are older than this dg and were edited by hand, so ${install} keeps them: ${f.edited.join(", ")}. To overwrite them with the current Skills, run ${install} --force`,
          ]),
    ];
  });
}

/**
 * dg hooks check・dg next・dg brief が足す、古い Skill の警告。古いものがなければ空。
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
