import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "@deguboard/core";
import { createLocalOnlyRepo } from "../../core/test/helpers/git-fixture.js";
import { GUIDE_TOPICS, fillPlaceholders, readGuide } from "./guide.js";
import { run } from "./program.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function dg(cwd: string, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd,
    streams: { out: (t) => out.push(t), err: (t) => err.push(t) },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("dg guide", () => {
  it("すべてのトピックが読め、見出しで始まり、未知の項目を残さない", async () => {
    for (const topic of GUIDE_TOPICS) {
      const text = fillPlaceholders(await readGuide(topic), defaultConfig());
      expect(text.startsWith("# "), topic).toBe(true);
      expect(text, topic).not.toMatch(/\{\{/);
    }
  });

  it("work と finish は ticket check を案内し、本文全体を書き戻す手順を残さない", async () => {
    const work = await readGuide("work");
    const finish = await readGuide("finish");
    expect(work).toContain("ticket check");
    expect(finish).toContain("ticket check");
    expect(finish).not.toContain("--body");
    expect(work).not.toContain("--body");
  });

  it("work は PR の要らない作業を --without-branch で claim し、確かめたら done、残れば review と案内する", async () => {
    const work = await readGuide("work");
    expect(work).toContain("## PR の要らない作業");
    expect(work).toContain("ticket claim <id> --without-branch");
    expect(work).toContain("ticket move <id> done");
    expect(work).toContain("ticket move <id> review");
  });

  it("plan・work・finish は Plan を作り、人の承認で approve し、順と範囲を読んで進め、終わったら閉じると案内する", async () => {
    const plan = await readGuide("plan");
    const work = await readGuide("work");
    const finish = await readGuide("finish");
    expect(plan).not.toContain("まだない");
    for (const command of ["plan create", "plan approve", "plan show", "--after", "--scope"])
      expect(plan).toContain(command);
    expect(plan).toContain("人の承認を得ないまま approve しない");
    expect(plan).toContain("plan.approve");
    for (const word of ["plan show", "waiting", "scope", "approach"]) expect(work).toContain(word);
    expect(finish).toContain("plan close");
  });

  it("config の値を埋める（既定なら main と origin、空の配列は「なし」）", () => {
    expect(
      fillPlaceholders(
        "{{git.remote}}/{{git.base_branch}} {{commit.mode}} {{actor.human_only}} {{nope}}",
        defaultConfig(),
      ),
    ).toBe("origin/main batch なし {{nope}}");
    expect(
      fillPlaceholders("{{actor.human_only}}", {
        ...defaultConfig(),
        actor: { human_only: ["epic.close", "iteration.close"] },
      }),
    ).toBe("epic.close, iteration.close");
  });

  it("overview にはすべてのトピックが載り、未知のトピックは終了コード 2", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const overview = await dg(local.dir, ["guide"]);
    expect(overview.code).toBe(0);
    for (const topic of GUIDE_TOPICS)
      if (topic !== "overview") expect(overview.out).toContain(`| ${topic}`);
    const unknown = await dg(local.dir, ["guide", "nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("nope");
  });

  it("初期化前は既定値で埋め、初期化後は config.yaml の値で埋める", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const before = await dg(local.dir, ["--json", "guide", "work"]);
    expect(JSON.parse(before.out).data).toMatchObject({ topic: "work", initialized: false });
    expect(before.out).toContain("origin/main");
    await dg(local.dir, ["init", "--base-branch", "develop"]);
    const after = await dg(local.dir, ["guide", "work"]);
    expect(after.out).toContain("origin/develop");
    expect(after.out).not.toContain("origin/main");
  });
});
