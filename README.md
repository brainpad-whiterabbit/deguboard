# deguboard

English | [日本語](https://github.com/brainpad-whiterabbit/deguboard/blob/main/README.ja.md)

A Git-native kanban board for practicing [Agentic-Agile](https://github.com/microsoft/agentic-agile-template/blob/main/MANIFESTO.md). You work as the agents' partner, designing, reviewing, and approving, while agents carry out small tickets with acceptance criteria in parallel along their dependencies. Every run is measured, so you can see where the work gets stuck and improve how you work together.

deguboard is an independent project. It is not made, endorsed, or supported by Microsoft.

## Features

- **Delegate with specs**: Hand over work as small tickets with acceptance criteria instead of open-ended prompts. Agents work from the ticket, and the result is checked against its criteria.
- **Run in parallel along dependencies**: Plan the order from dependencies, and agents work on tickets that are not blocked at the same time, each on its own branch and worktree.
- **Governance built in**: Plans wait for approval before work starts. A PR is marked ready or merged only when the quality gate (`dg gate`) passes. Each ticket has a gate level, `high` by default, which requires everything including an independent review; `low` skips the review, and `free` checks only that the PR is open and does not conflict. `actor.human_only` and workflow rules can reserve commands and transitions for people, and the Claude Code hooks refuse to mark a PR ready or merge it outside `dg`, and to write to the data directly.
- **Measure and improve**: Aggregate duration, tokens, retries, review findings, and results per ticket, step, and model with `dg metrics`, and use retrospectives to find bottlenecks and what to fix next.

## Installation

Prerequisites: Git 2.30 or later. To reflect pull request status on tickets, you also need the GitHub CLI (`gh`). deguboard runs on Linux and macOS.

1. **Install the extension**: Download `deguboard-vscode.vsix` from [GitHub Releases](https://github.com/brainpad-whiterabbit/deguboard/releases) and run `code --install-extension deguboard-vscode.vsix`. Then reload the VS Code window.
2. **Start with the repository**: Open the repository you want to manage, click the deguboard icon in the Activity Bar, and press **Start with this repository** on the start screen. It runs `dg init`, installs the Skills for Claude Code (`dg skill install`, such as `/dgall`), and writes the Claude Code hooks (`dg hooks install`, to `.claude/settings.local.json`, which git does not track).
3. **Terminal users only**: To run `dg` yourself in a terminal, run **Install dg command** from the Command Palette. It links `~/.local/bin/dg` (add `~/.local/bin` to your PATH if needed).

Other agents that can use a shell (Codex, Copilot CLI, and others) need no setup. Just ask them to "read `dg guide` and proceed with `dg`".

Data lives on a dedicated branch of your repository, so no service is required. Other team members only need to install the extension, clone the repository, and press the same button to see the same board.

## Usage

### Open the board

Click the deguboard icon in the Activity Bar to open the board. Use the tabs at the top to switch to the backlog and history.

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/open-board.gif" alt="Opening the board" width="560">

### Jump to details by ID or title

Run "deguboard: Go to Ticket" from the Command Palette, or press `Ctrl+K Ctrl+Alt+G` (`⌘K ⌘⌥G` on macOS), to filter tickets, Iterations, Epics, and Plans by ID or title and open their details.

### Use the keyboard

Rows in the sidebar (board, backlog, and history) work without a mouse. When you Tab into a list, only the current row is focusable, and a single Tab leaves the list.

| Key              | Action                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| ↑ ↓ / Home / End | Move between rows (the current row shows a focus outline)                                             |
| Enter            | Open details of the current row in an editor panel                                                    |
| Space            | Select or deselect the current row (keep adding to select several)                                    |
| a                | Open the "Ask Agent" menu for the selected rows (or the current row if none). Shift+F10 also opens it |

None of these conflict with VS Code's default keybindings.

With a mouse, Ctrl/⌘+click adds or removes a row from the selection and Shift+click selects the range from the row you pressed before; a plain click opens details instead. Pressing the strip at a row's left edge adds or removes that row, and dragging across the strip selects a range; Esc clears the selection. The speech bubble of a selected row (and `a`) asks an agent about all the selected rows. Right-click a ticket row or an Iteration or Epic heading to open its details or copy its ID (ask an agent from the speech bubble).

### Turn a rough idea into tickets

Ask for something in your own words with `/dgimport` (in Claude Code). The agent investigates the code and proposes tickets with acceptance criteria and dependencies. Approve them, and they appear in the backlog.

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/import.gif" alt="Turning a rough idea into tickets" width="560">

### Ask an agent

Click a row's speech bubble, choose what to ask for, and paste the copied request into your agent. For agents other than Claude Code, set the format to "Text". You can also pick an open terminal and "Send" the request to it. A single line is typed into the input without pressing Enter. Multiple lines are pasted with VS Code's paste, so choose whether to paste when asked. If the input does not support pasting, each line may be run separately.

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/ask-agent.gif" alt="Asking an agent" width="560">

### Hand off everything

Give `/dgall` an Iteration or tickets (in Claude Code), such as `/dgall s3 --auto`, and the agent plans and implements them in one go. It does not turn what you want to build into tickets, so do that first with `/dgimport`. The agent stops and asks for releasing (merging and publishing the release PR), deleting, abandoning, or undoing done on tickets, closing or reopening an Epic, Iteration, or Plan, merging PRs when `auto.merge` is off or when a PR does not meet the quality gate, changing a Plan's waits or scope, anything with `--force`, decisions with no suggested option, and answers that cannot be a choice. Other decisions proceed with the suggested option when `auto.decisions` in config includes them. Watch the progress on the board, and click a plan's band to see its dependencies as a graph. `--gate-high`, `--gate-low`, or `--gate-free` (`/dgwork` takes the same flags) sets the quality gate level of the target tickets (without one, each ticket keeps its own level). For other agents, ask them to "read `dg guide all` and proceed to the end with `--auto`".

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/run-all.gif" alt="Handing off everything" width="560">

### Find bottlenecks

In the history, ask for "Retrospect" from a finished Iteration's speech bubble. The agent aggregates the actuals (duration, tokens, and rework per step) and summarizes where work got stuck and what to fix next.

<img src="https://raw.githubusercontent.com/brainpad-whiterabbit/deguboard/main/packages/vscode/images/retro.gif" alt="Finding bottlenecks" width="560">

To aggregate tokens as well, enable reading usage from conversation transcripts (supported for Claude Code, Codex, and Copilot CLI).

```sh
dg config set metrics.read_transcripts true
```

This setting is shared with your team. To turn it off on your own machine only, set `DEGUBOARD_NO_TRANSCRIPTS=1`.

### Notice what awaits approval

When Plans await approval or tickets are in review, the sidebar title shows the count, like "DEGUBOARD: Awaiting Approval/Review 3" (otherwise just "DEGUBOARD"). When the count grows, a notification appears, and "Open" opens the details. The number on the Activity Bar icon is something else: the total of unpushed commits and remote updates not yet pulled.

You can turn notifications off under "Notifications" in Settings (the gear icon); the count stays visible. To turn them off only for yourself while keeping the team setting, use the "Mine" (自分) tab in Settings or add `--local` (a personal setting that is not committed to Git; see `dg config set --help`).

```sh
dg config set notify.approvals false --local
```

## Security and privacy

- The extension sends no telemetry and starts no HTTP server. Its only network access is `git` connecting to your remotes and `gh` connecting to GitHub.
- Data is stored in `.git/deguboard/`, and nothing is written outside `.git`.
- The extension runs only `git`, `gh`, and `dg --version`, none of them through a shell (git running a merge driver with `sh -c` during a sync rebase is how git works).
- Because git configuration can run arbitrary commands, the extension works only in trusted folders (not in Restricted Mode or virtual workspaces).
- The Skills written by `dg skill install` contain only text telling the agent to read `dg guide`, with no scripts and no tool permissions. Use `--dry-run` to see their contents.
- The hooks written by `dg hooks install` only call `dg hook <event>`, which records Runs and reads transcripts under `~/.claude/projects/`. Before a tool runs, they also refuse `gh pr ready` and `gh pr merge` (and the same operations through `gh api`) outside `dg`, file-edit tools that write under `.git/deguboard/`, and Bash commands that mention `.git/deguboard`; use the `dg` commands instead. Use `--dry-run` to see the settings, and `dg hooks uninstall` to remove them.
- See [SECURITY.md](https://github.com/brainpad-whiterabbit/deguboard/blob/main/SECURITY.md) (in Japanese) for how to report vulnerabilities.

## Other ways to use it

### Getting started as a developer

For developing deguboard itself. Install [mise](https://mise.jdx.dev/), clone the repository, and install the hooks. The hooks do not depend on PATH: `dg hooks install` writes the absolute paths of node and `dg.js`.

```sh
git clone https://github.com/brainpad-whiterabbit/deguboard.git && cd deguboard
mise trust && mise install    # install node and pnpm at the versions in mise.toml
mise run install              # install dependencies, build dg and the extension, and install the VSIX into VS Code
mise run dg -- hooks install  # write the hooks to .claude/settings.local.json with absolute paths (once per clone; again after upgrading node)
mise run dg -- hooks check    # in a new session, confirm the hooks are installed and that dg has received them
mise run dg:link              # optional: link dg to ~/.local/bin/dg to use it from your terminal (add ~/.local/bin to PATH if needed). To update, git pull and then mise run install
```

To install the VSIX by hand, run `code --install-extension packages/vscode/deguboard-vscode.vsix` after `mise run vsix`.

### Use the CLI

Besides the board, you can run the same operations from the `dg` command in a terminal (see step 3 of [Installation](#installation)).

```sh
dg ticket create "Validate login" --summary "Check the input" --acceptance "Reject empty input"
dg ticket list                # --json for machine-readable output
```

Without installing Skills, you can make the same requests by pasting text made with `dg ask --format text` into your agent.

### Use it from Claude Desktop (MCP)

`dg mcp` is a stdio MCP server that exposes `dg` commands as tools with names like `ticket_create`. Claude Desktop starts outside your repository without inheriting your PATH, so in `claude_desktop_config.json`, set `command` to the launcher that the extension installs at `~/.local/share/deguboard/dg` (it finds node itself), and pass `-C <target-repository>` and `mcp` as arguments. Write `command` as the absolute path of that file, with the home directory spelled out (`/Users/<you>/...` on macOS, `/home/<you>/...` on Linux): the JSON does not expand `~`. Claude Code can call `dg` through Bash, so it needs no registration.

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

## Documentation

The documents below are written in Japanese.

- [Requirements](docs/requirements.md): the source of truth for the current specification
- [ADRs](docs/adr/README.md): background and reasons for design decisions
- [Development guide](docs/development.md): for people developing in this repository
- [SECURITY.md](SECURITY.md): where to report vulnerabilities and which versions receive fixes
- `dg --help` and `dg guide <topic>`: the list of commands and the source of truth for agent workflows (bundled with the CLI)

## License

[MIT](LICENSE). Licenses of the dependencies bundled in the distributions are collected in `THIRD_PARTY_LICENSES.md`, generated by the build (in `dist/` of the VSIX).
