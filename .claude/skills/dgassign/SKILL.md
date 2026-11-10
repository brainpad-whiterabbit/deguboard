---
name: dgassign
description: Assigns deguboard tickets to Iterations (sprints) and Epics. When an Iteration is given, decides whether to put each unassigned todo into it. When none is given, proposes an Iteration or Epic that fits (creating one if needed). Puts items that should be handled soon into the active Iteration. Use when asked「スプリントに入れて」「Epic にまとめて」「割り振って」.
argument-hint: "[Iteration|Epic|ticket ID...]"
---

<!-- dg skill sha256:cae71952692f1ef00f1fe7287531bce6de5096b6923dda411fe93fd3a164c664 -->

# Assignment (assign)

Assigns tickets to an Iteration (sprint) and an Epic.

Run `dg guide assign` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. A refused operation (`TRANSITION_REJECTED`) is for a human to handle
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
