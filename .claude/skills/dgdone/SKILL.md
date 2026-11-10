---
name: dgdone
description: Checks merged tickets against their PRs to confirm they are done, confirms the remaining acceptance criteria, cleans up the work branch and worktree, and closes a finished Plan. Use when asked「t12 を完了にして」「マージしたので片付けて」「Plan を閉じて」.
argument-hint: "[ticket ID...|Plan ID|Iteration]"
---

<!-- dg skill sha256:5c9a713cfe91487a636b1046689c110d712a7bb1ea4196f30d173f367d564f8c -->

# Done (done)

Reconciles merged tickets to done, checks the remaining acceptance criteria, and cleans up.

Run `dg guide done` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. If an operation is refused (`TRANSITION_REJECTED`), ask a human to do it
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
