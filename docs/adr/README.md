# ADR 一覧

設計判断の記録。書き方と運用は [ADR-001](ADR-001-doc-strategy.md) に従う。

今の仕様の正本は[要件定義書](../requirements.md)で、ADR は判断の理由が要るときだけ番号で引く。書く場面・細部を消す道・まとめ直しは ADR-001 の[「ADR を書く場面」](ADR-001-doc-strategy.md#adr-を書く場面)と[「ADR は判断ごとに 1 本、判断と理由は書き換えない」](ADR-001-doc-strategy.md#adr-は判断ごとに-1-本判断と理由は書き換えない)の節に従う。判断を変えたら、古い ADR を有効な ADR の表から外し、「置き換え済み」の表に移す（表がなければ作る）。

## 有効な ADR

| 番号                                                | タイトル                                                                                            | テーマ             | 更新日     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------ | ---------- |
| [ADR-001](ADR-001-doc-strategy.md)                  | 文書の方針                                                                                          | 文書               | 2026-11-08 |
| [ADR-002](ADR-002-storage-and-id.md)                | チケットの保存と ID                                                                                 | データ             | 2026-11-02 |
| [ADR-003](ADR-003-status-and-workflow.md)           | ステータスとワークフロー                                                                            | ワークフロー       | 2026-11-03 |
| [ADR-004](ADR-004-agents-and-state.md)              | エージェントと状態の記録                                                                            | エージェントと照合 | 2026-11-07 |
| [ADR-005](ADR-005-work-metrics.md)                  | 作業の実績                                                                                          | 作業の実績         | 2026-11-07 |
| [ADR-007](ADR-007-architecture.md)                  | アーキテクチャ                                                                                      | アーキテクチャ     | 2026-11-05 |
| [ADR-008](ADR-008-tech-stack.md)                    | 技術構成と開発環境                                                                                  | 技術構成           | 2026-11-06 |
| [ADR-009](ADR-009-epic-and-iteration.md)            | Epic と Iteration                                                                                   | チケットのまとまり | 2026-11-03 |
| [ADR-011](ADR-011-procedure-in-code.md)             | 既定の手続きは dg のコードが持つ                                                                    | ワークフロー       | 2026-11-07 |
| [ADR-024](ADR-024-oxlint-latest.md)                 | react(immutability) の指摘を直したので oxlint を最新に上げ、版を留めない                            | 技術構成           | 2026-11-08 |
| [ADR-025](ADR-025-runs-by-hooks.md)                 | Run は harness のフックが印で開け閉めし、step を終えた事実で閉じる                                  | エージェント       | 2026-11-08 |
| [ADR-026](ADR-026-guard-pr-and-data.md)             | PR とデータを守る正しい道は dg のコマンドにし、フックは語の有無で粗く止め、すり抜けは事後に見つける | エージェント       | 2026-11-08 |
| [ADR-027](ADR-027-screen-vscode-writes-and-asks.md) | 人の画面は VS Code 拡張にし、画面から書くのはチケット詳細と設定だけで、ほかはエージェントに頼む     | UI                 | 2026-11-08 |

## 置き換え済み

| 番号                                                   | 置き換えた先                                        |
| ------------------------------------------------------ | --------------------------------------------------- |
| [ADR-006](ADR-006-ui-and-writes.md)                    | [ADR-027](ADR-027-screen-vscode-writes-and-asks.md) |
| [ADR-010](ADR-010-ui-writes-and-agent-requests.md)     | [ADR-027](ADR-027-screen-vscode-writes-and-asks.md) |
| [ADR-012](ADR-012-hooks-open-runs.md)                  | [ADR-025](ADR-025-runs-by-hooks.md)                 |
| [ADR-013](ADR-013-review-result-on-run.md)             | [ADR-025](ADR-025-runs-by-hooks.md)                 |
| [ADR-014](ADR-014-subagent-stop-and-resume.md)         | [ADR-025](ADR-025-runs-by-hooks.md)                 |
| [ADR-015](ADR-015-interrupt-stale-session-runs.md)     | [ADR-025](ADR-025-runs-by-hooks.md)                 |
| [ADR-016](ADR-016-session-from-agent-env.md)           | [ADR-025](ADR-025-runs-by-hooks.md)                 |
| [ADR-017](ADR-017-review-result-binding-edge-cases.md) | [ADR-025](ADR-025-runs-by-hooks.md)                 |
| [ADR-018](ADR-018-fix-run-by-marker.md)                | [ADR-025](ADR-025-runs-by-hooks.md)                 |
| [ADR-019](ADR-019-pr-advance-through-dg.md)            | [ADR-026](ADR-026-guard-pr-and-data.md)             |
| [ADR-020](ADR-020-hook-coarse-raw-command.md)          | [ADR-026](ADR-026-guard-pr-and-data.md)             |
| [ADR-021](ADR-021-detect-outside-dg-changes.md)        | [ADR-026](ADR-026-guard-pr-and-data.md)             |
| [ADR-022](ADR-022-close-fix-run-on-open.md)            | [ADR-025](ADR-025-runs-by-hooks.md)                 |
| [ADR-023](ADR-023-screen-entry-vscode.md)              | [ADR-027](ADR-027-screen-vscode-writes-and-asks.md) |
