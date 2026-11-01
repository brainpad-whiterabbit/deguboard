import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "@deguboard/core";
import { cliEnv } from "../../core/test/helpers/env.js";
import { createLocalOnlyRepo } from "../../core/test/helpers/git-fixture.js";
import { GUIDE_TOPICS, fillPlaceholders, readGuide, readGuideMeta } from "./guide.js";
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
    env: cliEnv(),
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

  it("Skill を持つトピックは対象の決め方・選択肢で聞く節・次の手順を持ち、本文に frontmatter を残さない", async () => {
    for (const topic of GUIDE_TOPICS) {
      const meta = await readGuideMeta(topic);
      const text = await readGuide(topic);
      expect(text.startsWith("---"), topic).toBe(false);
      if (topic === "overview" || topic === "parallel" || topic === "review") {
        expect(meta.description, topic).toBeUndefined();
        continue;
      }
      expect(meta.description, topic).toBeTruthy();
      expect(meta["argument-hint"], topic).toBeTruthy();
      for (const heading of ["## 対象を決める", "## 選択肢で聞く", "## 次の手順を選ぶ"])
        expect(text, `${topic} ${heading}`).toContain(heading);
      expect(text, topic).not.toContain("{{choices}}");
    }
  });

  it("work と done は ticket check を案内し、本文全体を書き戻す手順を残さない", async () => {
    const work = await readGuide("work");
    const done = await readGuide("done");
    expect(work).toContain("ticket check");
    expect(done).toContain("ticket check");
    expect(done).not.toContain("--body");
    expect(work).not.toContain("--body");
  });

  it("work は PR の要らない作業を --without-branch で claim し、確かめたら done、残れば review と案内する", async () => {
    const work = await readGuide("work");
    expect(work).toContain("## PR の要らない作業");
    expect(work).toContain("ticket claim <id> --without-branch");
    expect(work).toContain("ticket move <id> done");
    expect(work).toContain("ticket move <id> review");
  });

  it("plan・work・done は Plan を作り、人の承認で approve し、順と範囲を読んで進め、終わったら閉じると案内する", async () => {
    const plan = await readGuide("plan");
    const work = await readGuide("work");
    const done = await readGuide("done");
    expect(plan).not.toContain("まだない");
    for (const command of ["plan create", "plan approve", "plan show", "--after", "--scope"])
      expect(plan).toContain(command);
    expect(plan).toContain("人の承認を得ないまま approve しない");
    expect(plan).toContain("plan.approve");
    for (const word of ["plan show", "waiting", "scope", "approach"]) expect(work).toContain(word);
    expect(done).toContain("plan close");
  });

  it("all は --auto で自動で選ぶものと承認を残すものを分け、自動マージは auto.merge を true にしたときだけ条件を確かめて行う", async () => {
    const all = await readGuide("all");
    for (const heading of ["## `--auto` で自動で選ぶ", "### マージの前の条件", "**自動にしない"])
      expect(all).toContain(heading);
    expect(fillPlaceholders(all, defaultConfig())).toContain("今の設定：`false`");
    expect(fillPlaceholders(all, { ...defaultConfig(), auto: { merge: true } })).toContain(
      "今の設定：`true`",
    );
    expect(await readGuideMeta("all")).toMatchObject({
      "argument-hint": expect.stringContaining("--auto"),
    });
  });

  it("parallel は着手できるチケットを上限付きでサブエージェントに並べ、役割を分け、1 件でほかを止めないと案内し、work・all・review はそこへ案内する", async () => {
    const parallel = await readGuide("parallel");
    expect(parallel).toContain("# 着手できるチケットを並べて進める");
    for (const word of [
      "items[].waiting",
      "同時に 3 件まで",
      "**サブエージェントがしない**",
      "**1 件でほかを止めない**",
      "CLAIM_LOST",
      "マージ待ち",
      "`ticket update --pr`",
    ])
      expect(parallel).toContain(word);
    for (const topic of ["work", "all", "review"] as const) {
      const text = await readGuide(topic);
      expect(text, topic).toContain("`dg guide parallel`");
      expect(text, topic).not.toContain("「着手できるチケットを並べて進める」");
    }
    // 中身は parallel にだけ書く
    expect(await readGuide("work")).not.toContain("**サブエージェントがしない**");
  });

  it("review は品質ゲートを 1 か所に置き、work は PR を出す前の見直しと上限付きの修正ループを、all はマージの前の条件をそこへ案内し、実装・見直し・手直しの Run を分ける", async () => {
    const review = await readGuide("review");
    const work = await readGuide("work");
    const all = await readGuide("all");
    for (const heading of [
      "## 品質ゲート",
      "## 見直す",
      "## 指摘を直す（修正ループ）",
      "## Run の分け方",
      "## 終わり方",
    ])
      expect(review).toContain(heading);
    for (const word of [
      "`gh pr create --draft`",
      "**上限**：重い指摘を直すのは 2 回まで",
      "--retry-reason <直した指摘の要約>",
      "チケットは in_progress のまま",
      "人に報告",
      "`gh pr ready <PR>`",
      "MERGEABLE",
    ])
      expect(review).toContain(word);
    // 条件の中身は review にだけ書き、work と all は参照する
    expect(work).toContain("`dg guide review`");
    expect(work).toContain("上限付きの修正ループ");
    // 実装の Run は draft の PR で閉じ、見直しと手直しは別の step の Run にする
    expect(work).toContain("run start <id> <step>");
    expect(work).toContain("（software-development・general では `implement`）");
    expect(work).toContain("draft の PR を作ったら実装の Run を閉じる");
    expect(work).toContain("--retry-reason");
    for (const step of ["`review`", "`fix`"]) {
      expect(review).toContain(step);
      expect(work).toContain(step);
    }
    expect(review).not.toContain("Run を開けたまま");
    // 上限は親が数え、fix の Run の数では数えない。合う step がなければ代わりの step で記録する
    expect(review).toContain("回数は親が、重い指摘を直した回で数える");
    expect(review).toContain("**合う step がない**");
    // Run を自分で呼ぶ理由は review に置き、work は参照する
    expect(review).toContain("Run の ID を最初に含む会話記録");
    expect(work).toContain("（理由は `dg guide review` の「Run の分け方」）");
    // 手直しの失敗・中断では unclaim せず、review の「終わり方」に従う
    expect(review).toContain("**手直しが failure で返った・返らない**");
    expect(work).toContain("手直しの Run は `dg guide review` の「終わり方」");
    expect(work).toContain("手直しは unclaim せず");
    expect(work).not.toContain("開けたまま");
    expect(all).toContain("`dg guide review` の「品質ゲート」");
    for (const text of [work, all]) expect(text).not.toContain("--json mergeable");
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
