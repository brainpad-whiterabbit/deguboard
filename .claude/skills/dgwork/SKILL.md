---
name: dgwork
description: Advances the tickets of an approved Plan, starting with the ones that can be started. Claims a ticket, implements it, checks its acceptance criteria, and takes it to a PR. Work that needs no PR goes to done. Use when asked「p3 を進めて」「計画を再開して」「t12 を進めて」. For several tickets with no Plan, make a plan with dgplan first.
argument-hint: <Plan ID|ticket ID>
---

<!-- dg skill sha256:eba8fa94de45fdfe2626ddf59e573b44f733957acbcd2e1c26c1da3993cb5b19 -->

# Work (work)

Implements the approved Plan or tickets, starting with the ones ready to start, up to a PR.

Run `dg guide work` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. If an operation is refused (`TRANSITION_REJECTED`), ask a human to do it
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
