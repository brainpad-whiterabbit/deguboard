// エージェントに頼む対象の組の鍵（UI-15）。対象の ID を空白でつなぎ、場所（within）があれば @ を付けて後ろに置く。
// core の askMenuKey・parseAskMenuKey の写し（web は core の実行時のコードを取り込まない）。同じ結果になることを ask-key.test.ts で確かめる。
// ask-menu の key・右クリックの文脈の askTargets・拡張が埋める data-ask・画面の今の対象は、どれもこの書式で文字列にする

/** 対象の組の鍵。core の ask-menu が返す key と同じ形 */
export function askKey(targets: readonly string[], within?: string): string {
  return [...targets, ...(within ? [`@${within}`] : [])].join(" ");
}

/** 鍵を対象と場所（@ を付けた 1 つ。重ねたら後のもの）に分ける */
export function parseAskKey(key: string): { targets: string[]; within: string | undefined } {
  const tokens = key.split(/\s+/).filter(Boolean);
  const within = tokens
    .filter((t) => t.startsWith("@"))
    .at(-1)
    ?.slice(1);
  return { targets: tokens.filter((t) => !t.startsWith("@")), within };
}
