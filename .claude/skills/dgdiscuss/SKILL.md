---
name: dgdiscuss
description: Discusses deguboard tickets, an Epic, or an Iteration with a human, settles the open points with choices, and reflects the conclusion after the human approves before → after. With --deep, checks every viewpoint (need, purpose, approach, scope, order, premises, reversibility, visibility) and digs into the ones with open points. Changes no files or data while discussing. Use when asked「t12 を検討して」「e3 の中身を相談したい」「s3 の目標を一緒に決めて」「t12 を深く検討して」.
argument-hint: <ID...> [--deep]
---

<!-- dg skill sha256:62d9918f4267a8b56e1078f61e4d46d932a15baf980d6334929cec1370dde6a3 -->

# Discussion (discuss)

Settles the open points of tickets, an Epic, or an Iteration with a human through choices, and reflects the result after approval of before → after.

Run `dg guide discuss` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. If an operation is refused (`TRANSITION_REJECTED`), ask a human to do it
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
