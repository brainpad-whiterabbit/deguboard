# 1. Initialize the repository

In the repository you want to manage, do this once. It creates the place where tickets are stored (`.git/deguboard/`).

The easiest way is the setup checklist in the deguboard sidebar. It checks the folder, the OS, git, the Git repository, and the board from the top, and shows why on the first item that is not met. When a command can fix it, the item also shows a button and the command. When it cannot (for example, git is missing or a remote cannot be reached), fix it by hand and press Check again. On the **Board** item, press the button: a terminal runs `dg init` with the dg bundled in the extension, so `dg` does not need to be on your PATH. When the team already has a board on the remote, the same button takes it in. If the team keeps the board in another repository, choose **The team's board is in another repository**, enter the repository (a URL or a remote name) and its branch, and check it: the button then runs `dg init` with `--data-remote` and `--data-branch`.

To run it yourself in a terminal instead:

```sh
dg init
```

If `dg` is not found in a terminal, press the button in the sidebar instead. Or run **Install dg command** from the Command Palette (`deguboard.installDg`) to link `~/.local/bin/dg`.

Once the required items are met, the sidebar switches to the usual views without reopening. A band above them shows the recommended items that are left (the Skills and hooks, the dg command, and `.claude/.gitignore`).
