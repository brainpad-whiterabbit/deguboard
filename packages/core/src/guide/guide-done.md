---
description: Checks merged tickets against their PRs to confirm they are done (dg deletes the work branch and worktree that remain), confirms the remaining acceptance criteria, and closes a finished Plan. Use when asked「t12 を完了にして」「マージしたので片付けて」「Plan を閉じて」.
argument-hint: "[ticket ID...|Plan ID|Iteration]"
---

# Done (done)

Cleanup after a PR is merged. Work that needs no PR advances to done within `dg guide work`, so do not read this guide for it. Done is set by reconciling or by a human; the agent confirms and records. The marks on acceptance criteria are normally set in the `dg guide work` stage.

## Deciding the target

- Ticket ID: cleans up that ticket
- Plan ID (`p3`): cleans up the tickets of that Plan whose PRs are merged
- Iteration (`s3`): reconciles the review and in_progress tickets of that Iteration, and cleans them up
- No target given: shows the tickets that `sync` moved to done (`reconciled`) and the review tickets assigned to you as candidates, and asks a human which ones to clean up. Do not start on them before the answer

## Steps

1. Run `dg --json --actor agent sync`. Reconciling the merge of the PR (or the work branch entering `{{git.base_branch}}`) moves the ticket to done. `reconciled` shows `{ id, from, to, when }` (`when` is the fact that became the basis; `removed` is in step 4)
2. Confirm that `status` of `dg --json --actor agent ticket show <id>` became done. If it did not, read the `warnings` of `sync`. Either the facts are lacking (`gh` is not present, the branch is not pushed yet), or the Workflow does not include reconcile in that transition's `by`. In the latter case, confirm with a human, then advance with `ticket move <id> done`
   - If the PR is not merged yet (`wait_merge` of `dg --json --actor agent next <id>`), do not merge it on your own. Ask a human whether to merge it, and only when approved, run `dg --json --actor agent pr merge <id> --approved-by human` (it records who approved on the PR), then run `sync` again. When declined, do not merge, and leave the ticket waiting (the steps are in the "Merging after approval" section of `dg guide work`)
   - If the `warnings` say that a PR found by branch name was not used for reconciling, follow its guidance
   - If you try to record a branch afterward for work merged without recording it, `BRANCH_IN_USE` may refuse it (when the tip of the remaining branch is a true ancestor of base; merges by ff or merge commit). Do not record it. Confirm the merge with a human, then advance with `ticket move <id> done`. A squash merge can be recorded, and afterwards the warning in the item above applies
3. Check the remaining acceptance criteria. Using the `warnings` of `sync` (the warning "acceptance criteria items 2, 3 were left unchecked when the ticket became done", as printed) and the unchecked items in `acceptance` of `ticket show --json`, attach with `dg --json --actor agent ticket check <id> <numbers...>` only the items you confirmed as met by the merged deliverable (dg never attaches them on its own). Items you cannot confirm stay unchecked, and you tell a human
4. Do not delete the work branch or worktree yourself. When `merge.delete_branch` (current setting: `{{merge.delete_branch}}`) is true, `dg pr merge` deletes them, and `sync` deletes what remains when it moves a ticket to done (`removed` in each `reconciled` entry shows what was deleted). If the `warnings` of `sync` say that a worktree or branch was not deleted, tell a human the reason and the commands in the warning as printed, and do not run them. When the setting is false, they are kept
5. If you followed a Plan, read `progress` of `dg --json --actor agent plan show <p>`. If all its tickets are done or abandoned, see the "Closing a Plan" section below
6. Report to a human: what became done, the acceptance criteria left, the worktrees and branches that were not deleted (step 4), and what can be started next (`ready` of `plan show` if there is a Plan; otherwise `dg --json --actor agent ticket list --ready`)

## Closing a Plan

- When all tickets of a Plan are finished (done or abandoned), close it with `dg --json --actor agent plan close <p>`. No approval is needed, and the flow in `dg guide all` closes it the same way. Progress is not written to the Plan, so this is the only time to close it
- When rebuilding a plan without finishing it (the order or scope changed, or tickets were added or removed), also close it with `plan close <p>`, make it again by the steps of `dg guide plan`, and get human approval again. If tickets remain, `warnings` shows them, but it still closes. Until it is closed, the remaining tickets cannot go into a new Plan

## When not finished

- To stop the work, run `dg --json --actor agent ticket unclaim <id>` (only for in_progress; the ticket goes back to todo). An implementation or fix Run left open is closed as `failure` by unclaim. Do not unclaim a fix or review Run; follow the "How to finish" section of `dg guide review`. To give up the ticket itself (abandoned), confirm with a human first, then `ticket move <id> abandoned`
- If the requirements changed so that it should be a different ticket, propose filing a new one by the steps of `dg guide import`, and confirm with a human what to do with the original ticket

## Iteration and Epic

- Closing or reopening an Iteration and Epic is done only on a human's instruction (`dg guide assign`). If one looks closable (the rest are all done or abandoned), tell a human
- Epic progress is found each time from `progress` of `dg --json --actor agent epic show <e3>`. It is not saved

{{choices}}

## Choosing the next step

After cleaning up, report the result and ask with the following choices.

- **Advance the Plan** (recommended if the Plan has tickets left): advance it by the steps of `dg guide work` (if a Skill is available, `/dgwork p3`)
- **Make a plan**: if the Plan is finished and there are tickets that can be started (`ticket list --ready`), make the next Plan by the steps of `dg guide plan` (if a Skill is available, `/dgplan next <N>`)
- **Stop here**
