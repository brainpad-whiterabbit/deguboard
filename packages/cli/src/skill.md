# {{title}}

{{summary}}

Run `dg guide {{topic}}` first, and advance the target below by the steps it prints. This Skill holds no steps. The source of the steps is bundled with dg and matches its version.

- Always call `dg` with `--json --actor agent` (for example `dg --json --actor agent ticket show t12`). You identify as the agent. A refused operation (`TRANSITION_REJECTED`) is for a human to handle
- Read and write tickets only with `dg`. Do not edit the data files (under `.git/deguboard/`) directly
- {{dgPathNote}}

Target: $ARGUMENTS

If the target is empty, follow the "Deciding the target" section of the steps.
