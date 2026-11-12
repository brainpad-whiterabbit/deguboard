# 1. Initialize the repository

In the repository you want to manage, run this once. It creates the place where tickets are stored (`.git/deguboard/`).

The easiest way is to press **Start with this repository** on the deguboard start screen in the sidebar. A new terminal runs `dg init`, `dg skill install`, and `dg hooks install` in order, so `dg` does not need to be on your PATH.

To run it yourself in a terminal instead:

```sh
dg init
```

If `dg` is not found, build it as described in the README's [“Getting started before release”](https://github.com/brainpad-whiterabbit/deguboard#getting-started-before-release) section and put `dg` on your PATH (it is not on npm yet).

Once it finishes, the sidebar switches to the usual views without reopening.
