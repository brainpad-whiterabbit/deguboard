---
description: Carries out a change that a human asked for on deguboard targets, with one dg call per target (editing a ticket, Iteration, or Epic, closing or reopening an Iteration or Epic, making a ticket abandoned, or undoing done). Checks the preconditions first and asks only when one of them is hit. Use when asked「t12 を直して」「s3 を閉じて」「e2 を再開して」「t12 をやめて」「t12 の done を取り消して」.
argument-hint: "<ID...> (followed by one line of what to change)"
---

# Change (change)

Carries out one change that a human asked for: edit, close, reopen, abandon, or undo done. The change is the human's instruction, so the agent does not decide on its own whether to make it. It checks the preconditions, writes with one `dg` call per target, and reports before → after. Creating, splitting, assigning, and fixing tickets from a conversation are not here (`dg guide import`, `dg guide assign`).

## Deciding the target

- The IDs after the Skill call (`/dgchange t12`) are the targets, and the next line says what to change (for example "t12 を直して", "s3 を閉じて", "t12 の done を取り消して"). The instruction that follows gives the content (the new text, the reason, the Status to return to)
- If the change is not stated, or the target does not fit the change (for example, closing a ticket), do not guess. Show the target's state and ask what to change
- No target given: ask which target and which change

## Operations

| Change    | Target                    | Command                                                                                                                                     |
| --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| edit      | Ticket                    | `dg --json --actor agent ticket update <t12> --title … --body … --acceptance … --priority … --label … --depends-on …` (only what changes)    |
| edit      | Iteration                 | `dg --json --actor agent iteration update <s3> --name … --goal … --start … --end …` (only what changes)                                     |
| edit      | Epic                      | `dg --json --actor agent epic update <e3> --title … --body …` (only what changes)                                                           |
| close     | Iteration / Epic          | `dg --json --actor agent iteration close <s3>` / `epic close <e3>`                                                                          |
| reopen    | Iteration / Epic          | `dg --json --actor agent iteration reopen <s3>` / `epic reopen <e3>`                                                                        |
| abandon   | Ticket                    | `dg --json --actor agent ticket move <t12> abandoned`, after writing the reason in the body                                                 |
| undo done | Ticket (done)             | `dg --json --actor agent ticket move <t12> <todo/in_progress/review>`, after writing the reason in the body                                 |

Editing a ticket covers the title, summary, acceptance criteria, priority, labels, and dependencies. `--label` and `--depends-on` replace the whole list, so pass the existing values too. `--acceptance` replaces only the acceptance criteria section and keeps the marks of items with the same text. Iteration, Epic, gate level, assignee, and Workflow are not changed here (assignment is `dg guide assign`; lowering the gate level needs its own instruction).

## Steps

1. **Read the target**: `dg --json --actor agent ticket show <t12>` (or `iteration show <s3>`, `epic show <e3>`). Keep the current values of what will change as "before"
2. **Check the preconditions** of the change:
   - **close**: if any ticket in the Iteration or Epic is not done or abandoned, say so with the list (ID, title, state). An Iteration carries those tickets over (they are removed from it); an Epic refuses to close and closes only with `--force`. If the Iteration is active and every ticket is done or abandoned, and the repository has release steps (CLAUDE.md, README, development docs), ask with "Proceed with release" (`dg guide release`; if a Skill is available, `/dgrelease <s3>`) and "Close without releasing"
   - **reopen**: for an Iteration, if another Iteration in the same Project is active, say so (reopening is refused while one is active), and ask whether to close that one first. Carried-over tickets do not come back, so say that `iteration add` puts them in again
   - **abandon**: the reason must be in the instruction. If it is not, ask for it
   - **undo done**: the Status to return to (todo, in_progress, or review) and the reason must be in the instruction. If either is missing, ask for it
   - **edit**: work out before → after for each field. If the instruction does not settle the new value (for example "make it shorter" with several possible wordings), propose the new value
3. **Approval**: when a precondition above is hit, or the new value is your proposal, show before → after (and the material, such as the list of unfinished tickets) and ask with choices. When nothing is hit and the instruction settles the content, the request is already the human's instruction, so do not ask again
4. **Write once**: call `dg` once per target with the command in the table above, except abandon and undo done, which first write the reason with `ticket update --body` and then call `ticket move`. Do not split the change itself into several calls, and do not write anything the change did not ask for
5. **When refused**: if `dg` returns `TRANSITION_REJECTED` (the operation is in `actor.human_only`, or the Workflow's `by` limits the transition to humans), do not retry in another way. Give the human the exact command to run (without `--actor agent`), with the reason from `error.message`
6. **Report**: the target, before → after, and the `warnings` of the result (for example, tickets carried over by closing)

{{choices}}

## Choosing the next step

After reporting, ask with the following choices only when there is a next step in the flow; otherwise finish with the report.

- **Release**: if you closed an Iteration without releasing and release steps exist, release by the steps of `dg guide release` (if a Skill is available, `/dgrelease <s3>`)
- **Assign**: if closing carried tickets over, assign them by the steps of `dg guide assign` (if a Skill is available, `/dgassign <s3>`)
- **Stop here**
