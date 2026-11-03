// code で出す値と、その右に値をクリップボードに入れる小さなボタン（チケット詳細のブランチ名）。コピーは host に任せ
// （Webview では拡張ホストに頼む道もある）、押した後しばらく「コピーした」（だめなら「コピーできない」）を下に出す。
// 長い値は折り返し、ボタンは値の右に残す

import { useEffect, useState } from "react";
import { useHost } from "../host.js";

/** 結果の文言を出しておく時間（ミリ秒） */
export const COPY_NOTICE_MS = 1500;

export function CopyableCode({ text, label }: { text: string; label: string }) {
  const host = useHost();
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), COPY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [result]);
  return (
    <span className="copyable">
      <span className="copyable-line">
        <code>{text}</code>
        <button
          type="button"
          className="copy-button"
          aria-label={label}
          title={label}
          onClick={() =>
            void host.copy(text).then(
              () => setResult("copied"),
              () => setResult("failed"),
            )
          }
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
            <path d="M3.5 10.5h-1v-8h8v1" />
          </svg>
        </button>
      </span>
      <span className="copy-result muted" role="status" aria-live="polite">
        {result === "copied" ? "コピーした" : result === "failed" ? "コピーできない" : ""}
      </span>
    </span>
  );
}
