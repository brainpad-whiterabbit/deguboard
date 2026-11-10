---
description: Discusses deguboard tickets, an Epic, or an Iteration with a human, settles the open points with choices, and reflects the conclusion after the human approves before → after. Changes no files or data while discussing. Use when asked「t12 を検討して」「e3 の中身を相談したい」「s3 の目標を一緒に決めて」.
argument-hint: "<ID...>"
---

# Discussion (discuss)

Discusses the targets with a human until the open points are settled, then reflects the conclusion. This guide covers the discussion and the approval. The steps of writing follow the existing guides: `dg guide import` for tickets, and `dg guide change` for an Epic or Iteration.

## Deciding the target

- The IDs after the Skill call (`/dgdiscuss t12`) are the targets: tickets in todo, in_progress, or review (several allowed), or an open Epic or Iteration. The instruction that follows, if any, says what to discuss
- A done or abandoned ticket, or a closed Epic, Iteration, or Plan, is not discussed here. Show its state, point to the ask that fits (for example, filing follow-ups by `dg guide import`, or reopening by `dg guide change`), and stop
- No target given: ask which target to discuss

## While discussing

- Change no files and no data until the human approves the reflection in step 4. Only read: `dg --json --actor agent ticket show <t12>` (`epic show <e3>`, `iteration show <s3>`), and the code and documents the target refers to. Do not write with `dg`, edit files, or make branches or commits
- List the open points (what is unclear, what conflicts, which options exist) with the material for each, and settle them with choices by "Asking with choices" below. Put the recommended option first with its reason
- An answer that cannot be a choice (such as the wording of an acceptance criterion) is taken as free input

## What is reflected

Only the title, body (summary), acceptance criteria, priority, dependencies, and gate level are reflected (for an Iteration: the name and goal; for an Epic: the title and summary). Lowering the gate level needs the human's explicit instruction.

When the conclusion is a change of Status, of membership (Iteration or Epic), closing, or abandoning, do not do it here. Show the ask that fits and stop:

- Status (starting, reviewing, done): `dg guide work` or `dg guide done` (if a Skill is available, `/dgwork <t12>` or `/dgdone <t12>`)
- Membership: `dg guide assign` (`/dgassign <t12>`)
- Closing, reopening, abandoning, or undoing done: `dg guide change` (`/dgchange <ID>`)

## Steps

1. **Read the targets**: `dg --json --actor agent ticket show <t12>` (or `epic show`, `iteration show`). Keep the current values as "before"
2. **Discuss**: settle the open points by "While discussing" above. If the conclusion falls outside "What is reflected", show the ask that fits and stop
3. **Running Run**: for an in_progress ticket, check `dg --json --actor agent run list --running --ticket <t12>`. If a Run is running, tell the human before reflecting (the working agent reads the ticket it started with), and ask whether to reflect now or after the Run ends
4. **Approval**: show before → after for each target and field, and ask with the choices "Reflect" (recommended), "Revise", and "Cancel". Do not reflect without approval
5. **Reflect**: tickets by the steps of `dg guide import` (fixing an existing ticket with `ticket update`; splitting by filing new tickets), and an Epic or Iteration by the edit of `dg guide change`. The approval in step 4 is the human's instruction, so do not ask again for the same content
6. **Report**: the targets, before → after, and the `warnings` of the result

{{choices}}

## Choosing the next step

When the reflected tickets have a next step in the flow, ask with these choices after reporting. If they have none (or an Epic or Iteration was the target), finish with the report.

- **Make a plan**: for todo tickets whose content is settled, decide the order by the steps of `dg guide plan` (if a Skill is available, `/dgplan <ID...>`)
- **Assign**: for tickets not in an Iteration, assign them by the steps of `dg guide assign` (if a Skill is available, `/dgassign <ID...>`)
- **Stop here**
