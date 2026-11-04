// Iteration 詳細の「次の操作」の案内（UI-5）。Iteration の状態から、次にすることを一言で出し、頼める場合は依頼文をコピーするボタンを置く。
// 依頼文は core の ask コマンド（読み取りだけ）が作り、ここでは組み立て直さない。データには書き込まない（UI-7・UI-15）

import { useEffect, useMemo, useState } from "react";
import { COPY_NOTICE_MS } from "./copyable-code.js";
import { DetailLink } from "./parts.js";
import { carriedOverFrom } from "../pages/history.js";
import { useCommandData } from "../command-data.js";
import { useHost } from "../host.js";
import { useStore } from "../store.js";
import type { AskAction, AskView, HistoryLog, IterationDetail, Ticket } from "../types.js";
import { localDate } from "./iteration-parts.js";

/** 案内の種類。ready は全件が done か abandoned、overdue は終了日を過ぎて未完了あり、planned は始まる前、closed は持ち越しあり */
export type NextStep =
  | { kind: "ready" }
  | { kind: "overdue"; unfinished: number }
  | { kind: "planned" }
  | { kind: "closed"; carried: number };

/** 状態から案内を決める。案内が要らなければ null。today は YYYY-MM-DD（既定は手元の今日） */
export function nextStepOf(
  it: Pick<IterationDetail, "status" | "end" | "items" | "carried_over">,
  today: string = localDate(),
): NextStep | null {
  if (it.status === "planned") return { kind: "planned" };
  if (it.status === "closed")
    return it.carried_over ? { kind: "closed", carried: it.carried_over } : null;
  const unfinished = it.items.filter((t) => t.status !== "done" && t.status !== "abandoned").length;
  if (it.items.length > 0 && unfinished === 0) return { kind: "ready" };
  if (unfinished > 0 && it.end && it.end.slice(0, 10) < today)
    return { kind: "overdue", unfinished };
  return null;
}

/** 案内から頼む依頼文の頼むことと指示 */
function askOf(step: NextStep): { action: AskAction; note?: string } | null {
  if (step.kind === "ready") return { action: "release" };
  if (step.kind === "overdue")
    return {
      action: "close",
      note: `終了日を過ぎて未完了が ${step.unfinished} 件ある。閉じる前に、持ち越すか続けるかを相談したい`,
    };
  return null;
}

export function IterationNext({ it }: { it: IterationDetail }) {
  const step = nextStepOf(it);
  if (!step) return null;
  return (
    <div className="iteration-next" role="note">
      <NextText step={step} it={it} />
      <AskCopy id={it.id} ask={askOf(step)} />
    </div>
  );
}

function NextText({ step, it }: { step: NextStep; it: IterationDetail }) {
  if (step.kind === "ready") return <span>全件が終わっています。リリースできます</span>;
  if (step.kind === "overdue")
    return <span>終了日を過ぎ、未完了が {step.unfinished} 件あります。持ち越しを相談できます</span>;
  if (step.kind === "planned")
    return <span>最初のチケットを着手（claim）すると active になります</span>;
  return <CarriedLinks id={it.id} carried={step.carried} />;
}

/** 閉じた Iteration で持ち越したチケットの、今の Iteration へのリンク（持ち越しは履歴から求める。履歴の画面と同じ） */
function CarriedLinks({ id, carried }: { id: string; carried: number }) {
  const store = useStore();
  const { data } = useCommandData<HistoryLog>("history", {});
  const rows = useMemo(() => {
    if (!data) return null;
    const byId = new Map<string, Ticket>(store.tickets.map((t) => [t.id, t]));
    return carriedOverFrom(id, data.events, store.tickets).flatMap((tid) => byId.get(tid) ?? []);
  }, [data, id, store.tickets]);
  return (
    <span>
      持ち越し {carried} 件
      {rows && rows.length > 0 ? (
        <>
          ：
          {rows.map((t, n) => (
            <span key={t.id}>
              {n > 0 ? "、" : ""}
              {t.id} →{" "}
              {t.iteration ? (
                <DetailLink route={{ page: "iterations", id: t.iteration }}>
                  {t.iteration}
                </DetailLink>
              ) : (
                "Iteration なし"
              )}
            </span>
          ))}
        </>
      ) : null}
    </span>
  );
}

/** 依頼文をコピーするボタン。押したときに ask で依頼文を引いてコピーする（組み立ては core） */
function AskCopy({ id, ask }: { id: string; ask: ReturnType<typeof askOf> }) {
  const host = useHost();
  const { client } = useStore();
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), COPY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [result]);
  if (!ask) return null;
  return (
    <>
      <button
        type="button"
        title="エージェントに頼む依頼文をコピーする（書き込みはしない）"
        onClick={() =>
          void client
            .run<AskView>("ask", { targets: [id], ...ask, format: "skill" })
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
