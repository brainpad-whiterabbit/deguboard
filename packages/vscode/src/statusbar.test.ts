import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentBranch,
  headFile,
  statusBarText,
  statusBarTooltip,
  ticketOfBranch,
} from "./statusbar.js";

const tickets = [
  { id: "t1", status: "done", branch: "feat/a" },
  { id: "t2", status: "in_progress", branch: "feat/b" },
  { id: "t3", status: "todo", branch: null },
];

describe("ticketOfBranch", () => {
  it("ブランチが branch に一致するチケットを返す", () => {
    expect(ticketOfBranch(tickets, "feat/b")?.id).toBe("t2");
  });
  it("紐づくチケットがないブランチでは undefined", () => {
    expect(ticketOfBranch(tickets, "main")).toBeUndefined();
  });
  it("デタッチ HEAD（ブランチなし）では undefined", () => {
    expect(ticketOfBranch(tickets, undefined)).toBeUndefined();
  });
});

describe("statusBarText", () => {
  const ticket = { id: "t2", status: "in_progress", branch: "feat/b" };
  it("ID と Status を出す", () => {
    expect(statusBarText(ticket, false)).toContain("t2 in_progress");
    expect(statusBarText(ticket, false)).not.toContain("spin");
  });
  it("Run が実行中なら回るアイコンで見分けられる", () => {
    expect(statusBarText(ticket, true)).toContain("$(sync~spin)");
    expect(statusBarTooltip(ticket, true)).toContain("Run が実行中");
    expect(statusBarTooltip(ticket, false)).not.toContain("Run が実行中");
  });
});

describe("currentBranch・headFile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dg-sb-"));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    return { dir, git };
  };

  it("今のブランチ名を返し、チェックアウトで変わる", async () => {
    const { dir, git } = repo();
    expect(await currentBranch(dir)).toBe("main");
    git("checkout", "-q", "-b", "feat/x");
    expect(await currentBranch(dir)).toBe("feat/x");
  });
  it("デタッチ HEAD では undefined", async () => {
    const { dir, git } = repo();
    git("checkout", "-q", "--detach");
    expect(await currentBranch(dir)).toBeUndefined();
  });
  it("リポジトリでないフォルダでは undefined", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dg-sb-"));
    dirs.push(dir);
    expect(await currentBranch(dir)).toBeUndefined();
    expect(await headFile(dir)).toBeUndefined();
  });
  it("HEAD のファイルの場所を返す", async () => {
    const { dir } = repo();
    expect((await headFile(dir))?.endsWith("/.git/HEAD")).toBe(true);
  });
});
