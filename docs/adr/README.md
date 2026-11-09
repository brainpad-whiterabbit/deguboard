# ADR 一覧

設計判断の記録。書き方と運用は [ADR-001](ADR-001-doc-strategy.md) に従う。

今の仕様の正本は[要件定義書](../requirements.md)で、ADR は判断の理由が要るときだけ番号で引く。ADR は今の判断と理由だけを書き、判断を変える PR で本文を直接書き換える。書く場面と直し方・削除は ADR-001 の[「ADR を書く場面」](ADR-001-doc-strategy.md#adr-を書く場面)と[「ADR は今の判断だけを書き、判断を変える PR で直す」](ADR-001-doc-strategy.md#adr-は今の判断だけを書き判断を変える-pr-で直す)の節に従う。要らなくなった ADR は削除し、番号は使い回さない。新しい ADR は下の「最後に使った番号」の次にする。

## 有効な ADR

最後に使った番号：ADR-034

| 番号                                                | タイトル                                                                                                | テーマ             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------ |
| [ADR-001](ADR-001-doc-strategy.md)                  | 文書の方針                                                                                              | 文書               |
| [ADR-003](ADR-003-status-and-workflow.md)           | ステータスとワークフロー                                                                                | ワークフロー       |
| [ADR-008](ADR-008-tech-stack.md)                    | 技術構成と開発環境                                                                                      | 技術構成           |
| [ADR-009](ADR-009-epic-and-iteration.md)            | Epic と Iteration                                                                                       | チケットのまとまり |
| [ADR-011](ADR-011-procedure-in-code.md)             | 既定の手続きは dg のコードが持つ                                                                        | ワークフロー       |
| [ADR-024](ADR-024-oxlint-latest.md)                 | react(immutability) の指摘を直したので oxlint を最新に上げ、版を留めない                                | 技術構成           |
| [ADR-025](ADR-025-runs-by-hooks.md)                 | Run は harness のフックが印で開け閉めし、step を終えた事実で閉じる                                      | エージェント       |
| [ADR-026](ADR-026-guard-pr-and-data.md)             | PR とデータを守る正しい道は dg のコマンドにし、フックは語の有無で粗く止め、すり抜けは事後に見つける     | エージェント       |
| [ADR-027](ADR-027-screen-vscode-writes-and-asks.md) | 人の画面は VS Code 拡張にし、画面から書くのはチケット詳細と設定だけで、ほかはエージェントに頼む         | UI                 |
| [ADR-028](ADR-028-agents-and-state.md)              | ツールはエージェントを動かさず、状態はブランチの事実で進め、排他は claim の push で決める               | エージェントと照合 |
| [ADR-029](ADR-029-work-metrics.md)                  | 作業の使用量は Run ごとに公式の記録から実測し、数だけを Git に写す                                      | 作業の実績         |
| [ADR-030](ADR-030-flow-and-guide-in-core.md)        | Iteration の流れもコードが判定し、guide の節は Core が返し、カスタマイズは config と guide.notes に限る | ワークフロー       |
| [ADR-031](ADR-031-claim-prepares-work.md)           | claim が Iteration への追加と開始、作業ブランチの worktree の作成まで行う                               | ワークフロー       |
| [ADR-033](ADR-033-architecture.md)                  | アーキテクチャ（索引は印で確かめる読みの結果をディスクに残す）                                          | アーキテクチャ     |
| [ADR-034](ADR-034-storage-and-id.md)                | チケットの保存と ID                                                                                     | データ             |
