import { useEffect, useState } from "react";
import { useHost } from "../host.js";
import { tr } from "../l10n.js";

/** 結果の文言を出しておく時間（ミリ秒） */
export const COPY_NOTICE_MS = 1500;

/** コピーの結果（コピーした・コピーできない）を COPY_NOTICE_MS だけ持つ。track に渡した Promise の成否で結果を決める */
export function useCopyNotice() {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), COPY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [result]);
  const track = (copying: Promise<unknown>) =>
    void copying.then(
      () => setResult("copied"),
      () => setResult("failed"),
    );
  return { result, track };
}

/** コピーの結果を読み上げ付きで出す span（結果がないときは空） */
export function CopyResult({ result }: { result: "copied" | "failed" | null }) {
  return (
    <span className="copy-result muted" role="status" aria-live="polite">
      {result === "copied" ? tr("コピーした") : result === "failed" ? tr("コピーできない") : ""}
    </span>
  );
}

export function CopyableCode({ text, label }: { text: string; label: string }) {
  const host = useHost();
  const { result, track } = useCopyNotice();
  return (
    <span className="copyable">
      <span className="copyable-line">
        <code>{text}</code>
        <button
          type="button"
          className="copy-button"
          aria-label={label}
          title={label}
          onClick={() => track(host.copy(text))}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
            <path d="M3.5 10.5h-1v-8h8v1" />
          </svg>
        </button>
      </span>
      <CopyResult result={result} />
    </span>
  );
}
