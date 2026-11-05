import { useState } from "react";
import { useCommandData } from "../command-data.js";
import { useHost } from "../host.js";
import type { BranchChanges, ChangedFile, ChangeKind } from "../types.js";
import { tr, msg } from "../l10n.js";
import { trNode } from "../l10n-node.js";

const KIND_MARK: Record<ChangeKind, { mark: string; label: string }> = {
  added: { mark: "A", label: msg("追加") },
  modified: { mark: "M", label: msg("変更") },
  deleted: { mark: "D", label: msg("削除") },
  renamed: { mark: "R", label: msg("名前の変更") },
  copied: { mark: "C", label: msg("写し") },
};

export function TicketChanges({ ticket }: { ticket: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="changes">
      <h2>
        {trNode(
          "変更{0}",
          <button type="button" className="changes-toggle" onClick={() => setOpen(!open)}>
            {open ? tr("閉じる") : tr("変更を見る")}
          </button>,
        )}
      </h2>
      {open ? <ChangesList ticket={ticket} /> : null}
    </section>
  );
}

function ChangesList({ ticket }: { ticket: string }) {
  const host = useHost();
  const { data, error } = useCommandData<BranchChanges>("ticket.changes", { ticket });
  const [failed, setFailed] = useState(false);
  // 一覧を出せない理由（ブランチがない・base がない）は core の message をそのまま出す
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">{tr("読み込み中…")}</p>;
  const total = data.files.reduce(
    (sum, f) => ({ add: sum.add + (f.additions ?? 0), del: sum.del + (f.deletions ?? 0) }),
    { add: 0, del: 0 },
  );
  const openDiff = host.openDiff;
  return (
    <>
      <p className="changes-summary muted">
        {trNode(
          "{0}{1}{2} ファイル {3}{4}{5}{6}",
          <code>
            {data.base_ref}...{data.head_ref}
          </code>,
          " ",
          data.files.length,
          <span className="changes-add">+{total.add}</span>,
          " ",
          <span className="changes-del">−{total.del}</span>,
          openDiff ? null : tr("（差分は VS Code で開ける）"),
        )}
      </p>
      {data.files.length === 0 ? (
        <p className="empty">{trNode("{0} との間に変更はない", data.base_ref)}</p>
      ) : (
        <ul className="changes-list">
          {data.files.map((f) => (
            <li key={`${f.old_path ?? ""}\0${f.path}`}>
              {openDiff ? (
                <button
                  type="button"
                  className="changes-file"
                  title={tr("{0} の差分を開く", f.path)}
                  onClick={() => {
                    setFailed(false);
                    openDiff({
                      ticket,
                      path: f.path,
                      old_path: f.old_path,
                      base_commit: data.base_commit,
                      head_commit: data.head_commit,
                    }).catch(() => setFailed(true));
                  }}
                >
                  <FileRow file={f} />
                </button>
              ) : (
                <div className="changes-file">
                  <FileRow file={f} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <span className="muted" role="status" aria-live="polite">
        {failed ? tr("差分を開けない") : ""}
      </span>
    </>
  );
}

function FileRow({ file: f }: { file: ChangedFile }) {
  const kind = KIND_MARK[f.kind];
  return (
    <>
      <abbr className={`change-kind change-${f.kind}`} title={tr(kind.label)}>
        {kind.mark}
      </abbr>
      <span className="changes-path">
        {f.old_path ? (
          <>
            <span className="muted">{f.old_path} → </span>
            {f.path}
          </>
        ) : (
          f.path
        )}
      </span>
      <span className="changes-stat">
        {f.binary ? (
          <span className="muted">{tr("バイナリ")}</span>
        ) : (
          <>
            <span className="changes-add">+{f.additions}</span>{" "}
            <span className="changes-del">−{f.deletions}</span>
          </>
        )}
      </span>
    </>
  );
}
