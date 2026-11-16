---
description: Assigns deguboard tickets to Iterations (sprints) and Epics. When an Iteration is given, decides whether to put each unassigned todo into it. When none is given, proposes an Iteration or Epic that fits (creating one if needed). Puts items that should be handled soon into the active Iteration. Use when asked「スプリントに入れて」「Epic にまとめて」「割り振って」.
argument-hint: "[Iteration|Epic|ticket ID...]"
---

# Assignment (assign)

Puts tickets into Iterations (a period of planning. `sprint` is an alias) and Epics (grouping by purpose).

## Deciding the target

- Iteration (`s3`): decides one by one whether to put each unassigned todo into that Iteration
- Epic (`e3`): makes a proposal of tickets that have no Epic and fit its purpose
- Ticket ID: proposes an Iteration and Epic that fit that ticket (if none fit, propose creating one)
- No target given: suggests the active Iteration (or a planned one if there is none) and confirms it, then targets unassigned todos

## Iteration

- List: `dg --json --actor agent iteration list` (`status` is planned / active / closed)
- Create: `dg --json --actor agent iteration create "<name>" --goal "<goal>"`. An Iteration has no planned dates; the period is recorded from when it starts (`started_at`) to when it closes (`closed_at`)
- Update: `dg --json --actor agent iteration update <s3> --goal "<goal>"`. `--name` also changes only what is specified. A closed Iteration can also be updated
- Add: `dg --json --actor agent iteration add <s3> <t12> <t13> --approved-by human`, after a human selected or instructed the tickets. A ticket that was in another Iteration moves
- Remove: `dg --json --actor agent iteration remove <s3> <t12> --approved-by human`
- The Workflow's `flow.assign` judges putting tickets into and out of an Iteration or Epic (`iteration add` and `remove`, `epic add` and `remove`, and `ticket update --iteration` and `--epic`; `ask_unless_auto` by default; the values are in the "Operations that may be limited to humans" section of `dg guide overview`). With the default, pass `--approved-by human` only after a human approved or instructed it; in a flow that a human started with `--auto`, pass `--auto` instead and do not ask. When the board's value is `anyone`, pass neither; when it is `human_only`, give the human the exact command to run
- Start: `dg --json --actor agent iteration start <s3>` (planned → active). Only one Iteration can be active. If another one is active, both starting and reopening are refused. Ask a human whether to close the previous one
- Close: `iteration close <s3>`. Tickets carried over are removed from the Iteration
- Reopen: `iteration reopen <s3>`. Returns to active. Carried-over tickets do not return, so add them again with `iteration add`
- The Workflow's `flow.release` judges closing and reopening an Iteration: with the default (`human_only`) the agent's call is refused, so give the human the exact command to run (`dg iteration close <s3>` or `dg iteration reopen <s3>`); when the board's value asks for approval, run it only on a human's instruction, with `dg --json --actor agent iteration close <s3> --approved-by human` (see the "Operations that may be limited to humans" section of `dg guide overview`)

## Epic

- List and progress: `dg --json --actor agent epic list` (`progress.done / progress.total`)
- Add: `dg --json --actor agent epic add <e3> <t12> <t13> --approved-by human`. A closed Epic cannot take tickets. `flow.assign` judges it, as for an Iteration above
- Remove: `dg --json --actor agent epic remove <e3> <t12> --approved-by human`
- Close and reopen: `dg --json --actor agent epic close <e3>` / `epic reopen <e3>`. If anything other than done or abandoned remains, it is refused, and `--force` closes it anyway. The Workflow's `governance.epic` judges both: with the default (`human_only`) the agent's call is refused, so give the human the exact command to run; when the board's value asks for approval, run it only on a human's instruction, with `--approved-by human` (see the "Operations that may be limited to humans" section of `dg guide overview`)

## Assignee

- Assign a human or their AI: `dg --json --actor agent ticket update <t12> --assignee human` (the user), `--assignee agent` (the user's AI), `--assignee <ID>` (another user, such as `bob` or `bob/agent`). Remove it with `--assignee none`
- An assignee is a planned mark, not exclusive. Starting work is decided by claim, and the claiming actor becomes the assignee
- If you file a ticket, follow the "Creator and assignee" section of `dg guide import` (`--created-by`)

## When proposing an assignment

1. Read the Iteration's goal and the tickets in it with `dg --json --actor agent iteration show <s3>`
2. Collect the unassigned todos (those without an `iteration`, from `dg --json --actor agent ticket list --status todo`). Make a proposal from the ones that fit the goal, looking at the order of dependencies
3. Show a table with one line for each, giving the reason for putting it in or not. Have a human select the rows to put in with multiple selection, then run `iteration add` with `--approved-by human` (the selection is the approval). In a flow started with `--auto` where `approval.auto_ok` of `dg flow next` is true, do not ask: put in the rows you propose with `iteration add … --auto`, and show them
4. For items that should be handled soon (such as bugs), propose putting them into the active Iteration
5. In a flow (the assign stage of `dg flow next`): the candidates to decide are `stage.tickets` (only the ones that no earlier assignment has seen). When the flow's tickets are in no Iteration (`target.iteration` is null), decide the one Iteration for them (propose one that fits from `iteration list`, or creating one), because the flow goes on only when they are in one Iteration. After the selected rows are put in (also when the human selected none), pass the checkpoint with the command in `checkpoint` of `dg flow next` (`dg --json --actor agent checkpoint assign <target>`, with `--approved-by human` after the human's selection, or `--auto` where the rows were put in without asking). It records the candidates left out, so that the flow does not ask about them again; candidates that appear later are asked about

{{choices}}

## Choosing the next step

After assigning, ask with these choices.

- **Check**: fix the mismatches in the assigned tickets' bodies and Epics by the steps of `dg guide check` (if a Skill is available, `/dgcheck s3`)
- **Make a plan** (recommended): arrange the assigned Iteration's tickets in the order of advancing by the steps of `dg guide plan` (if a Skill is available, `/dgplan s3`)
- **Stop here**
