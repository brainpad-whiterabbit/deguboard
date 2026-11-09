import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "@deguboard/core";
import { cliEnv } from "../../core/test/helpers/env.js";
import { createLocalOnlyRepo } from "../../core/test/helpers/git-fixture.js";
import { GUIDE_TOPICS, fillPlaceholders, readGuide, readGuideMeta, renderGuide } from "./guide.js";
import { buildProgram, run } from "./program.js";

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
    expect((await renderGuide("work", dir, "実装する（draft の PR まで）")).text).toMatchSnapshot(
      "work の節",
    );
    expect((await renderGuide("import", dir, "次の手順を選ぶ")).text).toMatchSnapshot(
      "import の節",
    );
    expect((await renderGuide("plan", dir, "Plan の作り方")).text).toMatchSnapshot(
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

  it("work の実装の手順は draft の PR まで、正本を読み直して直し、PR の本文に読み直したことと付けられなかった項目を書く", async () => {
    const impl = section(await readGuide("work"), "## 実装する（draft の PR まで）");
    for (const word of ["requirements", "README"]) expect(impl).toContain(word);
    // 判断を変えたら ADR の本文を同じ PR で直し、この PR が誤りにした ADR の細部は消す（報告に回さない）
    for (const word of [
      "判断を変えたら、その判断の ADR（あれば）の本文を同じ PR で直接書き換える",
      "この PR が誤りにした ADR の細部は、その PR で消す",
      "変えていない文書の前からのずれは直さず、報告に書く",
    ])
      expect(impl, word).toContain(word);
    // 読み直し → PR を作る → 本文に読み直した正本と直した箇所を書く、の順
    expect(impl).toMatch(/読み直し[\s\S]*?gh pr create --draft[\s\S]*?読み直した正本と直した箇所/);
    expect(impl).toContain("付けられなかった受け入れ条件");
  });

  it("work の claim は実装の Run を開き、委譲は --no-run で claim すると案内し、run は親が自分で進めるときの claim と PR の記録だけを書く（RN-5）", async () => {
    const work = await readGuide("work");
    expect(lineWith(work, "`implement`")).toContain("--no-run");
    const run = await readGuide("run");
    const self = section(run, "## 親が自分で進めるとき");
    for (const word of ["`ticket claim`", "data.run", "ticket update --pr", "`success`"])
      expect(self, word).toContain(word);
    // サブエージェントの Run の開閉・--agent・開いたままの警告は書かない
    for (const word of ["--agent", "フック", "--no-run", "run start", "開いたまま"])
      expect(run, word).not.toContain(word);
    expect(await readGuide("overview")).toContain("`ticket claim` が開く");
  });

  it("review は文書との食い違いを、この PR が変えた約束・手順・規約で文書を直していないものに限って重い指摘にし、前からのずれは audit に送る。参考節との食い違いは軽い指摘として返し、参考節がなければ見比べないと案内し、直さなかった軽い指摘は dg pr ready が PR の本文に書き足すと決める", async () => {
    const review = await readGuide("review");
    const look = bullet(section(review, "## 見直す"), "見る");
    for (const word of [
      "範囲の外の指摘",
      "文書との食い違い",
      "## 参考",
      "参考節との食い違い",
      "節がなければ見比べない",
    ])
      expect(look, word).toContain(word);
    // 重い・軽いの分けは「返す」だけに書く（見る と返す で二度並べない）
    const back = bullet(section(review, "## 見直す"), "返す");
    for (const word of ["この PR が変えた", "Iteration の見直しに送る", "参考節との食い違い"])
      expect(back, word).toContain(word);
    // 受け入れ条件の指摘は category に「受け入れ条件」を含め、手直しに渡す軽い指摘を dg が category で選ぶ（t600）
    for (const word of ["受け入れ条件の欠け", "category に「受け入れ条件」を含める"])
      expect(back, word).toContain(word);
    const fix = section(review, "## 修正ループ（親）");
    for (const word of [
      "参考節との食い違い",
      "dg pr ready` が PR の本文に書き足す",
      "直さなかった軽い指摘",
      // 手直しが直さずに返した理由は dg が書けないので、親が報告に書く（t600）
      "手直しが直さずに返した指摘と理由は dg が書けない",
      "親が報告に書く",
    ])
      expect(fix, word).toContain(word);
    expect(fix).not.toContain("gh pr edit");
    expect(fix).not.toContain("手直しが返すときも理由を含めてもらう");
    expect(await readGuide("parallel")).toContain(
      "直さなかった軽い指摘は `dg pr ready` が PR の本文に書き足す",
    );
  });

  it("review は ADR や要件に足した細部を重い指摘にし、文書を直していない重い指摘は約束・手順・規約の変更に限る", async () => {
    const review = await readGuide("review");
    const back = bullet(section(review, "## 見直す"), "返す");
    for (const word of [
      "ADR や要件に足した細部",
      "細部をコード・テスト・ヘルプへ移す",
      "重い",
      "約束・手順・規約",
      "文書を直していない",
    ])
      expect(back, word).toContain(word);
  });

  it("import は受け入れ条件に ADR や要件の書き足しを入れるのを判断の種類に当たるときだけにし、それ以外はテストとコメントで約束を示すと案内する", async () => {
    const criteria = lineWith(await readGuide("import"), "受け入れ条件に ADR や要件定義書");
    for (const word of ["移行が要る", "テストとコメント"]) expect(criteria, word).toContain(word);
  });

  it("同梱の guide（guide-*.md の全部）は、このリポジトリの ADR 番号を書かない（基準は中身を 1 文で書く）", async () => {
    const dir = new URL("../../core/src/guide/", import.meta.url);
    const files = (await readdir(dir)).filter((file) => /^guide-.+\.md$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(await readFile(new URL(file, dir), "utf8"), file).not.toMatch(/ADR-\d{3}/);
  });

  it("import は本文の項目の引用しない値の行末コメントが拒まれると書き、直し方はエラーの文に任せる", async () => {
    const comment = lineWith(await readGuide("import"), "行末コメントは拒まれる");
    for (const word of [
      "title・summary・acceptance・body",
      "直し方はエラーの文",
      "行だけのコメントは使える",
    ])
      expect(comment, word).toContain(word);
  });

  it("audit は ADR の細部と実装のずれを「ADR の細部を消す」として起票し、意図した設計はテストかコメントで押さえる起票を勧める", async () => {
    const audit = await readGuide("audit");
    expect(audit).toContain("「ADR の細部を消す」");
    expect(section(audit, "## 同じ指摘を繰り返さない")).toContain("テストかコメント");
  });

  it("work は PR の要らない作業を --without-branch で claim し、確かめたら done、残れば review と案内する。claim の warnings は「claim の前後」に任せ、Iteration の選び方は書き写さず、今の設定を埋める", async () => {
    const work = await readGuide("work");
    const noBranch = section(work, "## PR の要らない作業");
    expect(noBranch).toContain("ticket claim <id> --without-branch");
    expect(noBranch).toContain("ticket move <id> done");
    expect(noBranch).toContain("ticket move <id> review");
    expect(noBranch).toContain("「claim の前後」");
    expect(noBranch).not.toContain("iteration add <S> <id>");
    const before = (text: string) => section(text, "## claim の前後");
    // 入れ先の選び方は claim のコード（ticket claim --help）が正本で、guide に書き写さない（ST-3）
    expect(before(work)).toContain("ticket claim --help");
    expect(before(work)).not.toContain("start` が最も早い");
    expect(before(fillPlaceholders(work, defaultConfig()))).toContain("今の設定：`false`");
    expect(
      before(fillPlaceholders(work, { ...defaultConfig(), lint: { require_iteration: true } })),
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
    for (const word of ["plan show", "`next`", "`ready`", "waiting", "scope", "approach"])
      expect(work).toContain(word);
    expect(done).toContain("plan close");
  });

  it("all は --auto の範囲を config の auto.decisions と auto.merge に任せ、人が決める判断は聞いて止まる。自動マージは auto.merge を true にしたときだけ条件を確かめて行う", async () => {
    const all = await readGuide("all");
    const auto = section(all, "## `--auto` で自動で選ぶ");
    for (const word of [
      "approval.auto",
      "approval.what",
      "accept",
      "auto.decisions",
      "auto.merge",
      "dg guide review",
      "人が決める判断",
    ])
      expect(auto).toContain(word);
    expect(fillPlaceholders(all, defaultConfig())).toContain("今の設定：`false`");
    expect(fillPlaceholders(all, defaultConfig())).toContain(
      "今の設定：`assign, check, plan, audit, accept`",
    );
    expect(
      fillPlaceholders(all, { ...defaultConfig(), auto: { ...defaultConfig().auto, merge: true } }),
    ).toContain("今の設定：`true`");
    expect(await readGuideMeta("all")).toMatchObject({
      "argument-hint": expect.stringContaining("--auto"),
    });
  });

  it("work は Iteration への追加と開始、worktree の作成を claim に任せ、warnings が出たら人に頼むと案内し、親に git worktree と iteration add・start を打たせない。check は lint_iteration_missing の直す案を claim と同じ規則で示す。今の設定は両方で埋める", async () => {
    const work = await readGuide("work");
    const before = section(work, "## claim の前後");
    for (const word of ["`warnings`", "lint_iteration_missing", "人に頼み", "作業は続ける"])
      expect(before, word).toContain(word);
    for (const text of [work, await readGuide("parallel")])
      for (const word of ["git worktree add", "iteration add <S>", "iteration start <S>"])
        expect(text, word).not.toContain(word);
    const check = await readGuide("check");
    for (const word of [
      "lint_iteration_missing",
      "iteration add <S> <id>",
      "人に聞く",
      "ticket claim --help",
    ])
      expect(check, word).toContain(word);
    for (const text of [work, check]) {
      expect(fillPlaceholders(text, defaultConfig())).toContain("今の設定：`false`");
      expect(
        fillPlaceholders(text, { ...defaultConfig(), lint: { require_iteration: true } }),
      ).toContain("今の設定：`true`");
    }
  });

  it("work は段階のモデルを dg next の model に任せ、調べものは models.light。{{models.*}} は埋めない。見直し役は親のモデル", async () => {
    const work = await readGuide("work");
    expect(work).not.toContain("{{models.");
    expect(work).not.toContain("implement` のモデル");
    expect(work).toContain("`model` が空でなければ");
    expect(work).toContain(
      "印のない調べもののサブエージェントは `models.light`（空なら親のモデル）",
    );
    expect(await readGuide("review")).toContain("段階によらず親のモデル");
    expect(await readGuide("plan")).toContain("--tier");
  });

  it("check は lint_iteration_multiple_active でどれを閉じるかを人に聞き、閉じるのは人の指示で行う", async () => {
    const multiple = lineWith(await readGuide("check"), "lint_iteration_multiple_active");
    expect(multiple).toContain("どれを閉じるかを人に聞く");
    expect(multiple).toContain("人の指示で行う");
  });

  it("parallel は next の手が複数あるとき上限付きでサブエージェントに並べ、1 件でほかを止めないと案内し、work・all はそこへ案内する", async () => {
    const parallel = await readGuide("parallel");
    expect(parallel).toContain("# 着手できるチケットを並べて進める");
    for (const word of [
      "`next`",
      "同時に 3 件まで",
      "1 件でほかを止めない",
      "CLAIM_LOST",
      "マージ待ち",
      "claim の前後",
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
      "## 品質ゲート",
      "## 見直しを起動する（親）",
      "## 見直す",
      "## 指摘を直す",
      "## 修正ループ（親）",
      "## 終わり方",
    ])
      expect(review).toContain(heading);
    // 回数と Run の説明は dg が持つ。guide には書かない（ADR-011）
    for (const word of ["2 回まで", "3 回まで", "Run の分け方", "--agent", "run start", "--no-run"])
      expect(review, word).not.toContain(word);
    const fix = section(review, "## 修正ループ（親）");
    expect(bullet(fix, "上限")).toContain("fix_rounds");
    expect(bullet(fix, "上限")).toContain("wait_human");
    expect(bullet(fix, "直す指摘")).toContain("--role fix");
    expect(fix).toContain("同じ会話の続きでは頼まない");
    expect(fix).toContain("`dg next` を呼ばない");
    // 見直しは dg next の brief を渡す。ゲートの条件は dg gate の判定に任せる
    expect(section(review, "## 見直しを起動する（親）")).toContain("`dg next` が `review`");
    // brief に入るのは役の節だけなので、親は work の review・fix の手から親の節へ辿る（t593）
    const work = await readGuide("work");
    expect(lineWith(work, "- `review`：")).toContain("「見直しを起動する（親）」");
    expect(lineWith(work, "- `fix`：")).toContain("「修正ループ（親）」");
    expect(bullet(fix, "範囲の外の指摘")).toContain("dg guide import");
    expect(section(review, "## 品質ゲート")).toContain("MERGEABLE");
    expect(section(review, "## 品質ゲート")).toContain("fix_rounds");
    // PR を出すのは dg pr ready（ゲートを満たすときだけ gh を呼ぶ）。満たさないまま出すときだけ人が gh を打つ
    const ending = section(review, "## 終わり方");
    for (const word of [
      "`dg --json --actor agent pr ready <id>`",
      "GATE_FAILED",
      "in_progress のまま",
      "人に報告",
      "wait_human",
    ])
      expect(ending, word).toContain(word);
    expect(lineWith(ending, "見直し役を起動できない")).toContain("見直していない");
    expect(lineWith(ending, "見直し役が返らない")).toContain("`dg guide run`");
    // 作業の guide は review を参照し、条件の中身は review に書く
    for (const topic of ["work", "all"] as const)
      expect(await readGuide(topic), topic).toContain("`dg guide review`");
    expect(lineWith(await readGuide("all"), "todo に戻さず")).toContain("返らない");
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
    const before = await dg(local.dir, ["--json", "guide", "audit"]);
    expect(JSON.parse(before.out).data).toMatchObject({ topic: "audit", initialized: false });
    expect(before.out).toContain("origin/main");
    await dg(local.dir, ["init", "--base-branch", "develop"]);
    const after = await dg(local.dir, ["guide", "audit"]);
    expect(after.out).toContain("origin/develop");
    expect(after.out).not.toContain("origin/main");
  });

  it("--section は見出しの文言でも、補足を除いた名前でも、その節の本文だけを出す", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const full = await dg(local.dir, ["guide", "work"]);
    const byHeading = await dg(local.dir, [
      "guide",
      "work",
      "--section",
      "実装する（draft の PR まで）",
    ]);
    const byName = await dg(local.dir, ["guide", "work", "--section", "実装する"]);
    expect(byHeading.code).toBe(0);
    expect(byName.out).toBe(byHeading.out);
    expect(byName.out.startsWith("## 実装する（draft の PR まで）")).toBe(true);
    expect(byName.out).toContain("gh pr create --draft");
    expect(byName.out).not.toContain("実装の結果を受け取る");
    expect(full.out).toContain(byName.out);
  });

  it("--section の本文でも {{choices}} の差し替えと config の値の埋め込みが効く", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const choices = await dg(local.dir, ["guide", "plan", "--section", "選択肢で聞く"]);
    expect(choices.out.startsWith("## 選択肢で聞く")).toBe(true);
    expect(choices.out).not.toContain("{{");
    expect(choices.out).toContain("AskUserQuestion");
    const claim = await dg(local.dir, ["guide", "work", "--section", "claim の前後"]);
    expect(claim.out).not.toContain("{{");
    // 初期化していない repo は既定値で埋める（config の既定値に合わせる）
    expect(claim.out).toContain(`今の設定：\`${defaultConfig().lint.require_iteration}\``);
  });

  it("ない節は使い方の誤りとして終了コード 2 で、そのトピックの節の一覧を返す", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const result = await dg(local.dir, ["guide", "work", "--section", "ない節"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("ない節");
    expect(result.err).toContain("実装する");
    expect(result.err).toContain("claim の前後");
  });

  it("--json の data には topic・section（見出しの文言）・text が入り、節を指定しないと section は null", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const withSection = await dg(local.dir, ["--json", "guide", "work", "--section", "実装する"]);
    expect(JSON.parse(withSection.out).data).toMatchObject({
      topic: "work",
      section: "実装する（draft の PR まで）",
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
      "claim の前後",
      "--section",
      "実装する",
    ]);
    expect(JSON.parse(both.out).data).toMatchObject({
      section: "claim の前後",
      sections: ["claim の前後", "実装する（draft の PR まで）"],
    });
    const text: string = JSON.parse(both.out).data.text;
    expect(text.startsWith("## claim の前後")).toBe(true);
    expect(text).toContain("\n\n## 実装する（draft の PR まで）\n");

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
