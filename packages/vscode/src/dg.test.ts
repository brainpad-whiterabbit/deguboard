import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { bundleTranslator, setTranslator } from "./l10n.js";
import { describe, expect, it } from "vitest";
import { dgCheckCwd, majorOf, resolveDg, runDgVersion } from "./dg.js";

// 文言は日本語の訳で確かめる（表示言語が日本語のときに今までと同じ文言が出ること）。英語は l10n.test.ts で確かめる
setTranslator(
  bundleTranslator(
    JSON.parse(
      readFileSync(new URL("../l10n/bundle.l10n.ja.json", import.meta.url), "utf8"),
    ) as Record<string, string>,
  ),
);

const enoent = () => {
  const e = new Error("spawn dg ENOENT") as NodeJS.ErrnoException;
  e.code = "ENOENT";
  return Promise.reject(e);
};

describe("PATH の dg", () => {
  it("dg --version の出力を版にし、ENOENT は missing、それ以外の失敗は error", async () => {
    expect(await resolveDg(undefined, async () => "1.2.3\n")).toEqual({
      kind: "found",
      version: "1.2.3",
    });
    expect(await resolveDg(undefined, enoent)).toEqual({ kind: "missing" });
    expect(await resolveDg(undefined, () => Promise.reject(new Error("壊れている")))).toEqual({
      kind: "error",
      detail: "壊れている",
    });
  });

  it("確かめるフォルダを cwd にして dg --version を動かし、フォルダがなければ cwd を渡さない", async () => {
    const seen: (string | undefined)[] = [];
    const run = async (cwd?: string) => {
      seen.push(cwd);
      return "1.0.0";
    };
    await resolveDg("/work/repo", run);
    await resolveDg(undefined, run);
    expect(seen).toEqual(["/work/repo", undefined]);
  });

  // sh の起動ファイルで確かめるので Windows では外す
  it.skipIf(process.platform === "win32")(
    "既定の実行は、渡した cwd で dg を動かす（shim が cwd の設定で版を選ぶため）",
    async () => {
      // PATH の先頭に、cwd を出力する dg を置いて確かめる
      const bin = mkdtempSync(join(tmpdir(), "dg-bin-"));
      const work = mkdtempSync(join(tmpdir(), "dg-work-"));
      const dg = join(bin, "dg");
      writeFileSync(dg, "#!/bin/sh\npwd -P\n");
      chmodSync(dg, 0o755);
      const path = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
      try {
        expect((await runDgVersion(work)).trim()).toBe(realpathSync(work));
        expect((await runDgVersion()).trim()).toBe(realpathSync(process.cwd()));
      } finally {
        process.env.PATH = path;
        rmSync(bin, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it("フォルダが手元のファイルのときだけ、そこを dg --version の cwd にする", () => {
    expect(dgCheckCwd({ scheme: "file", fsPath: "/work/repo-b" })).toBe("/work/repo-b");
    // file 以外の scheme（仮想のファイルなど）は cwd を渡さない
    expect(dgCheckCwd({ scheme: "vscode-vfs", fsPath: "/repo-b" })).toBeUndefined();
    expect(dgCheckCwd({ scheme: "file", fsPath: "" })).toBeUndefined();
  });

  it("版のメジャーを読み、読めない版は undefined", () => {
    expect(majorOf("v3.1.0")).toBe(3);
    expect(majorOf("dev")).toBeUndefined();
  });
});
