---
name: dgrelease
description: Checks that every ticket of a deguboard Iteration is done, proceeds by the repository's release steps, and closes the Iteration with approval. Asks for approval before merging the release PR and publishing. Use when asked「s3 をリリースして」「リリースを進めて」.
argument-hint: "[Iteration]"
---

<!-- dg skill sha256:c91d2f24c4ff7628172fcad59b4f15f80cb6ac8326755fc71e2f6a31d0124ebe -->

# Release (release)

Checks that all tickets in an Iteration are done, follows the release steps, and closes the Iteration.

Run `dg guide release` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. If an operation is refused (`TRANSITION_REJECTED`), ask a human to do it
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
