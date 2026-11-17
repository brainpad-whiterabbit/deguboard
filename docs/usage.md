# Usage details

English | [日本語](usage.ja.md)

This page covers the things people do that the [README](../README.md) leaves out. The details of each command are in `dg <command> --help`, the steps for agents are in `dg guide <topic>`, and the promises are in [requirements.md](requirements.md) (written in Japanese), which is the source of truth; this page does not copy them.

## Skills

The Skills are for Claude Code. Say the request in plain words, or type the command. The command column shows an example; the arguments are described in the Skill's `argument-hint` and in `dg guide <topic>`. For agents without the Skills, use the plain-text form of Ask Agent.

| Skill       | What it does                                                                                                                  | Example request                             | Command                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------- |
| `dgimport`  | Turns a conversation, a plan, or a design document into tickets, after approval                                               | "Turn this discussion into tickets"         | `/dgimport`             |
| `dgassign`  | Puts tickets into an Iteration or an Epic, after approval                                                                     | "Assign these tickets to a sprint"          | `/dgassign s3`          |
| `dgcheck`   | Finds mismatches among tickets, Epics, Iterations, and Plans, and fixes them                                                  | "Check the tickets of s3"                   | `/dgcheck s3`           |
| `dgplan`    | Decides the order of tickets and records it in a Plan awaiting approval                                                       | "Plan the tickets of s3"                    | `/dgplan s3`            |
| `dgwork`    | Advances an approved Plan through ready PRs, merges after approval, and cleanup                                               | "Run plan p3"                               | `/dgwork p3`            |
| `dgall`     | Carries an Iteration or tickets from assignment to release in one flow                                                        | "Carry s3 through to release automatically" | `/dgall s3 --auto`      |
| `dgaudit`   | Reviews the whole repository by viewpoint before release, and files findings                                                  | "Review the repository before the release"  | `/dgaudit s3`           |
| `dgrelease` | Checks that an Iteration is done and prepares the release; by default you pass the release checkpoint and close the Iteration | "Release s3"                                | `/dgrelease s3`         |
| `dgdone`    | Confirms merged tickets are done and cleans up their branches and worktrees                                                   | "t12 is merged, clean it up"                | `/dgdone t12`           |
| `dgretro`   | Looks back on a closed Iteration by the team's perspectives                                                                   | "Look back on s3"                           | `/dgretro s3`           |
| `dgchange`  | Carries out one change a human asked for (edit, close, reopen, abandon, undo)                                                 | "Close s3"                                  | `/dgchange s3 close it` |
| `dgdiscuss` | Settles the open points of tickets, an Epic, or an Iteration with a human                                                     | "Let's discuss t12"                         | `/dgdiscuss t12`        |
| `dgstatus`  | Tells where the work on an in-progress ticket is, and why it stopped                                                          | "How far has t12 got?"                      | `/dgstatus t12`         |
| `dgexplain` | Explains what a ticket, Epic, or Iteration is about, with text diagrams                                                       | "Explain t12"                               | `/dgexplain t12`        |
| `dgconfig`  | Explains the settings and the Workflow, and changes them after you approve before → after                                     | "What is commit.mode?"                      | `/dgconfig commit.mode` |

## Hand off everything

In Claude Code, pass an Iteration or tickets such as `/dgall s3 --auto`, and the agent carries on through assignment, planning, implementation, review, and release. Assignment only decides the Iteration for given tickets that are in none; with an Iteration, the flow advances the tickets already in it and does not offer other todos (use `/dgassign` for that). It does not create tickets for what you want to build, so first turn your ideas into tickets with `/dgimport`.

- With `--auto`, the agent goes ahead without asking only where the board's Workflow (`workflow.yaml`) has the value `ask_unless_auto`. By default that is assignment, the fixes of the check, Plan approval, starting a ticket (todo → in_progress), and merging a PR that passed the quality gate. Other decisions still stop and ask you, even with `--auto`: by default these include the audit findings, merging the release PR and publishing it, abandoning a ticket or undoing done, and closing or reopening an Epic. Some operations are only for a person (`human_only`): the agent cannot run them even with your approval, so it gives you the command and waits. By default these are passing the release checkpoint and closing the Iteration (`dg checkpoint release <S>`, `dg iteration close <S>`), and deleting a ticket. How to see and change these values is in [Workflow](#workflow), and the full list is in `dg guide all`.
- For a PR that passed the quality gate, the agent asks you whether to merge it, and merges it only when you approve (your approval is recorded on the PR). It is merged without asking only with `--auto`, while the value of the review → done boundary is `ask_unless_auto` (the default). For a PR that does not meet the gate, the agent shows the unmet conditions and asks whether to merge it anyway; your approval overrides the unmet conditions, but it cannot override a PR that is closed or still a draft, a conflict with the base, or the requirement to merge the commit that was judged.
- You can follow the progress on the Board. Press the Plan band to show the dependency graph.
- For agents other than Claude Code, ask them to "read `dg guide all` and carry on to the end with `--auto`."

## Quality gate levels

The conditions checked before a PR becomes ready or is merged depend on the ticket's gate level (`gate`).

| Gate level       | Conditions checked                              |
| ---------------- | ----------------------------------------------- |
| `high` (default) | Everything, including an independent review     |
| `low`            | Everything except the review (checks still run) |
| `free`           | Only that the PR is open and does not conflict  |

Set the level in the ticket details or with `dg ticket update <id> --gate <level>`. Passing `--gate-high`, `--gate-low`, or `--gate-free` to `/dgall` or `/dgwork` gives the level for the target tickets (without them, each ticket keeps its own level). Raising a level is applied at once. Lowering a level (high → low → free) can only be done by a person: dg rejects an agent's call, so the flow asks you to run `dg ticket update <id> --gate <level>` for each ticket and waits. The details of the conditions are in `dg gate --help`.

## Workflow

The board's Workflow (`workflow.yaml`) decides who may do what on the board: which Status moves an agent makes on its own, where it must ask you first, what only a person may do, and which stages `--auto` passes without asking. There is one Workflow for the whole board, shared by the team, with no personal override. It is separate from the settings (`config.yaml`). `dg init` writes the default Workflow, and an item left out of the file (or a missing file) takes the default.

### What it decides

| Item         | What it decides                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `states`     | The display names of the five Statuses. Statuses cannot be added or removed                                                                                                                       |
| `boundaries` | For each of the three forward moves (todo → in_progress, in_progress → review, review → done), the Git facts it requires (`requires`) and who decides (`decide`)                                  |
| `exceptions` | Who may make the moves outside the flow: `abandon` (to abandoned), `back` (to the previous Status), and `reopen` (out of done)                                                                    |
| `wip`        | The limit of tickets in a column                                                                                                                                                                  |
| `flow`       | Who decides at each stage of the flow (`assign`, `check`, `plan`, `audit`, `release`, `retro`), the stages to skip (`skip`), and stages of your own                                               |
| `governance` | Who may delete tickets (`delete`), change the team's settings (`config`), change another person's assignee or claim (`reassign`), close or reopen an Epic (`epic`), and create tickets (`create`) |

The facts for `requires` are `deps_done` (the tickets it depends on are done), `branch_exists`, `branch_pushed`, `branch_merged`, `pr_open`, `pr_draft`, and `pr_merged`. A `!` in front, such as `!pr_draft`, requires the fact to be false.

### What the values mean

`decide` and the values under `exceptions`, `flow`, and `governance` take one of these values.

| Value             | For a person                  | For an agent                                                              |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `anyone`          | Goes ahead                    | Goes ahead                                                                |
| `ask_unless_auto` | Goes ahead                    | Asks you first; goes ahead without asking in a flow started with `--auto` |
| `always_ask`      | Goes ahead                    | Asks you first, even with `--auto`                                        |
| `human_only`      | Goes ahead                    | Refused; the agent gives you the command to run                           |
| `agent_only`      | Needs `--override "<reason>"` | Goes ahead                                                                |

When an agent goes ahead with your approval, dg records you as the approver (`dg history` shows it). Moves that `dg sync` makes from Git facts count as the agent's side. A person can pass an unmet `requires` with `--override "<reason>"`.

By default, an agent opens review on its own. It asks you before starting a ticket (todo → in_progress; your instruction to advance the ticket or your approval of its Plan counts as the approval), merging a PR (review → done), assigning, fixing what the check found, and approving a Plan; `--auto` passes these. It always asks before abandoning or reopening a ticket, filing audit findings and retro improvements, changing the team's settings, changing another person's claim, and closing or reopening an Epic. Only a person may close an Iteration (release) and delete a ticket. The WIP limits are 5 for in_progress and 3 for review.

### Fixed in Core

Some operations are fixed in Core, and `workflow.yaml` cannot loosen them: changing the Workflow itself (`dg workflow set`) always needs a person's approval, uninstalling the hooks and lowering a ticket's gate level can only be done by a person, and merging a PR that does not meet the quality gate always needs a person's approval.

### See and change it

- **See**: `dg workflow show` gives every value with its default and whether it was changed, and its `moves` tell what each Status move means for a person and for an agent. The Workflow tab of the settings screen shows the same rows (read only), and you can ask the agent about a row from there.
- **Change**: ask `/dgconfig`, for example "What does flow.release do?" or "Let agents close an Iteration after asking me". The agent shows each value that changes, before → after, and writes the file with `dg workflow set` only after you approve. Without the Skill, write the `definition` from `dg --json workflow show` to a file, change the values, and run `dg workflow set --file <file>`. Do not edit `workflow.yaml` in the data branch directly.
- **Validate**: `dg workflow validate` finds the errors in the file. A Workflow with errors is not used.

The meaning of each item is in `dg workflow show --help`, and stages of your own are in `dg flow next --help`.

## Resolve a sync conflict

When two people change the same field of a ticket to different values, sync stops before the push. The notification shows the remote and local values of the conflicting field side by side.

- Press "Take remote" or "Take local" in the notification, and only the conflicting field takes that side's value (other changes stay). In a terminal, use `dg sync --resolve remote` or `dg sync --resolve local`.
- Until the conflict is resolved, the push waits, and so do writes that push right away, such as creating tickets and claims.
- Conflicts in `config.yaml` or in the Workflow (`workflow.yaml`) get no buttons. Resolve them by hand, following the warning from `dg sync`.

For agents, see the "When sync stops" section of `dg guide overview`. For details, see `dg sync --help`.

## Keep the data in another repository

By default, the kanban data (the `deguboard` branch) is fetched from and pushed to the same remote as the code. To keep it in a repository other than the code's, name that repository's git remote in `git.data_remote` in the config. Work branches and pull requests still use the code's remote (`git.remote`), and where the data sits in your clone does not change.

To start a new board, or to join one from a new clone, pass the data repository to `dg init` (a remote name or a URL; for a URL, dg adds the remote):

```sh
dg init --data-remote git@github.com:acme/kanban.git
```

In VS Code, the board item of the setup checklist does the same: choose that the team's board is in another repository, enter the repository and its branch, and check it. The button then runs `dg init` with `--data-remote` and `--data-branch`.

If dg cannot reach the data remote (the network, the credentials, or the URL is wrong), `dg init` stops without creating a board. Fix the connection and run `dg init` again to take in the team's board. In VS Code, the board item shows the reason and a "Check again" button. Under "If you know the team has no board", a separate button ("Create a new board on this machine only") runs `dg init --new-board`, which creates a board only on this machine. If the remote already has a board, the new one shares no history with it, and `dg sync` then stops with `DATA_HISTORY_UNRELATED`. Use `--new-board` only when you know the team has no board yet, or when you want a separate board on purpose.

To move an existing board to another repository, a person does the following in order:

1. Run `dg sync`, add the new repository as a remote, and push the data to it.

   ```sh
   dg sync
   git remote add kanban git@github.com:acme/kanban.git
   git push kanban deguboard
   ```

2. Change the config, then sync. `dg config set` pushes the change to the old remote right away, and `dg sync` then pushes it to the new one, so both have it.

   ```sh
   dg config set git.data_remote kanban
   dg sync
   ```

3. In every other clone, add the remote under the same name (`git remote add kanban <URL>`) and run `dg sync`. The first command that takes in the config change stops without pushing and asks you to run it again; from then on that clone uses the new remote. A clone that does not have the remote stops and shows the `git remote add` command. To use another remote name in one clone, run `dg config set git.data_remote <name> --local`.
4. After every clone has moved, delete the branch from the old remote. A clone that has not moved would push its data to the old remote again, so do this last.

   ```sh
   git push origin --delete deguboard
   ```

If the board's data branch is not `deguboard` (see the next section), push with `git push kanban deguboard:<data branch>` in step 1 and delete `<data branch>` in step 4.

## Keep several kanbans in one repository

One dedicated data repository can hold the kanbans of several code repositories. Give each repository its own data branch (`deguboard-<name>` is recommended) in `git.data_branch`; each clone fetches and pushes only its own branch. Each kanban stays separate: numbers, dependencies, Iterations, and Epics do not cross repositories.

```sh
# in the webapp repository
dg init --data-remote git@github.com:acme/kanban.git --data-branch deguboard-webapp
# in the api repository
dg init --data-remote git@github.com:acme/kanban.git --data-branch deguboard-api
```

- A new clone runs `dg init` with the same `--data-remote` and `--data-branch`. The branch name is in the config's `git.data_branch`, but the config is inside the data, so the first init needs it.
- A branch name cannot contain `/`: `deguboard/webapp` is rejected, and `deguboard-webapp` is suggested.
- When the data remote or the data branch points at a branch that holds another board (the two share no history and both hold data), `dg sync` and writes stop with `DATA_HISTORY_UNRELATED` before taking anything in. Give this board its own branch: `dg init --data-branch <branch>` (for example `deguboard-<repository>`), `dg sync`, then `dg config set git.data_branch <branch>`.
- Read access can only be split by repository. Everyone who can read the dedicated repository can read every kanban in it. Keep a kanban that only some people may see in a repository of its own.
- To rename the data branch of an existing board, follow the steps of the previous section on the same remote: in step 1 run `git push <data remote> deguboard:<new name>`, in step 2 run `dg config set git.data_branch <new name>` and `dg sync`, and in step 4 delete the old branch. To move a board into a shared repository under a new name, rename the branch first and then move it to the repository, one move at a time. Changing both at once makes the next command push to the old branch name in the new repository, which may be another board's branch.

## Count tokens

Tokens are counted only when deguboard reads usage from conversation transcripts (Claude Code, Codex, and Copilot CLI). To turn it on:

```sh
dg config set metrics.read_transcripts true
```

The setting is shared with your team. To turn it off on your own machine only, set `DEGUBOARD_NO_TRANSCRIPTS=1`.

## Notifications

When there are Plans awaiting approval or tickets in review, the count appears in the sidebar title (for example, "DEGUBOARD: Awaiting Approval/Review 3"), and a notification appears when the count goes up. Press "Open" in the notification to open the details. The number on the Activity Bar icon is separate: it is the total of unpushed commits and remote updates that have not been pulled.

You can turn notifications off in the settings screen (the gear icon) under "Notifications". The count stays visible. To turn them off only for yourself while keeping the team setting, use the "Mine" tab of the settings screen or `--local`.

```sh
dg config set notify.approvals false --local
```

## Go to Ticket

From the Command Palette, run "deguboard: Go to Ticket", or press `Ctrl+K Ctrl+Alt+G` (`⌘K ⌘⌥G` on macOS). Filter tickets, Iterations, Epics, and Plans by ID or title, and open the details.

## Use the CLI

You can do the same things as on the screen from a terminal with `dg`. The Command Palette command "Install dg command" creates `~/.local/bin/dg` (add `~/.local/bin` to your PATH if it is not there).

```sh
dg ticket create "Validate login" --summary "Check the input" --acceptance "Reject an empty value"
dg ticket list                # --json for machine-readable output
dg --help                     # the list of commands
```

For an agent that does not have the Skill installed, paste the text made by `dg ask --format text` and ask with it.

## Use other agents

deguboard's hooks record Runs and guard the data and the merges without the agent's cooperation. At present, the hooks reach only Claude Code. To see whether the hooks reach the session, run `dg hooks check` in the repository. It checks that the hooks are in Claude Code's settings, runs each hook's dg command with `--version` to confirm that it works, and checks the records of the hooks that dg received. For an agent without hooks it warns that they are missing, and it can be run again after you install or change them.

Where the hooks do not reach the agent:

- Runs are recorded only from the agent's own `dg run` calls. Sub-agents' Runs are not opened and closed automatically, so the parent agent may implement and fix the ticket itself, and it opens and closes the Run with `dg run`. The guides say so.
- The guard against direct edits to the data and against ready or merge without `dg` does not work. Nothing stops a direct edit of `.git/deguboard/` or a `gh pr merge` that skips `dg pr merge`, and at the end of a response, a change made outside `dg` is not reported.
- Tokens are counted only for agents that can read their conversation records: Claude Code, Codex, and Copilot CLI today. Turn on the setting described in [Count tokens](#count-tokens) to count them.
- An agent that cannot start a reviewer asks a person to review the PR, and writes in the PR body that the PR was not reviewed by a reviewer.

## Use it from Claude Desktop (MCP)

`dg mcp` is an MCP server over stdio that offers the `dg` commands as tools. In `claude_desktop_config.json`, set `command` to the absolute path of the launcher `~/.local/share/deguboard/dg` that the extension installs (JSON does not expand `~`, so use `/Users/<you>/...` on macOS and `/home/<you>/...` on Linux), and pass `-C <target repository>` and `mcp` as `args`. Claude Code can call `dg` through Bash, so it needs no registration.

```json
{
  "mcpServers": {
    "deguboard": {
      "command": "/Users/<you>/.local/share/deguboard/dg",
      "args": ["-C", "/path/to/repo", "mcp"]
    }
  }
}
```

## What it writes and runs

Board data is stored in `.git/deguboard/`. At startup, the extension writes outside `.git` only these two things:

- The `dg` launcher, which terminals and hooks call, and its `current` file pointing to the bundled `dg`, in `~/.local/share/deguboard/`.
- The dg Skills (`dg*`) already installed in the repository's `.claude/skills/` and in `~/.claude/skills/`. It updates them only where an older version of `dg` wrote them. It does not overwrite a Skill written by a newer `dg`, and it keeps a Skill you edited by hand and shows a warning.

It does not install a Skill that is not already there by itself. Where some dg Skills are installed, a notice lists the missing bundled ones:

- **Install** installs them. In the repository, it also adds a line per installed Skill to `.claude/.gitignore`, as `dg skill install` does (commit it).
- **Don't show again** stops the notice for those Skills.

`~/.local/bin/dg` is written only by "Install dg command" and removed by "Uninstall dg command".

The extension runs only `git`, `gh`, and `dg --version`, and only in trusted folders.

The Skills only tell the agent to read `dg guide`. The hooks only call `dg hook <event>`, which records Runs and refuses to mark a PR ready, merge it, or write to the data outside `dg`. See the Skills with `dg skill install --dry-run` and the hooks with `dg hooks install --dry-run`. Remove the dg Skills with `dg skill uninstall` (your own Skills and `.claude/.gitignore` stay).
