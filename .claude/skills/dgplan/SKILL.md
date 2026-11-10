---
name: dgplan
description: Decides the order in which to advance deguboard tickets, records it in a Plan, and gets human approval. Use when asked「t12 を進めて」「s3 を全部進めて」「次の 3 件を進めて」「計画だけ立てて」, or to approve a Plan that is awaiting approval. Also use when asked only for the order, such as「次にやるチケットは？」 (shows the order and stops). Advance an approved Plan with dgwork.
argument-hint: <ticket ID...|Iteration|Epic|next [N]> | <Plan ID>
---

<!-- dg skill sha256:6c2f8de21930ca6d5d6865f4131c3d03f43630bf017f37650e882e235db55869 -->

# Plan (plan)

Decides the order to advance tickets, records it as a Plan, and gets human approval.

Run `dg guide plan` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. A refused operation (`TRANSITION_REJECTED`) is for a human to handle
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
