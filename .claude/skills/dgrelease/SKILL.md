---
name: dgrelease
description: Checks that every ticket of a deguboard Iteration is done, proceeds by the repository's release steps, and closes the Iteration with approval. Asks for approval before merging the release PR and publishing. Use when asked「s3 をリリースして」「リリースを進めて」.
argument-hint: "[Iteration]"
---

<!-- dg skill sha256:0b94d4918646fa80406ab0304984449ad77b49289dc620dc69d72cd98576841c -->

# Release (release)

Checks that all tickets in an Iteration are done, follows the release steps, and closes the Iteration.

Run `dg guide release` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. A refused operation (`TRANSITION_REJECTED`) is for a human to handle
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
