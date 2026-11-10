---
name: dgall
description: Advances a deguboard Iteration or tickets through assignment, check, plan, work, audit, and release (or clean-up), in one flow. Approval stays where each stage's steps put it, and the flow does not stop between stages. A flow that stopped midway can be resumed with the same arguments. --no-assign skips the assignment stage. --auto chooses reversible decisions that come with a suggested option. Use when asked「s3 を最後まで進めて」「割り当てからリリースまでやって」.
argument-hint: <Iteration|ticket ID...> [--no-assign] [--auto] [--gate-high|--gate-low|--gate-free]
---

<!-- dg skill sha256:892520b252d5053c7ab301fa4e08633b640554ec3c1070b420359edaab1ac4ac -->

# End to end (all)

Advances an Iteration or tickets stage by stage, from assignment through release (or cleanup).

Run `dg guide all` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. If an operation is refused (`TRANSITION_REJECTED`), ask a human to do it
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
