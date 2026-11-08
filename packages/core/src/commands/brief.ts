// サブエージェントに渡す文（brief・EX-3、ADR-011）。役（実装・見直し・手直し）とチケットの事実から、貼る文を組む。読み取りだけで、データは書き換えない。
// 文の組み立ては純粋な関数（composeBrief）に置き、brief コマンドと dg next が事実を渡して使う。定型の文の言語は ask と同じく表示言語で選ぶ（ADR-010）。
// どの役の文も先頭に印を置き、フックが Run を開け閉めする。手直しのやり直しの理由は、サブエージェントが run retry-reason で開いている Run に書き足す（ADR-018）

import { z } from "zod";
import { findBranchWorktree } from "../git/worktree.js";
import { REVIEW_STEP } from "../model/run.js";
import { type AcceptanceItem, parseAcceptance, type Ticket } from "../model/ticket.js";
import { ASK_LANGUAGES, type AskLanguage } from "./ask.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { openPlanOf, ticketRef } from "./helpers.js";
import { openedStepOf } from "./run.js";

/** 文を組む役。implement は実装（claim の step）、review は見直し、fix は手直し（reclaim の step） */
export const BRIEF_ROLES = ["implement", "review", "fix"] as const;
export type BriefRole = (typeof BRIEF_ROLES)[number];

/** 文に入れる事実。step は役が開く Run の step */
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
}

export interface Brief {
  ticket: string;
  role: BriefRole;
  /** 役が開く Run の step（文の先頭の印の step。fix はもう一度の claim が開くのと同じ step） */
  step: string;
  language: AskLanguage;
  /** サブエージェントに貼る文。先頭の行が印 */
  text: string;
}

/** 定型の文の言語に合わせて、日本語と英語のどちらかを選ぶ */
const say = (lang: AskLanguage, ja: string, en: string) => (lang === "en" ? en : ja);

/** 文の事実から、役の文を組む（純粋な関数。文の形の正本はテストのスナップショット） */
export function composeBrief(
  role: BriefRole,
  f: BriefFacts,
  lang: AskLanguage,
  findings?: string,
): string {
  const L = (ja: string, en: string) => say(lang, ja, en);
  const colon = L("：", ": ");
  /** 箇条書きの 1 行（見出しと本文を続ける） */
  const item = (label: string, body: string) => `- ${label}${colon}${body}`;
  const id = f.id;
  // 見直しの役は読むだけ（しない：ファイルを変える）なので、場所の文言を分ける
  const scope =
    role === "review"
      ? L("ファイルは読むだけで、変えない。", "Read the files only; do not change them.")
      : L("ファイルはこの worktree の中だけで編集する。", "Edit files only inside this worktree.");
  const where = item(
    L("場所", "Location"),
    `worktree ${f.worktree ?? L("（claim で決まる。dg --json --actor agent ticket show で確かめる）", "(set by the claim; check it with dg --json --actor agent ticket show)")}${L("、", ", ")}${L("ブランチ", "branch")} ${f.branch ?? L("（claim で決まる。ticket show の branch で確かめる）", "(set by the claim; check the branch in ticket show)")}${L("。", ". ")}${scope}`,
  );
  const plan = f.plan
    ? [
        f.plan.scope !== null
          ? item(L(`Plan ${f.plan.id} の範囲`, `Plan ${f.plan.id} scope`), f.plan.scope)
          : undefined,
        f.plan.approach !== null ? item(L("方針", "Approach"), f.plan.approach) : undefined,
      ].filter((line): line is string => line !== undefined)
    : [];
  const acceptance = [
    item(L("受け入れ条件", "Acceptance criteria"), ""),
    ...(f.acceptance.length > 0
      ? f.acceptance.map((a) => `  ${a.index}. ${a.text}`)
      : [
          `  ${L("（本文に受け入れ条件がない。確かめる項目を親に聞く）", "(none in the body; ask the parent which items to check)")}`,
        ]),
  ];
  const tools =
    role === "review"
      ? item(
          L("道具", "Tools"),
          L(
            "ファイルは Read で読む。Bash の cat・heredoc・sed -i でソースを書き換えない。",
            "read files with Read. Do not write source with Bash cat, heredoc, or sed -i.",
          ),
        )
      : item(
          L("道具", "Tools"),
          L(
            "ファイルは Read で読み、Edit で直す。Bash の cat・heredoc・sed -i でソースを読み書きしない。",
            "read files with Read and edit them with Edit. Do not read or write source with Bash cat, heredoc, or sed -i.",
          ),
        );
  const never = (ja: string, en: string) => item(L("しない", "Do not"), L(ja, en));
  const returns = (ja: string, en: string) => item(L("返すもの", "Return"), L(ja, en));
  const runLine = (ja: string, en: string) => item("Run", L(ja, en));
  const marker = `deguboard: ticket=${id} step=${f.step}`;

  if (role === "implement") {
    return [
      marker,
      L(
        `チケット ${id}「${f.title}」を実装し、PR を draft で作ってください。`,
        `Implement ticket ${id} "${f.title}" and create the PR as a draft.`,
      ),
      where,
      ...plan,
      item(
        L("規約", "Conventions"),
        L(
          `リポジトリのルートにあるエージェント向けの指示ファイルと \`dg guide work\` の「実装する」（draft の PR まで）に従う。読み直して直す正本は requirements（約束だけを直し、細部は足さない）と README・コードのコメントで、ADR は判断と理由を書き換えないので入れない。この PR で古くなった ADR の細部は直さず、報告に書く（\`dg guide audit\` が起票する「ADR の細部を消す」の材料）。PR は \`gh pr create --draft\` で作り、本文にチケット ID（${id}）を書く。`,
          `Follow the agent instruction file at the repository root and the "実装する" section of \`dg guide work\` (up to creating a draft PR). The sources to reread and fix are requirements (change only the promises; do not add details), the README, and code comments; do not include ADRs, since they record decisions and reasons and are not rewritten. Do not fix ADR details that this PR leaves stale; report them as material for the "ADR の細部を消す" ticket from \`dg guide audit\`. Create the PR with \`gh pr create --draft\` and write the ticket ID (${id}) in its body.`,
        ),
      ),
      ...acceptance,
      tools,
      runLine(
        "この文の先頭の印で、フックが実装の Run を開き閉じる。Run は開かず閉じない。claim は親が済ませている。",
        "the marker on the first line makes the hook open and close the implementation Run. Do not open or close a Run. The parent has already claimed the ticket.",
      ),
      never(
        "claim・unclaim・iteration add・Plan の操作・見直し役の起動・PR の ready（`dg pr ready`）・マージ・`ticket check`・`ticket update --pr`・ほかのチケットの作業。範囲の外で見つけたことは直さず、返すものに書く。",
        "claim, unclaim, iteration add, Plan operations, launching a reviewer, making the PR ready (`dg pr ready`), merge, `ticket check`, `ticket update --pr`, or work on other tickets. Do not fix things outside the scope; report them in what you return.",
      ),
      returns(
        "draft の PR の URL と番号・確かめた受け入れ条件（番号ごと）と付けられなかった項目（理由）・読み直した正本と直した箇所・検査（書式・lint・テスト）の結果・人に伝えること。",
        "the draft PR's URL and number; the acceptance criteria you checked (by number) and those you could not (with reasons); the sources you reread and what you changed there; the results of the checks (format, lint, tests); and anything the human should know.",
      ),
    ].join("\n");
  }

  if (role === "review") {
    return [
      marker,
      L(
        `チケット ${id}「${f.title}」の PR を見直してください。実装したのとは別の役として見ます。`,
        `Review the PR for ticket ${id} "${f.title}" as a reviewer separate from the implementer.`,
      ),
      where,
      item(
        L("差分", "Diff"),
        L(
          `\`git fetch ${f.remote}\` のあと \`git diff ${f.remote}/${f.baseBranch}...${f.branch ?? "<ブランチ>"}\` で見る。`,
          `After \`git fetch ${f.remote}\`, look at \`git diff ${f.remote}/${f.baseBranch}...${f.branch ?? "<branch>"}\`.`,
        ),
      ),
      item(
        L("チケット本文", "Ticket body"),
        L(
          `\`dg --json --actor agent ticket show ${id}\` の本文と受け入れ条件を読む。`,
          `Read the body and acceptance criteria in \`dg --json --actor agent ticket show ${id}\`.`,
        ),
      ),
      item(
        L("規約", "Conventions"),
        L(
          "リポジトリのルートにあるエージェント向けの指示ファイルと `dg guide review` の「見直す」に従う。見る観点は受け入れ条件の漏れ・不具合・文書との食い違い（この PR が変えた約束・手順・規約で、文書を同じ PR で直していないものは重い。ADR や要件に細部を足した変更も重い。文書を直していない重い指摘は約束・手順・規約の変更に限る。細部の直し方はコード・テスト・ヘルプへ移すこと。前からのずれは軽い）・規約の違反・範囲の外の変更。チケット本文に `## 参考` 節があれば、そこに書いたファイルと差分で変えたファイルを見比べ、参考節にない大きな広がりと、参考節のファイルに触れていない変更を「参考節との食い違い」として返す。",
          'Follow the agent instruction file at the repository root and the "見直す" (Review) section of `dg guide review`. Look for missed acceptance criteria, bugs, mismatches with the docs (docs left stale by a promise, procedure, or rule this PR changed are heavy, and so are details added to an ADR or requirements, whose fix moves the details into code, tests, or help; heavy findings about docs are limited to promises, procedures, and rules; older drift is light), rule violations, and changes outside the scope. If the ticket body has a `## 参考` section, compare the files it names with the files the diff changes, and report as "参考節との食い違い" any large spread outside the section and any change that does not touch the files the section names.',
        ),
      ),
      tools,
      runLine(
        "この文の先頭の印で、フックが見直しの Run（review）を開き閉じる。Run は開かず閉じない。",
        "the marker on the first line makes the hook open and close the review Run. Do not open or close a Run.",
      ),
      item(
        L("記録", "Record"),
        L(
          `一覧を返す前に、\`dg --json --actor agent run review-result ${id} --heavy <重い指摘の数> --light <軽い指摘の数>\` を 1 回記録する（重い指摘がなければ \`--passed\` も付ける）。`,
          `Before returning the list, record the result once with \`dg --json --actor agent run review-result ${id} --heavy <number of heavy findings> --light <number of light findings>\` (add \`--passed\` if there are no heavy findings).`,
        ),
      ),
      never(
        "ファイルを変える・コミットする・push する・Run のほかに dg へ書き込む・ほかのチケットを見る。",
        "change files, commit, push, write anything to dg other than the Run, or look at other tickets.",
      ),
      returns(
        "指摘を重い（受け入れ条件の漏れ・不具合・この PR が変えた約束・手順・規約で文書を直していないもの・ADR や要件に足した細部・規約の違反）と軽い（言い回し・好み・前からのずれ）に分けた一覧（ファイルと行・理由・直し方）と、最新のコミットで回した検査の結果。参考節との食い違いは軽い指摘の欄に分けて書き、重い指摘に数えない。",
        "a list of findings split into heavy (missed acceptance criteria, bugs, docs left stale by a promise, procedure, or rule this PR changed, details added to an ADR or requirements, rule violations) and light (wording, preference, older drift from the docs), each with file and line, reason, and how to fix it; and the results of the checks run on the latest commit. Report 参考節との食い違い (mismatches with the 参考 section) under the light findings, and do not count them as heavy.",
      ),
    ].join("\n");
  }

  // fix（手直し）。印でフックが fix の Run を開き、理由はサブエージェントが run retry-reason で書き足す（ADR-018）
  return [
    marker,
    L(
      `チケット ${id}「${f.title}」の PR の指摘を直してください。同じブランチで直して push します。`,
      `Fix the findings on the PR for ticket ${id} "${f.title}". Fix them on the same branch and push.`,
    ),
    item(
      "PR",
      `${f.pr !== undefined ? `#${f.pr}` : L("（ticket show の pr で確かめる）", "(check pr in ticket show)")}${L("（draft のまま。ready にしない）", " (keep it as a draft; do not mark it ready)")}`,
    ),
    where,
    item(
      L("直す指摘", "Findings to fix"),
      findings ??
        L(
          "（直す指摘の一覧をここに貼る：見直し役か人のレビューが返した、重い指摘と直すと決めた軽い指摘。件ごとにファイルと行・理由・直し方）",
          "(paste the list of findings here: the heavy findings and the light ones you decided to fix, returned by the reviewer or the human reviewer, each with file and line, reason, and how to fix it)",
        ),
    ),
    item(
      L("直し始める前に", "Before you start fixing"),
      L(
        `\`dg --json --actor agent run retry-reason ${id} --reason <直す指摘 1 件の要約> --reason <2 件目の要約> …\` を単独のコマンドで 1 回呼んで、fix の Run にやり直しの理由を書く。直す指摘 1 件に 1 つ --reason を繰り返す（回数は理由の数になる）。書くのは見直し役・人のレビューの指摘だけで、検査の失敗を直したことは書かない。要約は 1 行で、秘密・コマンドの文字列・パスは書かない。`,
        `Run \`dg --json --actor agent run retry-reason ${id} --reason <summary of finding 1> --reason <summary of finding 2> …\` once, as a standalone command, to write the retry reasons on the fix Run. Repeat --reason once per finding you fix (the number of reasons is the retry count). Write only the findings from the reviewer or the human reviewer, not fixes for failed checks. Each summary is one line and must not contain secrets, command strings, or paths.`,
      ),
    ),
    item(
      L("直す範囲", "Scope of the fix"),
      L(
        "挙げられた重い指摘と、直すと決めた軽い指摘。ほかの軽い指摘は直すかを決め、直さないものは理由を返す。",
        "The heavy findings listed, and the light ones you decide to fix. For the other light findings, decide whether to fix them, and return the reasons for those you leave.",
      ),
    ),
    item(
      L("規約", "Conventions"),
      L(
        "リポジトリのルートにあるエージェント向けの指示ファイルと `dg guide review` の「指摘を直す」に従う。検査（書式・lint・テスト）を最新のコミットで通してから push する。",
        'Follow the agent instruction file at the repository root and the "指摘を直す" (Fixing findings) section of `dg guide review`. Run the checks (format, lint, tests) on the latest commit before you push.',
      ),
    ),
    ...acceptance,
    tools,
    runLine(
      "この文の先頭の印で、フックが手直しの Run（fix）を開き閉じる。Run は開かず閉じない（claim・`run start`・`run finish` は使わない）。",
      "the marker on the first line makes the hook open and close the fix Run. Do not open or close a Run (do not use claim, `run start`, or `run finish`).",
    ),
    never(
      "claim・unclaim・PR の ready（`dg pr ready`）・マージ・`ticket update --pr`・`ticket check`・ほかのチケットの作業。",
      "claim, unclaim, making the PR ready (`dg pr ready`), merge, `ticket update --pr`, `ticket check`, or work on other tickets.",
    ),
    returns(
      "直したコミット（ハッシュと要約）と push の有無・直さなかった軽い指摘と理由・確かめた受け入れ条件（番号ごと）と付けられなかった項目（理由）・検査の結果・人に伝えること。",
      "the commits you made (hash and summary) and whether you pushed; the light findings you did not fix, with reasons; the acceptance criteria you checked (by number) and those you could not (with reasons); the results of the checks; and anything the human should know.",
    ),
  ].join("\n");
}

/** 役の文を、チケットの事実（ブランチの worktree・Plan・規約の場所の設定）から組む */
export async function briefOf(
  ctx: CommandContext,
  ticket: Ticket,
  role: BriefRole,
  opts: { language?: AskLanguage | undefined; findings?: string | undefined } = {},
): Promise<Brief> {
  const language = opts.language ?? "ja";
  const step =
    role === "implement"
      ? openedStepOf(ctx, ticket, "claim")
      : role === "fix"
        ? openedStepOf(ctx, ticket, "reclaim")
        : REVIEW_STEP;
  const doc = ctx.store.require("ticket", ticket.id);
  const plan = openPlanOf(ctx.store, ticket.id);
  const details = plan?.data.details?.[ticket.id];
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
  };
  return {
    ticket: ticket.id,
    role,
    step,
    language,
    text: composeBrief(role, facts, language, opts.findings),
  };
}

export const brief = defineCommand({
  name: "brief",
  positionals: ["ticket"],
  group: "brief",
  summary:
    "サブエージェントに渡す文を組む（EX-3。読み取りだけ）。役（implement・review・fix）ごとに、先頭に印 `deguboard: ticket=<id> step=<step>` を置いた文を返す（フックが印で Run を開け閉めする）。" +
    "文には場所（worktree・ブランチ）・Plan の範囲と方針・規約の場所・受け入れ条件・道具（Read・Edit）・Run の扱い・しないこと・返すものを入れる。review には結果を記録する呼び出し、fix には直す指摘の一覧（findings）とやり直しの理由を書く呼び出し（run retry-reason）を入れる。" +
    "定型の文の言語は language（ask と同じく省けば ja）。チケットの中身は書いた言葉のまま。dg next の implement・review・fix の手の brief と同じ文",
  input: z.object({
    ticket: ticketRef,
    role: z.enum(BRIEF_ROLES).describe("役。implement（実装）・review（見直し）・fix（手直し）"),
    language: z
      .enum(ASK_LANGUAGES)
      .optional()
      .describe("文の定型の文の言語。省けば ja。チケットの中身は変えない"),
    findings: z
      .string()
      .optional()
      .describe(
        "fix の文に入れる、直す指摘の一覧（見直し役か人のレビューが返したもの）。省けば貼る場所を空けて返す",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const ticket = ctx.store.require("ticket", input.ticket).data;
    return ok<Brief>(
      await briefOf(ctx, ticket, input.role, {
        language: input.language,
        findings: input.findings,
      }),
    );
  },
});

export const briefCommands = [brief];
