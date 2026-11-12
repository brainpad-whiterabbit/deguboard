# @deguboard/server

[deguboard](https://github.com/brainpad-whiterabbit/deguboard) の HTTP サーバー。[`packages/core`](../core) のコマンド定義を HTTP に写し、画面を配信する。CLI（[`packages/cli`](../cli)）の `dg serve` と `dg mcp` が使う部品で、版はこれらと揃える。

deguboard を使い始めるには、このパッケージではなく VS Code 拡張（VSIX）を入れる。`dg serve` は配置の確認などに使う開発用で、利用者の入口ではない。使い方は[リポジトリの README](https://github.com/brainpad-whiterabbit/deguboard#readme)、仕様は[要件定義書](https://github.com/brainpad-whiterabbit/deguboard/blob/main/docs/requirements.md)。
