---
description: Tells how the work on an in-progress ticket is going (where it is now, why it has stopped if it has, and the next step), from the ticket, dg next, the Runs, the worktree's commits, and the PR. Changes no data. Use when asked「t12 の様子を教えて」「t12 はどこまで進んだ？」「止まっている理由を聞きたい」.
argument-hint: "<ID...>"
---

# Status (status)

Tells a human how the work on a ticket is going: where it is now, why it has stopped (if it has), and the next step. This guide only reads. It changes no data: no `dg` write, no file, no branch, no commit, and no PR.

## Deciding the target

- The IDs after the Skill call (`/dgstatus t12`) are the targets. Each should be an in_progress ticket. For any other status, show its status from `ticket show` and the ask that fits (for example, `dg guide work` for a todo ticket, or `dg guide done` for one in review), and stop
- No target given: ask which ticket, with the choices below

{{choices}}

## Reading

For each target, read with `dg --json --actor agent` (none of these writes):

- `ticket show <t12>`: `status`, `stage` (where the work is), `worktree` (null if there is none yet), `branch`, `pr`, `plan`, `deps_done`, and `pending_deps`
- `next <t12>`: the next step and the reason for the stage
- `run list --ticket <t12>`: the Runs of the ticket. The latest one's `result` and `error` say why a stop happened. `run list --running --ticket <t12>` lists the unfinished ones on this machine
- The commits in the worktree: when `worktree` is set, `git -C <worktree> log --oneline -5`
- The PR: when `pr` is set, `gh pr view <number> --json state,isDraft,reviewDecision`. If `gh` is not available, say that the PR state is unknown

## Answering

Answer in 3 to 5 lines, in the words the human used: where the work is now (the stage, and whether a Run is running), why it has stopped (if it has), and the next step. Then:

- A Run is running (`run list --running` shows one): show the stage of that Run and the latest commits of the worktree. Do not act on the ticket or the Run (no claim, finish, resume, or move). The agent working on it owns it
- It has stopped (in_progress and no Run running): say why, from the latest Run's `result` and `error`, or from the stage in `next`. Recommend resuming only, and do not resume here (see "Choosing the next step")
- It is waiting (`deps_done` is false, or it is in a Plan that is not approved yet): say which dependencies or which Plan it waits for
- Otherwise: say how far it has got (the commits and the PR state), and give the next step from `next`

## Steps

1. **Read the target**: `ticket show <t12>`. If it is not in_progress, show its status and the ask that fits, then stop
2. **Read the stage and the Runs**: `next <t12>`, `run list --ticket <t12>`, and `run list --running --ticket <t12>`
3. **Read the worktree and the PR**: the commits in the worktree and the PR state, as in "Reading"
4. **Answer**: 3 to 5 lines, as in "Answering"

## Choosing the next step

This guide asks no choices of its own. As the last line of the answer, it only recommends resuming a stopped ticket with `dg guide work` (if a Skill is available, `/dgwork <t12>`), and does not resume the work itself. Without a Skill, read `dg guide work` and continue with that step when the human asks.
