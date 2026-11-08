import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import { openContext } from "./context.js";
import { brief, composeBrief, type BriefFacts } from "./brief.js";
import { runCommand } from "./define.js";
import { next, type NextStep } from "./next.js";
import { findCommand } from "./registry.js";
import { init } from "./setup.js";
import { ticketClaim, ticketCreate, ticketUpdate } from "./ticket.js";
import { workflowSet } from "./workflow.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** 文の事実。対象は t12 の実装中のチケット（PR #7・feat/t12）に既定の値を入れる */
const facts = (over: Partial<BriefFacts> = {}): BriefFacts => ({
  id: "t12",
  title: "右の列を細くする",
  pr: 7,
  branch: "feat/t12",
  worktree: "/work/deguboard.worktrees/feat/t12",
  acceptance: [
    { index: 1, text: "列の幅が 240px になる", checked: false },
    { index: 2, text: "狭い画面で折り返さない", checked: false },
  ],
  step: "implement",
  plan: { id: "p3", scope: "右の列の CSS だけ", approach: "幅の変数を 1 つ足す" },
  remote: "origin",
  baseBranch: "main",
  ...over,
});

describe("サブエージェントに渡す文の形（brief）", () => {
  it("実装の文は先頭の行に印を置き、場所・Plan・規約・受け入れ条件・道具・Run・しないこと・返すものを含む（日本語）", () => {
    expect(composeBrief("implement", facts(), "ja")).toMatchInlineSnapshot(`
      "deguboard: ticket=t12 step=implement
      チケット t12「右の列を細くする」を実装し、PR を draft で作ってください。
      - 場所：worktree /work/deguboard.worktrees/feat/t12、ブランチ feat/t12。ファイルはこの worktree の中だけで編集する。
      - Plan p3 の範囲：右の列の CSS だけ
      - 方針：幅の変数を 1 つ足す
      - 規約：リポジトリのルートにあるエージェント向けの指示ファイルと \`dg guide work\` の「実装する」（draft の PR まで）に従う。PR は \`gh pr create --draft\` で作り、本文にチケット ID（t12）を書く。
      - 受け入れ条件：
        1. 列の幅が 240px になる
        2. 狭い画面で折り返さない
      - 道具：ファイルは Read で読み、Edit で直す。Bash の cat・heredoc・sed -i でソースを読み書きしない。
      - Run：この文の先頭の印で、フックが実装の Run を開き閉じる。Run は開かず閉じない。claim は親が済ませている。
      - しない：claim・unclaim・iteration add・Plan の操作・見直し役の起動・PR の ready（\`dg pr ready\`）・マージ・\`ticket check\`・\`ticket update --pr\`・ほかのチケットの作業。範囲の外で見つけたことは直さず、返すものに書く。
      - 返すもの：draft の PR の URL と番号・確かめた受け入れ条件（番号ごと）と付けられなかった項目（理由）・読み直した正本と直した箇所・検査（書式・lint・テスト）の結果・人に伝えること。"
    `);
  });

  it("見直しの文は先頭の行に review の印を置き、差分の取り方と結果の記録を含む（日本語）", () => {
    expect(composeBrief("review", facts({ step: "review" }), "ja")).toMatchInlineSnapshot(`
      "deguboard: ticket=t12 step=review
      チケット t12「右の列を細くする」の PR を見直してください。実装したのとは別の役として見ます。
      - 場所：worktree /work/deguboard.worktrees/feat/t12、ブランチ feat/t12。ファイルは読むだけで、変えない。
      - 差分：\`git fetch origin\` のあと \`git diff origin/main...feat/t12\` で見る。
      - チケット本文：\`dg --json --actor agent ticket show t12\` の本文と受け入れ条件を読む。
      - 規約：リポジトリのルートにあるエージェント向けの指示ファイルと \`dg guide review\` の「見直す」に従う。見る観点は受け入れ条件の漏れ・不具合・文書との食い違い（この PR が変えた文書のずれは重い。前からのずれは軽い）・規約の違反・範囲の外の変更。チケット本文に \`## 参考\` 節があれば、そこに書いたファイルと差分で変えたファイルを見比べ、参考節にない大きな広がりと、参考節のファイルに触れていない変更を「参考節との食い違い」として返す。
      - 道具：ファイルは Read で読む。Bash の cat・heredoc・sed -i でソースを書き換えない。
      - Run：この文の先頭の印で、フックが見直しの Run（review）を開き閉じる。Run は開かず閉じない。
      - 記録：一覧を返す前に、\`dg --json --actor agent run review-result t12 --heavy <重い指摘の数> --light <軽い指摘の数>\` を 1 回記録する（重い指摘がなければ \`--passed\` も付ける）。
      - しない：ファイルを変える・コミットする・push する・Run のほかに dg へ書き込む・ほかのチケットを見る。
      - 返すもの：指摘を重い（受け入れ条件の漏れ・不具合・この PR が変えた文書との食い違い・規約の違反）と軽い（言い回し・好み・前からのずれ）に分けた一覧（ファイルと行・理由・直し方）と、最新のコミットで回した検査の結果。参考節との食い違いは軽い指摘の欄に分けて書き、重い指摘に数えない。"
    `);
  });

  it("手直しの文は先頭の行に fix の印を置き、run retry-reason で理由を書かせ、指摘の一覧を入れる（日本語）（ADR-018）", () => {
    expect(composeBrief("fix", facts({ step: "fix" }), "ja", "1. src/a.ts:3 の型が違う（重い）"))
      .toMatchInlineSnapshot(`
        "deguboard: ticket=t12 step=fix
        チケット t12「右の列を細くする」の PR の指摘を直してください。同じブランチで直して push します。
        - PR：#7（draft のまま。ready にしない）
        - 場所：worktree /work/deguboard.worktrees/feat/t12、ブランチ feat/t12。ファイルはこの worktree の中だけで編集する。
        - 直す指摘：1. src/a.ts:3 の型が違う（重い）
        - 直し始める前に：\`dg --json --actor agent run retry-reason t12 --reason <直す指摘 1 件の要約> --reason <2 件目の要約> …\` を単独のコマンドで 1 回呼んで、fix の Run にやり直しの理由を書く。直す指摘 1 件に 1 つ --reason を繰り返す（回数は理由の数になる）。書くのは見直し役・人のレビューの指摘だけで、検査の失敗を直したことは書かない。要約は 1 行で、秘密・コマンドの文字列・パスは書かない。
        - 直す範囲：挙げられた重い指摘と、直すと決めた軽い指摘。ほかの軽い指摘は直すかを決め、直さないものは理由を返す。
        - 規約：リポジトリのルートにあるエージェント向けの指示ファイルと \`dg guide review\` の「指摘を直す」に従う。検査（書式・lint・テスト）を最新のコミットで通してから push する。
        - 受け入れ条件：
          1. 列の幅が 240px になる
          2. 狭い画面で折り返さない
        - 道具：ファイルは Read で読み、Edit で直す。Bash の cat・heredoc・sed -i でソースを読み書きしない。
        - Run：この文の先頭の印で、フックが手直しの Run（fix）を開き閉じる。Run は開かず閉じない（claim・\`run start\`・\`run finish\` は使わない）。
        - しない：claim・unclaim・PR の ready（\`dg pr ready\`）・マージ・\`ticket update --pr\`・\`ticket check\`・ほかのチケットの作業。
        - 返すもの：直したコミット（ハッシュと要約）と push の有無・直さなかった軽い指摘と理由・確かめた受け入れ条件（番号ごと）と付けられなかった項目（理由）・検査の結果・人に伝えること。"
      `);
  });

  it("英語の文は定型の文だけを英語にし、チケットの中身は書いた言葉のまま入れる", () => {
    expect(composeBrief("implement", facts(), "en")).toMatchInlineSnapshot(`
      "deguboard: ticket=t12 step=implement
      Implement ticket t12 "右の列を細くする" and create the PR as a draft.
      - Location: worktree /work/deguboard.worktrees/feat/t12, branch feat/t12. Edit files only inside this worktree.
      - Plan p3 scope: 右の列の CSS だけ
      - Approach: 幅の変数を 1 つ足す
      - Conventions: Follow the agent instruction file at the repository root and the "実装する" section of \`dg guide work\` (up to creating a draft PR). Create the PR with \`gh pr create --draft\` and write the ticket ID (t12) in its body.
      - Acceptance criteria: 
        1. 列の幅が 240px になる
        2. 狭い画面で折り返さない
      - Tools: read files with Read and edit them with Edit. Do not read or write source with Bash cat, heredoc, or sed -i.
      - Run: the marker on the first line makes the hook open and close the implementation Run. Do not open or close a Run. The parent has already claimed the ticket.
      - Do not: claim, unclaim, iteration add, Plan operations, launching a reviewer, making the PR ready (\`dg pr ready\`), merge, \`ticket check\`, \`ticket update --pr\`, or work on other tickets. Do not fix things outside the scope; report them in what you return.
      - Return: the draft PR's URL and number; the acceptance criteria you checked (by number) and those you could not (with reasons); the sources you reread and what you changed there; the results of the checks (format, lint, tests); and anything the human should know."
    `);
    expect(composeBrief("review", facts({ step: "review" }), "en")).toMatchInlineSnapshot(`
      "deguboard: ticket=t12 step=review
      Review the PR for ticket t12 "右の列を細くする" as a reviewer separate from the implementer.
      - Location: worktree /work/deguboard.worktrees/feat/t12, branch feat/t12. Read the files only; do not change them.
      - Diff: After \`git fetch origin\`, look at \`git diff origin/main...feat/t12\`.
      - Ticket body: Read the body and acceptance criteria in \`dg --json --actor agent ticket show t12\`.
      - Conventions: Follow the agent instruction file at the repository root and the "見直す" (Review) section of \`dg guide review\`. Look for missed acceptance criteria, bugs, mismatches with the docs (a drift this PR changed is heavy; an older drift is light), rule violations, and changes outside the scope. If the ticket body has a \`## 参考\` section, compare the files it names with the files the diff changes, and report as "参考節との食い違い" any large spread outside the section and any change that does not touch the files the section names.
      - Tools: read files with Read. Do not write source with Bash cat, heredoc, or sed -i.
      - Run: the marker on the first line makes the hook open and close the review Run. Do not open or close a Run.
      - Record: Before returning the list, record the result once with \`dg --json --actor agent run review-result t12 --heavy <number of heavy findings> --light <number of light findings>\` (add \`--passed\` if there are no heavy findings).
      - Do not: change files, commit, push, write anything to dg other than the Run, or look at other tickets.
      - Return: a list of findings split into heavy (missed acceptance criteria, bugs, mismatches with the docs this PR changed, rule violations) and light (wording, preference, older drift from the docs), each with file and line, reason, and how to fix it; and the results of the checks run on the latest commit. Report 参考節との食い違い (mismatches with the 参考 section) under the light findings, and do not count them as heavy."
    `);
    expect(composeBrief("fix", facts({ step: "fix" }), "en")).toMatchInlineSnapshot(`
      "deguboard: ticket=t12 step=fix
      Fix the findings on the PR for ticket t12 "右の列を細くする". Fix them on the same branch and push.
      - PR: #7 (keep it as a draft; do not mark it ready)
      - Location: worktree /work/deguboard.worktrees/feat/t12, branch feat/t12. Edit files only inside this worktree.
      - Findings to fix: (paste the list of findings here: the heavy findings and the light ones you decided to fix, returned by the reviewer or the human reviewer, each with file and line, reason, and how to fix it)
      - Before you start fixing: Run \`dg --json --actor agent run retry-reason t12 --reason <summary of finding 1> --reason <summary of finding 2> …\` once, as a standalone command, to write the retry reasons on the fix Run. Repeat --reason once per finding you fix (the number of reasons is the retry count). Write only the findings from the reviewer or the human reviewer, not fixes for failed checks. Each summary is one line and must not contain secrets, command strings, or paths.
      - Scope of the fix: The heavy findings listed, and the light ones you decide to fix. For the other light findings, decide whether to fix them, and return the reasons for those you leave.
      - Conventions: Follow the agent instruction file at the repository root and the "指摘を直す" (Fixing findings) section of \`dg guide review\`. Run the checks (format, lint, tests) on the latest commit before you push.
      - Acceptance criteria: 
        1. 列の幅が 240px になる
        2. 狭い画面で折り返さない
      - Tools: read files with Read and edit them with Edit. Do not read or write source with Bash cat, heredoc, or sed -i.
      - Run: the marker on the first line makes the hook open and close the fix Run. Do not open or close a Run (do not use claim, \`run start\`, or \`run finish\`).
      - Do not: claim, unclaim, making the PR ready (\`dg pr ready\`), merge, \`ticket update --pr\`, \`ticket check\`, or work on other tickets.
      - Return: the commits you made (hash and summary) and whether you pushed; the light findings you did not fix, with reasons; the acceptance criteria you checked (by number) and those you could not (with reasons); the results of the checks; and anything the human should know."
    `);
  });

  it("どの役の文も先頭の行に印があり、手直しの文は claim で Run を開かせない（印と claim で二重にしない。ADR-018）", () => {
    const marked = (role: "implement" | "review" | "fix") =>
      composeBrief(role, facts({ step: role }), "ja").split("\n")[0];
    expect(marked("implement")).toBe("deguboard: ticket=t12 step=implement");
    expect(marked("review")).toBe("deguboard: ticket=t12 step=review");
    expect(marked("fix")).toBe("deguboard: ticket=t12 step=fix");
    expect(composeBrief("fix", facts({ step: "fix" }), "ja")).not.toContain("ticket claim");
  });

  it("Plan の範囲と方針がなければ、その行は出さない。受け入れ条件がなければ親に聞く旨を出す", () => {
    const text = composeBrief("implement", facts({ plan: null, acceptance: [] }), "ja");
    expect(text).not.toContain("Plan p3");
    expect(text).not.toContain("方針：");
    expect(text).toContain("本文に受け入れ条件がない");
  });

  it("dg brief は読み取りだけ（write: false）で、CLI・HTTP・MCP が写す一覧にある", () => {
    expect(findCommand("brief")).toMatchObject({ write: false, needs: "store" });
  });
});

describe("dg brief と dg next の文（EX-3）", () => {
  async function prepared() {
    const f = await createFixture();
    cleanups.push(f.cleanup);
    const actor = { kind: "agent" as const, user: "eiki" };
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {}, actor }), {
      template: "software-development",
    });
    const ctx = await openContext({ cwd: f.cloneA, actor });
    await runCommand(ticketCreate, ctx, {
      title: "A",
      body: "## 受け入れ条件\n\n- [ ] 一覧が出る\n",
    });
    await runCommand(ticketCreate, ctx, { title: "B" });
    return ctx;
  }

  it("dg brief は役ごとの文を返し、先頭の印の step は役が開く Run の step と同じ", async () => {
    const ctx = await prepared();
    const implement = (await runCommand(brief, ctx, { ticket: "t1", role: "implement" })).data;
    expect(implement).toMatchObject({
      ticket: "t1",
      role: "implement",
      step: "implement",
      language: "ja",
    });
    expect(implement.text.split("\n")[0]).toBe("deguboard: ticket=t1 step=implement");
    expect(implement.text).toContain("1. 一覧が出る");
    const review = (await runCommand(brief, ctx, { ticket: "t1", role: "review" })).data;
    expect(review.text.split("\n")[0]).toBe("deguboard: ticket=t1 step=review");
    const fix = (
      await runCommand(brief, ctx, { ticket: "t1", role: "fix", findings: "1. 直す指摘" })
    ).data;
    expect(fix).toMatchObject({ step: "fix" });
    expect(fix.text.split("\n")[0]).toBe("deguboard: ticket=t1 step=fix");
    expect(fix.text).toContain("1. 直す指摘");
  });

  it("language を en にすると定型の文が英語になり、チケットの題は書いた言葉のまま", async () => {
    const ctx = await prepared();
    const text = (await runCommand(brief, ctx, { ticket: "t1", role: "implement", language: "en" }))
      .data.text;
    expect(text).toContain('Implement ticket t1 "A"');
    expect(text).toContain("Do not:");
  });

  it("dg next は implement・review・fix の手に文を入れ、ほかの手（wait_deps など）では null", async () => {
    const ctx = await prepared();
    await runCommand(ticketUpdate, ctx, { ticket: "t2", depends_on: ["t1"] });
    const t1 = (await runCommand(next, ctx, { ticket: "t1" })).data as NextStep;
    expect(t1).toMatchObject({ kind: "implement" });
    expect(t1.brief?.split("\n")[0]).toBe("deguboard: ticket=t1 step=implement");
    const t2 = (await runCommand(next, ctx, { ticket: "t2" })).data as NextStep;
    expect(t2).toMatchObject({ kind: "wait_deps", brief: null });
    const en = (await runCommand(next, ctx, { ticket: "t1", language: "en" })).data as NextStep;
    expect(en.brief).toContain("Implement ticket t1");
  });

  it("実行中の Run を待つ手（implement・review・fix）では文を出さない（貼ると Run が重なる）", async () => {
    const ctx = await prepared();
    await runCommand(ticketClaim, ctx, { ticket: "t1", agent: "claude-code" });
    const waiting = (await runCommand(next, ctx, { ticket: "t1" })).data as NextStep;
    expect(waiting).toMatchObject({ kind: "implement", brief: null });
    expect(waiting.running_run).not.toBeNull();
    expect(waiting.commands[0]).toContain("終わりを待つ");
  });

  it("todo の手は claim の前に組むので、claim の後に文を組み直す行を出す", async () => {
    const ctx = await prepared();
    const todo = (await runCommand(next, ctx, { ticket: "t1" })).data as NextStep;
    expect(todo.commands.join("\n")).toContain("brief t1 --role implement");
  });

  it("Workflow で実装と手直しの step の名前を変えても、印と文の step はその名前になる", async () => {
    const ctx = await prepared();
    const projectWorkflow = [...ctx.store.projects.values()][0]?.data.workflow as string;
    await runCommand(workflowSet, ctx, {
      workflow: projectWorkflow,
      definition: {
        id: projectWorkflow,
        name: "renamed",
        transitions: [],
        steps: [
          { id: "build", opens_on: "claim" },
          { id: "rework", opens_on: "reclaim" },
        ],
      },
    });
    const implement = (await runCommand(brief, ctx, { ticket: "t1", role: "implement" })).data;
    expect(implement.step).toBe("build");
    expect(implement.text.split("\n")[0]).toBe("deguboard: ticket=t1 step=build");
    const fix = (await runCommand(brief, ctx, { ticket: "t1", role: "fix" })).data;
    expect(fix.step).toBe("rework");
    expect(fix.text.split("\n")[0]).toBe("deguboard: ticket=t1 step=rework");
  });
});
