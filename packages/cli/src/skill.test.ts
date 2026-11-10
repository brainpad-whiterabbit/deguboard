import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DG_PATH_NOTE,
  DG_PATH_NOTE_EN,
  SKILL_SUMMARY,
  agentSkillDirs,
  askSkillInstalled,
  skillSummary,
} from "@deguboard/core";
import { createLocalOnlyRepo } from "../../core/test/helpers/git-fixture.js";
import { readGuide } from "./guide.js";
import { run } from "./program.js";
import { buildSkills, installSkill } from "./skill.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function dg(cwd: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd,
    env,
    streams: { out: (t) => out.push(t), err: (t) => err.push(t) },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function tempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-home-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 廃止した deguboard Skill の、配っていたときの中身（sha256 で見分ける） */
const RETIRED_TEMPLATE = await readFile(
  new URL("../test/fixtures/retired-deguboard-skill.md", import.meta.url),
  "utf8",
);

const skillPath = (base: string, name: string) =>
  path.join(base, ".claude", "skills", name, "SKILL.md");
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

describe("dg skill install", () => {
  it("どの Skill にも、PATH に dg がないときの置き換えの案内（core の DG_PATH_NOTE_EN）が入り、日本語の案内は入らない", async () => {
    for (const s of await buildSkills()) {
      expect(s.content).toContain(DG_PATH_NOTE_EN);
      expect(s.content).not.toContain(DG_PATH_NOTE);
      expect(s.content).not.toContain("{{");
    }
  });

  it("すべての Skill の冒頭に、core の SKILL_SUMMARY の英語の 1 文が入る（日本語の文は小窓と依頼文が引く）", async () => {
    const skills = await buildSkills();
    expect(Object.keys(SKILL_SUMMARY).sort()).toEqual(skills.map((s) => s.name).sort());
    for (const s of skills) {
      expect(s.content).toContain(`\n${skillSummary(s.name, "en")}\n`);
      expect(s.content).not.toContain(skillSummary(s.name, "ja"));
      expect(skillSummary(s.name, "en"), s.name).not.toMatch(/[぀-ヿ一-鿿]/);
    }
  });

  it("リポジトリの最上位の .claude/skills/ に dg<トピック> の Skill を書き、--json は置き場所と名前を返す", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const sub = path.join(local.dir, "sub");
    await mkdir(sub);
    const result = await dg(sub, ["--json", "skill", "install"]);
    expect(result.code).toBe(0);
    const skills = await buildSkills();
    expect(JSON.parse(result.out)).toMatchObject({
      ok: true,
      data: {
        dir: path.join(local.dir, ".claude", "skills"),
        scope: "project",
        written: skills.map((s) => s.name),
        conflicts: [],
      },
    });
    for (const s of skills)
      expect(await readFile(skillPath(local.dir, s.name), "utf8")).toBe(s.content);
  });

  it("--dry-run は書く先と中身を返し、ファイルを書かず消さない", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const skills = await buildSkills();
    const result = await dg(local.dir, ["--json", "skill", "install", "--dry-run"]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.out).data;
    expect(data.dryRun).toBe(true);
    expect(data.written).toEqual(skills.map((s) => s.name));
    expect(data.files).toEqual(
      skills.map((s) => ({
        name: s.name,
        path: skillPath(local.dir, s.name),
        content: s.content,
      })),
    );
    expect(await exists(path.join(local.dir, ".claude"))).toBe(false);
    // 人向けの出力にも書く先と中身が出る
    const text = await dg(local.dir, ["skill", "install", "--dry-run"]);
    expect(text.out).toContain(skillPath(local.dir, "dgwork"));
    expect(text.out).toContain("dg guide work");
    expect(await exists(path.join(local.dir, ".claude"))).toBe(false);
  });

  it("--dry-run は更新・廃止の消去もしない", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    expect((await dg(local.dir, ["skill", "install"])).code).toBe(0);
    const old = skillPath(local.dir, "dgwork");
    await writeFile(old, "手で書いた\n");
    const retired = skillPath(local.dir, "deguboard");
    await mkdir(path.dirname(retired), { recursive: true });
    await writeFile(retired, RETIRED_TEMPLATE);
    const data = JSON.parse(
      (await dg(local.dir, ["--json", "skill", "install", "--dry-run", "--force"])).out,
    ).data;
    expect(data.updated).toContain("dgwork");
    expect(data.retired).toEqual(["deguboard"]);
    expect(await readFile(old, "utf8")).toBe("手で書いた\n");
    expect(await readFile(retired, "utf8")).toBe(RETIRED_TEMPLATE);
  });

  it("--dry-run で手を加えた Skill を --force なしにすると、files に入らず conflicts に入り、警告は「しない」と書く", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    expect((await dg(local.dir, ["skill", "install"])).code).toBe(0);
    const edited = skillPath(local.dir, "dgwork");
    await writeFile(edited, "手で書いた\n");
    const retired = skillPath(local.dir, "deguboard");
    await mkdir(path.dirname(retired), { recursive: true });
    await writeFile(retired, `${RETIRED_TEMPLATE}手を加えた\n`);
    const result = await dg(local.dir, ["--json", "skill", "install", "--dry-run"]);
    const parsed = JSON.parse(result.out);
    expect(parsed.data.conflicts).toEqual(["dgwork"]);
    expect(parsed.data.retiredKept).toEqual(["deguboard"]);
    expect(parsed.data.files).toEqual([]);
    expect(parsed.warnings.join("\n")).toContain("上書きしない。");
    // 手を加えた文は guide.notes に移すよう案内する（AG-2）
    expect(parsed.warnings.join("\n")).toContain("dg config set guide.notes.work");
    expect(parsed.warnings.join("\n")).toContain("消さない。");
    expect(parsed.warnings.join("\n")).not.toContain("しなかった");
    expect(await readFile(edited, "utf8")).toBe("手で書いた\n");
    expect(await readFile(retired, "utf8")).toBe(`${RETIRED_TEMPLATE}手を加えた\n`);
    // 実際に入れるときは過去形のまま
    const real = JSON.parse((await dg(local.dir, ["--json", "skill", "install"])).out);
    expect(real.warnings.join("\n")).toContain("上書きしなかった");
    expect(real.warnings.join("\n")).toContain("消さなかった");
  });

  it("--personal --dry-run は書く先が HOME の下になり、何も書かない", async () => {
    const home = await tempHome();
    const result = await dg(home, ["--json", "skill", "install", "--personal", "--dry-run"], {
      HOME: home,
    });
    expect(result.code).toBe(0);
    const data = JSON.parse(result.out).data;
    expect(data).toMatchObject({
      scope: "personal",
      dryRun: true,
      dir: path.join(home, ".claude", "skills"),
    });
    expect(data.files.length).toBeGreaterThan(0);
    for (const file of data.files as Array<{ path: string }>) {
      expect(file.path.startsWith(path.join(home, ".claude", "skills") + path.sep)).toBe(true);
    }
    expect(await exists(path.join(home, ".claude"))).toBe(false);
  });

  it("-C で指したリポジトリに書く", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const home = await tempHome();
    const result = await dg(home, ["-C", local.dir, "skill", "install"]);
    expect(result.code).toBe(0);
    expect(await exists(skillPath(local.dir, "dgwork"))).toBe(true);
  });

  it("手を加えていない Skill は更新し、手を加えたものは残して警告し、--force で上書きする", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    expect((await dg(local.dir, ["skill", "install"])).code).toBe(0);
    const again = JSON.parse((await dg(local.dir, ["--json", "skill", "install"])).out);
    expect(again.data.written).toEqual([]);
    expect(again.data.unchanged).toContain("dgwork");
    // 印のハッシュと中身が合わない（dgplan）、印がない（dgwork）なら手を加えたとみなす
    const plan = (await buildSkills()).find((s) => s.name === "dgplan")!;
    await writeFile(
      skillPath(local.dir, "dgplan"),
      plan.content.replace(/sha256:[0-9a-f]{64}/, "sha256:" + "0".repeat(64)),
    );
    await writeFile(skillPath(local.dir, "dgwork"), "手で書いた\n");
    // 古い版の中身でも、印のハッシュが中身と合えば手を加えていないので更新する（dgimport）
    const unmodified = (await buildSkills()).find((s) => s.name === "dgimport")!;
    const older = unmodified.content.replace(
      "Target: $ARGUMENTS",
      "Target (older version): $ARGUMENTS",
    );
    const hash = createHash("sha256")
      .update(older.replace(/^<!-- dg skill sha256:[0-9a-f]{64} -->\n/m, ""))
      .digest("hex");
    await writeFile(
      skillPath(local.dir, "dgimport"),
      older.replace(/sha256:[0-9a-f]{64}/, `sha256:${hash}`),
    );
    const third = await dg(local.dir, ["--json", "skill", "install"]);
    const data = JSON.parse(third.out).data;
    expect(data.updated).toEqual(["dgimport"]);
    expect(data.conflicts).toEqual(["dgplan", "dgwork"]);
    expect(JSON.parse(third.out).warnings.join("\n")).toContain("dgwork");
    expect(await readFile(skillPath(local.dir, "dgwork"), "utf8")).toBe("手で書いた\n");
    const forced = JSON.parse((await dg(local.dir, ["--json", "skill", "install", "--force"])).out);
    expect(forced.data.updated).toEqual(["dgplan", "dgwork"]);
    expect(forced.data.conflicts).toEqual([]);
  });

  it("廃止した deguboard Skill は、配ったままの中身なら消し、手を加えてあれば残して警告する", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    await mkdir(path.dirname(skillPath(local.dir, "deguboard")), { recursive: true });
    await writeFile(skillPath(local.dir, "deguboard"), RETIRED_TEMPLATE);
    const first = JSON.parse((await dg(local.dir, ["--json", "skill", "install"])).out);
    expect(first.data.retired).toEqual(["deguboard"]);
    expect(await exists(path.dirname(skillPath(local.dir, "deguboard")))).toBe(false);
    await mkdir(path.dirname(skillPath(local.dir, "deguboard")), { recursive: true });
    await writeFile(skillPath(local.dir, "deguboard"), RETIRED_TEMPLATE + "追記\n");
    const second = JSON.parse((await dg(local.dir, ["--json", "skill", "install", "--force"])).out);
    expect(second.data.retiredKept).toEqual(["deguboard"]);
    expect(second.warnings.join("\n")).toContain("deguboard");
    expect(await exists(skillPath(local.dir, "deguboard"))).toBe(true);
  });

  it("--personal ならホームディレクトリの .claude/skills に書き、リポジトリの外でも動く", async () => {
    const home = await tempHome();
    const result = await dg(home, ["--json", "skill", "install", "--personal"], { HOME: home });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).data).toMatchObject({
      dir: path.join(home, ".claude", "skills"),
      scope: "personal",
    });
    expect(await exists(skillPath(home, "dgimport"))).toBe(true);
  });

  it("書いた場所は、頼むことが Skill の有無を見る場所（agentSkillDirs）に入り、入れれば有りと判定される（AG-5）", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const home = await tempHome();
    const env = { HOME: home };
    const query = { env, topLevel: local.dir };
    expect(await askSkillInstalled(agentSkillDirs(query))).toBe(false);
    for (const scope of ["project", "personal"] as const) {
      const result = await installSkill({ cwd: local.dir, scope, env, force: false });
      expect(agentSkillDirs(query)).toContain(result.dir);
      expect(await askSkillInstalled([result.dir])).toBe(true);
    }
  });

  it("HOME が空か未設定なら、install も判定も OS のホームディレクトリを使う", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const expected = path.join(os.homedir(), ".claude", "skills");
    for (const env of [{ HOME: "" }, {}]) {
      // 本物のホームに書かないように、書く先だけを確かめる
      const result = await installSkill({
        cwd: local.dir,
        scope: "personal",
        env,
        force: false,
        dryRun: true,
      });
      expect(result.dir).toBe(expected);
      expect(agentSkillDirs({ env, topLevel: local.dir })).toContain(expected);
    }
  });

  it("リポジトリの外で --personal なしなら失敗する", async () => {
    const home = await tempHome();
    const result = await dg(home, ["--json", "skill", "install"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).error.code).toBe("GIT_ERROR");
  });
});

describe("Skill の本文", () => {
  it("段階ごとの Skill が guide の frontmatter から作られ、dg guide <topic> を読ませ、agent を名乗らせる", async () => {
    const skills = await buildSkills();
    expect(skills.map((s) => s.name)).toEqual([
      "dgimport",
      "dgassign",
      "dgcheck",
      "dgplan",
      "dgwork",
      "dgaudit",
      "dgrelease",
      "dgdone",
      "dgall",
    ]);
    for (const s of skills) {
      expect(s.content, s.name).toMatch(
        new RegExp(
          `^---\\nname: ${s.name}\\ndescription: .+\\nargument-hint: .+\\n---\\n\\n<!-- dg skill sha256:[0-9a-f]{64} -->\\n`,
        ),
      );
      expect(s.content, s.name).toContain(`dg guide ${s.topic}`);
      expect(s.content, s.name).toContain("$ARGUMENTS");
      expect(s.content, s.name).toContain("--json --actor agent");
      expect(s.content, s.name).toContain('"Deciding the target"');
      expect(await readGuide(s.topic), s.name).toContain("## Deciding the target");
    }
  });

  it("手順を書き写さない（コマンドの手順は guide に任せる）", async () => {
    for (const s of await buildSkills())
      for (const word of ["ticket claim", "ticket import", "plan approve", "git worktree"])
        expect(s.content, `${s.name} ${word}`).not.toContain(word);
  });

  it("起票は guide import を経て提案と承認に届く（AG-3）", async () => {
    const dgimport = (await buildSkills()).find((s) => s.name === "dgimport")!;
    expect(dgimport.content).toContain("dg guide import");
    expect(await readGuide("import")).toContain("**propose** turning them into tickets");
  });

  it("このリポジトリに入れた Skill は生成した中身と同じで、廃止した deguboard Skill は残っていない", async () => {
    const dir = fileURLToPath(new URL("../../../.claude/skills/", import.meta.url));
    for (const s of await buildSkills())
      expect(await readFile(path.join(dir, s.name, "SKILL.md"), "utf8"), s.name).toBe(s.content);
    expect(await readdir(dir)).not.toContain("deguboard");
  });
});
