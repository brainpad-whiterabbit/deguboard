---
description: Looks back on a closed deguboard Iteration. Shows a short summary of its numbers (Runs, time and tokens per step, failures, retries, heavy findings, carry-overs), asks which viewpoints to look into (outcome, flow, rework, comparison), gives Keep / Problem / Try with a number or a ticket ID as the basis of each finding, and after approval files the improvements as tickets. Use when asked「s3 を振り返って」「レトロして」「振り返りをまとめて」.
argument-hint: "[Iteration] [viewpoints]"
---

# Retrospective (retro)

Looks back on a closed Iteration from its numbers and tickets, and gives Keep / Problem / Try. The retrospective itself is answered in the chat and is not stored in the data. Only the Try rows that a human approves change data: they become tickets, which are advanced through a plan and PRs. The form and writing of the tickets follow `dg guide import`.

## Deciding the target

- Iteration (`s3`): the target. It should be closed. For any other status, show its status from `iteration show` and the ask that fits (for example, `dg guide release` for an active one whose tickets are all done), and stop
- No target given: suggests the Iteration closed last (`iteration list --status closed`, the latest `closed_at`) and asks to confirm it. If there is none, say so and stop
- Viewpoints (`outcome`, `flow`, `rework`, `comparison`) after the Iteration, or named in the instruction: look into those, and do not ask which viewpoints (step 3)

In the steps below, `<S>` is the ID of the target Iteration.

## Retrospective steps

1. **Read the numbers**: after `dg --json --actor agent sync`, read `metrics show --iteration <S> --by step`, `ticket list --iteration <S> --include-abandoned`, and `iteration show <S>` (all with `dg --json --actor agent`)
2. **Show the summary**: a few lines, before asking anything
   - Runs: `total.runs`, and the tickets by status from `ticket list`
   - Share of time per step: each group's `duration_seconds` over `total.duration_seconds`
   - Share of tokens per step: each group's tokens over the tokens of `total`. A Run's tokens are its `input`, `output`, `cache_read`, and `cache_write` added together (cache is `cache_read` and `cache_write` together). The four counts are separate and do not overlap, so they add up without counting any token twice. A group whose four values are all null is "unknown"; when a group has `missing` counts for them, its share covers only the Runs that have the values, and the note says so
   - Failures: `total.results.failure` and `interrupted`
   - Retries and heavy findings: `total.retries` and `total.reviews.heavy`
   - Carry-overs: `carried_over` of `iteration show <S>`, and any ticket of `ticket list` that is neither done nor abandoned
   - Gaps in the measurement, as notes (see the "Gaps in the measurement" section below)
3. **Ask the viewpoints**: once, with multiple selection, from the four in the "Viewpoints" section below. Recommend the viewpoints where a number stands out, and give the number as the reason (for example, "rework: 4 retries and 1 heavy finding", "flow: implement took 84% of the time, 1 failure", "outcome: 3 carry-overs", "comparison: `retro-<previous S>` has tickets"). If nothing stands out, recommend outcome. Do not ask when the viewpoints are already decided (see "Deciding the target")
4. **Look into each chosen viewpoint**: read the commands of the viewpoint, and answer its questions (the "Viewpoints" section). Read only; no subagent is needed
5. **Show Keep / Problem / Try**: in the table of the "Keep / Problem / Try" section below, with the notes on the gaps
6. **Get approval**: ask once, with multiple selection (`#`), which Try rows to reflect (include "Do not reflect"). Write nothing until approval is obtained. If there is no Try row to reflect, do not ask
7. **Reflect and report**: file the approved rows (see the "Filing tickets" section below), and report the tickets filed and updated and the rows not reflected

Reading (steps 1 to 5) proceeds without waiting for approval. Besides the viewpoints, approval is asked only once, in step 6.

## Viewpoints

| Viewpoint  | What to read (`dg --json --actor agent`)                                                                                                                               | Questions to answer                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outcome    | `iteration show <S>` (`goal`, `completed`, `carried_over`, and where the carry-overs are now in `next.moved`), `ticket list --iteration <S> --include-abandoned`       | Was the goal met? What was finished, what was abandoned, and what was carried over? Where are the carry-overs now, and are they finished?                       |
| Flow       | `metrics show --iteration <S> --by step`, `--by ticket`, and `--by model`; `run list --iteration <S>` (`result` and `error` of the Runs that failed or were interrupted) | Which step took the largest share of the time, and which the largest share of the tokens? Where the two shares differ, which step is the reason? Which tickets took far longer than the others? Why did the failed or interrupted Runs stop?                      |
| Rework     | `metrics show --iteration <S> --by ticket` (`retries`, `reviews.heavy`), then for those tickets `run list --ticket <t12>` and the PR (see "Causes of rework")           | Which tickets were reworked, and how many times? What kind of cause does each have? Which kind is the most common?                                              |
| Comparison | `metrics show --iteration <previous S> --by step`, `ticket list --label retro-<previous S> --include-abandoned` (see "Comparison with the previous Iteration")          | Which numbers got better or worse than the previous Iteration? Was each Try of the previous retrospective finished, and did the number it aimed at change?       |

## Causes of rework

Divide the causes into kinds only from these two sources. Do not infer a cause from the diff, the title, or the size of a ticket.

- `retry_reasons` of the fix Runs (`run list --ticket <t12>`): one line for each finding that was fixed
- The review comments of the PR where a heavy finding was recorded (`review.heavy` of the review Runs; the PR number is `pr` of `ticket show <t12>`): read them with `gh pr view <number> --json reviews,comments`

The kinds are: the ticket (acceptance criteria or scope that were unclear or missing), the plan (order, dependencies, or overlap), the implementation (a defect or a missed case), tests (missing or unstable), documents (not fixed with the change), and the environment and tools (checks, hooks, the gate). Show the count of each kind with the ticket IDs.

If `gh` is not available or the comments cannot be read, write the cause of that heavy finding as "unknown", and say that it could not be read. A retry with no `retry_reasons` is also "unknown".

## Comparison with the previous Iteration

- The previous Iteration is the one closed just before `<S>` (`iteration list --status closed`, by `closed_at`). If there is none, say so and skip this viewpoint
- Compare the same numbers as the summary (Runs, share of time per step, share of tokens per step, failures, retries, heavy findings, carry-overs). Counts depend on the number of tickets, so show them with the number of tickets or as a rate
- The Try of the previous retrospective is the tickets with the label `retro-<previous S>` (for example `retro-s2`). Show from each one's status whether it was finished: done (finished), in_progress or review (under way), todo (not started), abandoned (dropped). For a finished Try, show whether the number it aimed at changed
- If no ticket has the label, say that the previous retrospective filed no Try (or was not done), and compare only the numbers

## Gaps in the measurement

Add these as notes to the summary and to the Keep / Problem / Try table, with their counts.

- `missing`: the number of Runs whose value could not be read, per value (`duration_seconds`, `input`, `output`, `cache_read`, `cache_write`, `tools`). Those Runs are not added to the totals
- Tokens not read: when `metrics.read_transcripts` is false (`dg config show`), or DEGUBOARD_NO_TRANSCRIPTS is set where the Runs were finished, their usage is not read. Those Runs count in `missing` for `input`, `output`, `cache_read`, and `cache_write`, so the token shares are not measured. Note it as a gap, not as 0
- `estimated_runs`: the number of Runs whose usage is estimated. The totals include the estimates
- `no_runs`: done tickets claimed by an agent that have no implement Run. Their work is not in the numbers
- Runs follow each ticket's current Iteration, so the Runs of the carried-over tickets are not in the numbers of `<S>`

Do not fill in a value that has a gap by guessing. For a finding that depends on it, write "unknown" with the gap as the reason (for example, "share of time per step: unknown, 3 Runs have no `duration_seconds`"), and do not make it a Keep or a Problem.

## Keep / Problem / Try

| #   | Kind | Finding | Basis | Handling |
| --- | ---- | ------- | ----- | -------- |

- Kind is Keep (what went well and should continue), Problem (what went wrong), or Try (what to change next, for a Problem or to strengthen a Keep)
- Every finding has a basis: a number (with the command and the field it came from) or ticket IDs. Drop a finding that has neither
- Only Try rows have a handling, one of:
  - "File": a new ticket
  - "`ticket update <ID>`": when an unfinished ticket with the same aim exists
  - "File an improvement to the rules or guide": a ticket that changes the repository's rules (CLAUDE.md, development docs), `guide.notes`, or a guide, when the Try is about how the work is done
  - "Do not fix (reason)"
- Write a Try so that it is one change whose effect can be seen in a number of the next Iteration. Keep the rows few (up to about 5 Try rows); put small ones into one row

## Filing tickets

- File the approved rows by the steps of `dg guide import`, and attach the label `retro-<S>` (for example `retro-s3`). The next retrospective reads this label to tell whether the Try was finished, so do not add or remove it except by this procedure
- Do not write `iteration` (`<S>` is closed). Putting the tickets into an Iteration is done with `dg guide assign`
- For a "`ticket update <ID>`" row, read the ticket with `ticket show <ID>` first, then add the finding as an acceptance item with `ticket update <ID> --acceptance` (`--acceptance` replaces the whole acceptance criteria section, so give the existing items and the new one) or in the body (`--body` replaces the whole body, so give the existing text and the addition), and add `retro-<S>` to its labels (`--label` replaces the whole list, so give the existing labels too)
- In the summary, write the Problem, its basis (the number or the ticket IDs), and the number that should change. Do not decide how to fix it (decide it in planning)

{{choices}}

## Choosing the next step

After showing the result (also when nothing was filed), ask with the following choices.

- **Assign** (recommended when something was filed): put the filed tickets into an Iteration by the steps of `dg guide assign` (if a Skill is available, `/dgassign <ID...>`)
- **Stop here** (recommended when nothing was filed)
