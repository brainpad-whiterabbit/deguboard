# 1. リポジトリを初期化する

管理したいリポジトリで、一度だけ実行します。チケットを置く場所（`.git/deguboard/`）ができます。

いちばん簡単なのは、サイドバーの始め方の画面の **このリポジトリで始める** を押すことです。新しいターミナルで `dg init`・`dg skill install`・`dg hooks install` が順に実行されるので、`dg` が PATH になくても動きます。

自分でターミナルから実行するなら、次のコマンドを実行します。

```sh
dg init
```

`dg` が見つからないときは、README の「[Getting started before release](https://github.com/brainpad-whiterabbit/deguboard#getting-started-before-release)」のとおりにビルドして、`dg` を PATH に通します（npm にはまだ公開していません）。

実行すると、開き直さなくてもサイドバーがいつもの画面に変わります。
