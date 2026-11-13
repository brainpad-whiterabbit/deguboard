# 3. エージェントに頼む

Claude Code を使うなら、Skill（`/dgimport` など）は手順 1 の **このリポジトリで始める** で入っているので、ここでは何も実行しません。`dg init` を自分でターミナルから実行した人だけ、そのターミナルで `dg skill install` と `dg hooks install` を一度ずつ実行します。Skill とフックは git が追跡しない（2 つのコマンドが `.claude/.gitignore` に足します。この `.gitignore` はコミットします）ので、clone した人もそれぞれ `dg skill install` と `dg hooks install` を実行します。

ほかのエージェントには「`dg guide` を読んでから `dg` で進めて」と頼みます。

チケットの行の吹き出しか、サイドバーのタイトル行の吹き出しから、依頼文を作れます。コピーして自分のエージェントに貼るか、開いているターミナルを選んで **送る** こともできます。コピーも送るのも、データには何も書きません。

[エージェントに頼む入力欄を開く](command:deguboard.askInSidebar)
