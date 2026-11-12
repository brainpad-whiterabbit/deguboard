# 1. Initialize the repository

In the repository you want to manage, run this once. It creates the place where tickets are stored (`.git/deguboard/`).

The easiest way is to press **Start with this repository** on the deguboard start screen in the sidebar. A new terminal runs `dg init`, `dg skill install`, and `dg hooks install` in order, so `dg` does not need to be on your PATH.

To run it yourself in a terminal instead:

```sh
dg init
```

If `dg` is not found in a terminal, press **Start with this repository** on the start screen in the sidebar instead. Or run **Install dg command** from the Command Palette (`deguboard.installDg`) to link `~/.local/bin/dg`.

Once it finishes, the sidebar switches to the usual views without reopening.
