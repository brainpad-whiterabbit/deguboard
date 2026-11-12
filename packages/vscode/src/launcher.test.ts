import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  formatCurrent,
  installLauncher,
  LAUNCHER_SCRIPT,
  launcherDir,
  linkDg,
  linkPathOf,
  onPath,
  parseCurrent,
  removeLauncherOf,
  shouldWriteCurrent,
  unlinkDg,
  type Current,
} from "./launcher.js";

let home: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "dg-launcher-"));
  dir = launcherDir(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** 引数と ELECTRON_RUN_AS_NODE を出すだけの、dg.mjs の代わり */
function fakeDg(): string {
  const file = path.join(home, "ext", "dist", "cli", "dg.mjs");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    "console.log(JSON.stringify({ args: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE }));\n",
  );
  return file;
}

/** PATH に置く偽の node。-p には major を返し、ほかは名前を出す */
function fakeNodeDir(major: number): string {
  const bin = mkdtempSync(path.join(home, "bin-"));
  const file = path.join(bin, "node");
  writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "-p" ]; then echo ${major}; else echo "path-node $*"; fi\n`,
  );
  chmodSync(file, 0o755);
  return bin;
}

function runLauncher(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      [path.join(dir, "dg"), ...args],
      { env: { HOME: home, ...env } },
      (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const mine = (over: Partial<Current> = {}): Current => ({
  version: "0.24.0",
  node: process.execPath,
  dg: fakeDg(),
  ...over,
});

describe("launcherDir", () => {
  it("ホームの .local/share/deguboard に置く", () => {
    expect(launcherDir("/home/u")).toBe(path.join("/home/u", ".local", "share", "deguboard"));
  });
});

describe("current の形", () => {
  it("書いた形を読み戻せ、パスの中の = は残る", () => {
    const current = { version: "0.24.0", node: "/a=b/node", dg: "/x/My App/dg.mjs" };
    expect(parseCurrent(formatCurrent(current))).toEqual(current);
  });

  it("知らない行と = のない行は無視する", () => {
    expect(parseCurrent("# memo\nother=1\nversion=1.0.0\n")).toEqual({ version: "1.0.0" });
  });
});

describe("compareVersions", () => {
  it("major・minor・patch の順に数で比べる", () => {
    expect(compareVersions("0.24.0", "0.23.9")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.23.0", "0.24.0")).toBeLessThan(0);
  });

  it("読めない版は undefined", () => {
    expect(compareVersions("dev", "0.1.0")).toBeUndefined();
  });
});

describe("shouldWriteCurrent", () => {
  const me = { version: "0.23.0", node: "/me/node", dg: "/me/dg.mjs" };
  const all = () => true;

  it("current がないか欠けていれば書く", () => {
    expect(shouldWriteCurrent(undefined, me, all)).toBe(true);
    expect(shouldWriteCurrent({ version: "9.0.0" }, me, all)).toBe(true);
  });

  it("版の新しい拡張の current は、node と dg.mjs が残っていれば書き換えない", () => {
    expect(shouldWriteCurrent({ version: "0.24.0", node: "/n", dg: "/d" }, me, all)).toBe(false);
  });

  it("版の新しい拡張の current でも、node か dg.mjs が消えていれば書き直す", () => {
    const newer = { version: "0.24.0", node: "/n", dg: "/d" };
    expect(shouldWriteCurrent(newer, me, (f) => f !== "/n")).toBe(true);
    expect(shouldWriteCurrent(newer, me, (f) => f !== "/d")).toBe(true);
  });

  it("同じ版か古い版、読めない版の current は書き直す", () => {
    for (const version of ["0.23.0", "0.22.5", "dev"]) {
      expect(shouldWriteCurrent({ version, node: "/n", dg: "/d" }, me, all), version).toBe(true);
    }
  });

  it("自分の版が読めないときは、生きている current を書き換えない", () => {
    const unknown = { ...me, version: "" };
    expect(shouldWriteCurrent({ version: "0.22.0", node: "/n", dg: "/d" }, unknown, all)).toBe(
      false,
    );
    expect(
      shouldWriteCurrent({ version: "0.22.0", node: "/n", dg: "/d" }, unknown, (f) => f !== "/n"),
    ).toBe(true);
    expect(shouldWriteCurrent({ version: "dev", node: "/n", dg: "/d" }, unknown, all)).toBe(true);
  });
});

describe("installLauncher", () => {
  it("起動ファイル（実行できる固定の sh）と current を書く", async () => {
    const current = mine();
    expect(await installLauncher(current, { dir })).toBe("written");
    expect(await readFile(path.join(dir, "dg"), "utf8")).toBe(LAUNCHER_SCRIPT);
    expect(statSync(path.join(dir, "dg")).mode & 0o777).toBe(0o755);
    expect(parseCurrent(await readFile(path.join(dir, "current"), "utf8"))).toEqual(current);
  });

  it("版の古い拡張は、新しい版の生きている current を書き換えない", async () => {
    const newer = mine();
    await installLauncher(newer, { dir });
    expect(await installLauncher(mine({ version: "0.23.0", node: "/old/node" }), { dir })).toBe(
      "kept",
    );
    expect(parseCurrent(await readFile(path.join(dir, "current"), "utf8"))).toEqual(newer);
  });

  it("版の古い拡張でも、current の dg.mjs が消えていれば書き直す", async () => {
    await installLauncher(mine({ dg: path.join(home, "gone", "dg.mjs") }), { dir });
    const older = mine({ version: "0.23.0" });
    expect(await installLauncher(older, { dir })).toBe("written");
    expect(parseCurrent(await readFile(path.join(dir, "current"), "utf8"))).toEqual(older);
  });

  it("版の古い拡張は起動ファイルの中身を戻さず、ないときだけ置く", async () => {
    await installLauncher(mine(), { dir });
    writeFileSync(path.join(dir, "dg"), "#!/bin/sh\n# newer launcher\n");
    await installLauncher(mine({ version: "0.23.0" }), { dir });
    expect(await readFile(path.join(dir, "dg"), "utf8")).toBe("#!/bin/sh\n# newer launcher\n");
    rmSync(path.join(dir, "dg"));
    await installLauncher(mine({ version: "0.23.0" }), { dir });
    expect(await readFile(path.join(dir, "dg"), "utf8")).toBe(LAUNCHER_SCRIPT);
  });

  it("複数のウィンドウが同時に書いても、current はどれか 1 つの全体になり、一時ファイルが残らない", async () => {
    const dg = fakeDg();
    const writers = Array.from({ length: 20 }, (_, i) => mine({ dg, version: `0.24.${i}` }));
    await Promise.all(writers.map((w) => installLauncher(w, { dir })));
    const text = await readFile(path.join(dir, "current"), "utf8");
    expect(writers.map(formatCurrent)).toContain(text);
    expect(readdirSync(dir).sort()).toEqual(["current", "dg"]);
  });

  it("Windows と改行を含むパスでは書かない", async () => {
    expect(await installLauncher(mine(), { dir, platform: "win32" })).toBe("unsupported");
    expect(await installLauncher(mine({ dg: "/a\nb" }), { dir })).toBe("unsupported");
    expect(() => statSync(dir)).toThrow();
  });
});

describe("起動ファイル", () => {
  it("current の node で dg.mjs を動かし、引数をそのまま渡して ELECTRON_RUN_AS_NODE を付ける", async () => {
    await installLauncher(mine(), { dir });
    const result = await runLauncher(["--version", "a b"], { PATH: fakeNodeDir(24) });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: ["--version", "a b"], electron: "1" });
  });

  it("current の node が消えていれば、PATH の node 24 以上で動かす", async () => {
    await installLauncher(mine({ node: path.join(home, "gone", "node") }), { dir });
    const result = await runLauncher(["--version"], { PATH: fakeNodeDir(24) });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^path-node .*dg\.mjs --version$/m);
  });

  it("PATH の node が 24 より古ければ、VS Code を一度開くよう英語で案内して失敗する", async () => {
    await installLauncher(mine({ node: path.join(home, "gone", "node") }), { dir });
    const result = await runLauncher(["--version"], { PATH: fakeNodeDir(22) });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Open VS Code with the deguboard extension once/);
  });

  it("current がなければ案内して失敗する", async () => {
    await installLauncher(mine(), { dir });
    rmSync(path.join(dir, "current"));
    const result = await runLauncher([], { PATH: fakeNodeDir(24) });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Open VS Code/);
  });
});

describe("~/.local/bin/dg の張りと外し", () => {
  it("起動ファイルへのリンクを張り、二度目は何もしない", async () => {
    await installLauncher(mine(), { dir });
    expect(linkPathOf(home)).toBe(path.join(home, ".local", "bin", "dg"));
    expect(await linkDg({ home })).toEqual({ kind: "linked" });
    expect(readlinkSync(linkPathOf(home))).toBe(path.join(dir, "dg"));
    expect(await linkDg({ home })).toEqual({ kind: "already" });
  });

  it("ほかの dg は上書きせず、張り先を示して止まる（別の先へのリンクと通常のファイル）", async () => {
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    symlinkSync("/elsewhere/dg.js", linkPathOf(home));
    expect(await linkDg({ home })).toEqual({ kind: "occupied", target: "/elsewhere/dg.js" });
    expect(readlinkSync(linkPathOf(home))).toBe("/elsewhere/dg.js");
    rmSync(linkPathOf(home));
    writeFileSync(linkPathOf(home), "other");
    expect(await linkDg({ home })).toEqual({ kind: "occupied" });
    expect(await readFile(linkPathOf(home), "utf8")).toBe("other");
  });

  it("外すのは起動ファイルを指すリンクだけで、起動ファイルは残す", async () => {
    await installLauncher(mine(), { dir });
    expect(await unlinkDg({ home })).toEqual({ kind: "absent" });
    await linkDg({ home });
    expect(await unlinkDg({ home })).toEqual({ kind: "removed" });
    expect(() => readlinkSync(linkPathOf(home))).toThrow();
    expect(existsSync(path.join(dir, "dg"))).toBe(true);
    symlinkSync("/elsewhere/dg.js", linkPathOf(home));
    expect(await unlinkDg({ home })).toEqual({ kind: "foreign", target: "/elsewhere/dg.js" });
    expect(readlinkSync(linkPathOf(home))).toBe("/elsewhere/dg.js");
  });

  it("拡張を消すとき、current がこの拡張の dg.mjs を指すときだけ起動ファイル・current・リンクを片付ける", async () => {
    const current = mine();
    await installLauncher(current, { dir });
    await linkDg({ home });
    expect(await removeLauncherOf(path.join(home, "other", "dg.mjs"), { home })).toBe(false);
    expect(existsSync(path.join(dir, "current"))).toBe(true);
    expect(readlinkSync(linkPathOf(home))).toBe(path.join(dir, "dg"));

    expect(await removeLauncherOf(current.dg, { home })).toBe(true);
    expect(existsSync(path.join(dir, "current"))).toBe(false);
    expect(existsSync(path.join(dir, "dg"))).toBe(false);
    expect(() => readlinkSync(linkPathOf(home))).toThrow();
  });

  it("拡張を消すとき、リンクがほかの dg を指していれば残す", async () => {
    const current = mine();
    await installLauncher(current, { dir });
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    symlinkSync("/elsewhere/dg.js", linkPathOf(home));
    expect(await removeLauncherOf(current.dg, { home })).toBe(true);
    expect(readlinkSync(linkPathOf(home))).toBe("/elsewhere/dg.js");
  });

  it("current がなければ、拡張を消しても何もしない", async () => {
    expect(await removeLauncherOf(path.join(home, "dg.mjs"), { home })).toBe(false);
  });

  it("PATH の並びに dir があるかを、末尾の / の違いを除いて見る", () => {
    expect(onPath("/a/bin", "/usr/bin:/a/bin/")).toBe(true);
    expect(onPath("/a/bin", "/usr/bin:/a/binx")).toBe(false);
    expect(onPath("/a/bin", undefined)).toBe(false);
  });
});
