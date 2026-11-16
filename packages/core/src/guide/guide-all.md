---
description: Advances a deguboard Iteration or tickets through assignment, check, plan, work, audit, and release (or clean-up), in one flow. Approval stays where each stage's steps put it, and the flow does not stop between stages. A flow that stopped midway can be resumed with the same arguments. --no-assign skips the assignment stage. --auto goes ahead without asking where the board's Workflow value is ask_unless_auto. Use when asked「s3 を最後まで進めて」「割り当てからリリースまでやって」.
argument-hint: "<Iteration|ticket ID...> [--no-assign] [--auto] [--gate-high|--gate-low|--gate-free]"
---

# End to end (all)

Advances an Iteration or tickets from assignment to release, in one flow. The current stage and the next step come from `dg flow next`, so this guide only describes how to do each step it returns.

## Deciding the target

- Iteration (`s3`): the tickets of that Iteration, and the candidates to put into it (todos not in an Iteration). Candidates are handled only in the assignment stage
- Ticket ID (one or more) or Plan ID (`p7`): advances that target. Audit and release run for a ticket's Iteration only when all the tickets of that Iteration are finished. If the ticket is not in an Iteration, audit and release do not run
- No target given: the same as the "Deciding the target" section of `dg guide release`
- `--no-assign`: skips the assignment stage. If the check suggests putting tickets into an Iteration, it does not apply the suggestion and leaves it in the final report
- `--auto`: goes ahead without asking where the Workflow's value is `ask_unless_auto`. See "Going ahead without asking with `--auto`" below. It can be combined with `--no-assign`
- `--gate-high`, `--gate-low`, `--gate-free`: the quality gate level for the target tickets. Pass it to `flow next` as `--gate <level>`. The work stage's `commands` then set the level on each ticket whose level differs, before its `next`, and `next` follows that level: high goes through the review and the fix loop, low and free go from the PR straight to `ready` (low still runs the checks, free does not). The conditions per level are in the "Quality gate" section of `dg guide review`. Raising the level is set without asking, with `--auto` too. Lowering it is fixed in Core to a human: the entry in `commands` is then a sentence asking a human to run `dg ticket update <id> --gate <level>`, so pass it on and wait, with `--auto` too. With no level given, each ticket keeps its own level (no level is high)

Below, the target Iteration is written as `<S>`. The flow starts without asking.

## Stages

The order of stages and the current stage are decided by `dg flow next`. Whether a stage asks for approval is decided by the board's Workflow (`dg --json --actor agent workflow show`), and `approval` of `flow next` gives the result for this call. The places are below, with the value that decides each one and its default. Each stage's steps also get approval there.

| Stage   | Where approval is asked                      | Value that decides it (default)                    |
| ------- | -------------------------------------------- | -------------------------------------------------- |
| Assign  | Rows to put in                               | `flow.assign` (`ask_unless_auto`)                  |
| Check   | Rows to fix                                  | `flow.check` (`ask_unless_auto`)                   |
| Check   | Deletion, abandoned, closing                 | Always asked (`governance`, `exceptions`, `flow`)  |
| Plan    | Plan                                         | `flow.plan` (`ask_unless_auto`)                    |
| Work    | Merge of each PR (`dg guide work`)           | `decide` of review → done (`ask_unless_auto`)      |
| Audit   | Table of findings                            | `flow.audit` (`always_ask`)                        |
| Release | Merge of the release PR, publishing, closing | `flow.release` (`human_only`)                      |

Closing a Plan whose tickets are all finished is part of the Work stage. It needs no approval, so the flow closes it and goes on (the steps are in "Closing a Plan" of `dg guide done`).

## Running the flow

1. Call `dg --json --actor agent flow next <target…>` when starting, and after finishing each stage (add `--auto` and `--no-assign` if given, and `--gate <level>` for `--gate-<level>`). In the result, `stage.name` is the current stage (`assign`, `check`, `plan`, `work`, `close`, `audit`, `release`, or `stop`; `close` is the Plan closing above); `commands` are the dg commands to call (in order; in the work stage, the first entry may instead be a WIP limit step, a sentence to read and follow before starting new tickets); `guide.text` is how to do the stage (the sections in `guide.sections` joined in order, including all the sections of the same topic that the step section points to, and for work the parallel steps after them); and `approval` is whether approval is needed and where
2. Do the stage's step. Run `commands` in order, and follow `guide.text` (to read it again, use `guide.command`; for work it is two `dg guide` calls joined by `&&`, so read both in order). Do not read the whole guide of the stage's topic again. Read a section of another topic only when `guide.text` points to it (the "…" section of `dg guide <topic>`)
   - `work` follows `dg guide work`. Its `guide.text` includes the parallel steps (`dg guide parallel`), which apply when `ready` of `plan show` has two or more tickets and subagents can be started. The parent only advances, asks for approval, and reads and writes `dg`
   - For `release`, if the repository's rules have no release steps, follow the "When there are no release steps" section of `guide.text`
   - The two release tickets that the release steps file carry the label `release-<S>`. `flow next` does not count them as remaining or plan them, so it keeps returning `release` while they remain. Advance them in the release stage, not in the Plan and Work stages
3. When `approval.required` is true, ask a human about `approval.what`. Include "Stop here" in the choices. `approval.value` is the Workflow's value that decided it, and `approval.agent` is what it means for you: with `approval`, run the judged command with `--approved-by human` only after the human approves (an entry of `commands` that carries `--approved-by human` is run only then); with `reject` (`human_only`), you cannot run it, so give the human the exact command to run. When `approval.required` is false, go ahead without asking. For how `--auto` changes it, see "Going ahead without asking with `--auto`" below
4. After a stage's step is finished (approval obtained, fixed, or done), copy that result's `resume` as it is into `--resume`, and return to 1 (`dg --json --actor agent flow next <target…> --resume <resume>`). Do not assemble the value. If you stop midway through an assign, check, or audit step (approval was not obtained, or you stopped at the table of findings), stop without copying that `resume`. To resume, pass the `resume` copied before, or call without `--resume` using the same target and arguments. Copying the `resume` of a step stopped midway makes the flow skip that stage as finished
5. When `stage.name` is `stop`, or `repeated` is not null (the same stage continues and the facts do not change), show `ask_human` and the state, and stop

## Between stages

- **No stopping between stages**: except where `approval.required` applies, do not ask, and call the next `flow next`
- **Merge follows `approval` of the work stage**: when `approval.auto_ok` is true (the flow was started with `--auto`, and the `decide` of the review → done boundary is `ask_unless_auto`, the default), a PR that passes the quality gate is merged without asking, as "Going ahead without asking with `--auto`" below says. When `approval.required` is true, ask a human whether to merge it, and merge it only when approved, by the "Merging after approval" section of `dg guide work` (`dg pr merge <id> --approved-by human`). When declined, do not merge, and leave the PR waiting. After a PR is put out, advance the next step while it waits for its merge. If there is no next step, ask about the merges that wait, and stop if none is approved
- **Handling failures**: a ticket whose implementation failed goes back to todo, as in `dg guide parallel`, and tickets that do not wait for it advance. A ticket whose review or fix returned failure, or did not return, is not put back to todo, and follows the "How to finish" section of `dg guide review`

## Going ahead without asking with `--auto`

`--auto` means one thing: where the Workflow's value is `ask_unless_auto`, go ahead without asking. It changes nothing anywhere else. dg enforces it: a command run with `--auto` passes only where the value that judges it is `ask_unless_auto`, records the agent as the approver, and is refused anywhere else (the "Operations that may be limited to humans" section of `dg guide overview`).

- What is written in `approval.auto` (`approval.auto_ok` is true): go ahead with the suggested option, and briefly show what was chosen and the material for the decision on the spot. Run the judged commands with `--auto`, as `commands` gives them (`iteration add … --auto`, `plan approve <p> --auto`). Do not pass `--approved-by` (no human approved it)
- Whatever remains in `approval.what` is asked about, with `--auto` too. A value of `always_ask` asks, and a value of `human_only` is left to a human
- A command that is refused because it asks for a human's approval, and whose error says to run it again with `--auto`, is run again with `--auto` (the value is `ask_unless_auto`): for example `ticket move <id> done --auto` for work that needs no PR, under the default review → done. When the error does not say so, ask a human

Merges and the approvals that `--auto` never skips are handled as follows.

- **A PR is merged without asking** only when `approval.auto_ok` of the work stage is true, and only a PR that meets the "Quality gate" section of `dg guide review` is merged, with `dg --json --actor agent pr merge <id> --auto`. Leave out `--method` and `--delete-branch`, so that config's `merge.method` and `merge.delete_branch` (current settings: `{{merge.method}}` and `{{merge.delete_branch}}`) decide the method and whether the branch is deleted. If the PR does not meet the gate, it is never merged without asking (`--auto` returns `GATE_FAILED`): show the conditions it did not meet and ask whether to merge it anyway, by the "Merging without meeting the gate" section of `dg guide review` (when approved, the agent merges with `--approved-by human`, which overrides every unmet condition except `pr`, `mergeable`, and `head`; a human is not asked to run `gh`)
- **Asked, and the flow stops, with `--auto` too**: everything whose value is not `ask_unless_auto` on this board (by default: the audit's table of findings; merging and publishing the release PR and closing the Iteration; deleting a ticket, abandoning it, or undoing done; closing or reopening an Epic; the team's settings and another user's assignee); what is fixed in Core (changing the Workflow with `dg workflow set`, lowering a quality gate level, merging a PR that does not meet the quality gate); and what has no value to decide it: changing a Plan's waits (`after`) and scope, operations with `--force`, decisions with no suggested option, and answers that cannot be a choice

## Reporting the result

At the end of the flow, report the result of each stage: the lines fixed in assign and check, the Plans approved, the PRs put out and merged, the tickets filed, the released version and the state of the Iteration, the assignment suggestions not applied, and the tickets left. With `--auto`, also report the decisions chosen automatically and the results of checking the conditions for PRs merged automatically.

{{choices}}

## Choosing the next step

When the flow stops, ask with the following choices, according to the reason it stopped. When the Iteration is closed and the flow has ended (the reason `flow next` gives for that), report the result and ask with the retrospective choice and "Stop here".

- **Merge** (when PRs that meet the quality gate wait for their merge): when chosen, merge them by the "Merging after approval" section of `dg guide work`, and continue the flow
- **Resume** (recommended when it stopped waiting for a merge): after the merge, read `dg guide all` again, and call `flow next` with the same target and arguments (such as `--auto`) to continue (if a Skill is available, `/dgall <S>`)
- **Look back on the Iteration** (only when the Iteration `<S>` was closed and the flow has ended; recommended then): look back on `<S>` by the steps of `dg guide retro`. The numbers of a closed Iteration are complete at this point, and the retrospective writes nothing without approval (if a Skill is available, `/dgretro <S>`)
- **Stop here**
