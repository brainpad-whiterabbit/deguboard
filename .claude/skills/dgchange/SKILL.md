---
name: dgchange
description: Carries out a change that a human asked for on deguboard targets, with one dg call per target (editing a ticket, Iteration, or Epic, closing or reopening an Iteration or Epic, making a ticket abandoned, or undoing done). Checks the preconditions first and asks only when one of them is hit. Use when asked「t12 を直して」「s3 を閉じて」「e2 を再開して」「t12 をやめて」「t12 の done を取り消して」.
argument-hint: <ID...> (followed by one line of what to change)
---

<!-- dg skill sha256:f91db4220268cf4af5f7ba333623a777fa62013d5d8da1feaaf96753f8e2c61a -->

# Change (change)

Carries out the edit, close, reopen, abandon, or undo done that a human asked for, with one dg call after checking the preconditions.

Run `dg guide change` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. If an operation is refused (`TRANSITION_REJECTED`), ask a human to do it
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
