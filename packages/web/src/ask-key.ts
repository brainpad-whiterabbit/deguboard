// エージェントに頼む対象の組の鍵（UI-15）。対象の ID を空白でつなぎ、場所（within）があれば @ を、頼む場所（place）があれば # を付けて後ろに置く。
// core の askMenuKey・parseAskMenuKey の写し（web は core の実行時のコードを取り込まない）。同じ結果になることを ask-key.test.ts で確かめる。
// ask-menu の key・拡張が埋める data-ask・画面の今の対象は、どれもこの書式で文字列にする

/** 対象の組の鍵。core の ask-menu が返す key と同じ形 */
export function askKey(targets: readonly string[], within?: string, place?: string): string {
  return [...targets, ...(within ? [`@${within}`] : []), ...(place ? [`#${place}`] : [])].join(" ");
}

/** 鍵を対象と場所（@ を付けた 1 つ）と頼む場所（# を付けた 1 つ）に分ける。重ねたら後のもの */
export function parseAskKey(key: string): {
  targets: string[];
  within: string | undefined;
  place: string | undefined;
} {
  const tokens = key.split(/\s+/).filter(Boolean);
  const last = (mark: string) =>
    tokens
      .filter((t) => t.startsWith(mark))
      .at(-1)
      ?.slice(1);
  return {
    targets: tokens.filter((t) => !t.startsWith("@") && !t.startsWith("#")),
    within: last("@"),
    place: last("#"),
  };
}
