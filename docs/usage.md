# Usage details

English | [日本語](usage.ja.md)

This page covers the things people do that the [README](../README.md) leaves out. The details of each command are in `dg <command> --help`, the steps for agents are in `dg guide <topic>`, and the promises are in [requirements.md](requirements.md) (written in Japanese), which is the source of truth; this page does not copy them.

## Skills

The Skills are for Claude Code. Say the request in plain words, or type the command. The command column shows an example; the arguments are described in the Skill's `argument-hint` and in `dg guide <topic>`. For agents without the Skills, use the plain-text form of Ask Agent.

| Skill       | What it does                                                                    | Example request                             | Command            |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------- | ------------------ |
| `dgimport`  | Turns a conversation, a plan, or a design document into tickets, after approval | "Turn this discussion into tickets"         | `/dgimport`        |
| `dgassign`  | Puts tickets into an Iteration or an Epic, after approval                       | "Assign these tickets to a sprint"          | `/dgassign s3`     |
| `dgcheck`   | Finds mismatches among tickets, Epics, Iterations, and Plans, and fixes them    | "Check the tickets of s3"                   | `/dgcheck s3`      |
| `dgplan`    | Decides the order of tickets and records it in a Plan awaiting approval         | "Plan the tickets of s3"                    | `/dgplan s3`       |
| `dgwork`    | Advances an approved Plan through ready PRs, merges after approval, and cleanup | "Run plan p3"                               | `/dgwork p3`       |
| `dgall`     | Carries an Iteration or tickets from assignment to release in one flow          | "Carry s3 through to release automatically" | `/dgall s3 --auto` |
| `dgaudit`   | Reviews the whole repository by viewpoint before release, and files findings    | "Review the repository before the release"  | `/dgaudit s3`      |
| `dgrelease` | Checks that an Iteration is done, then releases it after approval               | "Release s3"                                | `/dgrelease s3`    |
| `dgdone`    | Confirms merged tickets are done and cleans up their branches and worktrees     | "t12 is merged, clean it up"                | `/dgdone t12`      |
| `dgretro`   | Looks back on a closed Iteration by the team's perspectives                     | "Look back on s3"                           | `/dgretro s3`      |
| `dgchange`  | Carries out one change a human asked for (edit, close, reopen, abandon, undo)   | "Close s3"                                  | `/dgchange s3`     |
| `dgdiscuss` | Settles the open points of tickets, an Epic, or an Iteration with a human       | "Let's discuss t12"                         | `/dgdiscuss t12`   |
| `dgstatus`  | Tells where the work on an in-progress ticket is, and why it stopped            | "How far has t12 got?"                      | `/dgstatus t12`    |

## Hand off everything

In Claude Code, pass an Iteration or tickets such as `/dgall s3 --auto`, and the agent carries on through assignment, planning, implementation, review, and release. It does not create tickets for what you want to build, so first turn your ideas into tickets with `/dgimport`.

- With `--auto`, the decisions listed in `auto.decisions` in the config proceed with the suggested option. Decisions that people make, such as release, abandoning or deleting a ticket, and closing an Epic or Iteration, stop and ask. The full list is in `dg guide all`.
- For a PR that passed the quality gate, the agent asks you whether to merge it, and merges it only when you approve (your approval is recorded on the PR). It is merged without asking only with `--auto` when `auto.merge` in the config is true. For a PR that does not meet the gate, the agent shows the unmet conditions and asks whether to merge it anyway; your approval overrides only the conditions listed in `merge.approval_overrides` in the config, but it cannot override a PR that is closed or still a draft, a conflict with the base, or the requirement to merge the commit that was judged.
- You can follow the progress on the Board. Press the Plan band to show the dependency graph.
- For agents other than Claude Code, ask them to "read `dg guide all` and carry on to the end with `--auto`."

## Quality gate levels

The conditions checked before a PR becomes ready or is merged depend on the ticket's gate level (`gate`).

| Gate level       | Conditions checked                              |
| ---------------- | ----------------------------------------------- |
| `high` (default) | Everything, including an independent review     |
| `low`            | Everything except the review (checks still run) |
| `free`           | Only that the PR is open and does not conflict  |

Set the level in the ticket details or with `dg ticket update <id> --gate <level>`. Passing `--gate-high`, `--gate-low`, or `--gate-free` to `/dgall` or `/dgwork` sets the level of the target tickets all at once (without them, each ticket keeps its own level). Lower a level only when a person asks for it. The details of the conditions are in `dg gate --help`.

## Resolve a sync conflict

When two people change the same field of a ticket to different values, sync stops before the push. The notification shows the remote and local values of the conflicting field side by side.

- Press "Take remote" or "Take local" in the notification, and only the conflicting field takes that side's value (other changes stay). In a terminal, use `dg sync --resolve remote` or `dg sync --resolve local`.
- Until the conflict is resolved, the push waits, and so do writes that push right away, such as creating tickets and claims.
- Conflicts in `config.yaml` or in the workflow get no buttons. Resolve them by hand, following the warning from `dg sync`.

For agents, see the "When sync stops" section of `dg guide overview`. For details, see `dg sync --help`.

## Keep the data in another repository

By default, the kanban data (the `deguboard` branch) is fetched from and pushed to the same remote as the code. To keep it in a repository other than the code's, name that repository's git remote in `git.data_remote` in the config. Work branches and pull requests still use the code's remote (`git.remote`), and where the data sits in your clone does not change.

To start a new board, or to join one from a new clone, pass the data repository to `dg init` (a remote name or a URL; for a URL, dg adds the remote):

```sh
dg init --data-remote git@github.com:acme/kanban.git
```

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
- When the data remote or the data branch points at a branch that holds another board (the two share no history and both hold data), `dg sync` and writes stop with `DATA_HISTORY_UNRELATED` before taking anything in. Give this board its own branch: `dg init --data-branch <name>`, `dg sync`, then `dg config set git.data_branch <name>`.
- Read access can only be split by repository. Everyone who can read the dedicated repository can read every kanban in it. Keep a kanban that only some people may see in a repository of its own.
- To rename the data branch of an existing board, follow the steps of the previous section on the same remote: in step 1 run `git push <data remote> deguboard:<new name>`, in step 2 run `dg config set git.data_branch <new name>` and `dg sync`, and in step 4 delete the old branch. To move a board into a shared repository under a new name, rename the branch first and then move it to the repository, one move at a time. Changing both at once makes the next command push to the old branch name in the new repository, which may be another board's branch.

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

deguboard's hooks record Runs and guard the data and the merges without the agent's cooperation. At present, the hooks reach only Claude Code. To see whether the hooks reach the session, run `dg hooks check` in the repository. It reads only Claude Code's settings and the records the hooks received, so for an agent without hooks it warns that they are missing, and it can be run again after you install or change them.

Where the hooks do not reach the agent:

- Runs are recorded only from the agent's own `dg run` calls. Sub-agents' Runs are not opened and closed automatically, so the parent agent may implement and fix the ticket itself, and it opens and closes the Run with `dg run`. The guides say so.
- The guard against direct edits to the data and against ready or merge without `dg` does not work. Nothing stops a direct edit of `.git/deguboard/` or a `gh pr merge` that skips `dg pr merge`, and at the end of a response, a change made outside `dg` is not reported.
- Tokens are counted only for agents that can read their conversation records: Claude Code, Codex, and Copilot CLI today. Set `metrics.read_transcripts` to count them (see the README).
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
