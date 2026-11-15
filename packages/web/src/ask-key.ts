// エージェントに頼む対象の組の鍵（UI-15）。対象の ID を空白でつなぎ、場所（within）があれば @ を、頼む場所（place）があれば # を、
// 設定の項目（item。設定画面の行。ask の key）があれば = を付けて後ろに置く。
// core の askMenuKey・parseAskMenuKey の写し（web は core の実行時のコードを取り込まない）。同じ結果になることを ask-key.test.ts で確かめる。
// ask-menu の key・拡張が埋める data-ask・画面の今の対象は、どれもこの書式で文字列にする

/** 対象の組の鍵。core の ask-menu が返す key と同じ形 */
export function askKey(
  targets: readonly string[],
  within?: string,
  place?: string,
  item?: string,
): string {
  return [
    ...targets,
    ...(within ? [`@${within}`] : []),
    ...(place ? [`#${place}`] : []),
    ...(item ? [`=${item}`] : []),
  ].join(" ");
}

/** 鍵を対象と場所（@ を付けた 1 つ）と頼む場所（# を付けた 1 つ）と設定の項目（= を付けた 1 つ）に分ける。重ねたら後のもの */
export function parseAskKey(key: string): {
  targets: string[];
  within: string | undefined;
  place: string | undefined;
  item: string | undefined;
} {
  const tokens = key.split(/\s+/).filter(Boolean);
  const last = (mark: string) =>
    tokens
      .filter((t) => t.startsWith(mark))
      .at(-1)
      ?.slice(1);
  return {
    targets: tokens.filter((t) => !/^[@#=]/.test(t)),
    within: last("@"),
    place: last("#"),
    item: last("="),
  };
}
