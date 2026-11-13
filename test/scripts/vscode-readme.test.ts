// scripts/lib/vscode-readme.mjs（ルートの README から拡張の README を作る）を確かめる（t429）

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extensionReadme, relativeLinks } from "../../scripts/lib/vscode-readme.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("拡張の README の生成", () => {
  it("README の全文をそのまま写す", () => {
    const text = `# x\n\n紹介\n\n## Tips\n\n[a](https://example.com/a)\n`;
    expect(extensionReadme(text)).toBe(text);
  });

  it("相対リンクがどこかにあれば、その先を出して投げる（Marketplace で切れるため）", () => {
    expect(() => extensionReadme(`# x\n\n[a](docs/a.md)\n`)).toThrow("docs/a.md");
    expect(() => extensionReadme(`[a](#x)\n`)).toThrow("#x");
    expect(() => extensionReadme(`<img src="images/a.gif">\n`)).toThrow("images/a.gif");
    expect(() =>
      extensionReadme(`[a](https://example.com/a)\n\n## License\n\n[MIT](LICENSE)\n`),
    ).toThrow("LICENSE");
  });

  it("今のルートの README は相対リンクがなく、最後の節まで拡張の README に入る", () => {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    expect(relativeLinks(readme)).toEqual([]);
    const text = extensionReadme(readme);
    expect(text).toBe(readme);
    expect(text).toContain("## License");
  });
});
