import { CopyResult, useCopyNotice } from "./copyable-code.js";
import { ASK_FORMAT_KEY, chosenAskFormat } from "./ask-composer.js";
import { DetailLink } from "./parts.js";
import { useHost } from "../host.js";
import { useStore } from "../store.js";
import type { AskAction, AskView, IterationDetail } from "../types.js";
import { tr, trNode } from "../l10n.js";

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
      return <span>{tr("全件が終わっています。リリースできます")}</span>;
    case "overdue":
      return (
        <span>
          {trNode("終了日を過ぎ、未完了が {0} 件あります。持ち越しを相談できます", next.unfinished)}
        </span>
      );
    case "planned":
      return (
        <span>
          {tr("ほかに active がなければ、最初のチケットを着手（claim）すると active になります")}
        </span>
      );
    case "closed":
      return (
        <span>
          {tr("持ち越し ")}
          {next.carried}
          {tr(" 件")}
          {next.moved.length > 0 ? (
            <>
              {trNode(
                "：{0}",
                next.moved.map((t, n) => (
                  <span key={t.id}>
                    {n > 0 ? tr("、") : ""}
                    {t.id} →{" "}
                    {t.iteration ? (
                      <DetailLink route={{ page: "iterations", id: t.iteration }}>
                        {t.iteration}
                      </DetailLink>
                    ) : t.status === "done" || t.status === "abandoned" ? (
                      tr("{0}済み", t.status === "done" ? tr("完了") : tr("中止"))
                    ) : (
                      tr("Iteration なし")
                    )}
                  </span>
                )),
              )}
            </>
          ) : null}
          {/* 履歴（コミット済みの変更）から求めるので、batch でまだコミットしていない分は出ない */}
          {next.moved.length < next.carried ? (
            <span className="muted">{tr("（持ち越し先はコミットすると出ます）")}</span>
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
        title={tr("エージェントに頼む依頼文をコピーする（書き込みはしない）")}
        onClick={() => {
          const format = chosenAskFormat(host.state.get<unknown>(ASK_FORMAT_KEY));
          track(
            client
              .run<AskView>("ask", { targets: [id], action, ...(format ? { format } : {}) })
              .then((r) => host.copy(r.data.text)),
          );
        }}
      >
        {tr("依頼文をコピー")}
      </button>
      <CopyResult result={result} />
    </>
  );
}
