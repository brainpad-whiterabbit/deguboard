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

// 文言の検査は節（見出し・手順・行）を切り出してから要点語の含有で行い、強調記号や括弧・接続の語には頼らない。
// 順序を確かめるときだけ正規表現を使い、行をまたぐところは [\s\S]*? でつなぐ

/** 見出しの節を、同じか浅い階層の次の見出しの手前まで切り出す。見出しがなければ空 */
function section(text: string, heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const body = text.split(`${heading}\n`)[1] ?? "";
  return body.split(new RegExp(`\\n#{1,${level}} `))[0] ?? "";
}

/** 番号付きの手順 n を、下位の箇条書きを含めて次の手順の手前まで切り出す。なければ空 */
function step(text: string, n: number): string {
  return text.split(new RegExp(`\\n${n}\\. `))[1]?.split(/\n\d+\. /)[0] ?? "";
}

/** 要点語を含む最初の行。なければ空 */
function lineWith(text: string, word: string): string {
  return text.split("\n").find((line) => line.includes(word)) ?? "";
}

/** 「- **名前**：…」の箇条書きの行を、強調記号によらず名前で引く。なければ空 */
function bullet(text: string, name: string): string {
  return text.split("\n").find((line) => line.replace(/\*\*/g, "").startsWith(`- ${name}：`)) ?? "";
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
      if (topic === "overview" || topic === "run" || topic === "parallel" || topic === "review") {
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

  it("次の手順は Skill がなければ dg guide を読んで続けると案内する", async () => {
    const choices = lineWith(await readGuide("import"), "次の手順が選ばれたら");
    for (const word of ["Skill", "使えなければ", "`dg guide <topic>`", "その手順で続ける"])
      expect(choices).toContain(word);
    expect(lineWith(await readGuide("overview"), "Skill は任意")).toContain("dg guide <topic>");
    for (const topic of GUIDE_TOPICS) {
      const next = section(await readGuide(topic), "## 次の手順を選ぶ");
      for (const line of next.split("\n").filter((l) => l.includes("`/dg"))) {
        expect(line, topic).toContain("Skill があれば");
        expect(line, topic).toContain("dg guide");
      }
    }
  });

  it("import は受け入れ条件が 7 項目以上のチケットを分けることを、根拠とともに勧める", async () => {
    const tips = section(await readGuide("import"), "## よいチケットの書き方");
    expect(tips).toMatch(
      /受け入れ条件が 7 項目以上[\s\S]*?分けることを勧める[\s\S]*?10 件のうち 9 件/,
    );
  });

  it("work と done は ticket check を案内し、本文全体を書き戻す手順を残さない", async () => {
    const work = await readGuide("work");
    const done = await readGuide("done");
    expect(work).toContain("ticket check");
    expect(done).toContain("ticket check");
    expect(done).not.toContain("--body");
    expect(work).not.toContain("--body");
  });

  it("work は PR を作る前に、触れた節の正本とコメントを読み直してずれを同じ PR で直し、報告に書くと案内する", async () => {
    const flow = section(await readGuide("work"), "## 流れ");
    const reread = lineWith(flow, "正本とコメントを読み直す");
    for (const word of ["requirements", "ADR", "README"]) expect(reread).toContain(word);
    // 読み直し → 同じ PR で直す → PR を作る → 本文に読み直した正本と直した箇所を書く、の順
    expect(flow).toMatch(
      /正本とコメントを読み直す[\s\S]*?同じ PR で直す[\s\S]*?gh pr create --draft[\s\S]*?読み直した正本と直した箇所/,
    );
    expect(await readGuide("parallel")).toContain("読み直した正本と直した箇所");
    // 見直し役が --agent を渡すときも自分の Adapter の名前（役割名だと使用量とモデル名が取れない）。
    // 並べて進める実装と手直しのサブエージェントは印で頼むので Run を開かない（ADR-018）
    for (const topic of ["review"])
      expect(await readGuide(topic), topic).toMatch(
        /自分の Adapter の名前。Claude Code なら `claude-code`/,
      );
  });

  it("work の普段の経路では claim が実装の Run を開き run start を呼ばず、委譲（段階のモデル・parallel）では --no-run で claim すると案内する（RN-5）", async () => {
    const work = await readGuide("work");
    const flow = section(work, "## 流れ");
    expect(step(flow, 2)).toContain("data.run");
    expect(step(flow, 2)).toContain("--no-run");
    expect(step(flow, 4)).toMatch(/^実装する。Run は手順 2 の claim が開いている/);
    expect(section(work, "## PR の要らない作業")).toContain("claim が開いた Run");
    const run = await readGuide("run");
    expect(section(run, "## Run を記録する")).toContain("`ticket claim` が開く");
    expect(bullet(section(run, "## 段階のモデル"), "実装")).toContain("--no-run");
    expect(bullet(await readGuide("parallel"), "親")).toContain("--no-run");
    expect(section(await readGuide("review"), "## Run の分け方")).toContain("--no-run");
    expect(await readGuide("overview")).toContain("`ticket claim` が開く");
  });

  it("review は参考節との食い違いを軽い指摘として返し、参考節がなければ見比べないと案内し、直さなかった軽い指摘は親が PR の本文に書き足すと決め、親とサブエージェントの一覧にも入れる", async () => {
    const review = await readGuide("review");
    const look = bullet(section(review, "## 見直す"), "見る");
    for (const word of [
      "## 参考",
      "参考節との食い違い",
      "節がなければ見比べない",
      "範囲の外の指摘",
    ])
      expect(look, word).toContain(word);
    expect(bullet(section(review, "## 見直す"), "返す")).toContain("参考節との食い違いは軽い指摘");
    const fixLoop = section(review, "## 指摘を直す（修正ループ）");
    expect(fixLoop).toContain("参考節との食い違い");
    expect(fixLoop).toContain("親が PR の本文に書き足す");
    expect(fixLoop).toContain("直さなかった軽い指摘と理由");
    expect(section(await readGuide("all"), "## 文脈の扱い")).toContain("直さなかった軽い指摘");
    expect(await readGuide("parallel")).toContain("直さなかった軽い指摘を PR の本文に書き足し");
    expect(await readGuide("parallel")).toContain("直さなかった軽い指摘と理由");
    expect(step(section(await readGuide("work"), "## 流れ"), 6)).toContain("親が書き足す");
    expect(step(section(await readGuide("work"), "## 流れ"), 6)).toContain("指摘を直す");
  });

  it("work は PR の要らない作業を --without-branch で claim し、確かめたら done、残れば review と案内する", async () => {
    const noBranch = section(await readGuide("work"), "## PR の要らない作業");
    expect(noBranch).toContain("ticket claim <id> --without-branch");
    expect(noBranch).toContain("ticket move <id> done");
    expect(noBranch).toContain("ticket move <id> review");
  });

  it("work の PR の要らない作業は、claim --without-branch の前に上の手順 1 を案内し、今の設定を埋める", async () => {
    const work = await readGuide("work");
    const noBranch = section(work, "## PR の要らない作業");
    const reference = noBranch.indexOf("上の手順 1");
    expect(reference).toBeGreaterThan(-1);
    expect(reference).toBeLessThan(noBranch.indexOf("ticket claim <id> --without-branch"));
    expect(lineWith(noBranch, "上の手順 1")).toContain("lint.require_iteration");
    expect(lineWith(noBranch, "上の手順 1")).toContain("Iteration に入れる");
    // 選び方は上の手順 1 にだけ書き、この節には書き写さない
    expect(noBranch).not.toContain("iteration add <S> <id>");
    expect(section(fillPlaceholders(work, defaultConfig()), "## PR の要らない作業")).toContain(
      "今の設定：`false`",
    );
    expect(
      section(
        fillPlaceholders(work, { ...defaultConfig(), lint: { require_iteration: true } }),
        "## PR の要らない作業",
      ),
    ).toContain("今の設定：`true`");
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
    // 循環は plan create で拒否され経路が出る（after だけと、after・depends_on をまたぐもの）。外すか向きを変える
    const cycle = lineWith(plan, "after` だけの循環");
    expect(cycle).toContain("`after`・`depends_on` をまたぐ循環");
    expect(cycle).toContain("経路が出る");
    expect(cycle).toContain("向きを変える");
    for (const word of ["plan show", "`next`", "`ready`", "waiting", "scope", "approach"])
      expect(work).toContain(word);
    expect(done).toContain("plan close");
  });

  it("all は --auto で自動で選ぶものと承認を残すものを分け、自動マージは auto.merge を true にしたときだけ条件を確かめて行う", async () => {
    const all = await readGuide("all");
    const auto = section(all, "## `--auto` で自動で選ぶ");
    for (const word of ["自動で選ぶ", "自動にしない", "auto.merge", "マージの前の条件"])
      expect(auto).toContain(word);
    expect(section(all, "### マージの前の条件")).toContain("品質ゲート");
    expect(fillPlaceholders(all, defaultConfig())).toContain("今の設定：`false`");
    expect(fillPlaceholders(all, { ...defaultConfig(), auto: { merge: true } })).toContain(
      "今の設定：`true`",
    );
    expect(await readGuideMeta("all")).toMatchObject({
      "argument-hint": expect.stringContaining("--auto"),
    });
  });

  it("work は lint.require_iteration が true なら claim の前に Iteration に入れると案内し、今の設定を埋める", async () => {
    const work = await readGuide("work");
    const flow = section(work, "## 流れ");
    expect(flow.indexOf("Iteration に入れる")).toBeLessThan(flow.indexOf("ticket claim <id>"));
    expect(flow).toContain("iteration add <S> <id>");
    expect(flow).toContain("lint_iteration_missing");
    expect(fillPlaceholders(work, defaultConfig())).toContain("今の設定：`false`");
    expect(
      fillPlaceholders(work, { ...defaultConfig(), lint: { require_iteration: true } }),
    ).toContain("今の設定：`true`");
  });

  it("run は段階のモデルを config の models.* で埋め、空なら「なし」と出す。見直し役は親のモデル", async () => {
    const run = await readGuide("run");
    expect(fillPlaceholders(run, defaultConfig())).toContain(
      "light `なし`・standard `なし`・heavy `なし`",
    );
    expect(
      fillPlaceholders(run, {
        ...defaultConfig(),
        models: { light: "haiku", standard: "sonnet", heavy: "opus" },
      }),
    ).toContain("light `haiku`・standard `sonnet`・heavy `opus`");
    expect(await readGuide("review")).toContain("段階によらず親のモデル");
    expect(await readGuide("plan")).toContain("--tier");
  });

  it("parallel は親が claim の前に Iteration に入れると案内し、check は lint_iteration_missing の直す案を示し、どちらも今の設定を埋める", async () => {
    const parallel = await readGuide("parallel");
    const parent = bullet(parallel, "親");
    for (const word of ["Iteration に入れる", "claim", "worktree", "手順 1", "手順 2"])
      expect(parent).toContain(word);
    expect(parent.indexOf("Iteration に入れる")).toBeLessThan(parent.indexOf("claim"));
    expect(parallel).toContain("iteration add <S> <id>");
    const check = await readGuide("check");
    expect(check).toContain("lint_iteration_missing");
    expect(check).toContain("iteration add <S> <id>");
    expect(check).toContain("人に聞く");
    for (const text of [parallel, check]) {
      expect(fillPlaceholders(text, defaultConfig())).toContain("今の設定：`false`");
      expect(
        fillPlaceholders(text, { ...defaultConfig(), lint: { require_iteration: true } }),
      ).toContain("今の設定：`true`");
    }
    // work の手順 1 が Iteration に入れる、手順 2 が claim、手順 3 が worktree で、parallel の参照と合う
    const flow = section(await readGuide("work"), "## 流れ");
    expect(step(flow, 1)).toContain("着手できるか確かめる");
    expect(step(flow, 1)).toContain("Iteration に入れる");
    expect(step(flow, 2)).toContain("claim する");
    expect(step(flow, 3)).toContain("worktree");
    expect(lineWith(await readGuide("all"), "lint.require_iteration")).toContain(
      "Iteration に入れる",
    );
  });

  it("check は lint_iteration_multiple_active でどれを閉じるかを人に聞き、work の手順 2 は Iteration の start が拒否されたら読み直して planned のままなら人に頼む", async () => {
    const multiple = lineWith(await readGuide("check"), "lint_iteration_multiple_active");
    expect(multiple).toContain("どれを閉じるかを人に聞く");
    expect(multiple).toContain("人の指示で行う");
    const step2 = step(section(await readGuide("work"), "## 流れ"), 2);
    const start = lineWith(step2, "Iteration を始める");
    for (const word of [
      "iteration start <S>",
      "拒否されたら",
      "iteration show",
      "active なら何もせず",
      "planned のまま",
      "人に頼む",
      "作業は続ける",
    ])
      expect(start).toContain(word);
  });

  it("parallel は着手できるチケットを上限付きでサブエージェントに並べ、役割を分け、1 件でほかを止めないと案内し、work・all・review はそこへ案内する", async () => {
    const parallel = await readGuide("parallel");
    expect(parallel).toContain("# 着手できるチケットを並べて進める");
    for (const word of [
      "`ready`",
      "同時に 3 件まで",
      "サブエージェントがしない",
      "1 件でほかを止めない",
      "CLAIM_LOST",
      "マージ待ち",
      "`ticket update --pr`",
    ])
      expect(parallel).toContain(word);
    for (const topic of ["work", "all", "review"] as const) {
      const text = await readGuide(topic);
      expect(text, topic).toContain("`dg guide parallel`");
      expect(text, topic).not.toContain("着手できるチケットを並べて進める");
    }
    // 中身は parallel にだけ書く
    expect(await readGuide("work")).not.toContain("サブエージェントがしない");
  });

  it("review は品質ゲートを 1 か所に置き、work は PR を出す前の見直しと上限付きの修正ループを、all はマージの前の条件をそこへ案内し、実装・見直し・手直しの Run を分ける", async () => {
    const review = await readGuide("review");
    const work = await readGuide("work");
    const run = await readGuide("run");
    const all = await readGuide("all");
    for (const heading of [
      "## 品質ゲート",
      "## 見直す",
      "## 指摘を直す（修正ループ）",
      "## Run の分け方",
      "## 終わり方",
    ])
      expect(review).toContain(heading);
    const fixLoop = section(review, "## 指摘を直す（修正ループ）");
    expect(bullet(fixLoop, "上限")).toContain("重い指摘を直すのは 2 回まで");
    const runs = section(review, "## Run の分け方");
    expect(runs).toContain("--retry-reason <直した指摘の要約>");
    // サブエージェントの手直しは印でフックが開き、理由は run retry-reason で書く。自分で直すならもう一度の claim が開いて sync が閉じる（ADR-018）
    expect(fixLoop).toContain("run retry-reason <id> --reason <指摘の要約>");
    expect(fixLoop).toContain("ticket claim <id> --retry-reason <指摘の要約>");
    expect(lineWith(runs, "修正ループの 1 回")).toContain("文の印でフックが開く");
    expect(lineWith(runs, "修正ループの 1 回")).toContain("ticket claim <id> --retry-reason");
    expect(lineWith(runs, "修正ループの 1 回")).toContain("次の見直しの Run の開始はその場で");
    expect(review).not.toContain("run finish --retry-reason");
    const parallel = await readGuide("parallel");
    expect(bullet(parallel, "サブエージェントがしない")).toMatch(
      /^- \*\*サブエージェントがしない\*\*：claim・/,
    );
    expect(bullet(parallel, "親")).toContain("run retry-reason");
    expect(bullet(parallel, "親")).toContain("--retry-reason <指摘の要約>");
    expect(lineWith(section(work, "## 流れ"), "gh pr create --draft")).toContain(
      "手順 8 と同じもう一度の claim",
    );
    const ending = section(review, "## 終わり方");
    // PR を出すのは dg pr ready（ゲートを満たすときだけ gh を呼ぶ。t545）。満たさないまま出すときだけ人が gh を打つ
    for (const word of [
      "チケットは in_progress のまま",
      "人に報告",
      "`dg --json --actor agent pr ready <id>`",
      "人に `gh pr ready` を打ってもらう",
    ])
      expect(ending).toContain(word);
    expect(section(review, "## 見直す")).toContain("`gh pr create --draft`");
    expect(section(review, "## 品質ゲート")).toContain("MERGEABLE");
    // 条件の中身は review にだけ書き、work と all は参照する
    expect(work).toContain("`dg guide review`");
    expect(work).toContain("上限付きの修正ループ");
    // 実装の Run は PR 番号の記録（ticket update --pr）が閉じ、見直しと手直しは別の step の Run にする（RN-6）
    const flow = section(work, "## 流れ");
    expect(flow).toContain("run start <id> <step>");
    expect(lineWith(flow, "run start <id> <step>")).toContain("`implement`");
    expect(lineWith(flow, "run start <id> <step>")).toContain("software-development");
    expect(lineWith(flow, "gh pr create --draft")).toContain("実装の Run を `success` で閉じる");
    expect(lineWith(flow, "gh pr create --draft")).toContain("PR の作成時刻");
    expect(section(work, "## PR の要らない作業")).toContain(
      "`ticket move`（done か review）が `success` で閉じる",
    );
    expect(lineWith(run, "**結果**")).toContain("`ticket unclaim` が `failure` で閉じる");
    expect(run).toContain("--retry-reason");
    for (const step of ["`review`", "`fix`"]) {
      expect(review).toContain(step);
      expect(run).toContain(step);
    }
    expect(review).not.toContain("Run を開けたまま");
    // 上限は親が数え、fix の Run の数では数えない。合う step がなければ代わりの step で記録する
    expect(bullet(fixLoop, "上限")).toContain("親が");
    expect(bullet(fixLoop, "上限")).toContain("重い指摘を直した回で数える");
    // 代わりの step の手順は step を選ぶ run に置き、review は参照する
    expect(bullet(runs, "合う step がない")).toContain("`dg guide run`");
    const noStep = bullet(section(run, "## Run を記録する"), "合う step がない");
    expect(noStep).toContain("`fix` がなければ `review`");
    // step は definition に足して --file で書く。--template は定義を丸ごと置き換える
    expect(noStep).toContain("`dg workflow set <id> --file <path>`");
    expect(noStep).toContain("定義を丸ごと置き換える");
    // テンプレートにも fix がない consulting では人に伝えない
    for (const word of ["consulting", "テンプレート", "伝えず"]) expect(noStep).toContain(word);
    // Run を自分で呼ぶ理由は review に置き、run は参照する
    expect(runs).toContain("Run の ID");
    expect(runs).toContain("会話記録");
    const selfCall = bullet(section(run, "## Run を記録する"), "自分で呼ぶ");
    expect(selfCall).toContain("`dg guide review`");
    expect(selfCall).toContain("Run の分け方");
    // 手直しの失敗・中断では unclaim せず、review の「終わり方」に従う
    const fixFailed = bullet(ending, "手直しが failure で返った・返らない");
    expect(fixFailed).toContain("unclaim は実装の失敗と");
    expect(fixFailed).toContain("実装を途中でやめたときだけ");
    expect(lineWith(work, "手直し・見直しは unclaim せず")).toContain("終わり方");
    expect(lineWith(work, "手直し・見直しは unclaim せず")).toContain("`dg guide review`");
    // 閉じ損ねた・返らない見直し役の Run は親が interrupted で閉じ、見直し役を起動し直す
    const reviewerLost = bullet(ending, "見直し役が閉じ損ねた・返らない");
    for (const word of ["interrupted", "見直し役を起動し直す", "見直し役を起動できない"])
      expect(reviewerLost).toContain(word);
    expect(bullet(ending, "見直し役を起動できない")).toBeTruthy();
    const parallelFix = lineWith(
      await readGuide("parallel"),
      "手直し・見直しが失敗で返ったか返らない",
    );
    for (const word of ["unclaim せず", "`dg guide review`", "終わり方"])
      expect(parallelFix).toContain(word);
    expect(parallelFix).toContain("印で頼んだ手直しの Run は push して返ったときにフックが閉じる");
    const allFailed = lineWith(all, "todo に戻さず");
    for (const word of ["手直し", "見直し", "返らない"]) expect(allFailed).toContain(word);
    // done の「終わらなかったとき」は実装の Run と手直し・見直しの Run を分け、review へ案内する
    const unfinished = section(await readGuide("done"), "## 終わらなかったとき");
    expect(unfinished).toContain("実装・手直しの Run は unclaim が `failure` で閉じる");
    for (const word of ["手直し・見直しの Run", "unclaim せず", "`dg guide review`", "終わり方"])
      expect(unfinished).toContain(word);
    expect(work).not.toContain("開けたまま");
    expect(section(all, "### マージの前の条件")).toContain("`dg guide review`");
    for (const text of [work, all]) expect(text).not.toContain("--json mergeable");
  });

  it("plan・work・parallel・all・run・review は plan の Run を案内しない", async () => {
    expect(await readGuide("plan")).not.toContain("run start <id> plan");
    for (const topic of ["plan", "work", "parallel", "all", "run", "review"])
      expect(await readGuide(topic)).not.toMatch(/`plan` の Run|step.*`plan`|\| `plan`/);
  });

  it("plan の手順 4 は参考節のファイルが重なるチケットを並行させず after でつなぎ、参考節のないチケットは依存と優先度で順を決めると案内する", async () => {
    const order = step(await readGuide("plan"), 4);
    for (const word of [
      "## 参考",
      "重なる",
      "並行させず",
      "`after`",
      "参考節のないチケット",
      "依存と優先度",
    ])
      expect(order, word).toContain(word);
    // つなぐ判断 → 参考節のないチケットは対象外 → 従来どおり依存と優先度、の順
    expect(order).toMatch(
      /並行させず `after` でつなぐ[\s\S]*?参考節のないチケット[\s\S]*?依存と優先度/,
    );
    expect(await readGuide("import")).toContain("並行させず `after` でつなぐ");
  });

  it("review は版上げの PR で見直しを省ける条件を品質ゲートに書き、release はそこへ案内する", async () => {
    const gate = section(await readGuide("review"), "## 品質ゲート");
    for (const word of [
      "版上げの PR は見直しを省ける",
      "コード・文書・手順を変えない",
      "人の承認が見直しの代わりになる",
      "版上げの例外は下",
    ])
      expect(gate).toContain(word);
    const release = await readGuide("release");
    const steps = section(release, "## リリースの手順");
    for (const word of ["`dg guide review`", "品質ゲート", "版上げの条件"])
      expect(steps).toContain(word);
    // 条件の中身は review にだけ書く
    expect(release).not.toContain("コード・文書・手順を変えない");
    expect(release).not.toContain("ロックファイル");
  });

  it("config の値を埋める（既定なら main と origin、空の配列と空の文字列は「なし」）", () => {
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
    // 既定が空でも、空の文字列を明示して「なし」になることを確かめる
    expect(
      fillPlaceholders("{{models.light}}", {
        ...defaultConfig(),
        models: { ...defaultConfig().models, light: "" },
      }),
    ).toBe("なし");
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
