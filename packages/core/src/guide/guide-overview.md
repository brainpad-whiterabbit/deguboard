# How to use deguboard (for agents)

deguboard is a ticket tool that is managed with Git. You (the AI agent) call `dg` from Bash to read and write tickets. Humans decide "what to build", "in what order to proceed", and "whether to approve the deliverables". You carry out filing, planning, implementation, and review.

## Rules to follow every time

- Always call `dg` with `--json` and read the result's `ok` and `data`. A failure has `error.code` and `error.message`. Exit codes: 0 success / 1 failure / 2 usage error
- Always pass `--actor agent` on every call (environment variables may not persist across Bash calls). Operations limited to humans are refused for agents (`TRANSITION_REJECTED`). When refused, ask a human
- You are recorded as `<user>/agent` (for example `eiki/agent`). The user is decided in this order: `--user`, `DEGUBOARD_USER`, git config `deguboard.user`, git `user.name`, OS user name (the source is shown as `user_source` in `whoami`). A human is recorded as `<user>`. A ticket's creator (`created_by`) and assignee (`assignee`) are stored in this form. The `--created-by` and `--assignee` options also accept the shorthands `human` (the user) and `agent` (the user's AI)
- Do not edit data files directly (under `.git/deguboard/`). Read them with `dg … show --json`. Changes written outside dg are found the next time dg runs, and dg stops writing (see "Changes outside dg" below)
- Ticket IDs can be `t12` or `12`. Epics are `e3`, Iterations are `s3`. When calling from outside the repository, use `-C <dir>`
- Writes are committed according to `commit.mode` (currently `{{commit.mode}}`). Filing, claim, and starting or reopening an Iteration commit and push at once. In `batch`, other changes stay in the working tree, so run `dg --json --actor agent sync` at each break. In `manual`, `sync` does not commit either, so ask a human to run `dg commit` (only `sync --resolve`, which resolves conflicts, commits the waiting changes first, even in `manual`)
- Record work results as a Run. When the parent advances work itself, `ticket claim` opens the implementation Run, so note the ID in `data.run`, and close it when recording the PR (`ticket update --pr`). For the steps, see the "When the parent advances work itself" section of `dg guide run`. Usage (token counts) is imported from the conversation record when the Run closes, so do not write the numbers yourself
- If a filing result has `provisional: true`, the number is provisional and not yet pushed, and the ID may change. Tell a human and run `sync`
- Write tickets, PRs, commits, and replies to humans in the language of the repository's existing text and of the human's request. Do not switch to English just because this guide is in English

## When sync stops

Writes and `sync` take in the remote deguboard branch before they push. When they stop, do the following. In every case, do not edit the data files.

- **Conflict**: `data.conflicts` of `sync` is not empty (`ok` stays true), or filing, claim, or starting or reopening an Iteration fails with `SYNC_CONFLICT`. Both sides changed the same field to different values, or changed the same line of a body. Local commits remain, and push, reconcile, filing, claim, and starting or reopening an Iteration stop until it is resolved. Do not choose which value to keep yourself (even when advancing with `--auto`). Show the files in `conflicts` and ask a human with choices: "remote" (take the remote value) or "local" (take the local value). Then run `dg --json --actor agent sync --resolve <remote|local>` once, on the side that was chosen. Only the conflicting fields (for a body, the lines that collided) take that side's value. Other changes and commits remain, and push and reconcile complete. Tell a human the `file`, `field`, `taken` (the value taken), and `discarded` (the value thrown away) in `data.resolved`. If `conflicts` remains after `--resolve`, the file is outside the merge driver's scope (such as `config.yaml`), so a human has to resolve it, as the warning's remedy says
- **Push keeps being refused**: if filing, claim, or starting or reopening an Iteration fails with `PUSH_FAILED`, nothing was fetched and no commit remains. Wait a little and retry the same operation (for claim, first check with `ticket show` that no one has started it). If another write leaves a warning that it could not be pushed, the commit remains locally, and the next `sync` sends it again
- **Remote unreachable**: the commits remain locally, and the filed number becomes a provisional number (`provisional: true`). When the remote is reachable again, run `sync`. If the provisional number collides with a remote number, `sync` renumbers it and shows `{ from, to }` in `data.renumbered`. If it was renumbered, correct the number you told a human and tell them again. When there is a conflict besides the provisional number, or when uncommitted changes remain in `manual`, it cannot be renumbered and appears as a conflict above (`--resolve` renumbers first, then commits the waiting changes and resolves the conflict)

## Changes outside dg

dg checks the data repository (the deguboard worktree) for changes that did not go through dg commands (uncommitted changes, and commits without dg's mark) each time a command runs. When it finds some, a command that writes stops with `OUTSIDE_CHANGES`, and a command that only reads returns a warning. `error.detail` (in parentheses for a warning) shows which files are involved (for a commit, the short SHA, subject, and files). If a Stop hook is installed, the same thing is returned when you finish a response.

- Do not revert or adopt them on your own, even if you may have written them. Tell a human the files and commits that came up, and let them decide whether to adopt or discard
- **Adopt**: when a human confirms they are correct, run `dg --json --actor agent adopt`. If there are no errors in the same check as `dg validate`, the current state becomes the baseline for later checks (uncommitted changes are committed as waiting changes by the next `commit` or `sync`). If there are errors, `adopt` does not adopt them and fails with `VALIDATION_FAILED`, so let a human fix them or decide to discard them
- **Discard**: a human reverts in the deguboard worktree. Even after the revert, the baseline may differ, for example when dg's waiting changes were reverted too, so run `dg --json --actor agent adopt` to make the current state the baseline before continuing

## Operations that may be limited to humans

By default, agents can run every operation. Limits are added in the settings.

- By command: a command listed in `actor.human_only` in `config.yaml` is refused for the agent. Current setting: {{actor.human_only}}. Examples: `plan.approve` (limit approving a Plan to humans), `epic.close`, `iteration.close`
- By ticket transition: a transition whose Workflow `transitions` marks `by: [human]` (such as making a ticket abandoned, or moving it back from done) is refused for the agent. Check with `dg --json --actor agent workflow show <id>`
- Making a ticket abandoned, undoing done, and closing or reopening an Epic or Iteration are decisions for humans. Even when they are not refused, if no human has instructed them, confirm with a human before running them
- Approving a Plan (`plan approve`) is done only when a human has approved it, even when it is not refused (see `dg guide plan`)

## Topics

| Topic    | Skill     | Contents                                                                                                                                       | When to read                                                       |
| -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| import   | dgimport  | Turns a conversation into tickets (decomposition, dependencies, Epics, importing drafts)                                                       | When requirements are settled and asked to "make tickets"          |
| assign   | dgassign  | Puts tickets into Iterations (sprints) and Epics                                                                                               | When asked to "put it in the sprint"                               |
| check    | dgcheck   | Shows findings from `sync`, `validate`, and `lint` with fix proposals in a table, and fixes them after approval                                | Before planning / when asked to "check"                            |
| plan     | dgplan    | Decides the order of advancing, records it in a Plan, and gets human approval (dependencies, `--ready`, `plan create`, `plan approve`)         | Before advancing several tickets                                   |
| work     | dgwork    | Advances one ticket (the Plan's order and scope, claim, worktree, checking acceptance criteria, PR, reconcile; also work that needs no PR)     | When starting work on a ticket                                     |
| run      | None      | The Run for when the parent advances work itself (claim and PR recording), and cleaning up a stopped Run (a helper read from work and review)  | When recording a Run or cleaning up a stopped Run                  |
| parallel | None      | Advances ready tickets of a Plan at the same time, with a subagent per ticket (limits, roles of parent and subagents, one ticket does not stop the others) | When several tickets are ready and subagents can be started |
| review   | None      | Quality gate before opening a PR and before merging. The conditions depend on the ticket's gate level: high (all, including review by a separate subagent with a fix loop that has a limit), low (all but review), free (only the PR is open and has no conflicts) | After opening a PR as a draft / before merging automatically |
| audit    | dgaudit   | Before release, reviews the whole repository by perspective and files the findings after approval (subagents; does not edit files)            | When all tickets in an Iteration or Epic are done                  |
| release  | dgrelease | Confirms all tickets in an Iteration are done, advances with the repository's release steps, and closes the Iteration                         | After review, when releasing                                       |
| done     | dgdone    | Cleanup after merge, confirming the remaining acceptance criteria, and closing a Plan                                                          | After a PR is merged                                               |
| all      | dgall     | Advances assign → check → plan → work → audit → release, taking the stage from the state (can resume with the same arguments)                  | When asked to "carry s3 through to the end"                        |

Read with `dg guide <topic>`. In Claude Code, the Skill that `dg skill install` installs (such as `/dgimport`) reads the topic. A Skill is optional. Without one, read `dg guide <topic>` and proceed with the same steps. In Claude Code, `dg hooks install` can also install hooks, and `dg hooks check` confirms whether they are installed, whether they work, and whether their input has the right shape (it warns when something is missing). For the list of commands, see `dg --help`. For each command's options, see `dg <group> <operation> --help`.
