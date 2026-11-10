---
name: dgdiscuss
description: Discusses deguboard tickets, an Epic, or an Iteration with a human, settles the open points with choices, and reflects the conclusion after the human approves before → after. Changes no files or data while discussing. Use when asked「t12 を検討して」「e3 の中身を相談したい」「s3 の目標を一緒に決めて」.
argument-hint: <ID...>
---

<!-- dg skill sha256:891399fd8614246868748bda2f43857a95aac4252bb7f8371b65bd84b6725dfa -->

# Discussion (discuss)

Settles the open points of tickets, an Epic, or an Iteration with a human through choices, and reflects the result after approval of before → after.

Run `dg guide discuss` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. If an operation is refused (`TRANSITION_REJECTED`), ask a human to do it
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
