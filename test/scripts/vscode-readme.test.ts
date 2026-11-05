// scripts/lib/vscode-readme.mjs（ルートの README から拡張の README を作る）を確かめる（t429）

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CUT_HEADING, extensionReadme, relativeLinks } from "../../scripts/lib/vscode-readme.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("拡張の README の生成", () => {
  it("切り出す見出しより前だけを写す", () => {
    const text = extensionReadme(`# x\n\n紹介\n\n${CUT_HEADING}\n\n細部\n`);
    expect(text).toBe("# x\n\n紹介\n");
  });

  it("見出しがなければ投げる", () => {
    expect(() => extensionReadme("# x\n\n紹介\n")).toThrow(CUT_HEADING);
  });

  it("前の部分に相対リンクがあれば投げ、後ろの部分の相対リンクは問わない", () => {
    expect(() => extensionReadme(`[a](docs/a.md)\n\n${CUT_HEADING}\n`)).toThrow("docs/a.md");
    expect(() => extensionReadme(`[a](#x)\n\n${CUT_HEADING}\n`)).toThrow("#x");
    expect(() => extensionReadme(`<img src="images/a.gif">\n\n${CUT_HEADING}\n`)).toThrow(
      "images/a.gif",
    );
    expect(extensionReadme(`[a](https://example.com/a)\n\n${CUT_HEADING}\n[b](docs/b.md)\n`)).toBe(
      "[a](https://example.com/a)\n",
    );
  });

  it("今のルートの README から作った拡張の README に相対リンクが残らない", () => {
    const text = extensionReadme(readFileSync(path.join(root, "README.md"), "utf8"));
    expect(relativeLinks(text)).toEqual([]);
    expect(text).toContain("## Security and privacy");
    expect(text).not.toContain(CUT_HEADING);
  });
});
