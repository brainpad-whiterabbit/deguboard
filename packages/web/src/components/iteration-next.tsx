// Iteration 詳細の「次の操作」の案内（UI-5）。何を案内するか・どの頼むことで頼むかは core（iteration.show の next）が決め、
// ここは種類ごとの文を出し、頼めるものは core の ask コマンドで作った依頼文をコピーするボタンを置くだけ。データには書き込まない（UI-7・UI-15）

import { CopyResult, useCopyNotice } from "./copyable-code.js";
import { ASK_FORMAT_KEY } from "./ask-composer.js";
import { DetailLink } from "./parts.js";
import { useHost } from "../host.js";
import { useStore } from "../store.js";
import type { AskAction, AskFormat, AskView, IterationDetail } from "../types.js";

type Next = NonNullable<IterationDetail["next"]>;

export function IterationNext({ it }: { it: IterationDetail }) {
  const next = it.next;
  if (!next) return null;
  return (
    <div className="iteration-next" role="note">
      <NextText next={next} />
      <AskCopy id={it.id} action={next.ask} />
    </div>
  );
}

function NextText({ next }: { next: Next }) {
  switch (next.kind) {
    case "ready":
      return <span>全件が終わっています。リリースできます</span>;
    case "overdue":
      return (
        <span>終了日を過ぎ、未完了が {next.unfinished} 件あります。持ち越しを相談できます</span>
      );
    case "planned":
      return (
        <span>ほかに active がなければ、最初のチケットを着手（claim）すると active になります</span>
      );
    case "closed":
      return (
        <span>
          持ち越し {next.carried} 件
          {next.moved.length > 0 ? (
            <>
              ：
              {next.moved.map((t, n) => (
                <span key={t.id}>
                  {n > 0 ? "、" : ""}
                  {t.id} →{" "}
                  {t.iteration ? (
                    <DetailLink route={{ page: "iterations", id: t.iteration }}>
                      {t.iteration}
                    </DetailLink>
                  ) : t.status === "done" || t.status === "abandoned" ? (
                    `${t.status === "done" ? "完了" : "中止"}済み`
                  ) : (
                    "Iteration なし"
                  )}
                </span>
              ))}
            </>
          ) : null}
          {/* 履歴（コミット済みの変更）から求めるので、batch でまだコミットしていない分は出ない */}
          {next.moved.length < next.carried ? (
            <span className="muted">（持ち越し先はコミットすると出ます）</span>
          ) : null}
        </span>
      );
  }
}

/** 依頼文をコピーするボタン。押したときに ask で依頼文を引いてコピーする（組み立ては core）。
 *  形式は頼む小窓で人が切り替えたもの（ASK_FORMAT_KEY）に従い、選んでいなければ渡さず ask の既定（Skill の有無）に任せる */
function AskCopy({ id, action }: { id: string; action: AskAction | null }) {
  const host = useHost();
  const { client } = useStore();
  const { result, track } = useCopyNotice();
  if (!action) return null;
  return (
    <>
      <button
        type="button"
        title="エージェントに頼む依頼文をコピーする（書き込みはしない）"
        onClick={() => {
          const format = host.state.get<AskFormat>(ASK_FORMAT_KEY);
          track(
            client
              .run<AskView>("ask", { targets: [id], action, ...(format ? { format } : {}) })
              .then((r) => host.copy(r.data.text)),
          );
        }}
      >
        依頼文をコピー
      </button>
      <CopyResult result={result} />
    </>
  );
}
