// 鍵の写しを照らすためだけに core の実行時のコード（askMenuKey・parseAskMenuKey）を取り込む（画面のコードは型だけを取る。ADR-007）
import { askMenuKey, parseAskMenuKey } from "@deguboard/core";
import { describe, expect, it } from "vitest";
import { askKey, parseAskKey } from "./ask-key.js";

/** 対象なし・1 件・複数・場所つきの組 */
const SETS: Array<[string[], string?]> = [
  [[]],
  [["t12"]],
  [["t1", "t2"]],
  [["s3"]],
  [["t12"], "s3"],
  [["t1", "t2"], "e2"],
];

describe("頼む対象の組の鍵（core の ask-menu の key の写し）", () => {
  it("組から作る鍵は core の askMenuKey と同じ", () => {
    for (const [targets, within] of SETS)
      expect(askKey(targets, within)).toBe(askMenuKey(targets, within));
  });

  it("鍵を分けた対象と場所は core の parseAskMenuKey と同じで、元の組に戻る", () => {
    const keys = [
      ...SETS.map(([targets, within]) => askKey(targets, within)),
      // core が受ける崩れた形（場所が前・重なった空白・場所の重ね）
      "@s3 t12",
      "  t1   t2 ",
      "t1 @e1 @s3",
    ];
    for (const key of keys) {
      const { refs, within } = parseAskMenuKey(key);
      expect(parseAskKey(key)).toEqual({ targets: refs, within });
    }
    for (const [targets, within] of SETS)
      expect(parseAskKey(askKey(targets, within))).toEqual({ targets, within });
  });
});
