// チケット詳細のブランチの下に出す、作業ブランチの worktree のパスと「新しいウィンドウで開く」（UI-4）。
// ボタンは Webview（拡張ホストが新しいウィンドウを開ける）だけに出し、ブラウザ（dg serve）ではパスとコピーだけにする

import { useState } from "react";
import { useHost } from "../host.js";
import { CopyableCode } from "./copyable-code.js";
import { tr } from "../l10n.js";

export function WorktreeRow({ ticket, path }: { ticket: string; path: string }) {
  const host = useHost();
  const [failed, setFailed] = useState(false);
  const open = host.openWorktree;
  return (
    <div className="worktree-row">
      <CopyableCode text={path} label={tr("worktree のパスをコピー")} />
      {open ? (
        <button
          type="button"
          className="worktree-open"
          onClick={() => {
            setFailed(false);
            open(ticket).catch(() => setFailed(true));
          }}
        >
          {tr("新しいウィンドウで開く")}
        </button>
      ) : null}
      <span className="muted" role="status" aria-live="polite">
        {failed ? tr("開けない") : ""}
      </span>
    </div>
  );
}
