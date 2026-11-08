// チケット詳細のブランチの下に出す、作業ブランチの worktree のパスとコピー（UI-4）

import { CopyableCode } from "./copyable-code.js";
import { tr } from "../l10n.js";

export function WorktreeRow({ path }: { path: string }) {
  return (
    <div className="worktree-row">
      <CopyableCode text={path} label={tr("worktree のパスをコピー")} />
    </div>
  );
}
