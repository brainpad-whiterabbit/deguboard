import { useHost } from "../host.js";
import { CopyableCode } from "./copyable-code.js";
import { tr, trNode, msg } from "../l10n.js";

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
  // ブラウザには見張りがないので、init の後は読み直してもらう
  const browser = useHost().surface === "browser";
  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      <h2 id="onboarding-title">{tr("deguboard を始める")}</h2>
      <p className="muted">
        {trNode(
          "このリポジトリはまだ deguboard を使っていません。{0} が PATH にあれば、次の順で始められます。コピーしてターミナルで実行してください。",
          <code>dg</code>,
        )}
      </p>
      <ol className="onboarding-steps">
        {ONBOARDING_STEPS.map((step) => (
          <li key={step.command}>
            <h3>{step.title}</h3>
            <p className="muted">{step.body}</p>
            <CopyableCode text={step.command} label={tr("{0} をコピー", step.command)} />
          </li>
        ))}
      </ol>
      <p className="muted">
        {browser
          ? tr("1 を済ませたら、ページを読み直してください。")
          : tr("1 を済ませると、開き直さなくてもいつもの画面に変わります。")}
      </p>
    </section>
  );
}
