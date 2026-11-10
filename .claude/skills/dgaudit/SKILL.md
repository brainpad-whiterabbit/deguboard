---
name: dgaudit
description: Once every ticket of a deguboard Iteration (or Epic) is done, and before release, reviews the whole repository by viewpoint with subagents (documents and implementation, tests, architecture, README, dependencies, config files). Shows the findings in a table and, after approval, files them as tickets. The review does not change files. Use when asked「リリースの前に見直して」「リポジトリ全体を見直して」.
argument-hint: "[Iteration|Epic]"
---

<!-- dg skill sha256:fb1226c4b6c664f3bb511f857599af3dfca8c8f691355fd2f6324206df45a25b -->

# Audit (audit)

After an Iteration or Epic is done, reviews the whole repository by aspect and turns the findings approved by a human into tickets.

Run `dg guide audit` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. If an operation is refused (`TRANSITION_REJECTED`), ask a human to do it
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
