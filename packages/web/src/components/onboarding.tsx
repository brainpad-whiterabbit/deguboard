// dg init 前のリポジトリで、一覧の代わりに出す始め方の案内（UI-12）。サイドバーの幅（300px 前後）で読める縦の手順にする。
// ボタンはコマンドをコピーするだけで、データにもリポジトリにも書き込まない（ADR-010）。init の後は、見張りの読み直しで普段の画面に変わる

import { useHost } from "../host.js";
import { CopyableCode } from "./copyable-code.js";

/** 案内の手順。コマンドはコピーして、ターミナルで自分で実行する */
export const ONBOARDING_STEPS: { title: string; body: string; command: string }[] = [
  {
    title: "1. 初期化する",
    body: "このリポジトリにチケットを置く場所を作ります。ターミナルで実行します。",
    command: "dg init",
  },
  {
    title: "2. チケットを起こす",
    body: "やりたいことを 1 件のチケットにします。",
    command: 'dg ticket create "最初のチケット"',
  },
  {
    title: "3. エージェントに頼む",
    body: "Skill を入れると、エージェントが手順を読んでチケットを進めます。",
    command: "dg skill install",
  },
];

export function Onboarding() {
  // ブラウザには見張りがないので、init の後は読み直してもらう
  const browser = useHost().surface === "browser";
  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      <h2 id="onboarding-title">deguboard を始める</h2>
      <p className="muted">
        このリポジトリはまだ deguboard を使っていません。<code>dg</code> が PATH
        にあれば、次の順で始められます。コピーしてターミナルで実行してください。
      </p>
      <ol className="onboarding-steps">
        {ONBOARDING_STEPS.map((step) => (
          <li key={step.command}>
            <h3>{step.title}</h3>
            <p className="muted">{step.body}</p>
            <CopyableCode text={step.command} label={`${step.command} をコピー`} />
          </li>
        ))}
      </ol>
      <p className="muted">
        {browser
          ? "1 を済ませたら、ページを読み直してください。"
          : "1 を済ませると、開き直さなくてもいつもの画面に変わります。"}
      </p>
    </section>
  );
}
