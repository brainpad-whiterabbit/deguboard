---
description: Advances a deguboard Iteration or tickets through assignment, check, plan, work, audit, and release (or clean-up), in one flow. Approval stays where each stage's steps put it, and the flow does not stop between stages. A flow that stopped midway can be resumed with the same arguments. --no-assign skips the assignment stage. --auto chooses reversible decisions that come with a suggested option. Use when asked「s3 を最後まで進めて」「割り当てからリリースまでやって」.
argument-hint: "<Iteration|ticket ID...> [--no-assign] [--auto] [--gate-high|--gate-low|--gate-free]"
---

# End to end (all)

Advances an Iteration or tickets from assignment to release, in one flow. The current stage and the next step come from `dg flow next`, so this guide only describes how to do each step it returns.

## Deciding the target

- Iteration (`s3`): the tickets of that Iteration, and the candidates to put into it (todos not in an Iteration). Candidates are handled only in the assignment stage
- Ticket ID (one or more) or Plan ID (`p7`): advances that target. Audit and release run for a ticket's Iteration only when all the tickets of that Iteration are finished. If the ticket is not in an Iteration, audit and release do not run
- No target given: the same as the "Deciding the target" section of `dg guide release`
- `--no-assign`: skips the assignment stage. If the check suggests putting tickets into an Iteration, it does not apply the suggestion and leaves it in the final report
- `--auto`: see "Choosing automatically with `--auto`" below. It can be combined with `--no-assign`
- `--gate-high`, `--gate-low`, `--gate-free`: the quality gate level for the target tickets. Pass it to `flow next` as `--gate <level>`. The work stage's `commands` then set the level on each ticket whose level differs, before its `next`, and `next` follows that level: high goes through the review and the fix loop, low and free go from the PR straight to `ready` (low still runs the checks, free does not). The conditions per level are in the "Quality gate" section of `dg guide review`. A level a human wrote in the command is the human's decision, so with `--auto` too, set it without asking. With no level given, each ticket keeps its own level (no level is high)

Below, the target Iteration is written as `<S>`. The flow starts without asking, and closing is done only on a human's instruction.

## Stages

The order of stages and the current stage are decided by `dg flow next`. Approval is asked in the places below, and each stage's steps also get approval there.

| Stage   | Where approval is asked                      |
| ------- | -------------------------------------------- |
| Assign  | Rows to put in                               |
| Check   | Rows to fix; deletion, abandoned, closing    |
| Plan    | Plan                                         |
| Work    | Merge of each PR (`dg guide done`)           |
| Audit   | Table of findings                            |
| Release | Merge of the release PR, publishing, closing |

## Running the flow

1. Call `dg --json --actor agent flow next <target…>` when starting, and after finishing each stage (add `--auto` and `--no-assign` if given, and `--gate <level>` for `--gate-<level>`). In the result, `stage.name` is the current stage (`assign`, `check`, `plan`, `work`, `audit`, `release`, or `stop`); `commands` are the dg commands to call (in order); `guide.text` is how to do the stage (the sections in `guide.sections` joined in order, including all the sections of the same topic that the step section points to); and `approval` is whether approval is needed and where
2. Do the stage's step. Run `commands` in order, and follow `guide.text` (to read it again, use `guide.command`). Do not read the whole guide of the stage's topic again. Read a section of another topic only when `guide.text` points to it (the "…" section of `dg guide <topic>`)
   - `work` follows `dg guide parallel` whatever the number of tickets: each ticket is given to a subagent. The parent only advances, asks for approval, and reads and writes `dg`
   - For `release`, if the repository's rules have no release steps, follow the "When there are no release steps" section of `guide.text`
3. When `approval.required` is true, ask a human about `approval.what`. Include "Stop here" in the choices. For how `--auto` handles it, see "Choosing automatically with `--auto`" below
4. After a stage's step is finished (approval obtained, fixed, or done), copy that result's `resume` as it is into `--resume`, and return to 1 (`dg --json --actor agent flow next <target…> --resume <resume>`). Do not assemble the value. If you stop midway through an assign, check, or audit step (approval was not obtained, or you stopped at the table of findings), stop without copying that `resume`. To resume, pass the `resume` copied before, or call without `--resume` using the same target and arguments. Copying the `resume` of a step stopped midway makes the flow skip that stage as finished
5. When `stage.name` is `stop`, or `repeated` is not null (the same stage continues and the facts do not change), show `ask_human` and the state, and stop

## Between stages

- **No stopping between stages**: except where `approval.required` applies, do not ask, and call the next `flow next`
- **Merge follows `auto.merge`**: if `auto.merge` (current setting: `{{auto.merge}}`) is true, a PR that passes the quality gate is merged automatically with `--auto`; if false, a human merges it. After a PR is put out, advance the next step while waiting for its merge. If there is no next step, stop. Approval for the merge follows `approval`
- **Handling failures**: a ticket whose implementation failed goes back to todo, as in `dg guide parallel`, and tickets that do not wait for it advance. A ticket whose review or fix returned failure, or did not return, is not put back to todo, and follows the "How to finish" section of `dg guide review`

## Choosing automatically with `--auto`

With `--auto`, the flow proceeds without asking only in the following two cases. Whatever remains in `approval.what` is asked about. Briefly show what was chosen and the material for the decision on the spot.

- What is written in `approval.auto`: proceeds with the suggested option. Which decisions are included is decided by `auto.decisions` in config (current setting: `{{auto.decisions}}`) and by `auto.merge`
- The check of acceptance criteria after reconciling (step 3 of `dg guide done`), when `accept` is in `auto.decisions`

Merges and decisions a human makes are handled as follows.

- **A PR is merged** only when `auto.merge` (current setting: `{{auto.merge}}`) is true, and only a PR that meets the "Quality gate" section of `dg guide review` is merged with `dg --json --actor agent pr merge <id>`. Leave out `--method` and `--delete-branch`, so that config's `merge.method` and `merge.delete_branch` (current settings: `{{merge.method}}` and `{{merge.delete_branch}}`) decide the method and whether the branch is deleted. If the PR does not meet the gate, show the conditions it did not meet, ask for approval, and stop
- **Decisions a human makes are asked, and the flow stops, regardless of config**: merging and publishing the release PR (tags and destinations); deleting a ticket, abandoning it, or undoing done; closing or reopening an Epic, Iteration, or Plan; merging when `auto.merge` is false; changing a Plan's waits (`after`) and scope; operations with `--force`; decisions with no suggested option; and answers that cannot be a choice

## Reporting the result

At the end of the flow, report the result of each stage: the lines fixed in assign and check, the Plans approved, the PRs put out and merged, the tickets filed, the released version and the state of the Iteration, the assignment suggestions not applied, and the tickets left. With `--auto`, also report the decisions chosen automatically and the results of checking the conditions for PRs merged automatically.

{{choices}}

## Choosing the next step

When the flow stops, ask with the following choices, according to the reason it stopped. When the Iteration is closed and the flow has ended (the reason `flow next` gives for that), report the result without asking.

- **Resume** (recommended when it stopped waiting for a merge): after the merge, read `dg guide all` again, and call `flow next` with the same target and arguments (such as `--auto`) to continue (if a Skill is available, `/dgall <S>`)
- **Stop here**
