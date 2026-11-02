// .oxlintrc.json の no-restricted-imports の写しがずれていないことを確かめる（ADR-007）。
// 同じファイルに当たる override は前の制限を上書きするので、狭い override には広い override の patterns を手で写している。
// 片方だけ直すと黙って制限が抜けるので、写した側が元の patterns をそのまま含むことを見る

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface Override {
  files: string[];
  rules: Record<string, unknown>;
}

/** 行の頭から始まるコメントを除いて読む（.oxlintrc.json は行頭の // だけを使う。行末のコメントは消せず JSON として読めなくなるので書かない） */
async function readConfig(): Promise<{ overrides: Override[] }> {
  const text = await readFile(join(ROOT, ".oxlintrc.json"), "utf8");
  return JSON.parse(text.replaceAll(/^\s*\/\/.*$/gm, "")) as { overrides: Override[] };
}

/** files に path を含む override の no-restricted-imports の patterns */
function patternsOf(overrides: Override[], path: string): unknown[] {
  const found = overrides.find((o) => o.files.includes(path));
  if (!found) throw new Error(`${path} の override がない`);
  const rule = found.rules["no-restricted-imports"] as [string, { patterns: unknown[] }];
  return rule[1].patterns;
}

describe(".oxlintrc.json の制限の写し", () => {
  it("core の汎用部分の override は packages/core/** の patterns をそのまま写し、actions の禁止だけを足す", async () => {
    const { overrides } = await readConfig();
    const core = patternsOf(overrides, "packages/core/**");
    const generic = patternsOf(overrides, "packages/core/src/commands/**");
    expect(generic.slice(0, core.length)).toEqual(core);
    expect(generic.slice(core.length)).toEqual([
      expect.objectContaining({ regex: "^\\.\\.?/(\\.\\./)*actions(/|$)" }),
    ]);
  });

  it("web のテストの override は packages/web/** の patterns をそのまま写す", async () => {
    const { overrides } = await readConfig();
    expect(patternsOf(overrides, "packages/web/**/*.test.ts")).toEqual(
      patternsOf(overrides, "packages/web/**"),
    );
  });
});
