import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "@deguboard/core";
import { cliEnv } from "../../core/test/helpers/env.js";
import { createLocalOnlyRepo } from "../../core/test/helpers/git-fixture.js";
import { GUIDE_TOPICS, fillPlaceholders, readGuide, readGuideMeta, renderGuide } from "./guide.js";
import { buildProgram, run } from "./program.js";
import { buildSkills } from "./skill.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

// 本文の組み立て（読み込み・choices・config の埋め込み・節の切り出し）を変えたときに出力が変わっていないかを確かめる。
// 初期化していない一時ディレクトリで既定の config を使う。意図して本文を変えたときだけ snapshot を更新する
describe("dg guide の出力（本文の組み立て）", () => {
  it("トピックごとの本文と、節の本文が変わらない", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dg-guide-golden-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    for (const topic of GUIDE_TOPICS) {
      const guide = await renderGuide(topic, dir);
      expect(guide.warnings, topic).toEqual([]);
      expect(guide.text, topic).toMatchSnapshot(topic);
    }
    expect((await renderGuide("work", dir, "Implement (up to a draft PR)")).text).toMatchSnapshot(
      "work の節",
    );
    expect((await renderGuide("import", dir, "Choosing the next step")).text).toMatchSnapshot(
      "import の節",
    );
    expect((await renderGuide("plan", dir, "Creating a Plan")).text).toMatchSnapshot(
      "plan の節（見出し）",
    );
  });
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
  return (
    text
      .split("\n")
      .find((line) => line.replace(/\*\*/g, "").match(new RegExp(`^- ${name}(：|: )`))) ?? ""
  );
}

/** 英語に直したトピック（guide-*.md の本文が英語。選択肢の節は共通で英語） */
const ENGLISH_TOPICS = new Set([
  "overview",
  "choices",
  "import",
  "assign",
  "check",
  "plan",
  "work",
  "run",
  "parallel",
  "review",
  "audit",
  "release",
  "done",
  "change",
  "discuss",
  "status",
  "retro",
  "all",
]);

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
      // 英語に直した手順（overview・choices・import・assign・check・plan）は英語の見出し。選択肢の節は共通で英語
      const english = ENGLISH_TOPICS.has(topic);
      const target = english ? "## Deciding the target" : "## 対象を決める";
      const next = english ? "## Choosing the next step" : "## 次の手順を選ぶ";
      for (const heading of [target, "## Asking with choices", next])
        expect(text, `${topic} ${heading}`).toContain(heading);
      expect(text, topic).not.toContain("{{choices}}");
    }
  });

  it("次の手順は Skill がなければ dg guide を読んで続けると案内する", async () => {
    const choices = lineWith(await readGuide("import"), "When the next step is chosen");
    for (const word of ["Skill", "If not", "`dg guide <topic>`", "continue with that step"])
      expect(choices).toContain(word);
    expect(lineWith(await readGuide("overview"), "A Skill is optional")).toContain(
      "`dg guide <topic>`",
    );
    for (const topic of GUIDE_TOPICS) {
      const english = ENGLISH_TOPICS.has(topic);
      const next = section(
        await readGuide(topic),
        english ? "## Choosing the next step" : "## 次の手順を選ぶ",
      );
      for (const line of next.split("\n").filter((l) => l.includes("`/dg"))) {
        expect(line, topic).toContain(english ? "if a Skill is available" : "Skill があれば");
        expect(line, topic).toContain("dg guide");
      }
    }
  });

  it("import の次の手順は選択肢を 4 つ以内に収め、勧める割り当ては先頭のままで、検討は決めたい点が残るときに起票した ID で dg guide discuss へ進むと案内する", async () => {
    const next = section(await readGuide("import"), "## Choosing the next step");
    const items = next.split("\n").filter((line) => line.startsWith("- **"));
    expect(items.length).toBeLessThanOrEqual(4);
    expect(items[0]).toContain("**Assign** (recommended)");
    const discuss = lineWith(next, "**Discuss**");
    for (const word of ["open points", "`dg guide discuss`", "with the filed IDs", "/dgdiscuss"])
      expect(discuss, word).toContain(word);
  });

  it("import は受け入れ条件が 7 項目以上のチケットを分けることを、根拠とともに勧める", async () => {
    const tips = section(await readGuide("import"), "## How to write a good ticket");
    expect(tips).toMatch(/7 or more acceptance criteria[\s\S]*?recommend splitting[\s\S]*?9 of 10/);
  });

  it("work と done は ticket check を案内し、本文全体を書き戻す手順を残さない", async () => {
    const work = await readGuide("work");
    const done = await readGuide("done");
    expect(work).toContain("ticket check");
    expect(done).toContain("ticket check");
    expect(done).not.toContain("--body");
    expect(work).not.toContain("--body");
  });

  it("work の実装の手順は draft の PR まで、正本を読み直して直し、PR の本文に読み直したことと付けられなかった項目を書く", async () => {
    const impl = section(await readGuide("work"), "## Implement (up to a draft PR)");
    for (const word of ["requirements", "README"]) expect(impl).toContain(word);
    // 判断を変えたら ADR の本文を同じ PR で直し、この PR が誤りにした ADR の細部は消す（報告に回さない）
    for (const word of [
      "rewrite the body of that decision's ADR (if there is one) directly in the same PR",
      "Delete the details of an ADR that this PR made wrong",
      "Report stale documents from before that this PR did not change, without fixing them",
    ])
      expect(impl, word).toContain(word);
    // 読み直し → PR を作る → 本文に読み直した正本と直した箇所を書く、の順
    expect(impl).toMatch(
      /Read again[\s\S]*?gh pr create --draft[\s\S]*?read again and the places you fixed/,
    );
    expect(impl).toContain("the acceptance criteria that could not be met");
  });

  it("work の claim は実装の Run を開き、委譲は --no-run で claim すると案内し、run は親が自分で進めるときの claim と PR の記録だけを書く（RN-5）", async () => {
    const work = await readGuide("work");
    expect(lineWith(work, "`implement`")).toContain("--no-run");
    const run = await readGuide("run");
    const self = section(run, "## When the parent opens the Run itself");
    for (const word of ["`ticket claim`", "data.run", "ticket update --pr", "`success`"])
      expect(self, word).toContain(word);
    // サブエージェントの Run の開閉・--agent・開いたままの警告は書かない
    for (const word of ["--agent", "フック", "--no-run", "run start", "開いたまま"])
      expect(run, word).not.toContain(word);
    expect(await readGuide("overview")).toContain("`ticket claim` opens");
  });

  it("フックが届くセッションでは implement と fix を小さな手直しを含めていつもサブエージェントに頼み、親が自分で進めるのはフックが届かないときだけと案内する（t713）", async () => {
    const work = await readGuide("work");
    const who = section(work, "## Who implements and fixes");
    expect(lineWith(who, "**When dg hooks reach the session**")).toMatch(
      /always ask a subagent for `implement` and `fix`[\s\S]*even for a small fix[\s\S]*does not implement or fix it itself/,
    );
    // 親が自分で進める手順（--no-run を外す）は、フックが届かないときの項にだけある
    expect(lineWith(who, "**When no dg hook reaches the session**")).toContain("Remove `--no-run`");
    // 届いていないと警告するのは claim（--no-run）と brief。dg next は警告しない
    expect(lineWith(who, "**When no dg hook reaches the session**")).toContain(
      "`ticket claim --no-run` and `brief` warn",
    );
    expect(work.split("Remove `--no-run`").length).toBe(2);
    expect(lineWith(work, "`implement`")).not.toContain("implements it itself");
    const fixLoop = bullet(
      section(await readGuide("review"), "## Fix loop (parent)"),
      "Findings to fix",
    );
    expect(fixLoop).toContain(
      "When dg hooks reach the session, always ask a subagent, even for a small fix",
    );
    expect(fixLoop).toContain(
      "Only when no dg hook reaches the session may the parent fix it itself",
    );
    const run = await readGuide("run");
    expect(run).toContain(
      "When dg hooks reach the session, implementation and fixes are always asked of a subagent",
    );
    const overview = await readGuide("overview");
    expect(overview).toContain(
      "When dg hooks reach the session, implementation and fixes are always asked of a subagent",
    );
    expect(overview).toContain("Only when no dg hook reaches the session");
  });

  it("review は文書との食い違いを、この PR が変えた約束・手順・規約で文書を直していないものに限って重い指摘にし、前からのずれは audit に送る。参考節との食い違いは軽い指摘として返し、参考節がなければ見比べないと案内し、直さなかった軽い指摘は dg pr ready が PR の本文に書き足すと決める", async () => {
    const review = await readGuide("review");
    const look = bullet(section(review, "## Review"), "Look at");
    for (const word of [
      "findings outside the scope",
      "Mismatches with the documents",
      "## References",
      "mismatch with the references section",
      "If there is no section, do not compare",
    ])
      expect(look, word).toContain(word);
    // 重い・軽いの分けは「Return」だけに書く（Look at と Return で二度並べない）
    const back = bullet(section(review, "## Review"), "Return");
    for (const word of [
      "this PR changed",
      "sent to the Iteration review",
      "mismatches with the references section",
    ])
      expect(back, word).toContain(word);
    // 受け入れ条件の指摘は category に acceptance criteria を含め、手直しに渡す軽い指摘を dg が category で選ぶ（t600）
    for (const word of [
      "missing acceptance criteria",
      'include "acceptance criteria" in its category',
    ])
      expect(back, word).toContain(word);
    const fix = section(review, "## Fix loop (parent)");
    for (const word of [
      "mismatches with the references section",
      "`dg pr ready` adds them to the PR body",
      "Unfixed light findings",
      // 手直しが直さずに返した理由は dg が書けないので、親が報告に書く（t600）
      "dg cannot write the findings that the fixer returned without fixing",
      "the parent writes them in the report",
      // 親が手直しに渡す軽い指摘は run handoff で dg に伝え、直したかによらず本文に載らない（t639）
      "`dg --json --actor agent run handoff <id> --findings-file <file>`",
      'they are left out of the "Unfixed light findings" section (## Unfixed light findings) of the PR body whether they were fixed or not',
      "Findings passed to the fix (`run handoff`) are left out whether they were fixed or not",
    ])
      expect(fix, word).toContain(word);
    expect(fix).not.toContain("gh pr edit");
    expect(await readGuide("parallel")).toContain(
      "light findings you did not fix are added to the PR body by `dg pr ready`",
    );
  });

  it("review は ADR や要件に足した細部を重い指摘にし、文書を直していない重い指摘は約束・手順・規約の変更に限る", async () => {
    const review = await readGuide("review");
    const back = bullet(section(review, "## Review"), "Return");
    for (const word of [
      "details added to an ADR or the requirements",
      "move the detail to code, tests, or help",
      "heavy",
      "a promise, procedure, or convention",
      "without fixing the documents",
    ])
      expect(back, word).toContain(word);
  });

  it("import は受け入れ条件に ADR や要件の書き足しを入れるのを判断の種類に当たるときだけにし、それ以外はテストとコメントで約束を示すと案内する", async () => {
    const criteria = lineWith(await readGuide("import"), "Add a requirement document or ADR");
    for (const word of ["migration to reverse", "tests and comments"])
      expect(criteria, word).toContain(word);
  });

  it("同梱の guide（guide-*.md の全部）は、このリポジトリの ADR 番号を書かない（基準は中身を 1 文で書く）", async () => {
    const dir = new URL("../../core/src/guide/", import.meta.url);
    const files = (await readdir(dir)).filter((file) => /^guide-.+\.md$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(await readFile(new URL(file, dir), "utf8"), file).not.toMatch(/ADR-\d{3}/);
  });

  it("import は本文の項目の引用しない値の行末コメントが拒まれると書き、直し方はエラーの文に任せる", async () => {
    const comment = lineWith(await readGuide("import"), "trailing comment on an unquoted value");
    for (const word of [
      "title, summary, acceptance, body",
      "the error message says how to fix it",
      "comment-only lines are allowed",
    ])
      expect(comment, word).toContain(word);
  });

  it("audit は ADR の細部と実装のずれを「ADR の細部を消す」として起票し、意図した設計はテストかコメントで押さえる起票を勧める", async () => {
    const audit = await readGuide("audit");
    expect(audit).toContain('"Remove ADR details"');
    expect(section(audit, "## Not repeating the same findings")).toContain("tests or comments");
  });

  it("retro はまず数字の要約を出し、外れ値のある観点を理由つきで勧めて観点を複数選択で 1 回聞き、指示で決まっていれば聞かない", async () => {
    const retro = await readGuide("retro");
    const steps = section(retro, "## Retrospective steps");
    // 要約は metrics show --by step と ticket list から。聞くより前に出す
    for (const word of ["metrics show --iteration <S> --by step", "ticket list --iteration <S>"])
      expect(step(steps, 1), word).toContain(word);
    const summary = step(steps, 2);
    expect(summary).toContain("before asking anything");
    for (const word of [
      "`total.runs`",
      "Share of time per step",
      "`total.results.failure`",
      "`total.retries`",
      "`total.reviews.heavy`",
      "Carry-overs",
    ])
      expect(summary, word).toContain(word);
    const ask = step(steps, 3);
    for (const word of [
      "once, with multiple selection",
      "Recommend the viewpoints where a number stands out",
      "as the reason",
      "Do not ask when the viewpoints are already decided",
    ])
      expect(ask, word).toContain(word);
    expect(section(retro, "## Deciding the target")).toContain("do not ask which viewpoints");
    // 観点は 4 つで、それぞれ読む dg のコマンドと答える問いを持つ
    const viewpoints = section(retro, "## Viewpoints");
    for (const [name, command] of [
      ["Outcome", "iteration show <S>"],
      ["Flow", "run list --iteration <S>"],
      ["Rework", "metrics show --iteration <S> --by ticket"],
      ["Comparison", "ticket list --label retro-<previous S>"],
    ] as const) {
      const row = lineWith(viewpoints, `| ${name} `);
      expect(row, name).toContain(command);
      expect(row, name).toContain("?");
    }
  });

  it("retro の手戻りの原因は retry_reasons と heavy が出た PR のレビューのコメントだけから分け、gh がなければ「わからない」と書く", async () => {
    const causes = section(await readGuide("retro"), "## Causes of rework");
    for (const word of [
      "only from these two sources",
      "Do not infer a cause",
      "`retry_reasons`",
      "heavy finding",
      "gh pr view <number>",
    ])
      expect(causes, word).toContain(word);
    const unknown = lineWith(causes, "If `gh` is not available");
    expect(unknown).toContain('"unknown"');
  });

  it("retro の比較は前の Iteration の metrics に加え、retro-<前の S> のラベルのチケットの状態から前回の Try が終わったかを示す", async () => {
    const comparison = section(
      await readGuide("retro"),
      "## Comparison with the previous Iteration",
    );
    const tries = lineWith(comparison, "retro-<previous S>");
    for (const word of ["label", "status", "whether it was finished", "done", "todo", "abandoned"])
      expect(tries, word).toContain(word);
    expect(lineWith(section(await readGuide("retro"), "## Viewpoints"), "| Comparison ")).toContain(
      "metrics show --iteration <previous S> --by step",
    );
  });

  it("retro は計測の抜け（missing・estimated_runs・no_runs）を注意書きに添え、抜けのある値は推し量らず「わからない」と書く", async () => {
    const retro = await readGuide("retro");
    const gaps = section(retro, "## Gaps in the measurement");
    for (const word of ["as notes", "`missing`", "`estimated_runs`", "`no_runs`"])
      expect(gaps, word).toContain(word);
    const guess = lineWith(gaps, "by guessing");
    expect(guess).toContain("Do not fill in a value that has a gap");
    expect(guess).toContain('"unknown"');
    expect(step(section(retro, "## Retrospective steps"), 2)).toContain("Gaps in the measurement");
  });

  it("retro は根拠つきの Keep / Problem / Try の表と Try の扱いを示し、承認まで書き換えず、起票は guide import に従って retro-<S> を付け、Iteration は付けない", async () => {
    const retro = await readGuide("retro");
    const table = section(retro, "## Keep / Problem / Try");
    expect(table).toContain("| #   | Kind | Finding | Basis | Handling |");
    for (const word of [
      "a number (with the command and the field it came from) or ticket IDs",
      "Drop a finding that has neither",
      '"File"',
      '"`ticket update <ID>`"',
      '"File an improvement to the rules or guide"',
      '"Do not fix (reason)"',
    ])
      expect(table, word).toContain(word);
    const approval = step(section(retro, "## Retrospective steps"), 6);
    for (const word of [
      "once, with multiple selection",
      "Write nothing until approval is obtained",
    ])
      expect(approval, word).toContain(word);
    const filing = section(retro, "## Filing tickets");
    for (const word of [
      "`dg guide import`",
      "the label `retro-<S>`",
      "Do not write `iteration`",
      "`dg guide assign`",
    ])
      expect(filing, word).toContain(word);
    // 対象は閉じた Iteration だけ。振り返りはチャットで返し、データに残さない（振り返りの数字を AI に書かせて残すと正確でないため）
    expect(section(retro, "## Deciding the target")).toContain("It should be closed");
    expect(retro).toContain("is not stored in the data");
  });

  it("work は PR の要らない作業を --without-branch で claim し、確かめたら done、残れば review と案内する。claim の warnings は「claim の前後」に任せ、Iteration の選び方は書き写さず、今の設定を埋める", async () => {
    const work = await readGuide("work");
    const noBranch = section(work, "## Work that needs no PR");
    expect(noBranch).toContain("ticket claim <id> --without-branch");
    expect(noBranch).toContain("ticket move <id> done");
    expect(noBranch).toContain("ticket move <id> review");
    expect(noBranch).toContain('"Before and after claim"');
    expect(noBranch).not.toContain("iteration add <S> <id>");
    const before = (text: string) => section(text, "## Before and after claim");
    // 入れ先の選び方は claim のコード（ticket claim --help）が正本で、guide に書き写さない（ST-3）
    expect(before(work)).toContain("ticket claim --help");
    expect(before(work)).not.toContain("start` が最も早い");
    expect(before(fillPlaceholders(work, defaultConfig()))).toContain("current setting: `false`");
    expect(
      before(fillPlaceholders(work, { ...defaultConfig(), lint: { require_iteration: true } })),
    ).toContain("current setting: `true`");
  });

  it("plan・work・done は Plan を作り、人の承認で approve し、順と範囲を読んで進め、終わったら閉じると案内する", async () => {
    const plan = await readGuide("plan");
    const work = await readGuide("work");
    const done = await readGuide("done");
    expect(plan).not.toContain("まだない");
    for (const command of ["plan create", "plan approve", "plan show", "--after", "--scope"])
      expect(plan).toContain(command);
    expect(plan).toContain("Do not approve without a human's approval");
    expect(plan).toContain("plan.approve");
    for (const word of ["plan show", "`next`", "`ready`", "waiting", "scope", "approach"])
      expect(work).toContain(word);
    expect(done).toContain("plan close");
  });

  it("all は --auto の範囲を config の auto.decisions と auto.merge に任せ、人が決める判断は聞いて止まる。自動マージは auto.merge を true にしたときだけ条件を確かめて行う", async () => {
    const all = await readGuide("all");
    const auto = section(all, "## Choosing automatically with `--auto`");
    for (const word of [
      "approval.auto",
      "approval.what",
      "accept",
      "auto.decisions",
      "auto.merge",
      "dg guide review",
      "Decisions a human makes",
    ])
      expect(auto).toContain(word);
    expect(fillPlaceholders(all, defaultConfig())).toContain("current setting: `false`");
    expect(fillPlaceholders(all, defaultConfig())).toContain(
      "current setting: `assign, check, plan, audit, accept`",
    );
    expect(
      fillPlaceholders(all, { ...defaultConfig(), auto: { ...defaultConfig().auto, merge: true } }),
    ).toContain("current setting: `true`");
    expect(await readGuideMeta("all")).toMatchObject({
      "argument-hint": expect.stringContaining("--auto"),
    });
  });

  it("work は Iteration への追加と開始、worktree の作成を claim に任せ、warnings が出たら人に頼むと案内し、親に git worktree と iteration add・start を打たせない。check は lint_iteration_missing の直す案を claim と同じ規則で示す。今の設定は両方で埋める", async () => {
    const work = await readGuide("work");
    const before = section(work, "## Before and after claim");
    for (const word of [
      "`warnings`",
      "lint_iteration_missing",
      "ask a human for the Iteration",
      "Keep going with the work",
    ])
      expect(before, word).toContain(word);
    for (const text of [work, await readGuide("parallel")])
      for (const word of ["git worktree add", "iteration add <S>", "iteration start <S>"])
        expect(text, word).not.toContain(word);
    const check = await readGuide("check");
    for (const word of [
      "lint_iteration_missing",
      "iteration add <S> <id>",
      "ask a human whether",
      "ticket claim --help",
    ])
      expect(check, word).toContain(word);
    expect(fillPlaceholders(work, defaultConfig())).toContain("current setting: `false`");
    expect(fillPlaceholders(check, defaultConfig())).toContain("Current setting: `false`");
    expect(
      fillPlaceholders(check, { ...defaultConfig(), lint: { require_iteration: true } }),
    ).toContain("Current setting: `true`");
  });

  it("work は段階のモデルを dg next の model に任せ、調べものは models.light。{{models.*}} は埋めない。見直し役は親のモデル", async () => {
    const work = await readGuide("work");
    expect(work).not.toContain("{{models.");
    expect(work).not.toContain("implement` のモデル");
    expect(work).toContain("If `model` is not empty");
    expect(work).toContain("uses `models.light` (the parent's model if it is empty)");
    expect(await readGuide("review")).toContain("regardless of the stage");
    expect(await readGuide("plan")).toContain("--tier");
  });

  it("check は lint_iteration_multiple_active でどれを閉じるかを人に聞き、閉じるのは人の指示で行う", async () => {
    const multiple = lineWith(await readGuide("check"), "lint_iteration_multiple_active");
    expect(multiple).toContain("ask a human which one to close");
    expect(multiple).toContain("only on a human's instruction");
  });

  it("parallel は next の手が複数あるとき上限付きでサブエージェントに並べ、1 件でほかを止めないと案内し、work・all はそこへ案内する", async () => {
    const parallel = await readGuide("parallel");
    expect(parallel).toContain("# Advancing ready tickets in parallel");
    for (const word of [
      "`next`",
      "up to {{work.parallel}} at the same time",
      "One ticket does not stop the others",
      "CLAIM_LOST",
      "waiting for a merge",
      "Before and after claim",
    ])
      expect(parallel, word).toContain(word);
    for (const topic of ["work", "all"] as const) {
      const text = await readGuide(topic);
      expect(text, topic).toContain("`dg guide parallel`");
      expect(text, topic).not.toContain("着手できるチケットを並べて進める");
    }
  });

  it("review は品質ゲートと修正ループの回数を dg の判定に任せ、Run の説明と回数を書かず、止まった見直し役を終わり方で扱う", async () => {
    const review = await readGuide("review");
    for (const heading of [
      "## Quality gate",
      "## Starting the review (parent)",
      "## Review",
      "## Fix findings",
      "## Fix loop (parent)",
      "## How to finish",
    ])
      expect(review).toContain(heading);
    // 回数と Run の説明は dg が持つ。guide には書かない（EX-3）
    for (const word of ["2 回まで", "3 回まで", "Run の分け方", "--agent", "run start", "--no-run"])
      expect(review, word).not.toContain(word);
    const fix = section(review, "## Fix loop (parent)");
    expect(bullet(fix, "Limit")).toContain("fix_rounds");
    expect(bullet(fix, "Limit")).toContain("wait_human");
    expect(bullet(fix, "Findings to fix")).toContain("--role fix");
    expect(fix).toContain("Do not ask for it in the continuation of the same conversation");
    expect(fix).toContain("Do not call `dg next` until the fixing subagent returns");
    // 見直しは dg next の brief を渡す。ゲートの条件は dg gate の判定に任せる
    expect(section(review, "## Starting the review (parent)")).toContain(
      "that `dg next` returns as the `review` step",
    );
    // brief に入るのは役の節だけなので、親は work の review・fix の手から親の節へ辿る（t593）
    const work = await readGuide("work");
    expect(lineWith(work, "- `review`:")).toContain('"Starting the review (parent)"');
    expect(lineWith(work, "- `fix`:")).toContain('"Fix loop (parent)"');
    expect(bullet(fix, "Findings outside the scope")).toContain("dg guide import");
    expect(section(review, "## Quality gate")).toContain("MERGEABLE");
    expect(section(review, "## Quality gate")).toContain("fix_rounds");
    // PR を出すのは dg pr ready（ゲートを満たすときだけ gh を呼ぶ）。満たさないまま出すときだけ人が gh を打つ
    const ending = section(review, "## How to finish");
    for (const word of [
      "`dg --json --actor agent pr ready <id>`",
      "GATE_FAILED",
      "the ticket in_progress",
      "to a human",
      "wait_human",
    ])
      expect(ending, word).toContain(word);
    expect(lineWith(ending, "Cannot start a reviewer")).toContain("not reviewed");
    expect(lineWith(ending, "Reviewer does not return")).toContain("`dg guide run`");
    // 作業の guide は review を参照し、条件の中身は review に書く
    for (const topic of ["work", "all"] as const)
      expect(await readGuide(topic), topic).toContain("`dg guide review`");
    expect(lineWith(await readGuide("all"), "not put back to todo")).toContain("did not return");
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
      "overlap",
      "do not run them in parallel",
      "`after`",
      "Tickets without a references section",
      "dependencies and priority",
    ])
      expect(order, word).toContain(word);
    // つなぐ判断 → 参考節のないチケットは対象外 → 従来どおり依存と優先度、の順
    expect(order).toMatch(
      /do not run them in parallel[\s\S]*?`after`[\s\S]*?Tickets without a references section[\s\S]*?dependencies and priority/,
    );
    expect(await readGuide("import")).toContain("with `after` instead of running them in parallel");
  });

  it("review は版上げの PR を人の指示で low の段にする道を品質ゲートに書き、release はそこへ案内する", async () => {
    const gate = section(await readGuide("review"), "## Quality gate");
    for (const word of [
      "A version-bump PR runs at the low level",
      "only on a human's instruction",
      "takes the place of the review",
      "keep the high level and have it reviewed",
    ])
      expect(gate).toContain(word);
    const release = await readGuide("release");
    const steps = section(release, "## Release steps");
    for (const word of [
      "`dg guide review`",
      "Quality gate",
      "by setting the ticket's level to `low`",
    ])
      expect(steps).toContain(word);
    // 版上げの条件（変更の範囲）は review にだけ書く
    expect(release).not.toContain("version numbers");
    expect(release).not.toContain("CHANGELOG and lock file");
  });

  it("discuss は議論の間は書き換えず、論点を選択肢で決め、前後の差の承認を得てから import・change の手順で反映する", async () => {
    const guide = await readGuide("discuss");
    const discussing = section(guide, "## While discussing");
    for (const word of ["Change no files and no data", "with choices", '"Asking with choices"'])
      expect(discussing).toContain(word);
    // 選択肢の聞き方は共通の節（guide-choices）を差し込む
    expect(guide).toContain("## Asking with choices");
    const steps = section(guide, "## Steps");
    for (const word of ["in_progress", "run list --running", "tell the human before reflecting"])
      expect(step(steps, 3)).toContain(word);
    for (const word of ["before → after", "Do not reflect without approval"])
      expect(step(steps, 4)).toContain(word);
    // 反映の手順は書き写さず、チケットは import、Epic・Iteration は change に任せる
    expect(lineWith(step(steps, 5), "tickets")).toContain("`dg guide import`");
    expect(lineWith(step(steps, 5), "Epic or Iteration")).toContain("`dg guide change`");
    for (const word of ["ticket import", "ticket create", "epic update", "iteration update"])
      expect(guide).not.toContain(word);
    // 反映するのは題・本文・受け入れ条件・優先度・依存・段だけで、Status・所属・閉じる・やめるは合う頼むことを示して止まる
    const reflected = section(guide, "## What is reflected");
    for (const word of [
      "title",
      "body",
      "acceptance criteria",
      "priority",
      "dependencies",
      "gate level",
    ])
      expect(reflected.split("\n")[1]).toContain(word);
    for (const word of [
      "Status",
      "membership",
      "closing",
      "abandoning",
      "Show the ask that fits and stop",
    ])
      expect(reflected).toContain(word);
    for (const word of ["`dg guide assign`", "`dg guide change`"])
      expect(reflected).toContain(word);
    // status・retro の節は持たない（様子は guide status、振り返りは別の頼むこと）
    expect(guide).not.toMatch(/^## .*(status|retro)/im);
  });

  it("discuss の --deep は frontmatter と Skill の雛形に写り、観点をすべて持ち、論点のある観点だけを掘って外した観点は理由を 1 行で示し、方式は案を 2 つ以上比べ、受け入れ条件の文言は最後に回す", async () => {
    const guide = await readGuide("discuss");
    const meta = await readGuideMeta("discuss");
    expect(meta.description).toContain("--deep");
    expect(meta["argument-hint"]).toContain("--deep");
    const dgdiscuss = (await buildSkills()).find((s) => s.name === "dgdiscuss");
    expect(dgdiscuss?.content.split("\n---\n")[0]).toContain("--deep");
    expect(dgdiscuss?.content).toContain("With --deep, checks every viewpoint");

    // 観点は 1 つの節にまとめ、ほかの節は「--deep のときはその節に従う」の案内だけを足す
    expect(guide.split("## Deep discussion (`--deep`)").length - 1).toBe(1);
    const deep = section(guide, "## Deep discussion (`--deep`)");
    for (const viewpoint of [
      "**Need**",
      "**Purpose and outcome**",
      "**Approach**",
      "**Scope**",
      "**Order, dependencies, and priority**",
      "**Premises and risks**",
      "**Reversibility**",
      "**Visibility**",
    ])
      expect(deep, viewpoint).toContain(viewpoint);
    for (const word of ["now, drop it, or defer", "who gains what", "promise to users"])
      expect(deep, word).toContain(word);
    // 範囲の重なりは開いたチケットを ticket list --status で絞って --query で探し、References のファイルと突き合わせる
    const scope = lineWith(deep, "**Scope**");
    for (const word of [
      "ticket list --status todo,in_progress,review --query",
      "References",
      "files",
    ])
      expect(scope, word).toContain(word);
    // 方式の論点は案を 2 つ以上、利点と欠点の表で比べ、聞くのは選択肢で
    const approach = lineWith(deep, "**Approach**");
    for (const word of ["2 or more", "table of advantages and disadvantages", "recommended"])
      expect(approach, word).toContain(word);
    // 論点のある観点だけを掘り、外した観点は理由を 1 行で示す
    for (const word of ["only the ones with open points", "one-line reason"])
      expect(deep, word).toContain(word);
    // 受け入れ条件の文言は観点の論点が決まった後に回す
    expect(deep).toContain("comes last");
    expect(deep).toContain("after the points of the viewpoints above are settled");
    // やめる・分ける・移すの結論は今の反映の範囲に従い、--deep で変えない
    expect(deep).toContain("does not change what is reflected");
    // 対象の決め方・議論の間・手順 2 は、--deep のときこの節に従うと案内する
    for (const heading of ["## Deciding the target", "## While discussing", "## Steps"])
      expect(section(guide, heading), heading).toContain('"Deep discussion (`--deep`)" section');
  });

  it("status は進んでいる作業の様子を読むだけで書き換えず、Run が実行中なら手を出さず、止まっていれば再開を勧めるだけにする", async () => {
    const guide = await readGuide("status");
    // 読むものは ticket show・next・run list・worktree のコミット・PR の状態。書く dg の呼び方は持たない
    const reading = section(guide, "## Reading");
    for (const word of ["ticket show", "`next", "run list", "git -C", "gh pr view"])
      expect(reading).toContain(word);
    for (const word of ["ticket update", "ticket move", "ticket check", "run start", "run finish"])
      expect(guide).not.toContain(word);
    // 答えは 3 から 5 行で、今の段階・止まった理由・次の一手
    const answering = section(guide, "## Answering");
    expect(answering).toContain("3 to 5 lines");
    expect(answering).toContain("Do not act on the ticket or the Run");
    // 止まっていれば再開を勧めるだけで、ここでは再開せず、選択肢で聞かない
    expect(section(guide, "## Choosing the next step")).toContain("does not resume");
    expect(guide).toContain("## Asking with choices");
  });

  it("status は対象を選択肢で聞き、次の一手は選択肢で聞かない（別々に確かめる）", async () => {
    const guide = await readGuide("status");
    // 対象の決め方：対象がなければ、選択肢の節（差し込み）で ticket を聞く。その節は対象の節と次の手順の間にある
    const target = section(guide, "## Deciding the target");
    expect(target).toContain("No target given: ask which ticket, with the choices below");
    const choices = guide.indexOf("## Asking with choices");
    expect(choices).toBeGreaterThan(guide.indexOf("## Deciding the target"));
    expect(choices).toBeLessThan(guide.indexOf("## Reading"));
    // 次の一手：選択肢を出さず、再開を勧めるだけ。選択肢の節の語を持たない
    const next = section(guide, "## Choosing the next step");
    expect(next).toContain("asks no choices of its own");
    for (const word of ["Asking with choices", "AskUserQuestion", "ask which"])
      expect(next).not.toContain(word);
  });

  it("change は操作ごとの前提を確かめ、当たるときだけ前後を示して承認を得て、dg を 1 回呼び、拒否されたら人にコマンドを渡す", async () => {
    const steps = section(await readGuide("change"), "## Steps");
    // 前提の確認：close は未完了、Iteration の reopen はほかの active、abandon は理由、undo done は戻す Status と理由、edit は前後
    const pre = step(steps, 2);
    expect(lineWith(pre, "**close**")).toContain("not done or abandoned");
    expect(lineWith(pre, "**close**")).toContain("Close without releasing");
    expect(lineWith(pre, "**reopen**")).toContain(
      "another Iteration in the same Project is active",
    );
    expect(lineWith(pre, "**abandon**")).toContain("reason");
    for (const word of ["Status to return to", "reason"])
      expect(lineWith(pre, "**undo done**")).toContain(word);
    expect(lineWith(pre, "**edit**")).toContain("before → after");
    // 前後を示した承認は前提に当たるときだけ（頼んだ時点で人の指示があるので二重に聞かない）
    for (const word of ["before → after", "ask with choices", "do not ask again"])
      expect(step(steps, 3)).toContain(word);
    expect(step(steps, 4)).toContain("call `dg` once per target");
    for (const word of ["TRANSITION_REJECTED", "exact command", "do not retry"])
      expect(step(steps, 5)).toContain(word);
    // 1 回の呼び出しは表の dg のコマンドで、ticket の直すの範囲は題・概要・受け入れ条件・優先度・ラベル・依存
    const ops = section(await readGuide("change"), "## Operations");
    for (const word of ["--acceptance", "--priority", "--label", "--depends-on", "iteration close"])
      expect(ops).toContain(word);
  });

  it("config の値を埋める（既定なら main と origin、空の配列と空の文字列は none）", () => {
    expect(
      fillPlaceholders(
        "{{git.remote}}/{{git.base_branch}} {{commit.mode}} {{actor.human_only}} {{nope}}",
        defaultConfig(),
      ),
    ).toBe("origin/main batch none {{nope}}");
    expect(
      fillPlaceholders("{{actor.human_only}}", {
        ...defaultConfig(),
        actor: { human_only: ["epic.close", "iteration.close"] },
      }),
    ).toBe("epic.close, iteration.close");
    // 既定が空でも、空の文字列を明示して none になることを確かめる
    expect(
      fillPlaceholders("{{models.light}}", {
        ...defaultConfig(),
        models: { ...defaultConfig().models, light: "" },
      }),
    ).toBe("none");
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
    const before = await dg(local.dir, ["--json", "guide", "audit"]);
    expect(JSON.parse(before.out).data).toMatchObject({ topic: "audit", initialized: false });
    expect(before.out).toContain("origin/main");
    await dg(local.dir, ["init", "--base-branch", "develop"]);
    const after = await dg(local.dir, ["guide", "audit"]);
    expect(after.out).toContain("origin/develop");
    expect(after.out).not.toContain("origin/main");
  });

  it("parallel の上限は数字を書かず、config の work.parallel の今の値（個人の上書きを含む）を埋める", async () => {
    expect(await readGuide("parallel")).not.toMatch(/up to \d/);
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const before = await dg(local.dir, ["guide", "parallel"]);
    expect(before.out).toContain(`up to ${defaultConfig().work.parallel} at the same time`);
    await dg(local.dir, ["init"]);
    await dg(local.dir, ["config", "set", "work.parallel", "5"]);
    expect((await dg(local.dir, ["guide", "parallel"])).out).toContain("up to 5 at the same time");
    await dg(local.dir, ["config", "set", "work.parallel", "2", "--local"]);
    expect((await dg(local.dir, ["guide", "parallel"])).out).toContain("up to 2 at the same time");
  });

  it("--section は見出しの文言でも、補足を除いた名前でも、その節の本文だけを出す", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const full = await dg(local.dir, ["guide", "work"]);
    const byHeading = await dg(local.dir, [
      "guide",
      "work",
      "--section",
      "Implement (up to a draft PR)",
    ]);
    const byName = await dg(local.dir, ["guide", "work", "--section", "Implement"]);
    expect(byHeading.code).toBe(0);
    expect(byName.out).toBe(byHeading.out);
    expect(byName.out.startsWith("## Implement (up to a draft PR)")).toBe(true);
    expect(byName.out).toContain("gh pr create --draft");
    expect(byName.out).not.toContain("Receive the implementation result");
    expect(full.out).toContain(byName.out);
  });

  it("--section の本文でも {{choices}} の差し替えと config の値の埋め込みが効く", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const choices = await dg(local.dir, ["guide", "plan", "--section", "Asking with choices"]);
    expect(choices.out.startsWith("## Asking with choices")).toBe(true);
    expect(choices.out).not.toContain("{{");
    expect(choices.out).toContain("AskUserQuestion");
    const claim = await dg(local.dir, ["guide", "work", "--section", "Before and after claim"]);
    expect(claim.out).not.toContain("{{");
    // 初期化していない repo は既定値で埋める（config の既定値に合わせる）
    expect(claim.out).toContain(`current setting: \`${defaultConfig().lint.require_iteration}\``);
  });

  it("ない節は使い方の誤りとして終了コード 2 で、そのトピックの節の一覧を返す", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const result = await dg(local.dir, ["guide", "work", "--section", "ない節"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("ない節");
    expect(result.err).toContain("Implement");
    expect(result.err).toContain("Before and after claim");
  });

  it("--json の data には topic・section（見出しの文言）・text が入り、節を指定しないと section は null", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const withSection = await dg(local.dir, ["--json", "guide", "work", "--section", "Implement"]);
    expect(JSON.parse(withSection.out).data).toMatchObject({
      topic: "work",
      section: "Implement (up to a draft PR)",
      initialized: false,
    });
    expect(JSON.parse(withSection.out).data.text).toContain("gh pr create --draft");
    const whole = await dg(local.dir, ["--json", "guide", "work"]);
    expect(JSON.parse(whole.out).data).toMatchObject({ topic: "work", section: null });
  });

  it("--section を重ねると指定した順につなぎ、dg flow next の guide.command で guide.text と同じ本文を読み直せる", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const both = await dg(local.dir, [
      "--json",
      "guide",
      "work",
      "--section",
      "Before and after claim",
      "--section",
      "Implement",
    ]);
    expect(JSON.parse(both.out).data).toMatchObject({
      section: "Before and after claim",
      sections: ["Before and after claim", "Implement (up to a draft PR)"],
    });
    const text: string = JSON.parse(both.out).data.text;
    expect(text.startsWith("## Before and after claim")).toBe(true);
    expect(text).toContain("\n\n## Implement (up to a draft PR)\n");

    expect((await dg(local.dir, ["init"])).code).toBe(0);
    await dg(local.dir, ["iteration", "create", "S1"]);
    await dg(local.dir, ["ticket", "create", "A"]);
    const flow = JSON.parse((await dg(local.dir, ["--json", "flow", "next", "s1"])).out).data;
    // 引用した節の名前（空白を含む）を 1 つの引数に戻す
    const args = [...(flow.guide.command as string).matchAll(/"([^"]*)"|(\S+)/g)].map(
      (m) => m[1] ?? m[2]!,
    );
    expect(args.slice(0, 2)).toEqual(["dg", "guide"]);
    expect((await dg(local.dir, args.slice(1))).out).toBe(flow.guide.text);
  });

  it("buildProgram 経由の dg guide は guide.notes の文書を題名の直後に差し込み、読めないものは warnings に載せて guide は出す", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    expect((await dg(local.dir, ["init"])).code).toBe(0);
    await writeFile(join(local.dir, "work-notes.md"), "CLI の判断の基準\n");
    expect((await dg(local.dir, ["config", "set", "guide.notes.work", "work-notes.md"])).code).toBe(
      0,
    );
    await dg(local.dir, ["config", "set", "guide.notes.plan", "missing.md"]);

    const out: string[] = [];
    const err: string[] = [];
    const program = buildProgram({
      cwd: local.dir,
      env: cliEnv(),
      streams: { out: (t) => out.push(t), err: (t) => err.push(t) },
    });
    await program.parseAsync(["--json", "guide", "work"], { from: "user" });
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.data.text.split("\n")[2]).toBe("CLI の判断の基準");

    const planOut: string[] = [];
    const planProgram = buildProgram({
      cwd: local.dir,
      env: cliEnv(),
      streams: { out: (t) => planOut.push(t), err: () => undefined },
    });
    await planProgram.parseAsync(["--json", "guide", "plan"], { from: "user" });
    const planParsed = JSON.parse(planOut.join("\n"));
    expect(planParsed.warnings[0]).toContain("guide.notes.plan");
    expect(planParsed.data.text.startsWith("# ")).toBe(true);
  });
});
