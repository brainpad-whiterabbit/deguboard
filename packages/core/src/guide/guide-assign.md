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
- Create: `dg --json --actor agent iteration create "<name>" --goal "<goal>" --start 2026-11-01 --end 2026-11-14`
- Update: `dg --json --actor agent iteration update <s3> --goal "<goal>"`. `--name`, `--start`, and `--end` also change only what is specified. A closed Iteration can also be updated
- Add: `dg --json --actor agent iteration add <s3> <t12> <t13>`. A ticket that was in another Iteration moves
- Remove: `dg --json --actor agent iteration remove <s3> <t12>`
- Start: `dg --json --actor agent iteration start <s3>` (planned → active). Only one Iteration in a Project can be active. If another one is active, both starting and reopening are refused. Ask a human whether to close the previous one
- Close: `dg --json --actor agent iteration close <s3>`. Tickets carried over are removed from the Iteration. Close only on a human's instruction (limits: see `dg guide overview`)
- Reopen: `dg --json --actor agent iteration reopen <s3>`. Returns to active. Carried-over tickets do not return, so add them again with `iteration add`. Do this only on a human's instruction

## Epic

- List and progress: `dg --json --actor agent epic list` (`progress.done / progress.total`)
- Add: `dg --json --actor agent epic add <e3> <t12> <t13>`. Only tickets in the same Project. A closed Epic cannot take tickets
- Remove: `dg --json --actor agent epic remove <e3> <t12>`
- Close and reopen: `dg --json --actor agent epic close <e3>` / `epic reopen <e3>`. If anything other than done or abandoned remains, it is refused, and `--force` closes it anyway. Close only on a human's instruction (limits: see `dg guide overview`)

## Assignee

- Assign a human or their AI: `dg --json --actor agent ticket update <t12> --assignee human` (the user), `--assignee agent` (the user's AI), `--assignee <ID>` (another user, such as `bob` or `bob/agent`). Remove it with `--assignee none`
- An assignee is a planned mark, not exclusive. Starting work is decided by claim, and the claiming actor becomes the assignee
- If you file a ticket, follow the "Creator and assignee" section of `dg guide import` (`--created-by`)

## When proposing an assignment

1. Read the Iteration's goal and period and the tickets in it with `dg --json --actor agent iteration show <s3>`
2. Collect the unassigned todos (those without an `iteration`, from `dg --json --actor agent ticket list --status todo`). Make a proposal from the ones that fit the goal, looking at the order of dependencies
3. Show a table with one line for each, giving the reason for putting it in or not. Have a human select the rows to put in with multiple selection, then run `iteration add`
4. For items that should be handled soon (such as bugs), propose putting them into the active Iteration

{{choices}}

## Choosing the next step

After assigning, ask with these choices.

- **Check**: fix the mismatches in the assigned tickets' bodies and Epics by the steps of `dg guide check` (if a Skill is available, `/dgcheck s3`)
- **Make a plan** (recommended): arrange the assigned Iteration's tickets in the order of advancing by the steps of `dg guide plan` (if a Skill is available, `/dgplan s3`)
- **Stop here**
