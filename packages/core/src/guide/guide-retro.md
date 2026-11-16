---
description: Looks back on a closed deguboard Iteration by the team's perspectives (retro.perspectives in config.yaml). Shows a short summary of its numbers, proposes metrics for the perspectives that have no approved definition and records the approved ones, computes the defined metrics for the Iteration and the recent ones to show the trend, gives Keep / Problem / Try with a number or a ticket ID as the basis of each finding, and after approval files the improvements as tickets. Use when asked「s3 を振り返って」「レトロして」「振り返りをまとめて」.
argument-hint: "[Iteration] [perspectives]"
---

# Retrospective (retro)

Looks back on a closed Iteration from its numbers and tickets, by the team's perspectives, and gives Keep / Problem / Try. The retrospective itself, with the computed metrics, is answered in the chat and is not stored in the data. Only two things change data, both after a human approves: the metric definitions (recorded in the team's `config.yaml`) and the Try rows (they become tickets, which are advanced through a plan and PRs; the approval is recorded on the Iteration as the retro checkpoint). The form and writing of the tickets follow `dg guide import`.

## Deciding the target

- Iteration (`s3`): the target. It should be closed. For any other status, show its status from `iteration show` and the ask that fits (for example, `dg guide release` for an active one whose tickets are all done), and stop
- No target given: suggests the Iteration closed last (`iteration list --status closed`, the latest `closed_at`) and asks to confirm it. If there is none, say so and stop
- Perspectives (IDs of `retro.perspectives`, such as `spec` or `cost`) after the Iteration, or named in the instruction: propose and compute only for those. With none given, all the perspectives are the target

In the steps below, `<S>` is the ID of the target Iteration.

## Retrospective steps

1. **Read the numbers and the perspectives**: after `dg --json --actor agent sync`, read `metrics show --iteration <S> --by step`, `ticket list --iteration <S> --include-abandoned`, `iteration show <S>`, and `config show` (`retro.perspectives`) (all with `dg --json --actor agent`)
2. **Show the summary**: a few lines, before asking anything
   - Runs: `total.runs`, and the tickets by status from `ticket list`
   - Share of time per step: each group's `active_seconds` (the time worked, without the waits for the parent's requests) over `total.active_seconds`. `duration_seconds` is the elapsed time and includes the waits, so do not use it for the share. `active_seconds` adds up only the Runs whose waits were counted, so when `missing.active_seconds` is not 0, the share covers only those Runs: give that count in the note, with each group's `duration_seconds` for reference
   - Share of tokens per step: each group's tokens over the tokens of `total`. A Run's tokens are its `input`, `output`, `cache_read`, and `cache_write` added together (cache is `cache_read` and `cache_write` together). The four counts are separate and do not overlap, so they add up without counting any token twice. A group whose four values are all null is "unmeasured". Each value adds up only the Runs that have it, so when a group has `missing` counts for them, its share covers only those Runs, and the note gives the `missing` count of each value
   - Failures: `total.results.failure` and `interrupted`
   - Retries and heavy findings: `total.retries` and `total.reviews.heavy`
   - Carry-overs: `carried_over` of `iteration show <S>`, and any ticket of `ticket list` that is neither done nor abandoned
   - Gaps in the measurement, as notes (see the "Gaps in the measurement" section below)
3. **Propose metrics for the perspectives with no definition**: for each target perspective whose `metrics` is empty, propose its recommended metrics with the value computed for `<S>` (for a perspective that has no recommended metric, metrics that the data at hand can fill), in the table of the "Proposing metrics" section below. A perspective that has one or more adopted metrics gets no proposal. Ask once, with multiple selection (`#`), which proposals to approve (include "Approve none"). Record only the approved ones, each with `dg retro metric` (see "Proposing metrics"). Write nothing until approval is obtained. If every target perspective has a definition, do not ask
4. **Compute the defined metrics and show the trend**: for each target perspective that has definitions (those just approved included), compute every metric by its definition, for `<S>` and for the recent Iterations, and show the table of the "Computing the metrics and the trend" section below. A perspective that still has no definition is one row, "unmeasured (no approved definition)"
5. **Show Keep / Problem / Try**: in the table of the "Keep / Problem / Try" section below, with the notes on the gaps
6. **Get approval**: ask once, with multiple selection (`#`), which Try rows to reflect (include "Do not reflect"). Write nothing until approval is obtained. If there is no Try row to reflect, do not ask
7. **Reflect and report**: when the human approved rows in step 6, first pass the retro checkpoint with `dg --json --actor agent checkpoint retro <S> --approved-by human` (the Workflow's `flow.retro` judges filing the improvements; `always_ask` by default, so `--auto` does not skip the approval. When the board's value is `human_only`, give the human the exact command to run and wait; when it is `anyone`, leave `--approved-by` out). It records on `<S>` that the improvements were approved. When no row was approved, do not pass it. Then file the approved rows (see the "Filing tickets" section below), and report the metric definitions recorded, the tickets filed and updated, and the rows not reflected

Reading and computing proceed without waiting for approval. Approval is asked at most twice: for the metric definitions (step 3) and for the Try rows (step 6).

## Perspectives

- The perspectives are the team's, in `retro.perspectives` of `config.yaml`: each has an ID, a name, a question, and the approved metric definitions (`metrics`: metric ID → `definition`, `sources`, and `unmeasured`). Show the name and the question as they are written
- The defaults are seven, from the evaluation framework of Agentic-Agile, and none has a definition: `outcome`, `review` (how well the review works), `spec` (the quality of the tickets), `slicing` (how the work was divided), `stability` (of the agents), `cost`, and `improvement` (whether the Try of the previous retrospectives worked)
- dg adopts no metric by itself. It holds recommended metrics for the default perspectives (see "Proposing metrics"), but what to measure differs from team to team, so a metric is adopted only once a human has approved its definition
- A definition is not a formula that dg runs. It is a sentence that says how to count, and the commands the numbers come from. Read it and compute from it each time
- Change the perspectives themselves only when a human asks: `dg retro perspective <id> --name <name> --question <question>` adds one or changes its name or question, and `dg retro remove <perspective> [metric]` removes a perspective or one definition. Do not edit `config.yaml` directly, and do not use `dg config set` for them

## Proposing metrics

| #   | Perspective | Metric ID | How to count | Sources | Unmeasured part |
| --- | ----------- | --------- | ------------ | ------- | --------------- |

- Propose only for a perspective that has no adopted metric (its `metrics` is empty). A perspective that has even one adopted metric is left as the team decided: do not show the recommended metrics for it
- For such a perspective, propose its recommended metrics (the table "Recommended metrics" below) as they are written there: the metric ID, how to count, the sources, and the unmeasured part. Only when the perspective has no recommended metric (one the team added), or when a human asks for another metric, write a proposal of your own by the rules below
- Propose only what can be computed now from what dg and `gh` return: `metrics show`, `metrics sources`, `run list`, `ticket list`, `ticket show`, `iteration show`, `history`, and `gh pr view`. Run the sources for `<S>` before proposing, and show the value they give next to the proposal (a recommended metric included), so that the human approves a metric that is seen to work. A recommended metric whose sources give no value for `<S>` is shown as "unmeasured" with the reason
- "How to count" is one sentence: what is divided by what (or what is counted), and over which tickets or Runs. Write it so that another agent reading only the sentence and the sources gets the same number. Prefer a rate or a number per ticket to a bare count, because the Iterations differ in size
- "Sources" are the commands with the fields to read, with `<S>` for the Iteration (for example `dg metrics show --iteration <S> --by ticket (retries, reviews.heavy)`)
- "Unmeasured part" is the part of the perspective's question that the metric does not answer. Write it honestly; if no data at hand answers the question at all, propose nothing for that perspective and say what data would be needed
- Keep your own proposals few: one or two metrics for a perspective. A perspective can get more later
- Record an approved proposal with `dg --json --actor agent retro metric <perspective> <metric ID> --definition "<how to count>" --source "<command (fields)>" [--source ...] [--unmeasured "<unmeasured part>"]`. Write the definition in the words that were approved. It replaces a metric of the same ID as a whole
- To change a definition that exists, propose the new one the same way and record it only after approval. The results are not stored, so the earlier Iterations are computed again by the new definition and stay comparable

Recommended metrics (dg holds them for the default perspectives; none is adopted until a human approves it):

{{recommended_metrics}}

- `<previous S>` is the Iteration whose retrospective came just before (the one closed just before `<S>`). If no ticket has the label `retro-<previous S>`, the previous retrospective filed no Try: say so instead of giving a rate
- How to read the fields that the recommended metrics use is in the sections "Causes of rework", "Files and references of the tickets", and "Tokens per changed line" below

## Computing the metrics and the trend

| Perspective | Metric | (earlier Iterations) | `<S>` | Trend |
| ----------- | ------ | -------------------- | ----- | ----- |

- Compute each metric by its `definition`, from its `sources`, with `<S>` replaced by each Iteration. Do not change the way of counting to fit the data; if the definition no longer fits, propose a new one (see "Proposing metrics")
- The recent Iterations are the ones closed just before `<S>` (`iteration list --status closed`, by `closed_at`), up to three, one column each. If there is none, say so and show only `<S>`
- Show each value with what it was computed from (for example "82% (14 / 17)"), and the trend against the earlier Iterations in a word (up, down, flat) with whether that is better or worse for the perspective's question
- A value that cannot be computed is "unmeasured", with the reason (a source that failed, a field that is null or has `missing`, an Iteration with no Runs, `gh` not available). Do not fill it in by guessing, and do not make it 0
- Under the table, give the `unmeasured` part of each definition as a note, so that the number is not read as the whole answer to the question
- Do not store the results: not in a file, not in a ticket, not in `config.yaml`. They are computed again at the next retrospective

## Causes of rework

Each finding of a review has a `cause`, one of seven kinds (their meanings are in `dg run review-result --help`). The review Run keeps only the count of each kind, for heavy and for light findings, and `metrics show` adds them up. Read the causes from those counts. Do not infer a cause from the diff, the title, the size of a ticket, or the `retry_reasons` of the fix Runs.

- **Counts**: `metrics show --iteration <S> --by ticket` gives each ticket's `reviews.causes.heavy` and `reviews.causes.light`, the number of findings for each kind (`ticket`, `plan`, `implementation`, `tests`, `documents`, `environment`, and `unknown`). `total.reviews.causes` is the sum over the Iteration. Show the count of each kind with the ticket IDs of the groups that have it
- **Share**: heavy findings are the rework, and light findings are reported apart. The share of a kind is over the sum of `reviews.causes.heavy` (all kinds), not over `reviews.heavy`, because `reviews.heavy` also counts the findings of Runs with no cause counts
- **Unmeasured**: a review Run with results but no cause counts is not measured. `missing.review_causes` counts them (Runs from before causes were recorded, and results passed as counts only). Their findings are in `reviews.heavy` and `reviews.light` but not in the causes, so write their causes as "unmeasured" with that count. Do not make them 0, and do not read their causes from another source. When `reviews.causes` is null, no Run has cause counts, and every cause is "unmeasured"

## Files and references of the tickets

- `metrics sources --iteration <S>` gives, for each ticket, `files` (the paths that its merged PR changed), `refs` (the IDs of other tickets written in its title and body), and `origin` and `origin_cause` (the tickets whose change caused the defect that this ticket fixes, and the kind of cause, as recorded on the ticket). Use it for metrics about the overlap between PRs (the same file in `files` of two tickets) and about defects that passed the review or the audit (a ticket of `<S>` that is in the `origin` of a later ticket). Do not count them by hand from `git log` or the bodies
- Count the defects that passed the review only from `origin`, not from `refs`. `origin` is never filled in from `refs`, and tickets filed before `origin` was recorded have none: an empty `origin` does not mean that no defect passed, so write an Iteration from before as "unmeasured", not 0
- `files` is null when it could not be read, with the reason in `files_unknown` (no PR recorded, a PR not merged, `gh` not available, a PR with more than 100 files, or not read because of `--limit`: `unread` counts those, so raise `--limit`). Null is not "no files": leave such a ticket out of the metric and give the count of them with the number, and write "unmeasured" when most of the tickets are null
- `refs` tells only that the ID is written, not why. When the metric needs the reason (it came from that ticket, it depends on it, it is only an example), read the ticket with `ticket show` and say in the definition how to tell
- `refs` and `origin` of the tickets of `<S>` hold only what those tickets mention or record. To find the tickets that mention a ticket of `<S>` or fix its defect, read `metrics sources` of the later Iteration (or with no filter) and look for the ID in their `refs` or `origin`

## Tokens per changed line

- `lines` of `metrics show` holds the changed lines of the tickets of the Runs (`additions` and `deletions` of each ticket's merged PR) and the tokens per changed line (`per_line`). It is split into `output` (what was written) and `input_cache` (the context read: `input`, `cache_read`, and `cache_write` together), because `cache_read` is most of the tokens. Read the two separately, and do not add them into one number
- A ticket with no changed lines (work with no PR, or a PR not merged yet) is left out of `per_line`, and is counted in `lines.missing`. Show that count with the number
- In `--by step`, a group's `per_line` is the tokens of that step's Runs over the changed lines of their tickets, so it tells which step costs the most per line. In `--by ticket`, a ticket with few changed lines has a high `per_line` whatever the work was, so do not make it a Problem from `per_line` alone
- Changed lines are a rough measure of the size of the work, not of its value. Use the number to find where to look, and give the ticket IDs as the basis

## Gaps in the measurement

Add these as notes to the summary, to the table of the metrics, and to the Keep / Problem / Try table, with their counts.

- `missing`: the number of Runs whose value could not be read, per value (`duration_seconds`, `active_seconds`, `waited_seconds`, `input`, `output`, `cache_read`, `cache_write`, `tools`). Those Runs are not added to the totals
- Waits not counted: `missing.waited_seconds` (and `missing.active_seconds`) counts the Runs whose waits for the parent's requests could not be counted (an unfinished Run, a Run the parent opened itself, a Run of an agent whose Adapter does not count waits, a Run from before waits were recorded). Their time is not in `active_seconds`; note it as a gap, not as 0
- Tokens not read: the `missing` counts of `input`, `output`, `cache_read`, and `cache_write` are the signal. Each value adds up only the Runs that have it, so give the `missing` count of each value, and note it as a gap, not as 0. The usage is not read when `metrics.read_transcripts` was false, or DEGUBOARD_NO_TRANSCRIPTS was set, where the Runs were finished (the setting now, in `dg config show`, may differ from the one then). `dg run refresh` can read the usage of closed Runs again
- `lines.missing`: the number of tickets with no changed lines, which are left out of the tokens per changed line. A done ticket that has a PR and no lines can be filled with `dg metrics lines --iteration <S>` (it writes the lines to the tickets, so run it only when a human asks)
- `estimated_runs`: the number of Runs whose usage is estimated. The totals include the estimates
- `no_runs`: done tickets claimed by an agent that have no implement Run. Their work is not in the numbers
- `files_unknown` and `unread` of `metrics sources`: the tickets whose changed files could not be read (`files` is null). They are left out of the metrics that read `files`
- Runs follow each ticket's current Iteration, so the Runs of the carried-over tickets are not in the numbers of `<S>`

Do not fill in a value that has a gap by guessing. For a metric or a finding that depends on it, write "unmeasured" with the gap as the reason (for example, "share of time per step: unmeasured, 3 Runs have no `active_seconds`"), and do not make it a Keep or a Problem.

## Keep / Problem / Try

| #   | Kind | Finding | Basis | Handling |
| --- | ---- | ------- | ----- | -------- |

- Kind is Keep (what went well and should continue), Problem (what went wrong), or Try (what to change next, for a Problem or to strengthen a Keep)
- Every finding has a basis: a number (with the command and the field it came from) or ticket IDs. A number of a defined metric is given with the perspective and the metric ID. Drop a finding that has neither
- Only Try rows have a handling, one of:
  - "File": a new ticket
  - "`ticket update <ID>`": when an unfinished ticket with the same aim exists
  - "File an improvement to the rules or guide": a ticket that changes the repository's rules (the agent instructions such as CLAUDE.md or AGENTS.md, development docs), `guide.notes`, or a guide, when the Try is about how the work is done
  - "Do not fix (reason)"
- Write a Try so that it is one change whose effect can be seen in a number of the next Iteration, a defined metric where one fits. Keep the rows few (up to about 5 Try rows); put small ones into one row

## Filing tickets

- File the approved rows by the steps of `dg guide import`, and attach the label `retro-<S>` (for example `retro-s3`). The next retrospective reads this label to tell whether the Try was finished, so do not add or remove it except by this procedure
- Do not write `iteration` (`<S>` is closed). Putting the tickets into an Iteration is done with `dg guide assign`
- Write each filed Try's `## References` as the "How to write a good ticket" section of `dg guide import` says. The files the Try is expected to change are the estimate to write
- For a "`ticket update <ID>`" row, read the ticket with `ticket show <ID>` first, then add the finding as an acceptance item with `ticket update <ID> --acceptance` (`--acceptance` replaces the whole acceptance criteria section, so give the existing items and the new one) or in the body (`--body` replaces the whole body, so give the existing text and the addition), and add `retro-<S>` to its labels (`--label` replaces the whole list, so give the existing labels too)
- In the summary, write the Problem, its basis (the number or the ticket IDs), and the number that should change. Do not decide how to fix it (decide it in planning)

{{choices}}

## Choosing the next step

After showing the result (also when nothing was filed), ask with the following choices.

- **Assign** (recommended when something was filed): put the filed tickets into an Iteration by the steps of `dg guide assign` (if a Skill is available, `/dgassign <ID...>`)
- **Stop here** (recommended when nothing was filed)
