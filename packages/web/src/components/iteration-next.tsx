// Iteration 詳細の「次の操作」の案内（UI-5）。何を案内するか・どの頼むことで頼むかは core（iteration.show の next）が決め、
// ここは種類ごとの文を出し、頼めるものは core の ask コマンドで作った依頼文をコピーするボタンを置くだけ。データには書き込まない（UI-7・UI-15）

import { useEffect, useState } from "react";
import { COPY_NOTICE_MS } from "./copyable-code.js";
import { DetailLink } from "./parts.js";
import { useHost } from "../host.js";
import { useStore } from "../store.js";
import type { AskAction, AskView, IterationDetail } from "../types.js";

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

/** 依頼文をコピーするボタン。押したときに ask で依頼文を引いてコピーする（組み立ては core） */
function AskCopy({ id, action }: { id: string; action: AskAction | null }) {
  const host = useHost();
  const { client } = useStore();
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), COPY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [result]);
  if (!action) return null;
  return (
    <>
      <button
        type="button"
        title="エージェントに頼む依頼文をコピーする（書き込みはしない）"
        onClick={() =>
          void client
            .run<AskView>("ask", { targets: [id], action, format: "skill" })
            .then((r) => host.copy(r.data.text))
            .then(
              () => setResult("copied"),
              () => setResult("failed"),
            )
        }
      >
        依頼文をコピー
      </button>
      <span className="copy-result muted" role="status" aria-live="polite">
        {result === "copied" ? "コピーした" : result === "failed" ? "コピーできない" : ""}
      </span>
    </>
  );
}
