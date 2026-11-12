import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBundleLayout } from "./bundle-layout.js";
import { readGuide } from "./guide/guide.js";
import { storeCacheKey } from "./storage/store-cache.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dg-bundle-layout-"));
});

afterEach(async () => {
  setBundleLayout(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("束ねた CLI の配置（VS Code 拡張に同梱する dg.mjs）", () => {
  it("guide は guideDir（拡張の本体と共有する dist/）から読む", async () => {
    await writeFile(
      join(dir, "guide-work.md"),
      "---\ndescription: d\n---\n# 束ねた guide\n\n{{choices}}\n",
    );
    await writeFile(join(dir, "guide-choices.md"), "## Asking with choices\n");
    setBundleLayout({ entry: join(dir, "cli", "dg.mjs"), guideDir: dir, version: "9.8.7" });
    expect(await readGuide("work")).toBe("# 束ねた guide\n\n## Asking with choices\n");
  });

  it("配置がなければ、guide はこのパッケージの隣から読む", async () => {
    expect(await readGuide("work")).toMatch(/^# Work/);
  });

  it("store-cache の鍵の版は、束ねたときに埋めた版を使う", async () => {
    setBundleLayout({ entry: join(dir, "cli", "dg.mjs"), guideDir: dir, version: "9.8.7" });
    const key = JSON.parse(await storeCacheKey(dir, undefined)) as { version: string };
    expect(key.version).toBe("9.8.7");
  });
});
