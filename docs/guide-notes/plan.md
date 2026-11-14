データの同期と書き込みの経路（packages/core/src/git/sync.ts・git/write.ts と、それを呼ぶコマンド）を変えるチケットは tier を heavy にする。
変更が 500 行を超えそうなら、経路そのものの変更と呼び手の変更を別のチケットに分けて after でつなぐ（分けるときは dg guide import で起票し直すよう人に提案する）。
受け入れ条件に、push が拒まれた後の取り込み直しで止まる場合を含める。
根拠：s33 の重い指摘 7 件はすべてこの経路の t904（1258 行・retries 8・heavy 4）・t906（2132 行・retries 6・heavy 2）・t909（retries 2・heavy 1）に集まった。
