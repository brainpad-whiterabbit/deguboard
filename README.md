# deguboard

English | [日本語](https://github.com/brainpad-whiterabbit/deguboard/blob/main/README.ja.md)

An agentic kanban board inside your Git repository, with the development flow built in, so you and AI agents can grow your software together while keeping its quality high. Inspired by [Agentic-Agile](https://github.com/microsoft/agentic-agile-template/blob/main/MANIFESTO.md), it supports our own take on Agentic-Agile. You bring the idea; agents turn it into small tickets with acceptance criteria, implement them in parallel, and keep revising each one until it passes the quality gate. Every agent run is measured, and in the retrospective you decide how to improve the agents and the software.

- **You stay in charge**: Agents work under your oversight. You decide what to build and what ships, and the agents drive the work forward within those bounds. You build alongside them, and the AI never runs away with the work.
- **Made for teams**: The board lives on a dedicated branch of your repository, so everyone who clones it sees the same board. There is no server or service to run.
- **Measure and improve**: Every agent run records how long it took, how many tokens it used, and how much rework it needed. In the retrospective, your team reviews the trends of the metrics it chose, and any bottleneck it finds becomes a ticket for the next round of work.

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/flow.png" alt="The development flow: an agent turns your idea into tickets and plans the order, agents work in parallel through the quality gate in each Iteration and report the time and tokens per ticket, then release and retrospect; your whole team sees the same board, and you approve the tickets, the plan, and the release, monitor the Iteration, and choose what to improve" width="800">

## Installation

deguboard runs on Linux and macOS. It needs Git 2.30 or later, and the GitHub CLI (`gh`) to show pull request status on tickets.

1. **Install the extension**: Download `deguboard-vscode.vsix` from [GitHub Releases](https://github.com/brainpad-whiterabbit/deguboard/releases), run `code --install-extension deguboard-vscode.vsix`, and reload the VS Code window.
2. **Start with the repository**: Open your repository, click the deguboard icon in the Activity Bar, and press **Start with this repository**. It creates the board and installs the Skills (such as `/dgplan`) and the hooks for Claude Code on your machine. Commit the `.claude/.gitignore` it adds.
3. **Terminal users only**: To run `dg` yourself, run **Install dg command** from the Command Palette.

Teammates install the extension, clone the repository, and press the same button to see the same board.

## Usage

Click the deguboard icon in the Activity Bar. The tabs at the top switch between **Backlog**, **Board**, and **History**. You ask for work with **Ask Agent**, the speech bubble on a row or a heading: choose what to ask for, then paste the copied request into your agent or send it to an open terminal. The request comes in a Skill form and a plain-text form, and you can switch between them in the menu.

In Claude Code, you can also just say what you want in plain words, such as "Plan the tickets of s3", and the Skill that fits is chosen for you. This needs Claude Code, which loads the Skills that deguboard installs; other agents take the plain-text form. The list of Skills, with example requests and commands, is in the [usage guide](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md#skills).

### Backlog: turn ideas into tickets

1. **Create tickets**: Tell the agent what you want in your own words, such as "Turn this idea into tickets" (**Ask Agent** → **Create tickets**). It investigates the code and proposes small tickets with acceptance criteria and dependencies. Approve them, and they appear in the Backlog.

   <img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/import.gif" alt="Turning a rough idea into tickets" width="560">

2. **Read the details**: Click a row to open the ticket. You can edit its text and attributes there.
3. **Discuss**: When a ticket is still vague, choose **Ask Agent** → **Discuss**, or just say "Let's discuss t12". The agent settles the open points with you through choices and updates the ticket after you approve the changes.

### Board: assign, plan, and work in parallel

The Board shows the tickets of an Iteration in columns by status, and the band above it shows the Iteration's plans (Plan).

1. **Assign**: In the Backlog, select tickets by the left edge of their rows, then choose **Ask** → **Assign** at the bottom (for a single ticket, use **Ask Agent** on its row). The agent proposes the Iteration or Epic to put them into. Approve it, and they appear in Todo on the Board.

   <img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/assign.gif" alt="Assigning tickets to an Iteration and an Epic" width="560">

2. **Plan**: Choose **Ask Agent** → **Plan** on the Board's heading. The agent orders the tickets by their dependencies, and the Plan appears in the band, awaiting your approval. Click its state to open the dependency graph.

   <img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/plan.gif" alt="Planning and approving the order" width="612">

3. **Work**: Choose **Ask Agent** → **Run Plan** on the Plan in the band. Agents implement the tickets that are not blocked at the same time, each on its own branch and worktree, and open PRs. A PR becomes ready after it passes the quality gate, and the agent merges it after your approval. If the gate is not met, your approval can override only the conditions allowed by the config; see the [merge approval details](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md#hand-off-everything), including the option to merge passing PRs without asking with `--auto`. As the work goes on, the colors in the graph and the columns of the Board change.

   <img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/work.gif" alt="Agents working on a plan in parallel" width="612">

### History: retrospect and improve

Choose **Ask Agent** → **Retrospect** on a finished Iteration. The agent shows the actuals (duration and tokens per step, failures, and rework), computes the metrics your team approved for each perspective with their trend, and files the improvements you approve as tickets.

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/retro.gif" alt="Finding bottlenecks" width="560">

Tokens are counted only when deguboard reads usage from conversation transcripts (Claude Code, Codex, and Copilot CLI). To turn it on:

```sh
dg config set metrics.read_transcripts true
```

The setting is shared with your team. To turn it off on your own machine only, set `DEGUBOARD_NO_TRANSCRIPTS=1`.

## Tips

The details are in the [usage guide](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md).

- [Hand off everything](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md#hand-off-everything): say "Carry s3 through to release automatically", and the agent runs the Iteration from assignment to release in one go.
- [Quality gate levels](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md#quality-gate-levels): `high` (the default), `low`, or `free` per ticket.
- [Resolve a sync conflict](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md#resolve-a-sync-conflict) when two people change the same field.
- [Keep the data in another repository](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md#keep-the-data-in-another-repository) than the code's.
- [Notifications](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md#notifications) for Plans awaiting approval and tickets in review.
- [Go to Ticket](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md#go-to-ticket): jump to details by ID or title.
- [Use the CLI](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md#use-the-cli) and [use it from Claude Desktop (MCP)](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md#use-it-from-claude-desktop-mcp).
- Other agents that can use a shell (Codex, Copilot CLI, and others) need no setup: ask them to "read `dg guide` and proceed with `dg`". Where deguboard's hooks do not reach the agent, Runs are recorded only from the agent's own `dg run` calls, and nothing stops a merge that skips `dg pr merge`. The differences are in [Use other agents](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md#use-other-agents).

## Security and privacy

- The extension sends no telemetry and starts no HTTP server. Its only network access is `git` connecting to your remotes and `gh` connecting to GitHub.
- Board data is stored in `.git/deguboard/`. At startup, the extension writes outside `.git` only two things: the `dg` launcher, which terminals and hooks call, and its `current` file pointing to the bundled `dg`, in `~/.local/share/deguboard/`; and the dg Skills (`dg*`) already installed in the repository's `.claude/skills/` and in `~/.claude/skills/`, which it updates only where an older version of `dg` wrote them (it installs no Skill that is not already there, it does not overwrite a Skill written by a newer `dg`, and a Skill you edited by hand is kept and a warning is shown). `~/.local/bin/dg` is written only by "Install dg command" and removed by "Uninstall dg command". The extension runs only `git`, `gh`, and `dg --version`, and only in trusted folders.
- The Skills only tell the agent to read `dg guide`. The hooks only call `dg hook <event>`, which records runs and refuses to mark a PR ready, merge it, or write to the data outside `dg`. See both with `--dry-run`.
- See [SECURITY.md](https://github.com/brainpad-whiterabbit/deguboard/blob/main/SECURITY.md) for how to report vulnerabilities.

## Documentation

The documents below are written in Japanese, except the usage guide.

- [Usage guide](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/usage.md): the details that this README leaves out
- [Requirements](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/requirements.md): the source of truth for the current specification
- [ADRs](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/adr/README.md): background and reasons for design decisions
- [Development guide](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/development.md): for people developing in this repository
- `dg --help` and `dg guide <topic>`: the list of commands and the source of truth for agent workflows (bundled with the CLI, in English)

## License

[MIT](https://github.com/brainpad-whiterabbit/deguboard/blob/main/LICENSE). Licenses of the dependencies bundled in the distributions are collected in `THIRD_PARTY_LICENSES.md`, generated by the build (in `dist/` of the VSIX).
