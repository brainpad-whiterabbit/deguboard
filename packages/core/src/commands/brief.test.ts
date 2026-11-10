import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "../../test/helpers/git-fixture.js";
import { composeGuide } from "../guide/guide.js";
import { openContext } from "./context.js";
import { brief, composeBrief, type BriefFacts } from "./brief.js";
import { runCommand } from "./define.js";
import { next, type NextStep } from "./next.js";
import { runReviewResult } from "./run.js";
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
  guideText: "1. 検査を通す\n2. 読み直した正本を直す",
  ...over,
});

describe("サブエージェントに渡す文の形（brief）", () => {
  it("定型の文は英語だけで、チケットの中身は書いた言葉のまま入れる。実装・見直し・手直しの文の形は固定", () => {
    expect(composeBrief("implement", facts())).toMatchInlineSnapshot(`
      "deguboard: ticket=t12 step=implement
      Implement ticket t12 "右の列を細くする" and create the PR as a draft.
      - Location: worktree /work/deguboard.worktrees/feat/t12, branch feat/t12. Edit files only inside this worktree.
      - Plan p3 scope: 右の列の CSS だけ
      - Approach: 幅の変数を 1 つ足す
      - Conventions: Follow the agent instruction file at the repository root, and the steps below. Write the ticket ID (t12) in the PR body.
      --- Steps: Implement ---
      1. 検査を通す
      2. 読み直した正本を直す
      --- End of steps ---
      - Acceptance criteria: 
        1. 列の幅が 240px になる
        2. 狭い画面で折り返さない
      - Tools: read files with Read and edit them with Edit. Do not read or write source with Bash cat, heredoc, or sed -i.
      - Run: the marker on the first line makes the hook open and close the implementation Run. Do not open or close a Run. The parent has already claimed the ticket.
      - Do not: claim, unclaim, iteration add, Plan operations, launching a reviewer, making the PR ready (\`dg pr ready\`), merge, \`ticket check\`, \`ticket update --pr\`, or work on other tickets. Do not fix things outside the scope; report them in what you return.
      - Return: the draft PR's URL and number; the acceptance criteria you checked (by number) and those you could not (with reasons); the sources you reread and what you changed there; the results of the checks (format, lint, tests); and anything the human should know."
    `);
    expect(composeBrief("review", facts({ step: "review" }))).toMatchInlineSnapshot(`
      "deguboard: ticket=t12 step=review
      Review the PR for ticket t12 "右の列を細くする" as a reviewer separate from the implementer.
      - Location: worktree /work/deguboard.worktrees/feat/t12, branch feat/t12. Read the files only; do not change them.
      - Diff: After \`git fetch origin\`, look at \`git diff origin/main...feat/t12\`.
      - Ticket body: Read the body and acceptance criteria in \`dg --json --actor agent ticket show t12\`.
      - Conventions: Follow the agent instruction file at the repository root, and the steps below.
      --- Steps: Review ---
      1. 検査を通す
      2. 読み直した正本を直す
      --- End of steps ---
      - Tools: read files with Read. Do not write source with Bash cat, heredoc, or sed -i.
      - Run: the marker on the first line makes the hook open and close the review Run. Do not open or close a Run.
      - Record: Before returning the list, write the findings as a JSON array (each with severity (heavy or light), category, file, line, reason, and fix; the shape is in \`dg run review-result --help\`) to a temporary file outside the repository, and record it once with \`dg --json --actor agent run review-result t12 --findings-file <file>\`. Use \`[]\` if there are no findings. dg works out the counts and whether the review passed.
      - Do not: change files in the repository, commit, push, write anything to dg other than the Run, or look at other tickets.
      - Return: a list of findings split into heavy (missed acceptance criteria, bugs, docs left stale by a promise, procedure, or rule this PR changed, details added to an ADR or requirements, rule violations) and light (wording, preference, older drift from the docs), each with file and line, reason, and how to fix it; and the results of the checks run on the latest commit. Report mismatches with the references section (\`## References\` or \`## 参考\` in the body) under the light findings, and do not count them as heavy."
    `);
    expect(composeBrief("fix", facts({ step: "fix" }))).toMatchInlineSnapshot(`
      "deguboard: ticket=t12 step=fix
      Fix the findings on the PR for ticket t12 "右の列を細くする". Fix them on the same branch and push.
      - PR: #7 (keep it as a draft; do not mark it ready)
      - Location: worktree /work/deguboard.worktrees/feat/t12, branch feat/t12. Edit files only inside this worktree.
      - Findings to fix: (paste the list of findings here: the heavy findings and the light ones you decided to fix, returned by the reviewer or the human reviewer, each with file and line, reason, and how to fix it)
      - Before you start fixing: Run \`dg --json --actor agent run retry-reason t12 --reason <summary of finding 1> --reason <summary of finding 2> …\` once, as a standalone command, to write the retry reasons on the fix Run. Repeat --reason once per finding you fix (the number of reasons is the retry count). Write only the findings from the reviewer or the human reviewer, not fixes for failed checks. Each summary is one line and must not contain secrets, command strings, or paths.
      - Scope of the fix: The heavy findings listed, and the light ones you decide to fix. For the other light findings, decide whether to fix them, and return the reasons for those you leave.
      - Conventions: Follow the agent instruction file at the repository root, and the steps below. Run the checks (format, lint, tests) on the latest commit before you push.
      --- Steps: Fix findings ---
      1. 検査を通す
      2. 読み直した正本を直す
      --- End of steps ---
      - Acceptance criteria: 
        1. 列の幅が 240px になる
        2. 狭い画面で折り返さない
      - Tools: read files with Read and edit them with Edit. Do not read or write source with Bash cat, heredoc, or sed -i.
      - Run: the marker on the first line makes the hook open and close the fix Run. Do not open or close a Run (do not use claim, \`run start\`, or \`run finish\`).
      - Do not: claim, unclaim, making the PR ready (\`dg pr ready\`), merge, \`ticket update --pr\`, \`ticket check\`, or work on other tickets.
      - Return: the commits you made (hash and summary) and whether you pushed; the light findings you did not fix, with reasons; the acceptance criteria you checked (by number) and those you could not (with reasons); the results of the checks; and anything the human should know."
    `);
  });

  it("どの役の文も先頭の行に印があり、手直しの文は claim で Run を開かせない（印と claim で二重にしない。RN-7）", () => {
    const marked = (role: "implement" | "review" | "fix") =>
      composeBrief(role, facts({ step: role })).split("\n")[0];
    expect(marked("implement")).toBe("deguboard: ticket=t12 step=implement");
    expect(marked("review")).toBe("deguboard: ticket=t12 step=review");
    expect(marked("fix")).toBe("deguboard: ticket=t12 step=fix");
    expect(composeBrief("fix", facts({ step: "fix" }))).not.toContain("ticket claim");
  });

  it("Plan の範囲と方針がなければ、その行は出さない。受け入れ条件がなければ親に聞く旨を出す", () => {
    const text = composeBrief("implement", facts({ plan: null, acceptance: [] }));
    expect(text).not.toContain("Plan p3");
    expect(text).not.toContain("Approach:");
    expect(text).toContain("none in the body");
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
    });
    expect(implement).not.toHaveProperty("language");
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

  it("段が low・free のチケットで見直しの文を求めると、文を返したうえで警告する。high・段なし・ほかの役では警告しない", async () => {
    const ctx = await prepared();
    const gateWarnings = async (ticket: string, role: "implement" | "review" | "fix") =>
      (await runCommand(brief, ctx, { ticket, role, findings: "1. 指摘" })).warnings.filter((w) =>
        w.includes("gate level"),
      );
    expect(await gateWarnings("t1", "review")).toEqual([]);
    for (const gate of ["low", "free"] as const) {
      await runCommand(ticketUpdate, ctx, { ticket: "t1", gate });
      const result = await runCommand(brief, ctx, { ticket: "t1", role: "review" });
      expect(result.data.text.split("\n")[0]).toBe("deguboard: ticket=t1 step=review");
      expect(result.warnings).toContainEqual(
        expect.stringContaining(`The gate level of t1 is ${gate}`),
      );
      expect(await gateWarnings("t1", "implement")).toEqual([]);
      expect(await gateWarnings("t1", "fix")).toEqual([]);
    }
    await runCommand(ticketUpdate, ctx, { ticket: "t1", gate: "high" });
    expect(await gateWarnings("t1", "review")).toEqual([]);
  });

  it("dg brief は英語の名前の節（## Acceptance criteria）の受け入れ条件も文に入れる", async () => {
    const ctx = await prepared();
    await runCommand(ticketCreate, ctx, {
      title: "C",
      body: "## Summary\n\ns\n\n## Acceptance criteria\n\n- [ ] 英語の節の項目\n",
    });
    const implement = (await runCommand(brief, ctx, { ticket: "t3", role: "implement" })).data;
    expect(implement.text).toContain("1. 英語の節の項目");
  });

  it("役の文は指す節の本文を入れ、guide を読ませる文がない。dg next の brief も同じ本文", async () => {
    const ctx = await prepared();
    // 節の見出しを除いた本文。文の中では区切りの行に挟まれる
    const body = async (topic: string, section: string) =>
      (await composeGuide(topic, ctx.config, ctx.repo.topLevel, section)).text
        .split("\n")
        .slice(1)
        .join("\n")
        .trim();
    const cases = [
      { role: "implement", topic: "work", section: "Implement" },
      { role: "review", topic: "review", section: "Review" },
      { role: "fix", topic: "review", section: "Fix findings" },
    ] as const;
    for (const { role, topic, section } of cases) {
      const text = (await runCommand(brief, ctx, { ticket: "t1", role, findings: "1. 直す指摘" }))
        .data.text;
      expect(text, role).toContain(await body(topic, section));
      expect(text, role).not.toContain("dg guide");
    }
    const implement = (await runCommand(brief, ctx, { ticket: "t1", role: "implement" })).data;
    const next1 = (await runCommand(next, ctx, { ticket: "t1" })).data as NextStep;
    expect(next1.brief).toBe(implement.text);
  });

  it("手直しの文は --findings を渡さなければ、最新の見直しの記録から重い指摘と受け入れ条件の軽い指摘を入れる。参考節の軽い指摘は入れない（t600）", async () => {
    const ctx = await prepared();
    // 見直しの記録がないチケット（t2）は、貼る場所を空けて返す
    const none = (await runCommand(brief, ctx, { ticket: "t2", role: "fix" })).data;
    expect(none.text).toContain("(paste the list of findings here");
    await runCommand(runReviewResult, ctx, {
      ticket: "t1",
      findings: [
        {
          severity: "heavy",
          category: "不具合",
          file: "src/a.ts",
          line: 3,
          reason: "型が違う",
          fix: "型を直す",
        },
        { severity: "light", category: "受け入れ条件の漏れ", reason: "1 つめが足りない" },
        { severity: "light", category: "参考節との食い違い", file: "src/b.ts", reason: "広がり" },
      ],
    });
    const fix = (await runCommand(brief, ctx, { ticket: "t1", role: "fix" })).data;
    expect(fix.text).toContain("- [heavy] src/a.ts:3 (不具合): 型が違う Fix: 型を直す");
    expect(fix.text).toContain("- [light] 受け入れ条件の漏れ: 1 つめが足りない");
    expect(fix.text).not.toContain("参考節との食い違い");
    // 数だけで記録した回が最新なら、前の回の一覧は使わず貼る場所を空ける（t600）
    await runCommand(runReviewResult, ctx, { ticket: "t1", heavy: 0, light: 0, passed: true });
    const counted = (await runCommand(brief, ctx, { ticket: "t1", role: "fix" })).data;
    expect(counted.text).toContain("(paste the list of findings here");
    expect(counted.text).not.toContain("型が違う");
    // 渡したときは渡したものを使う
    const given = (await runCommand(brief, ctx, { ticket: "t1", role: "fix", findings: "1. 別" }))
      .data;
    expect(given.text).toContain("1. 別");
    expect(given.text).not.toContain("型が違う");
  });

  it("見直しと手直しの文には親向けの手順が入らない（親の節は文に入れない。t593）", async () => {
    const ctx = await prepared();
    // 親が進める手順の語（見直し役の起動・PR の本文・dg next の呼び出し・上限の進め方）
    const parentOnly = [
      "親",
      "新しいサブエージェント",
      "dg next を呼ばない",
      "上限を超え",
      "gh pr edit",
      "書き足",
      "人に頼",
    ];
    for (const role of ["review", "fix"] as const) {
      const text = (await runCommand(brief, ctx, { ticket: "t1", role, findings: "1. 直す指摘" }))
        .data.text;
      for (const word of parentOnly) expect(text, `${role} ${word}`).not.toContain(word);
    }
  });

  it("定型の文は英語で、チケットの題は書いた言葉のまま入る", async () => {
    const ctx = await prepared();
    const text = (await runCommand(brief, ctx, { ticket: "t1", role: "implement" })).data.text;
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
    expect(t1.brief).toContain("Implement ticket t1");
  });

  it("実行中の Run を待つ手（implement・review・fix）では文を出さない（貼ると Run が重なる）", async () => {
    const ctx = await prepared();
    await runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t1", agent: "claude-code" });
    const waiting = (await runCommand(next, ctx, { ticket: "t1" })).data as NextStep;
    expect(waiting).toMatchObject({ kind: "implement", brief: null });
    expect(waiting.running_run).not.toBeNull();
    expect(waiting.commands[0]).toContain("Wait for the running Run");
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
