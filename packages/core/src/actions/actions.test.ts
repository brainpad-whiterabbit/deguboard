import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git, type Fixture } from "../../test/helpers/git-fixture.js";
import { OperationError, UsageError } from "../errors.js";
import { resolveRepoPaths, type GitRepo } from "../git/repo.js";
import { configSchema, type Config } from "../model/config.js";
import {
  isSafeBranchName,
  listActions,
  runAction,
  type ActionContext,
  type ConfirmRequest,
} from "./index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

async function contextOf(
  dir: string,
  config: unknown = {},
  extra: Partial<ActionContext> = {},
): Promise<ActionContext> {
  const paths = await resolveRepoPaths(dir);
  const repo: GitRepo = { ...paths, remote: "origin", baseBranch: "main" };
  return { repo, config: configSchema.parse(config) as Config, ...extra };
}

async function rejection(p: Promise<unknown>): Promise<OperationError> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OperationError);
  return error as OperationError;
}

describe("Action の一覧", () => {
  it("ソフトウェア開発向けの Action とシェルが登録され、既定の設定ではシェルとテスト実行は使えない", () => {
    const list = listActions(configSchema.parse({}));
    expect(list.map((a) => a.name)).toEqual([
      "create_worktree",
      "create_branch",
      "run_tests",
      "create_pr",
      "merge_pr",
      "shell",
    ]);
    const shell = list.find((a) => a.name === "shell");
    expect(shell).toMatchObject({ confirm: true, available: false });
    expect(list.find((a) => a.name === "run_tests")?.available).toBe(false);
    expect(list.filter((a) => a.confirm).map((a) => a.name)).toEqual(["shell"]);
  });

  it("actions.shell が true ならシェルは使える（確認は要るまま）", () => {
    const list = listActions(configSchema.parse({ actions: { shell: true } }));
    expect(list.find((a) => a.name === "shell")).toMatchObject({ available: true, confirm: true });
  });
});

describe("任意のシェルの Action（AG-7）", () => {
  it("actions.shell が false なら確認を求めずに拒否し、コマンドは実行しない", async () => {
    const f = await fixture();
    const asked: ConfirmRequest[] = [];
    const ctx = await contextOf(f.cloneA, {}, { confirm: async (r) => (asked.push(r), true) });
    const error = await rejection(runAction(ctx, "shell", { command: "touch ran" }));
    expect(error.code).toBe("REJECTED");
    expect(error.message).toContain("actions.shell");
    expect(asked).toEqual([]);
    expect(await readdir(f.cloneA)).not.toContain("ran");
  });

  it("actions.shell が true でも、確認の手段がなければ実行しない", async () => {
    const f = await fixture();
    const ctx = await contextOf(f.cloneA, { actions: { shell: true } });
    const error = await rejection(runAction(ctx, "shell", { command: "touch ran" }));
    expect(error.code).toBe("REJECTED");
    expect(await readdir(f.cloneA)).not.toContain("ran");
  });

  it("確認で断られたら実行しない", async () => {
    const f = await fixture();
    const ctx = await contextOf(
      f.cloneA,
      { actions: { shell: true } },
      { confirm: async () => false },
    );
    const error = await rejection(runAction(ctx, "shell", { command: "touch ran" }));
    expect(error.code).toBe("REJECTED");
    expect(await readdir(f.cloneA)).not.toContain("ran");
  });

  it("確認で許されたら作業ディレクトリで実行し、確認にはコマンドと場所を渡す", async () => {
    const f = await fixture();
    const asked: ConfirmRequest[] = [];
    const ctx = await contextOf(
      f.cloneA,
      { actions: { shell: true } },
      { confirm: async (r) => (asked.push(r), true) },
    );
    const result = (await runAction(ctx, "shell", {
      command: "echo こんにちは > out.txt; exit 3",
    })) as {
      code: number;
    };
    expect(result.code).toBe(3);
    expect(await readFile(path.join(f.cloneA, "out.txt"), "utf8")).toBe("こんにちは\n");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ action: "shell", cwd: f.cloneA });
    expect(asked[0]?.input).toMatchObject({ command: "echo こんにちは > out.txt; exit 3" });
  });
});

describe("ブランチ名の検査（オプションの注入を拒む）", () => {
  it("git check-ref-format --branch と同じ判定をする", async () => {
    const f = await fixture();
    const names = [
      "main",
      "feat/actions",
      "fix/a-b_c.1",
      "日本語/ブランチ",
      "-D",
      "--upload-pack=touch pwned",
      "a..b",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "a?",
      "a*",
      "a[b",
      "a\\b",
      "a@{b",
      "a//b",
      "/a",
      "a/",
      "a.",
      ".a",
      "a/.b",
      "a.lock",
      "a/b.lock/c",
      "",
    ];
    for (const name of names) {
      const byGit = await git(f.cloneA, ["check-ref-format", "--branch", name]).then(
        () => true,
        () => false,
      );
      expect([name, isSafeBranchName(name)]).toEqual([name, byGit]);
    }
    // git は @ を HEAD のブランチと読み替えて通すが、名前としては拒む
    expect(isSafeBranchName("@")).toBe(false);
  });

  it("base に --upload-pack を渡しても実行せず、入力の誤りとして拒む", async () => {
    const f = await fixture();
    const ctx = await contextOf(f.cloneA);
    const marker = path.join(f.root, "pwned");
    for (const action of ["create_worktree", "create_branch"]) {
      await expect(
        runAction(ctx, action, { branch: "feat/x", base: `--upload-pack=touch ${marker}` }),
      ).rejects.toBeInstanceOf(UsageError);
    }
    await expect(runAction(ctx, "create_branch", { branch: "-D" })).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(
      runAction(ctx, "create_pr", { title: "t", branch: "--repo=evil/x" }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(await readdir(f.root)).not.toContain("pwned");
  });

  it("config の git.base_branch が - で始まるときも fetch の前に拒む", async () => {
    const f = await fixture();
    const marker = path.join(f.root, "pwned");
    const ctx = await contextOf(f.cloneA);
    const evil = { ...ctx, repo: { ...ctx.repo, baseBranch: `--upload-pack=touch ${marker}` } };
    const error = await rejection(runAction(evil, "create_branch", { branch: "feat/x" }));
    expect(error.code).toBe("REJECTED");
    expect(await readdir(f.root)).not.toContain("pwned");
  });
});

describe("登録済みの Action の実行", () => {
  it("知らない名前は NOT_FOUND、入力の誤りは UsageError", async () => {
    const f = await fixture();
    const ctx = await contextOf(f.cloneA);
    expect((await rejection(runAction(ctx, "deploy"))).code).toBe("NOT_FOUND");
    await expect(runAction(ctx, "create_branch", {})).rejects.toBeInstanceOf(UsageError);
  });

  it("create_worktree は取り込んだ base から作業ブランチを切り、worktree.root の下に checkout する", async () => {
    const f = await fixture();
    // B が main を進めても、A は取り込んでから切るので B のコミットを含む
    await git(f.cloneB, ["commit", "-q", "--allow-empty", "-m", "B の変更"]);
    await git(f.cloneB, ["push", "-q", "origin", "main"]);
    const ctx = await contextOf(f.cloneA);
    const result = (await runAction(ctx, "create_worktree", { branch: "feat/x" })) as {
      path: string;
    };
    expect(result.path).toBe(path.join(f.root, "a.worktrees", "feat", "x"));
    const head = await git(result.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(head.stdout.trim()).toBe("feat/x");
    const log = await git(result.path, ["log", "-1", "--format=%s"]);
    expect(log.stdout.trim()).toBe("B の変更");
    // 上流は付けない（push のときに決める）
    const upstream = await git(f.cloneA, ["config", "--get", "branch.feat/x.remote"]).catch(
      () => null,
    );
    expect(upstream).toBeNull();
  });

  it("create_branch は checkout せずにブランチだけを作る", async () => {
    const f = await fixture();
    const ctx = await contextOf(f.cloneA);
    await runAction(ctx, "create_branch", { branch: "fix/y" });
    const branches = await git(f.cloneA, ["branch", "--format=%(refname:short)"]);
    expect(branches.stdout.split("\n")).toContain("fix/y");
    const head = await git(f.cloneA, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(head.stdout.trim()).toBe("main");
  });

  it("run_tests は actions.test が空なら拒否し、あれば実行して成否を返す", async () => {
    const f = await fixture();
    const none = await contextOf(f.cloneA);
    expect((await rejection(runAction(none, "run_tests"))).code).toBe("REJECTED");
    const passing = await contextOf(f.cloneA, { actions: { test: ["git", "status", "--short"] } });
    expect(await runAction(passing, "run_tests")).toMatchObject({ passed: true, code: 0 });
    const failing = await contextOf(f.cloneA, { actions: { test: ["git", "no-such-command"] } });
    expect(await runAction(failing, "run_tests")).toMatchObject({ passed: false });
  });
});

describe("Core の汎用部分は Action に依存しない（AG-6）", () => {
  it("commands・storage・workflow・model・git は actions を import しない", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const offenders: string[] = [];
    for (const dir of ["commands", "storage", "workflow", "model", "git"]) {
      const files = await readdir(path.join(root, dir), { recursive: true });
      for (const file of files.filter((f) => f.endsWith(".ts"))) {
        const text = await readFile(path.join(root, dir, file), "utf8");
        if (/from\s+["'](\.\.?\/)+actions(\/|["'])/.test(text)) offenders.push(`${dir}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
