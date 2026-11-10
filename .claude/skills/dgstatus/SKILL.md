---
name: dgstatus
description: Tells how the work on an in-progress ticket is going (where it is now, why it has stopped if it has, and the next step), from the ticket, dg next, the Runs, the worktree's commits, and the PR. Changes no data. Use when asked「t12 の様子を教えて」「t12 はどこまで進んだ？」「止まっている理由を聞きたい」.
argument-hint: <ID...>
---

<!-- dg skill sha256:430d9851b8c8525281699614d114d7c900392f0438c700cd74e8ba16c9c5c61f -->

# Status (status)

Tells where an in-progress ticket is, why it has stopped, and the next step, without changing any data.

Run `dg guide status` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. If an operation is refused (`TRANSITION_REJECTED`), ask a human to do it
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
