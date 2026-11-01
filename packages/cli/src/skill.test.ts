import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalOnlyRepo } from "../../core/test/helpers/git-fixture.js";
import { GUIDE_TOPICS } from "./guide.js";
import { run } from "./program.js";
import { readSkillTemplate } from "./skill.js";

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

describe("dg skill install", () => {
  it("リポジトリの最上位の .claude/skills/deguboard/SKILL.md に書き、--json は書いたパスを返す", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const sub = path.join(local.dir, "sub");
    await mkdir(sub);
    const result = await dg(sub, ["--json", "skill", "install"]);
    expect(result.code).toBe(0);
    const expected = path.join(local.dir, ".claude", "skills", "deguboard", "SKILL.md");
    expect(JSON.parse(result.out)).toMatchObject({
      ok: true,
      data: { path: expected, scope: "project", overwritten: false },
    });
    expect(await readFile(expected, "utf8")).toBe(await readSkillTemplate());
  });

  it("-C で指したリポジトリに書く", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const home = await tempHome();
    const result = await dg(home, ["-C", local.dir, "skill", "install"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      path.join(local.dir, ".claude", "skills", "deguboard", "SKILL.md"),
    );
  });

  it("既存のファイルがあれば --force なしでは拒否し、--force で上書きする", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    expect((await dg(local.dir, ["skill", "install"])).code).toBe(0);
    const again = await dg(local.dir, ["--json", "skill", "install"]);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.out).error.code).toBe("ALREADY_EXISTS");
    const forced = await dg(local.dir, ["--json", "skill", "install", "--force"]);
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.out).data.overwritten).toBe(true);
  });

  it("--personal ならホームディレクトリの .claude/skills に書き、リポジトリの外でも動く", async () => {
    const home = await tempHome();
    const result = await dg(home, ["--json", "skill", "install", "--personal"], { HOME: home });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).data).toMatchObject({
      path: path.join(home, ".claude", "skills", "deguboard", "SKILL.md"),
      scope: "personal",
    });
  });

  it("リポジトリの外で --personal なしなら失敗する", async () => {
    const home = await tempHome();
    const result = await dg(home, ["--json", "skill", "install"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).error.code).toBe("GIT_ERROR");
  });
});

describe("Skill の本文", () => {
  it("frontmatter に name と description があり、場面ごとに dg guide <topic> を読ませ、agent を名乗らせる", async () => {
    const text = await readSkillTemplate();
    expect(text).toMatch(/^---\nname: deguboard\ndescription: .+\n---\n/);
    for (const topic of GUIDE_TOPICS) expect(text, topic).toContain(`dg guide ${topic}`);
    expect(text).toContain("--json --actor agent");
  });

  it("手順を書き写さない（コマンドの手順は guide に任せる）", async () => {
    const text = await readSkillTemplate();
    for (const word of ["ticket claim", "ticket import", "plan approve", "git worktree"])
      expect(text, word).not.toContain(word);
  });

  it("起票は guide create を経て提案と承認に届く（AG-3）", async () => {
    const text = await readSkillTemplate();
    const create = await readFile(new URL("./guide-create.md", import.meta.url), "utf8");
    expect(text).toMatch(/承認を得てから起票する/);
    expect(create).toContain("チケット化を**提案**する");
  });

  it("このリポジトリに入れた Skill は同梱のテンプレートと同じ", async () => {
    const installed = fileURLToPath(
      new URL("../../../.claude/skills/deguboard/SKILL.md", import.meta.url),
    );
    expect(await readFile(installed, "utf8")).toBe(await readSkillTemplate());
  });
});
