// 振り返りの推薦の指標（MT-7・ADR-035）。既定の観点ごとに、数え方・出どころ・測れないものを英語で持つ。
// 既定の観点の定義（config の retro.perspectives.*.metrics）には入れない：採用した指標が 1 つもない観点に、
// 振り返り（dg guide retro の候補の表）がここを提示し、人が承認したものだけを dg retro metric が config.yaml に書く。
// 形は承認した定義と同じ（retroMetricSchema）なので、承認されたらそのまま記録できる

import type { RetroMetric } from "./config.js";

/** 推薦の指標。既定の観点の ID → 指標の ID → 定義（出す順に並べる） */
export const RECOMMENDED_RETRO_METRICS: Readonly<
  Record<string, Readonly<Record<string, RetroMetric>>>
> = {
  outcome: {
    "done-rate": {
      definition:
        "Of the tickets that were in the Iteration when it closed, the share that is done (completed ÷ (completed + carried_over))",
      sources: ["dg iteration show <S> (completed, carried_over)"],
      unmeasured: "Whether the goal statement itself was met",
    },
  },
  review: {
    "heavy-per-reviewed": {
      definition:
        "The number of heavy findings per ticket that has one or more review records (the sum of reviews.heavy ÷ the number of tickets whose reviews.recorded is 1 or more)",
      sources: ["dg metrics show --iteration <S> --by ticket (reviews.heavy, reviews.recorded)"],
      unmeasured: "Defects found after the merge",
    },
    "first-pass-rate": {
      definition:
        "Of the tickets that have one or more review records, the share that passed with only one review (reviews.recorded is 1 and reviews.passed is 1)",
      sources: ["dg metrics show --iteration <S> --by ticket (reviews.recorded, reviews.passed)"],
      unmeasured: "Whether the reviews that passed missed defects",
    },
    "rounds-per-reviewed": {
      definition:
        "The number of reviews per ticket that has one or more review records (the sum of reviews.recorded ÷ the number of those tickets). Give the largest number of reviews of one ticket and that ticket's ID with it",
      sources: ["dg metrics show --iteration <S> --by ticket (reviews.recorded)"],
      unmeasured: "The cause of the many rounds (the ticket, the implementation, or the review)",
    },
    "escaped-defect-rate": {
      definition:
        "Of the tickets of <S> that have one or more review records, the share that is in the recorded origin of one or more other tickets (tickets[].origin of metrics sources with no filter). Do not count from refs or the bodies. Give the pairs of tickets counted and the count of each origin_cause with it. Tickets filed before origin was recorded have none, so treat an Iteration earlier than the Iteration of the first ticket with a recorded origin (the smallest ID whose origin is not empty) as unmeasured, not 0",
      sources: [
        "dg metrics sources --limit 1 (tickets[].origin, origin_cause, iteration; files is not read)",
        "dg metrics show --iteration <S> --by ticket (reviews.recorded)",
      ],
      unmeasured:
        "Defects not found yet (the count can grow in later Iterations, so a recent Iteration comes out lower), defects fixed without being made a ticket, and fixes whose origin was not recorded",
    },
  },
  spec: {
    "ticket-caused-rework-rate": {
      definition:
        "Of the tickets that have one or more review records, the share that has one or more heavy findings whose cause is the ticket (reviews.causes.heavy.ticket). Give the number of review Runs with no cause counts (missing.review_causes) with it, and treat an Iteration with no cause counts as unmeasured",
      sources: [
        "dg metrics show --iteration <S> --by ticket (reviews.recorded, reviews.causes.heavy.ticket)",
        "dg metrics show --iteration <S> (total.missing.review_causes)",
      ],
      unmeasured:
        "Flaws of a ticket that the review did not point out (the implementer made up for them and it passed), and flaws found after the merge",
    },
  },
  slicing: {
    "size-spread": {
      definition:
        "For the tickets with one or more changed lines (additions + deletions), the largest changed lines ÷ the median (the smaller of the two middle values when the count is even)",
      sources: ["dg metrics show --iteration <S> --by ticket (lines.additions, lines.deletions)"],
      unmeasured: "Whether the PRs collided",
    },
    "concurrent-overlap-rate": {
      definition:
        "Of the tickets of <S> whose PR's changed files could be read, the share that has another ticket of <S> with one or more changed files in common and an overlapping work period (from the ticket's branch_at to the PR's mergedAt). Leave out the tickets whose files is null and give their count with it. Give the overlapping pairs and the number of files in common with it",
      sources: [
        "dg metrics sources --iteration <S> (tickets[].files, files_unknown)",
        "dg ticket list --iteration <S> --include-abandoned (branch_at, pr)",
        "gh pr view <PR> --json mergedAt",
      ],
      unmeasured:
        "Whether the overlapping pairs actually conflicted (became CONFLICTING, or needed a commit to resolve the conflict), and whether the overlap is in the same lines",
    },
  },
  stability: {
    "failed-run-rate": {
      definition:
        "Of the Runs, the share that ended in failure or interrupted ((results.failure + results.interrupted) ÷ runs)",
      sources: ["dg metrics show --iteration <S> (total.results, total.runs)"],
      unmeasured: "Detours inside the Runs that did not fail",
    },
  },
  cost: {
    "tokens-per-line": {
      definition:
        "The tokens per changed line. Show output and input_cache separately and do not add them together. Give the number of tickets with no changed lines (lines.missing) with it",
      sources: ["dg metrics show --iteration <S> (total.lines.per_line, total.lines.missing)"],
      unmeasured: "Whether it was worth the value of the outcome",
    },
  },
  improvement: {
    "prev-try-done-rate": {
      definition:
        "Of the tickets with the label retro-<previous S> of the previous retrospective, the share that is done (abandoned ones are in the denominator too)",
      sources: ["dg ticket list --label retro-<previous S> --include-abandoned (status)"],
      unmeasured:
        "Whether the numbers aimed at moved (compare with the numbers in the body of the Try)",
    },
  },
};

/** 表のセルに入れる文。列の区切り（|）と改行で表が崩れないようにする */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/**
 * 推薦の指標の表（Markdown）。dg guide retro の候補の表に差し込む（guide.ts の `{{recommended_metrics}}`）。
 * 1 行が 1 指標で、出どころはコマンドごとにコードの書式にして `;` で並べる
 */
export function recommendedRetroMetricsTable(): string {
  const rows = Object.entries(RECOMMENDED_RETRO_METRICS).flatMap(([perspective, metrics]) =>
    Object.entries(metrics).map(
      ([id, m]) =>
        `| \`${perspective}\` | \`${id}\` | ${cell(m.definition)} | ${m.sources
          .map((s) => `\`${cell(s)}\``)
          .join("; ")} | ${cell(m.unmeasured ?? "")} |`,
    ),
  );
  return [
    "| Perspective | Metric ID | How to count | Sources | Unmeasured part |",
    "| ----------- | --------- | ------------ | ------- | --------------- |",
    ...rows,
  ].join("\n");
}
