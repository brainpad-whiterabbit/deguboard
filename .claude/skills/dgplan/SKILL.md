---
name: dgplan
description: Decides the order in which to advance deguboard tickets, records it in a Plan, and gets human approval. Use when asked「t12 を進めて」「s3 を全部進めて」「次の 3 件を進めて」「計画だけ立てて」, or to approve a Plan that is awaiting approval. Also use when asked only for the order, such as「次にやるチケットは？」 (shows the order and stops). Advance an approved Plan with dgwork.
argument-hint: <ticket ID...|Iteration|Epic|next [N]> | <Plan ID>
---

<!-- dg skill sha256:f6f14368111f8328e5506f1619d5e2392692dbbfb1bf7077ba2311031b398980 -->

# Plan (plan)

Decides the order to advance tickets, records it as a Plan, and gets human approval.

Run `dg guide plan` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. If an operation is refused (`TRANSITION_REJECTED`), ask a human to do it
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
