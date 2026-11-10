---
description: Advances the tickets of an approved Plan, starting with the ones that can be started. Claims a ticket, implements it, checks its acceptance criteria, and takes it to a PR. Work that needs no PR goes to done. Use when asked「p3 を進めて」「計画を再開して」「t12 を進めて」. For several tickets with no Plan, make a plan with dgplan first.
argument-hint: "<Plan ID|ticket ID>"
---

# Work (work)

Advances one ticket to a draft PR. `dg next` decides the steps and their order. This guide describes only how to do each step.

## Deciding the target

- Plan ID (`p3`): following "Following the Plan" below, advance one ticket at a time, starting with one that can be started
- Ticket ID: advance that ticket. If it is in an open Plan (`plan` of `ticket show`), follow that Plan
- No target given: suggest an approved Plan from `plan list --status open`, and confirm. If there is none, suggest making a plan with `dg guide plan`

## Steps

1. Call `dg --json --actor agent next <id>`, and do one of the `kind` steps. Do the `commands` in order. If there is a `brief`, paste it to a subagent (you may add a location for temporary files after it). If `model` is not empty, start the subagent with that model (`null` means the parent's model). A research subagent with no mark uses `models.light` (the parent's model if it is empty). After finishing, call `next` again
2. The parent's step for each `kind`:
   - `implement`: do the claim in `commands`, and follow "Before and after claim". Claim creates the worktree of the work branch, and returns its location in `worktree` (the default is `{{worktree.root}}/<branch name>`). Pass the text, and when it returns, do "Receive the implementation result". If the parent implements it itself, remove `--no-run` from the claim and do "Implement" below (claim opens the implementation Run)
   - `review`: start the reviewer by the "Starting the review (parent)" section of `dg guide review` (the text includes the "Review" steps)
   - `fix`: follow the "Fix loop (parent)" section of `dg guide review`, and pass the text with `brief <id> --role fix` (the text includes the "Fix findings" steps and the findings of the review record)
   - `ready`: put the PR out by the "How to finish" section of `dg guide review`. For a Workflow that does not look at PRs (such as general, where `sync` does not move it to review), after the PR is put out, move it to review yourself with `dg --json --actor agent ticket move <id> review`
   - `wait_merge` and `wait_human`: tell a human `ask_human` and ask (`wait_human` is in the "How to finish" section of `dg guide review`). For review findings from a human, follow the "Fix loop (parent)" section of `dg guide review`. After the merge, `dg guide done`
   - `wait_deps`: wait. Choose another ticket from `next` of the Plan
   - `done`: clean up by the steps of `dg guide done`

## Before and after claim

- If the assignee (`assignee` of `ticket show`) is another user, avoid the ticket
- When `lint.require_iteration` is true (current setting: `{{lint.require_iteration}}`), claim puts a ticket with no `iteration` into an Iteration, starts the planned Iteration, creates the worktree of the work branch, and runs config's `worktree.setup` (the preparation commands) in it. For how the Iteration is chosen, see `ticket claim --help`. If `warnings` says there is no Iteration to put it in, that it could not be started, that the worktree could not be created, or that a preparation command stopped, ask a human for the Iteration (going on without one causes `lint_iteration_missing`). Make the worktree by hand at the place the warning shows (when `worktree` is null; the default is `{{worktree.root}}/<branch name>`), and run the preparation commands the warning shows by hand. Keep going with the work
- The preparation commands can take several minutes, and claim does not return until they finish (limit: 10 minutes). If that is longer than the caller's limit (such as the default 2 minutes of an agent's Bash), lengthen the time you give the claim. If it is cut off midway, the claim and the implementation Run remain, but no warning appears. Run config's `worktree.setup` by hand in the worktree
- On `CLAIM_LOST`, go to another ticket. On `BRANCH_IN_USE`, change the `--branch` name and claim again

## Implement (up to a draft PR)

The implementer works within the scope and approach of `plan` in `next`, and does the following.

1. Pass the checks of the repository (format, lint, tests)
2. Read again the sources of truth for the sections touched (requirements, README, code comments). In the same PR, fix the documents of promises, procedures, and conventions that this PR changed. Report stale documents from before that this PR did not change, without fixing them. If the PR changed a decision, also rewrite the body of that decision's ADR (if there is one) directly in the same PR (keep the number). Delete the details of an ADR that this PR made wrong. Requirements state only promises, so do not add details to them (the sources of details are help, code, and tests)
3. Make a PR with `gh pr create --draft`. In the body, write the ticket ID (`t12`), the acceptance criteria that could not be met and why, and the sources you read again and the places you fixed
4. Report only the acceptance criteria that you confirmed as met by the deliverable or tests (the parent attaches the marks)

## Receive the implementation result

When it returns, compare the result with `acceptance` of `ticket show`, and attach with `dg --json --actor agent ticket check <id> <numbers...>` only the items you confirmed (items that could not be attached get their reasons in the PR body and the report). Record the PR number with `dg --json --actor agent ticket update <id> --pr <number>`. Do not have the drift from before that was reported fixed. Keep it in the PR body, as material for the Iteration review (`dg guide audit`). If details of an ADR that this PR made wrong remain, have them fixed before recording. After recording, go back to `next`.

## Following the Plan

Follow the order and contents of the approved Plan (`dg guide plan`).

- Before starting, run `dg --json --actor agent plan show <p>`. If `pending_approval` is true, do not start. Ask a human for approval
- The next ticket is `next` of `plan show`: the earliest one in the Plan's order that can be started (`ready`). `waiting` is the party to wait for. `after` is not checked by claim, so keep it yourself (if you advance tickets at the same time, see `dg guide parallel`)
- The scope (`scope`) and approach (`approach`) appear in `plan` of `next`. Before you widen the scope or change the approach, confirm with a human
- When one ticket reaches a PR, read `plan show` again and choose the next one. When all tickets of the Plan are finished, do the "Plan を閉じる" section of `dg guide done`

## Work that needs no PR

Work that does not change repository files (data maintenance, checks, research) makes no branch and no PR. It goes to done without relying on reconcile. (`next` assumes a PR, so do not use it.)

1. `dg --json --actor agent ticket claim <id> --without-branch` (claim opens a Run). Treat `warnings` as in "Before and after claim"
2. Confirm the acceptance criteria one item at a time, and attach with `ticket check` only the items that are met
3. When all of them are attached, `dg --json --actor agent ticket move <id> done`. If items that cannot be attached remain, `ticket move <id> review`, and report the remaining items and reasons to a human (a human sets done)
4. If you need to change repository files midway, record it with `ticket update <id> --branch <type>/<content>`, and move to the flow above. When the branch is no longer needed, use `--branch none`

## Status

- Advance `status` yourself only from in_progress to review. done is set by reconcile (merge). Run `ticket move <id> done` only when reconcile does not advance it, or when a human has instructed it (for the limits, see `dg guide overview`)
- To stop implementing, run `dg --json --actor agent ticket unclaim <id>` (the ticket goes back to todo. For how Runs are handled, see `dg guide run`)
- If you find other work midway, do not mix it into this ticket. Propose filing it with `dg guide import`

{{choices}}

## Choosing the next step

After you open a PR (and also after finishing work that needs no PR), report the result and ask with the following choices.

- **Advance to the next ticket** (recommended, if the Plan still has tickets that can be started): read `plan show` again, and advance the next one by these steps
- **Mark it done**: if the PR was merged, clean up by the steps of `dg guide done` (if a Skill is available, `/dgdone <ID>`)
- **Stop here**: wait for the merge (after the merge, `dg guide done`)
