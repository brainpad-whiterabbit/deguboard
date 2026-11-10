# deguboard

The CLI of [deguboard](https://github.com/brainpad-whiterabbit/deguboard), a Git-native kanban board for practicing [Agentic-Agile](https://github.com/microsoft/agentic-agile-template/blob/main/MANIFESTO.md) with AI agents, made independently of Microsoft. The command is `dg`.

```sh
npm i -g deguboard
dg --help
```

This package bundles the page that `dg serve` serves for development (checking the layout and taking screenshots; people use the board in the VS Code extension), the workflows for agents (`dg guide`), the Claude Code Skills (`dg skill install`), and the Claude Code hooks that record agent Runs (`dg hooks install`).

- Requirements, getting started, and features: [the repository README](https://github.com/brainpad-whiterabbit/deguboard#readme)
- Specification (in Japanese): [Requirements](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/requirements.md)
- Command details: `dg --help`, `dg <command> --help`
