// 設定画面の「Workflow」のタブ（UI-14）。今効いている workflow.yaml を読むだけで出す。入力欄も保存の操作も置かない。
// workflow.show の sections（core が省いた値を既定で埋め、行ごとに既定と違うかを決めたもの）を写すだけで、画面は Workflow を解釈しない。
// 節は workflow.yaml の最上位の項目（states・boundaries・exceptions・wip・flow・governance）、行はその下の値で、
// guide.notes.* の表と同じく名前とキーを左、値を右に置く。既定と違う行にはほかの項目と同じ左の線と「変更あり」（title に既定の値）を、
// 独自の段階には「独自の段階」の札と after・guide を付ける。
// 変更は画面でしない：行と節の見出しの頼む吹き出しから、workflow.<key> を core の ask に渡して /dgconfig に頼む
// （エージェントが前と後の差を見せ、人の承認を得てから dg workflow set で書く。値の意味も頼んで聞く）

import { msg, shownDefaultText, tr } from "../l10n.js";
import { ASK_SECTIONS, AskSpotBox } from "../components/ask-menu.js";
import type { WorkflowRow, WorkflowSection, WorkflowView } from "../types.js";

/** 行と節から頼むときに渡す項目の頭（core の ask の key：workflow.<key>。ASK_WORKFLOW_KEY の写しで、一致はテストが確かめる） */
export const WORKFLOW_ITEM_PREFIX = "workflow.";

/**
 * 節の名前と要約。鍵は workflow.yaml の最上位の項目（core の workflowSections の節の key）。
 * ない節は key をそのまま出す（どの節にも名前があることをテストが確かめる）
 */
const SECTIONS: Record<string, { label: string; summary: string }> = {
  states: {
    label: msg("状態"),
    summary: msg("Status の表示名。Status は 5 つで、増やせない"),
  },
  boundaries: {
    label: msg("境目"),
    summary: msg("前へ進む 3 つの境目ごとの、越える条件（requires）と決める人（decide）"),
  },
  exceptions: {
    label: msg("例外"),
    summary: msg("流れの外の動き（やめる・前へ戻す・終わったものを戻す）を決める人"),
  },
  wip: {
    label: msg("WIP の上限"),
    summary: msg("列ごとのチケットの数の上限。超えると知らせるだけで、着手は止めない"),
  },
  flow: {
    label: msg("流れの段階"),
    summary: msg("流れの段階ごとの決める人と、流れから外す段階（skip）。独自の段階も足せる"),
  },
  governance: {
    label: msg("カンバンの管理"),
    summary: msg("カンバンを管理する操作を決める人"),
  },
};

/**
 * 行の名前。鍵は core の workflowSections の行の key。ない行（独自の段階）は key の最後の部分をそのまま出す
 * （core が返すどの行にも名前があることをテストが確かめる）
 */
const ROW_NAMES: Record<string, string> = {
  "states.todo.label": msg("todo の表示名"),
  "states.in_progress.label": msg("in_progress の表示名"),
  "states.review.label": msg("review の表示名"),
  "states.done.label": msg("done の表示名"),
  "states.abandoned.label": msg("abandoned の表示名"),
  "boundaries.todo.in_progress.requires": msg("着手（todo → in_progress）の条件"),
  "boundaries.todo.in_progress.decide": msg("着手（todo → in_progress）を決める人"),
  "boundaries.in_progress.review.requires": msg("見直しに出す（in_progress → review）の条件"),
  "boundaries.in_progress.review.decide": msg("見直しに出す（in_progress → review）を決める人"),
  "boundaries.review.done.requires": msg("完了（review → done）の条件"),
  "boundaries.review.done.decide": msg("完了（review → done）を決める人"),
  "exceptions.abandon": msg("やめる（abandoned へ動かす）"),
  "exceptions.back": msg("前の Status へ戻す"),
  "exceptions.reopen": msg("終わったチケットを戻す"),
  "wip.todo": msg("todo の列の上限"),
  "wip.in_progress": msg("in_progress の列の上限"),
  "wip.review": msg("review の列の上限"),
  "wip.done": msg("done の列の上限"),
  "wip.abandoned": msg("abandoned の列の上限"),
  "flow.assign": msg("割り当て"),
  "flow.check": msg("点検"),
  "flow.plan": msg("計画"),
  "flow.audit": msg("リポジトリの見直し"),
  "flow.release": msg("リリース"),
  "flow.retro": msg("振り返り"),
  "flow.skip": msg("流れから外す段階"),
  "governance.delete": msg("チケットの削除"),
  "governance.config": msg("チームの設定の変更"),
  "governance.reassign": msg("ほかのユーザの担当の変更"),
  "governance.epic": msg("Epic を閉じる・再開する"),
  "governance.create": msg("チケットの起票"),
};

/** 節の名前（今の言語）。知らない節は key */
export function workflowSectionName(key: string): string {
  const found = Object.hasOwn(SECTIONS, key) ? SECTIONS[key] : undefined;
  return found === undefined ? key : tr(found.label);
}

/** 行の名前（今の言語）。知らない行（独自の段階）は key の最後の部分 */
export function workflowRowName(key: string): string {
  const name = Object.hasOwn(ROW_NAMES, key) ? ROW_NAMES[key] : undefined;
  return name === undefined ? (key.split(".").at(-1) ?? key) : tr(name);
}

/** 値の短い書き方。リストは [a, b]、空のリストは「空」、上限のない列（null）は「上限なし」 */
function valueText(value: WorkflowRow["value"] | undefined): string {
  if (value === null || value === undefined) return tr("上限なし");
  if (Array.isArray(value)) return value.length === 0 ? tr("空") : `[${value.join(", ")}]`;
  return String(value);
}

/**
 * 行に出す値。既定のままの値は、訳のある既定（Status の表示名）なら表示言語の訳で出す（UI-11）。
 * 既定のままかは core の modified で決め、画面では比べない
 */
function shownValue(row: WorkflowRow): string {
  return valueText(
    row.modified ? row.value : (shownDefaultText(row.value) as WorkflowRow["value"]),
  );
}

/**
 * 検索語で節と行を絞る（大文字小文字は区別しない）。節の名前か key に当たればその節の行をすべて、
 * そうでなければ名前・key（workflow. を付けた形でも）・値・独自の段階の after と guide に当たった行だけを出す。行のない節は出さない。検索語が空ならすべて
 */
export function workflowMatches(
  sections: readonly WorkflowSection[],
  query: string,
): WorkflowSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...sections];
  const hit = (s: string | undefined) => s !== undefined && s.toLowerCase().includes(q);
  return sections.flatMap((section) => {
    if (hit(workflowSectionName(section.key)) || hit(section.key)) return [section];
    const rows = section.rows.filter((r) =>
      [
        workflowRowName(r.key),
        `${WORKFLOW_ITEM_PREFIX}${r.key}`,
        shownValue(r),
        r.custom?.after,
        r.custom?.guide,
      ].some(hit),
    );
    return rows.length > 0 ? [{ ...section, rows }] : [];
  });
}

/** Workflow のタブの中身。workflow は store が読んだ workflow.show（読み終えるまでと、行を持たない前の版の cache では読み込み中を出す） */
export function WorkflowPanel({
  workflow,
  query,
}: {
  workflow: WorkflowView | null;
  query: string;
}) {
  const sections = workflow?.sections;
  if (!sections) return <p className="muted">{tr("読み込み中…")}</p>;
  const shown = workflowMatches(sections, query);
  return (
    <>
      {workflow.exists === false ? (
        <p className="config-hint config-workflow-missing muted">
          {tr("workflow.yaml がないので、どの値も既定の値")}
        </p>
      ) : null}
      {shown.length === 0 ? <p className="empty">{tr("該当する設定がない")}</p> : null}
      {shown.map((section) => (
        <section
          key={section.key}
          className="config-group config-workflow-group"
          aria-labelledby={`config-workflow-${section.key}`}
          data-section={section.key}
        >
          {/* 節の見出しからは、その項目の全体の説明と変更を頼む（項目は workflow.<項目>。候補と依頼文は core の ask が決める） */}
          <AskSpotBox
            className="config-section-head"
            targets={[]}
            label={tr("Workflow の節 {0}", section.key)}
            section={ASK_SECTIONS.configRow}
            item={`${WORKFLOW_ITEM_PREFIX}${section.key}`}
          >
            <h3 id={`config-workflow-${section.key}`}>{workflowSectionName(section.key)}</h3>
            <code className="config-key">{section.key}</code>
          </AskSpotBox>
          <div className="config-notes">
            {Object.hasOwn(SECTIONS, section.key) ? (
              <p className="config-summary muted">{tr(SECTIONS[section.key]!.summary)}</p>
            ) : null}
            <table className="config-notes-table">
              <tbody>
                {section.rows.map((row) => (
                  <WorkflowRowView key={row.key} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

/** 値 1 つの行。左に名前とキー（頼む吹き出しつき）、右に値と札。読むだけで入力欄は置かない */
function WorkflowRowView({ row }: { row: WorkflowRow }) {
  const { value } = row;
  return (
    <tr
      className={`config-field config-note${row.modified ? " modified" : ""}`}
      data-key={`${WORKFLOW_ITEM_PREFIX}${row.key}`}
    >
      <AskSpotBox
        as="th"
        scope="row"
        targets={[]}
        label={tr("Workflow の項目 {0}", row.key)}
        section={ASK_SECTIONS.configRow}
        item={`${WORKFLOW_ITEM_PREFIX}${row.key}`}
      >
        <span className="config-name">{workflowRowName(row.key)}</span>
        <code className="config-key">{row.key}</code>
      </AskSpotBox>
      <td>
        <div className="config-field-head config-workflow-value">
          {value === null || (Array.isArray(value) && value.length === 0) ? (
            <span className="muted">{shownValue(row)}</span>
          ) : Array.isArray(value) ? (
            value.map((v) => <code key={v}>{v}</code>)
          ) : (
            <code>{shownValue(row)}</code>
          )}
          {row.custom ? (
            <span className="badge config-custom-stage">{tr("独自の段階")}</span>
          ) : row.modified ? (
            <span
              className="badge config-modified"
              title={tr(
                "既定は {0}",
                valueText(shownDefaultText(row.default) as WorkflowRow["value"]),
              )}
            >
              {tr("変更あり")}
            </span>
          ) : null}
        </div>
        {row.custom ? (
          <p className="config-hint config-workflow-custom muted">
            <code className="config-key">after</code> <code>{row.custom.after}</code>{" "}
            <code className="config-key">guide</code> <code>{row.custom.guide}</code>
          </p>
        ) : null}
      </td>
    </tr>
  );
}
