---
description: Checks deguboard tickets, Epics, Iterations, and Plans. Shows the findings from dg sync, validate, and lint with fix proposals in a table, and fixes them only after approval. Use when asked「チケットを点検して」「整合性を確認して」「Iteration を見直して」, or before making a plan.
argument-hint: "[Iteration|Epic|ticket ID...]"
---

# Check (check)

Finds mismatches among tickets, Epics, Iterations, and Plans, and fixes them after approval. What counts as a mismatch is decided by `dg validate` and `dg lint` (for what `lint` flags, see `dg lint --help`). These steps do not decide the criteria. They read the findings and decide how to fix them.

## Deciding the target

- Iteration (`s3`) and Epic (`e3`): targets the tickets in it, and the findings on that Iteration or Epic itself
- Ticket ID: targets the findings on that ticket
- No target given: targets the whole Project (`--project {{default_project}}`)

## Check steps

1. **Collect findings**: run `dg --json --actor agent sync`, `dg --json --actor agent validate`, and `dg --json --actor agent lint` in order. Narrow the `sync` `warnings`, and the `validate` and `lint` `issues` (`code`, `id`, `message`) to the target
2. **Make fix proposals**: for each finding, read the content with `ticket show`, `epic show`, or `plan show` and decide how to fix it. Examples:
   - A section of the body is missing, or the acceptance criteria are empty: make a draft of acceptance criteria from the body (`ticket update --acceptance`). For the summary, pass the whole body with a `## Summary` section added to the current body via `--body` (`--body` replaces the body)
   - An unfinished ticket remains in a closed Epic: propose one of moving it to another Epic, removing it from the Epic, or making it abandoned
   - All tickets are finished, but the Epic or Plan is still open: propose closing it (`epic close` / `plan close`)
   - Not in an Iteration (`lint_iteration_missing`, when `lint.require_iteration` is true. Current setting: `{{lint.require_iteration}}`): choose an Iteration by the same rule as claim (see `ticket claim --help`) and propose adding it with `iteration add <S> <id>`. If there is no place to add it (a closed Iteration cannot take it, as with done tickets), ask a human whether to create an Iteration or change the setting
   - The open Plan's `after` and `depends_on` form a cycle (`lint_plan_wait_cycle`): propose one of removing the edge with `ticket update --depends-on`, closing the Plan and recreating it with a different `after`, or making the waiting ticket abandoned. Ask a human whether to close the Plan or make the ticket abandoned
   - Two or more active Iterations in the same Project (`lint_iteration_multiple_active`): ask a human which one to close (closing is done only on a human's instruction)
   - PR is made but there is no implementation Run (`lint_run_implement_missing`): this is a gap in Run recording, so do not fix the ticket. Report it to a human. There is no way to create the Run afterward. The target is unfinished tickets, and done tickets in an Iteration that is not closed
   - A commit after a closed implementation Run is not in any Run's period (`lint_commit_outside_run`), or a commit after review has no fix Run (`lint_run_fix_missing`): do not rewrite the Run record. As the message says, check the content of the commit and tell a human. `lint_run_fix_missing` may be ignored if that commit is not a fix. If one commit raises both `lint_commit_outside_run` and `lint_run_fix_missing`, follow the remedy for `lint_run_fix_missing`
   - `sync` warnings (cannot reconcile, or done with unchecked acceptance criteria left): propose confirming with the steps of `dg guide done`
3. **Show a table and get approval**: show the following table and ask with multiple selection (`#`) which rows to reflect (include "Do not reflect"). If a row's fix is not one choice, list the proposals and accept input outside the choices

   | #   | Target | Finding (code) | Fix proposal | Command |
   | --- | ------ | -------------- | ------------ | ------- |

4. **Fix**: run only the approved rows, in table order. Deletion, abandoned, and closing or reopening an Epic or Iteration are confirmed once more one at a time, even if the row was approved
5. **Confirm and report**: run `lint` and `validate` again, and report what was fixed, the findings left (with reasons), and any new findings

Collecting findings and making the table proceeds without waiting for approval (nothing is written). The `sync` writes only reconcile, so do not wait for them.

{{choices}}

## Choosing the next step

After reporting the result (including when there were no findings), ask with these choices.

- **Make a plan** (recommended): plan the target's todos by the steps of `dg guide plan` (if a Skill is available, `/dgplan <target>`)
- **Assign**: if there are todos not in an Iteration, assign them by the steps of `dg guide assign` (if a Skill is available, `/dgassign`)
- **Stop here**
