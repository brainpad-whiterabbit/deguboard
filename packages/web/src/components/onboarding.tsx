// dg init 前のリポジトリで、一覧の代わりに出す始め方の案内（UI-12）。サイドバーの幅（300px 前後）で読める縦の手順にする。
// VS Code の中では「このリポジトリで始める」ボタンが、専用の新しいターミナルで init・skill install・hooks install を実行する（拡張ホストに頼む）。
// dg serve のブラウザにはボタンがなく、コマンドをコピーするだけ（ADR-027）。init の後は、見張りの読み直しで普段の画面に変わる

import { CopyableCode } from "./copyable-code.js";
import { useHost } from "../host.js";
import { tr, msg } from "../l10n.js";
import { trNode } from "../l10n-node.js";

/** 案内の手順。コマンドはコピーして、ターミナルで自分で実行する */
export const ONBOARDING_STEPS: { title: string; body: string; command: string }[] = [
  {
    title: msg("1. 初期化する"),
    body: msg("このリポジトリにチケットを置く場所を作ります。ターミナルで実行します。"),
    command: "dg init",
  },
  {
    title: msg("2. チケットを起こす"),
    body: msg("やりたいことを 1 件のチケットにします。"),
    command: msg('dg ticket create "最初のチケット"'),
  },
  {
    title: msg("3. エージェントに頼む"),
    body: msg("Skill を入れると、エージェントが手順を読んでチケットを進めます。"),
    command: "dg skill install",
  },
];

export function Onboarding() {
  const { startRepository } = useHost();
  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      <h2 id="onboarding-title">{tr("deguboard を始める")}</h2>
      {startRepository ? (
        <>
          <p className="muted">
            {tr(
              "このリポジトリはまだ deguboard を使っていません。下のボタンを押すと、専用のターミナルで dg init・dg skill install・dg hooks install を順に実行します。dg が PATH になくても動きます。",
            )}
          </p>
          <button type="button" className="primary" onClick={() => void startRepository()}>
            {tr("このリポジトリで始める")}
          </button>
          <p className="muted">
            {tr("手で進めるなら、次のコマンドをコピーしてターミナルで実行してください。")}
          </p>
        </>
      ) : (
        <p className="muted">
          {trNode(
            "このリポジトリはまだ deguboard を使っていません。{0} が PATH にあれば、次の順で始められます。コピーしてターミナルで実行してください。",
            <code>dg</code>,
          )}
        </p>
      )}
      <ol className="onboarding-steps">
        {ONBOARDING_STEPS.map((step) => (
          <li key={step.command}>
            <h3>{tr(step.title)}</h3>
            <p className="muted">{tr(step.body)}</p>
            <CopyableCode text={tr(step.command)} label={tr("{0} をコピー", tr(step.command))} />
          </li>
        ))}
      </ol>
      <p className="muted">{tr("1 を済ませると、開き直さなくてもいつもの画面に変わります。")}</p>
    </section>
  );
}
