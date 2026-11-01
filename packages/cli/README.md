# deguboard

Git で管理するチケットとユーザー定義のワークフローを組み合わせた、AI エージェント対応のタスク管理ツール [deguboard](https://github.com/brainpad-whiterabbit/deguboard) の CLI。コマンドは `dg`。

```sh
npm i -g deguboard
dg --help
```

このパッケージには、`dg serve` が配信する画面と、エージェント向けの手順（`dg guide`）・Claude Code の Skill（`dg skill install`）を同梱する。

- 前提・使い始め方・できること：[リポジトリの README](https://github.com/brainpad-whiterabbit/deguboard#readme)
- 仕様：[要件定義書](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/requirements.md)
- コマンドの細部：`dg --help`、`dg <コマンド> --help`
