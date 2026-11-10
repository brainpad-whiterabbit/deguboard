---
name: dgwork
description: Advances the tickets of an approved Plan, starting with the ones that can be started. Claims a ticket, implements it, checks its acceptance criteria, and takes it to a PR. Work that needs no PR goes to done. Use when asked「p3 を進めて」「計画を再開して」「t12 を進めて」. For several tickets with no Plan, make a plan with dgplan first.
argument-hint: <Plan ID|ticket ID>
---

<!-- dg skill sha256:534af9105747447191df01864ad529485371065446ccf414a51a499d017bd261 -->

# Work (work)

Implements the approved Plan or tickets, starting with the ones ready to start, up to a PR.

Run `dg guide work` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. A refused operation (`TRANSITION_REJECTED`) is for a human to handle
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- If `dg` is not on PATH, replace `dg` with the command the repository's guide tells you to use (`npx deguboard`, `mise run dg --`, etc.). The same applies to `dg` in the steps.

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
