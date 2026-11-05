// 画面の言語の切り替え（t383）。dg serve は <html data-language> を付けないので日本語で出る。
// VS Code の拡張ホストが付ける data-language を、ページのスクリプトより前に付けて英語の画面にする

import type { BrowserContext } from "playwright-core";

/** 確かめる画面の言語。ja は dg serve のまま（data-language を付けない） */
export const LANGUAGES = ["ja", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

/** context で開くページの <html> に data-language を付ける。ja なら何もしない */
export async function useLanguage(context: BrowserContext, language: Language): Promise<void> {
  if (language === "ja") return;
  await context.addInitScript((value: string) => {
    // 初期化のスクリプトは <html> ができる前に走ることがあるので、できたときに付ける
    const set = () => {
      if (!document.documentElement) return false;
      document.documentElement.dataset["language"] = value;
      return true;
    };
    if (!set())
      new MutationObserver((_, observer) => {
        if (set()) observer.disconnect();
      }).observe(document, { childList: true });
  }, language);
}
