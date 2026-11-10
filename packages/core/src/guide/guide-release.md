---
description: Checks that every ticket of a deguboard Iteration is done, proceeds by the repository's release steps, and closes the Iteration with approval. Asks for approval before merging the release PR and publishing. Use when asked「s3 をリリースして」「リリースを進めて」.
argument-hint: "[Iteration]"
---

# Release (release)

Checks that the tickets of an Iteration are all done, proceeds by the repository's release steps, and closes the Iteration. The release processing (how the version is chosen, CHANGELOG, tags, destinations) is not kept in deguboard; it follows the repository's steps. These steps do not write how versions are assigned or the release commands. Whether the audit (`dg guide audit`) has been done is not checked, since it is not a condition for release.

## Deciding the target

- Iteration (`s3`): releases that Iteration
- No target given: suggests the active Iteration and asks to confirm it. If there is none, asks which one

Below, the Iteration to release is written as `<S>`.

## Release steps

1. **Check that all are done**: after `dg --json --actor agent sync`, check with `dg --json --actor agent iteration show <S>` that every ticket is done or abandoned. If there are no tickets, say so and stop. If some remain, show the list (ID, title, state, PR), and ask with "Mark as done" (`dg guide done`; if a Skill is available, `/dgdone <S>`) and "Stop here"
2. **Find the release steps**: find the release section in the repository's rules (CLAUDE.md, README, development docs), and show which document and which step will be followed. If there are none, see the "When there are no release steps" section below
3. **Proceed by the steps**: do not do operations that are not in the steps (changing how the version is decided, tagging by hand, skipping a step). If you stop, show the reason and ask
   - Do not use a checkout you are working in. Proceed in the temporary worktree made by `git fetch {{git.remote}} {{git.base_branch}}` and then `git worktree add --detach {{worktree.root}}/release-<S> {{git.remote}}/{{git.base_branch}}`. The release branch, dependency install, and build are also done inside it
   - The release PR is merged outside the temporary worktree. The check and publishing after the merge are done after taking in the merge and making the temporary worktree again
   - Operations that may proceed without waiting for approval are preparation (the temporary worktree, the branch, the version update, CHANGELOG, check commands, making the PR), since they can be reviewed within the PR
   - The release PR is a version-bump PR. Its review is skipped only when a human instructs it, by setting the ticket's level to `low` (the "Quality gate" section of `dg guide review`). Without that instruction, the high level's review applies
   - **Get approval before doing**: merging the release PR, and publishing operations (pushing a tag, publishing to a destination). Ask before each one. If the steps have a check mode such as `--dry-run`, run it first and show its result as material for the decision
   - When finished (also when stopped), remove the temporary worktree. If `git worktree remove` stops, check what remains with `git -C <path> status --short --branch`. If no change needed for the release remains, remove it with `--force`. If changes remain, do not remove it, and tell a human
4. **Close the Iteration**: ask with "Close" and "Stop here". If approved, run `dg --json --actor agent iteration close <S>`. The next Iteration starts, when you start on a ticket in it, by the "Before and after claim" section of `dg guide work` (not asked)
5. **Report the result**: the released version, the PR, what was published, the state of the Iteration, and the temporary worktree left (if any)

## When there are no release steps

Do not guess the version, the tag, or the CHANGELOG. Say that no release steps were found, and ask with "Close the Iteration (no release)" and "Stop here".

{{choices}}

## Choosing the next step

After reporting the result, ask with the following choices.

- **Make the next plan**: if todo tickets remain, make a plan by the steps of `dg guide plan` (if a Skill is available, `/dgplan next`)
- **Assign**: assign the unassigned todos to an Iteration by the steps of `dg guide assign` (if a Skill is available, `/dgassign`)
- **Stop here**
