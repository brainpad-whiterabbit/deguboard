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
import { createLocalOnlyRepo } from "../../core/test/helpers/git-fixture.js";
import { readGuide } from "./guide.js";
import { run } from "./program.js";
import { buildSkills } from "./skill.js";

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
    const older = unmodified.content.replace("指定：$ARGUMENTS", "指定（古い版）：$ARGUMENTS");
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
      expect(s.content, s.name).toContain("対象を決める");
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
    expect(await readGuide("import")).toContain("チケット化を**提案**する");
  });

  it("このリポジトリに入れた Skill は生成した中身と同じで、廃止した deguboard Skill は残っていない", async () => {
    const dir = fileURLToPath(new URL("../../../.claude/skills/", import.meta.url));
    for (const s of await buildSkills())
      expect(await readFile(path.join(dir, s.name, "SKILL.md"), "utf8"), s.name).toBe(s.content);
    expect(await readdir(dir)).not.toContain("deguboard");
  });
});
