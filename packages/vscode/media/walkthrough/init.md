# 1. Initialize the repository

In the repository you want to manage, do this once. It creates the place where tickets are stored (`.git/deguboard/`).

The easiest way is the setup checklist in the deguboard sidebar. It checks the folder, the OS, git, the Git repository, and the board from the top, and shows a button and the command on the first item that is not met. On the **Board** item, press the button: a terminal runs `dg init` with the dg bundled in the extension, so `dg` does not need to be on your PATH. When the team already has a board on the remote, the same button takes it in.

To run it yourself in a terminal instead:

```sh
dg init
```

If `dg` is not found in a terminal, press the button in the sidebar instead. Or run **Install dg command** from the Command Palette (`deguboard.installDg`) to link `~/.local/bin/dg`.

Once the required items are met, the sidebar switches to the usual views without reopening. A band above them shows the recommended items that are left (the Skills and hooks, the dg command, and `.claude/.gitignore`).
