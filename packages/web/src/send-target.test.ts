import { describe, expect, it } from "vitest";
import { canSend, resolveSendTarget, sentMessage } from "./send-target.js";

const A = { id: 1, label: "zsh" };
const B = { id: 2, label: "claude" };

describe("送る（UI-15）の判断", () => {
  it("開いているターミナルが 1 つでもあるときだけ送れる", () => {
    expect(canSend([])).toBe(false);
    expect(canSend([A])).toBe(true);
  });

  it("選んだターミナルを返し、閉じていたり未選択なら先頭、なければ null", () => {
    expect(resolveSendTarget([A, B], 2)).toBe(B);
    expect(resolveSendTarget([A, B], 9)).toBe(A);
    expect(resolveSendTarget([A, B], null)).toBe(A);
    expect(resolveSendTarget([], 1)).toBeNull();
  });

  it("送った知らせに送り先の名前と、Enter を押していないことを書く", () => {
    expect(sentMessage(B)).toContain("claude");
    expect(sentMessage(B)).toContain("Enter を押して");
  });
});
