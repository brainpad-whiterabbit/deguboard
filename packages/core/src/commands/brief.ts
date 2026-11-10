// サブエージェントに渡す文（brief・EX-3、ADR-011）。役（実装・見直し・手直し）とチケットの事実から、貼る文を組む。読み取りだけで、データは書き換えない。
// 役が行う手順は guide の節の本文を文に入れる（EX-5）。サブエージェントに guide を読ませず、dg next・dg brief・dg flow next が同じ本文を返す。
// 文の組み立ては純粋な関数（composeBrief）に置き、brief コマンドと dg next が事実を渡して使う。定型の文はエージェントが読むので英語だけにする（ADR-001 の言語の項。2 本立てにしない）。
// どの役の文も先頭に印を置き、フックが Run を開け閉めする。手直しのやり直しの理由は、サブエージェントが run retry-reason で開いている Run に書き足す（RN-7・RN-8）

import { z } from "zod";
import { findBranchWorktree } from "../git/worktree.js";
import { composeGuide } from "../guide/guide.js";
import { REVIEW_STEP } from "../model/run.js";
import { type AcceptanceItem, parseAcceptance, type Ticket } from "../model/ticket.js";
import { findingKey, findingText, latestRoundSince, splitFindings } from "../run/findings.js";
import { readReviewFindings } from "../run/record.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { openPlanOf, ticketRef } from "./helpers.js";
import { openedStepOf } from "./run.js";

/** 文を組む役。implement は実装（claim の step）、review は見直し、fix は手直し（reclaim の step） */
export const BRIEF_ROLES = ["implement", "review", "fix"] as const;
export type BriefRole = (typeof BRIEF_ROLES)[number];

/** 役が行う手順の節（guide のトピックと節の名前）。文には節の本文を入れる */
export const BRIEF_GUIDE: Record<BriefRole, { topic: string; section: string }> = {
  implement: { topic: "work", section: "Implement" },
  review: { topic: "review", section: "Review" },
  fix: { topic: "review", section: "Fix findings" },
};

/** 文に入れる事実。step は役が開く Run の step。guideText は BRIEF_GUIDE の節の本文（見出しを除き、config を埋めたもの） */
export interface BriefFacts {
  id: string;
  title: string;
  pr: number | undefined;
  branch: string | undefined;
  worktree: string | null;
  acceptance: AcceptanceItem[];
  step: string;
  plan: { id: string; scope: string | null; approach: string | null } | null;
  remote: string;
  baseBranch: string;
  guideText: string;
}

export interface Brief {
  ticket: string;
  role: BriefRole;
  /** 役が開く Run の step（文の先頭の印の step。fix はもう一度の claim が開くのと同じ step） */
  step: string;
  /** サブエージェントに貼る文。先頭の行が印 */
  text: string;
}

/** 文の事実から、役の文を組む（純粋な関数。文の形の正本はテストのスナップショット） */
export function composeBrief(role: BriefRole, f: BriefFacts, findings?: string): string {
  /** 箇条書きの 1 行（見出しと本文を続ける） */
  const item = (label: string, body: string) => `- ${label}: ${body}`;
  const id = f.id;
  // 見直しの役は読むだけ（しない：ファイルを変える）なので、場所の文言を分ける
  const scope =
    role === "review"
      ? "Read the files only; do not change them."
      : "Edit files only inside this worktree.";
  const where = item(
    "Location",
    `worktree ${f.worktree ?? "(set by the claim; check it with dg --json --actor agent ticket show)"}, branch ${f.branch ?? "(set by the claim; check the branch in ticket show)"}. ${scope}`,
  );
  const plan = f.plan
    ? [
        f.plan.scope !== null ? item(`Plan ${f.plan.id} scope`, f.plan.scope) : undefined,
        f.plan.approach !== null ? item("Approach", f.plan.approach) : undefined,
      ].filter((line): line is string => line !== undefined)
    : [];
  const acceptance = [
    item("Acceptance criteria", ""),
    ...(f.acceptance.length > 0
      ? f.acceptance.map((a) => `  ${a.index}. ${a.text}`)
      : ["  (none in the body; ask the parent which items to check)"]),
  ];
  const tools =
    role === "review"
      ? item(
          "Tools",
          "read files with Read. Do not write source with Bash cat, heredoc, or sed -i.",
        )
      : item(
          "Tools",
          "read files with Read and edit them with Edit. Do not read or write source with Bash cat, heredoc, or sed -i.",
        );
  const never = (body: string) => item("Do not", body);
  const returns = (body: string) => item("Return", body);
  const runLine = (body: string) => item("Run", body);
  const marker = `deguboard: ticket=${id} step=${f.step}`;
  // 役の手順の節の本文を、区切りの行で挟んで入れる（見出しは区切りの行の名前で示す）
  const steps = [
    `--- Steps: ${BRIEF_GUIDE[role].section} ---`,
    f.guideText,
    "--- End of steps ---",
  ];

  if (role === "implement") {
    return [
      marker,
      `Implement ticket ${id} "${f.title}" and create the PR as a draft.`,
      where,
      ...plan,
      item(
        "Conventions",
        `Follow the agent instruction file at the repository root, and the steps below. Write the ticket ID (${id}) in the PR body.`,
      ),
      ...steps,
      ...acceptance,
      tools,
      runLine(
        "the marker on the first line makes the hook open and close the implementation Run. Do not open or close a Run. The parent has already claimed the ticket.",
      ),
      never(
        "claim, unclaim, iteration add, Plan operations, launching a reviewer, making the PR ready (`dg pr ready`), merge, `ticket check`, `ticket update --pr`, or work on other tickets. Do not fix things outside the scope; report them in what you return.",
      ),
      returns(
        "the draft PR's URL and number; the acceptance criteria you checked (by number) and those you could not (with reasons); the sources you reread and what you changed there; the results of the checks (format, lint, tests); and anything the human should know.",
      ),
    ].join("\n");
  }

  if (role === "review") {
    return [
      marker,
      `Review the PR for ticket ${id} "${f.title}" as a reviewer separate from the implementer.`,
      where,
      item(
        "Diff",
        `After \`git fetch ${f.remote}\`, look at \`git diff ${f.remote}/${f.baseBranch}...${f.branch ?? "<branch>"}\`.`,
      ),
      item(
        "Ticket body",
        `Read the body and acceptance criteria in \`dg --json --actor agent ticket show ${id}\`.`,
      ),
      item(
        "Conventions",
        "Follow the agent instruction file at the repository root, and the steps below.",
      ),
      ...steps,
      tools,
      runLine(
        "the marker on the first line makes the hook open and close the review Run. Do not open or close a Run.",
      ),
      item(
        "Record",
        `Before returning the list, write the findings as a JSON array (each with severity (heavy or light), category, file, line, reason, and fix; the shape is in \`dg run review-result --help\`) to a temporary file outside the repository, and record it once with \`dg --json --actor agent run review-result ${id} --findings-file <file>\`. Use \`[]\` if there are no findings. dg works out the counts and whether the review passed.`,
      ),
      never(
        "change files in the repository, commit, push, write anything to dg other than the Run, or look at other tickets.",
      ),
      returns(
        "a list of findings split into heavy (missed acceptance criteria, bugs, docs left stale by a promise, procedure, or rule this PR changed, details added to an ADR or requirements, rule violations) and light (wording, preference, older drift from the docs), each with file and line, reason, and how to fix it; and the results of the checks run on the latest commit. Report mismatches with the references section (`## References` or `## 参考` in the body) under the light findings, and do not count them as heavy.",
      ),
    ].join("\n");
  }

  // fix（手直し）。印でフックが fix の Run を開き、理由はサブエージェントが run retry-reason で書き足す（RN-8）
  return [
    marker,
    `Fix the findings on the PR for ticket ${id} "${f.title}". Fix them on the same branch and push.`,
    item(
      "PR",
      `${f.pr !== undefined ? `#${f.pr}` : "(check pr in ticket show)"} (keep it as a draft; do not mark it ready)`,
    ),
    where,
    item(
      "Findings to fix",
      findings ??
        "(paste the list of findings here: the heavy findings and the light ones you decided to fix, returned by the reviewer or the human reviewer, each with file and line, reason, and how to fix it)",
    ),
    item(
      "Before you start fixing",
      `Run \`dg --json --actor agent run retry-reason ${id} --reason <summary of finding 1> --reason <summary of finding 2> …\` once, as a standalone command, to write the retry reasons on the fix Run. Repeat --reason once per finding you fix (the number of reasons is the retry count). Write only the findings from the reviewer or the human reviewer, not fixes for failed checks. Each summary is one line and must not contain secrets, command strings, or paths.`,
    ),
    item(
      "Scope of the fix",
      "The heavy findings listed, and the light ones you decide to fix. For the other light findings, decide whether to fix them, and return the reasons for those you leave.",
    ),
    item(
      "Conventions",
      "Follow the agent instruction file at the repository root, and the steps below. Run the checks (format, lint, tests) on the latest commit before you push.",
    ),
    ...steps,
    ...acceptance,
    tools,
    runLine(
      "the marker on the first line makes the hook open and close the fix Run. Do not open or close a Run (do not use claim, `run start`, or `run finish`).",
    ),
    never(
      "claim, unclaim, making the PR ready (`dg pr ready`), merge, `ticket update --pr`, `ticket check`, or work on other tickets.",
    ),
    returns(
      "the commits you made (hash and summary) and whether you pushed; the light findings you did not fix, with reasons; the acceptance criteria you checked (by number) and those you could not (with reasons); the results of the checks; and anything the human should know.",
    ),
  ].join("\n");
}

/**
 * 手直しの文に入れる指摘：最新の見直しの重い指摘と、受け入れ条件の文言に当たる軽い指摘（t600）、親が手直しに渡した軽い指摘（t639）。
 * 見直しの一覧がなければ undefined（文は貼る場所を空けて返す）。一覧は見直しの記録から読み、親が書き写さない
 */
async function latestFixFindings(ctx: CommandContext, ticket: Ticket): Promise<string | undefined> {
  const stored = await readReviewFindings(ctx.repo, ticket.id);
  // 作業ブランチの最新の回。一覧なしの回（数だけ）なら前の回の一覧は使わず、貼る場所を空ける
  const round = stored && latestRoundSince(stored.rounds, ticket.branch_at);
  if (!round?.findings) return undefined;
  // 親が手直しに渡した軽い指摘（run handoff）も直す指摘に入れる（t639）
  const { fix, unfixedLight } = splitFindings(round.findings, ctx.config.review.heavy_categories);
  const handed = new Set((round.handed ?? []).map(findingKey));
  const toFix = [...fix, ...unfixedLight.filter((f) => handed.has(findingKey(f)))];
  if (toFix.length === 0) return "(the latest review has no findings to fix)";
  return toFix.map((f) => `- ${findingText(f)}`).join("\n");
}

/** 役の文を、チケットの事実（ブランチの worktree・Plan・git の設定）と役の節の本文から組む */
export async function briefOf(
  ctx: CommandContext,
  ticket: Ticket,
  role: BriefRole,
  opts: { findings?: string | undefined } = {},
): Promise<{ brief: Brief; warnings: string[] }> {
  // 手直しの指摘は、渡されなければ見直しの記録から読む（渡されたものはそのまま使う）
  const findings =
    opts.findings ?? (role === "fix" ? await latestFixFindings(ctx, ticket) : undefined);
  const step =
    role === "implement"
      ? openedStepOf(ctx, ticket, "claim")
      : role === "fix"
        ? openedStepOf(ctx, ticket, "reclaim")
        : REVIEW_STEP;
  const doc = ctx.store.require("ticket", ticket.id);
  const plan = openPlanOf(ctx.store, ticket.id);
  const details = plan?.data.details?.[ticket.id];
  const guide = BRIEF_GUIDE[role];
  const note = await composeGuide(guide.topic, ctx.config, ctx.repo.topLevel, guide.section);
  const facts: BriefFacts = {
    id: ticket.id,
    title: ticket.title,
    pr: ticket.pr,
    branch: ticket.branch,
    worktree: ticket.branch ? await findBranchWorktree(ctx.repo, ticket.branch) : null,
    acceptance: parseAcceptance(doc.body) ?? [],
    step,
    plan: plan
      ? { id: plan.id, scope: details?.scope ?? null, approach: details?.approach ?? null }
      : null,
    remote: ctx.config.git.remote,
    baseBranch: ctx.config.git.base_branch,
    // 節の見出しは区切りの行に書くので外す（本文だけを入れる）
    guideText: note.text.replace(/^[^\n]*\n*/, ""),
  };
  return {
    brief: {
      ticket: ticket.id,
      role,
      step,
      text: composeBrief(role, facts, findings),
    },
    warnings: note.warnings,
  };
}

export const brief = defineCommand({
  name: "brief",
  positionals: ["ticket"],
  group: "brief",
  summary:
    "Compose the text to hand to a sub-agent (EX-3; read-only). For each role (implement, review, fix), returns text whose first line is the marker `deguboard: ticket=<id> step=<step>` (the hook opens and closes the Run from the marker). " +
    "The text includes the location (worktree and branch), the Plan's scope and approach, conventions, the role's steps (the body of the guide section), the acceptance criteria, tools (Read and Edit), how to treat the Run, what not to do, and what to return. For review it includes the call that records the result; for fix it includes the findings to fix (from the latest review record: the heavy findings and the light findings that match acceptance criteria wording; findings passed in are used instead) and the call that writes the reasons for the retry (run retry-reason). " +
    "The fixed text is in English. Ticket content stays in the words it was written in. It is the same text as the brief for dg next's implement, review, and fix steps",
  input: z.object({
    ticket: ticketRef,
    role: z
      .enum(BRIEF_ROLES)
      .describe("Role. implement (implementation), review (review), or fix (fix)"),
    findings: z
      .string()
      .optional()
      .describe(
        "List of findings to fix, for the fix text (what the reviewer or a person's review returned). When omitted, the heavy findings and the light findings that match acceptance criteria are taken from the latest review record; if there is no record, returns with a blank space to paste into",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const ticket = ctx.store.require("ticket", input.ticket).data;
    const { brief, warnings } = await briefOf(ctx, ticket, input.role, {
      findings: input.findings,
    });
    return ok<Brief>(brief, undefined, warnings);
  },
});

export const briefCommands = [brief];
