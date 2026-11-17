---
description: Checks that every ticket of a deguboard Iteration is done, proceeds by the repository's release steps, and closes the Iteration. Asks for approval before merging the release PR and publishing. By default (flow.release is human_only) asks a human to pass the release checkpoint and to close the Iteration. Use when asked「s3 をリリースして」「リリースを進めて」.
argument-hint: "[Iteration]"
---

# Release (release)

Checks that the tickets of an Iteration are all done, proceeds by the repository's release steps, and closes the Iteration. The release processing (how the version is chosen, CHANGELOG, tags, destinations) is not kept in deguboard; it follows the repository's steps. These steps do not write how versions are assigned or the release commands. Whether the audit (`dg guide audit`) has been done is not checked, since it is not a condition for release.

## Deciding the target

- Iteration (`s3`): releases that Iteration
- No target given: suggests the active Iteration and asks to confirm it. If there is none, asks which one

Below, the Iteration to release is written as `<S>`.

## Release steps

1. **Check that all are done**: after `dg --json --actor agent sync`, check with `dg --json --actor agent iteration show <S>` that every ticket is done or abandoned, apart from the release tickets labeled `release-<S>` (filed in step 3; when they exist, the release has started and is being resumed). If there are no tickets, say so and stop. If some remain, show the list (ID, title, state, PR), and ask with "Mark as done" (`dg guide done`; if a Skill is available, `/dgdone <S>`) and "Stop here". When all are done or abandoned, close the finished Plans first: `dg --json --actor agent plan list --status open` shows the open Plans with their progress, and for each one whose tickets are all done or abandoned, close it with `dg --json --actor agent plan close <p>` by the "Closing a Plan" section of `dg guide done`. No approval is needed for this
2. **Find the release steps**: find the release section in the repository's rules (the agent instructions such as CLAUDE.md or AGENTS.md, README, development docs), and show which document and which step will be followed. If there are none, see the "When there are no release steps" section below
3. **Proceed by the steps**: do not do operations that are not in the steps (changing how the version is decided, tagging by hand, skipping a step). If you stop, show the reason and ask
   - Do not use a checkout you are working in. Proceed in the temporary worktree made by `git fetch {{git.remote}} {{git.base_branch}}` and then `git worktree add --detach {{worktree.root}}/release-<S> {{git.remote}}/{{git.base_branch}}`. The release branch, dependency install, and build are also done inside it
   - The release PR is merged outside the temporary worktree. The check and publishing after the merge are done after taking in the merge and making the temporary worktree again
   - Operations that may proceed without waiting for approval are preparation (the temporary worktree, the branch, the version update, CHANGELOG, check commands, making the PR), since they can be reviewed within the PR. Filing the two tickets of the bullet below is also preparation, done with `--created-by human` since the human asked for the release
   - The release PR is a version-bump PR. Its review is skipped only when a human sets the ticket's level to `low` (only a human can lower it; the "Quality gate" section of `dg guide review`). Otherwise the high level's review applies
   - Split the release into two tickets in the Iteration, filed after step 1 with `--created-by human` and `--label release-<S>`. Step 1 and `dg flow next` do not count tickets with this label as remaining, so a release stopped midway resumes at the release stage, not at planning. If they already exist, continue with them instead of filing them again. The PR ticket's acceptance criteria are only those the PR's contents show (for example, the versions are aligned and the check commands pass). Acceptance criteria that need the merge or the publishing (the tag, the Release, the destinations) go to a second ticket with no PR, started with `claim --without-branch`. The agent checks them after the merge and publishing, then moves that ticket to done by step 3 of "Work that needs no PR" in `dg guide work`: when the Workflow's review → done boundary asks for a human's approval (it does by default), the agent records the human's instruction or approval to finish it with `--approved-by human`, and never passes it without one. Before asking for the merge approval, confirm with `dg --json --actor agent gate <PR ticket> --for merge` that the gate is met and check the PR ticket's criteria, so the merge needs no approval override. The override path below is only for when the gate still is not met after those criteria are checked (for example, the split did not make it pass). Both tickets must be done before the Iteration is closed (step 4)
   - **Pass the release checkpoint before the merge**: the preparation above may be done first, but before asking for the merge of the release PR, the release checkpoint must be passed: `dg checkpoint release <S>`. It records on the Iteration who let the release go ahead. The Workflow's `flow.release` judges it, as for closing (step 4). With `human_only` (the default) the agent cannot pass it: show the release PR and the material for the decision, and ask a human to run `dg checkpoint release <S>`, or to choose "Stop here". When the board's value asks for approval, ask, and if approved, run `dg --json --actor agent checkpoint release <S> --approved-by human`. In a flow, `checkpoint` of `dg flow next` gives the command, and is null once it is passed. When resuming a release, do not pass it again if `checkpoints` of `iteration show <S>` already has a `release` record that is not older than `reopened_at`
   - **Get approval before doing**: merging the release PR, and publishing operations (pushing a tag, publishing to a destination). Ask before each one. When the merge is approved, the agent merges the release PR with `dg --json --actor agent pr merge <id> --approved-by human` (`<id>` is the release PR's ticket), also when the gate still is not met after the PR ticket's criteria are checked: show the unmet conditions when asking, by the "Merging without meeting the gate" section of `dg guide review`. Do not ask the human to run `gh pr merge`. If the steps have a check mode such as `--dry-run`, run it first and show its result as material for the decision
   - When finished (also when stopped), remove the temporary worktree. If `git worktree remove` stops, check what remains with `git -C <path> status --short --branch`. If no change needed for the release remains, remove it with `--force`. If changes remain, do not remove it, and tell a human
4. **Close the Iteration**: the Workflow's `flow.release` judges closing (`human_only` by default; `definition.flow.release` of `dg --json --actor agent workflow show`). With `human_only`, the agent cannot close it: ask a human to run `dg iteration close <S>`, or to choose "Stop here". When the board's value asks for approval (`always_ask`, or `ask_unless_auto` outside a flow started with `--auto`), ask with "Close" and "Stop here", and if approved, run `dg --json --actor agent iteration close <S> --approved-by human`. The next Iteration starts, when you start on a ticket in it, by the "Before and after claim" section of `dg guide work` (not asked)
5. **Report the result**: the released version, the PR, what was published, the state of the Iteration, and the temporary worktree left (if any)

## When there are no release steps

Do not guess the version, the tag, or the CHANGELOG. Say that no release steps were found, and ask with "Close the Iteration (no release)" and "Stop here".

{{choices}}

## Choosing the next step

After reporting the result, ask with the following choices.

- **Look back on the Iteration** (only when the Iteration was closed in step 4, including the close with no release steps): look back on `<S>` by the steps of `dg guide retro` (recommended). The numbers of a closed Iteration are complete at this point, and the retrospective writes nothing without approval (if a Skill is available, `/dgretro <S>`)
- **Make the next plan**: if todo tickets remain, make a plan by the steps of `dg guide plan` (if a Skill is available, `/dgplan next`)
- **Assign**: assign the unassigned todos to an Iteration by the steps of `dg guide assign` (if a Skill is available, `/dgassign`)
- **Stop here**
