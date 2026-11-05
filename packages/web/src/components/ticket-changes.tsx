// チケット詳細の「変更」の節（UI-4）。作業ブランチのあるチケットに「変更を見る」を出し、押すと ticket.changes で
// base（git.base_branch）との merge-base からの変わったファイルを、種類（A・M・D・R の印）と行数つきで出す。読むだけで書き込まない。
// VS Code（Webview）ではファイルを押すと拡張ホストが差分エディタを開き、ブラウザ（dg serve）には差分エディタがないので一覧だけを出す。
// 押すまでは読まない（git diff を詳細を開くたびに走らせない）。開いた後は一覧の読み直し（同期のあと）で読み直す

import { useState } from "react";
import { useCommandData } from "../command-data.js";
import { useHost } from "../host.js";
import type { BranchChanges, ChangedFile, ChangeKind } from "../types.js";

const KIND_MARK: Record<ChangeKind, { mark: string; label: string }> = {
  added: { mark: "A", label: "追加" },
  modified: { mark: "M", label: "変更" },
  deleted: { mark: "D", label: "削除" },
  renamed: { mark: "R", label: "名前の変更" },
  copied: { mark: "C", label: "写し" },
};

export function TicketChanges({ ticket }: { ticket: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="changes">
      <h2>
        変更
        <button type="button" className="changes-toggle" onClick={() => setOpen(!open)}>
          {open ? "閉じる" : "変更を見る"}
        </button>
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
  if (!data) return <p className="muted">読み込み中…</p>;
  const total = data.files.reduce(
    (sum, f) => ({ add: sum.add + (f.additions ?? 0), del: sum.del + (f.deletions ?? 0) }),
    { add: 0, del: 0 },
  );
  const openDiff = host.openDiff;
  return (
    <>
      <p className="changes-summary muted">
        <code>
          {data.base_ref}...{data.head_ref}
        </code>{" "}
        {data.files.length} ファイル <span className="changes-add">+{total.add}</span>{" "}
        <span className="changes-del">−{total.del}</span>
        {openDiff ? null : "（差分は VS Code で開ける）"}
      </p>
      {data.files.length === 0 ? (
        <p className="empty">{data.base_ref} との間に変更はない</p>
      ) : (
        <ul className="changes-list">
          {data.files.map((f) => (
            <li key={`${f.old_path ?? ""}\0${f.path}`}>
              {openDiff ? (
                <button
                  type="button"
                  className="changes-file"
                  title={`${f.path} の差分を開く`}
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
        {failed ? "差分を開けない" : ""}
      </span>
    </>
  );
}

function FileRow({ file: f }: { file: ChangedFile }) {
  const kind = KIND_MARK[f.kind];
  return (
    <>
      <abbr className={`change-kind change-${f.kind}`} title={kind.label}>
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
          <span className="muted">バイナリ</span>
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
