import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { bundleTranslator, setTranslator } from "./l10n.js";
import { describe, expect, it } from "vitest";
import { dgAdvice, majorOf, resolveDg, runDgVersion } from "./dg.js";

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

  it("フォルダが複数あるときだけ、警告に確かめたフォルダの名前を入れる", () => {
    const failed = { kind: "error", detail: "needs Node.js 24" } as const;
    const many = dgAdvice(failed, "1.0.0", { name: "repo-b", folderCount: 2 })?.text ?? "";
    expect(many).toContain("needs Node.js 24");
    expect(many).toContain("確かめたフォルダ: repo-b");
    expect(
      dgAdvice({ kind: "found", version: "2.0.0" }, "1.0.0", { name: "repo-b", folderCount: 3 })
        ?.text,
    ).toContain("repo-b");
    // フォルダが 1 つ・フォルダがない（cwd を渡さない）ときは今と同じ文
    const plain = dgAdvice(failed, "1.0.0")?.text;
    expect(dgAdvice(failed, "1.0.0", { name: "repo-b", folderCount: 1 })?.text).toBe(plain);
    expect(plain).not.toContain("repo-b");
    // 案内（info）にはフォルダの名前を入れない
    expect(dgAdvice({ kind: "missing" }, "1.0.0", { name: "repo-b", folderCount: 2 })?.text).toBe(
      dgAdvice({ kind: "missing" }, "1.0.0")?.text,
    );
  });

  it("ないときは dg コマンドを勧め、メジャーが違えば知らせ、同じなら何も言わない（UI-11）", () => {
    expect(dgAdvice({ kind: "missing" }, "1.0.0")).toMatchObject({ level: "info" });
    const hint = dgAdvice({ kind: "missing" }, "1.0.0")?.text ?? "";
    // 手順は README を指さず、拡張のコマンドを勧める（コマンドパレットの題どおりに書く）
    expect(hint).toContain("コマンドパレットで「deguboard: dg コマンドを入れる」を実行する");
    expect(hint).not.toContain("README");
    expect(dgAdvice({ kind: "found", version: "2.0.1" }, "1.4.0")).toMatchObject({
      level: "warning",
    });
    expect(dgAdvice({ kind: "found", version: "2.0.1" }, "1.4.0")?.text).toContain(
      "メジャーが違う",
    );
    expect(dgAdvice({ kind: "found", version: "1.9.0" }, "1.4.0")).toBeUndefined();
    expect(dgAdvice({ kind: "found", version: "0.0.0" }, "0.0.0")).toBeUndefined();
    expect(dgAdvice({ kind: "error", detail: "x" }, "1.0.0")?.text).toContain("失敗");
    expect(majorOf("v3.1.0")).toBe(3);
    expect(majorOf("dev")).toBeUndefined();
  });
});
