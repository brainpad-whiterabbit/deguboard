---
name: dgcheck
description: Checks deguboard tickets, Epics, Iterations, and Plans. Shows the findings from dg sync, validate, and lint with fix proposals in a table, and fixes them only after approval. Use when asked「チケットを点検して」「整合性を確認して」「Iteration を見直して」, or before making a plan.
argument-hint: "[Iteration|Epic|ticket ID...]"
---

<!-- dg skill sha256:ce824c9849690172f67a768406a5ccfc821e8f859eb5debbe34bfd1e16a0dd78 -->

# Check (check)

Checks tickets, Epics, Iterations, and Plans, then fixes them after showing the proposed changes and getting approval.

Run `dg guide check` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. If an operation is refused (`TRANSITION_REJECTED`), ask a human to do it
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
