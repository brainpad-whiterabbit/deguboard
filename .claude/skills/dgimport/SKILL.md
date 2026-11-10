---
name: dgimport
description: Breaks down the results of a conversation (design discussion, bug investigation, review findings, etc.) or a plan or design document into deguboard tickets, and files them in one batch after approval. Fixes or splits existing tickets when that is enough. Use when asked「起票して」「チケットにして」「チケットを直して」, or when proposing to turn settled requirements into tickets.
argument-hint: "[target (plan name, document path, or ticket ID)]"
---

<!-- dg skill sha256:784371e887ac1625585c9fd1ee33243b188fe2b26858a89079b8d25c4ebc3555 -->

# Filing (import)

Splits the discussed content, plan, or design into tickets and creates them after approval.

Run `dg guide import` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. A refused operation (`TRANSITION_REJECTED`) is for a human to handle
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
