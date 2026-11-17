import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixture,
  createLocalOnlyRepo,
  git,
  openRepo,
  type Fixture,
} from "../../test/helpers/git-fixture.js";
import { OperationError } from "../errors.js";
import { collectBranchFacts } from "./facts.js";
import { checkOutside, dirtyFiles } from "./outside.js";
import { markRebase, rebaseInProgress, rebaseLeftByDg } from "./rebase.js";
import { GitError, runGit } from "./run.js";
import { fetchData, integrate, isDirty, push, syncStatus } from "./sync.js";
import { LOCAL_DATA_BRANCH, ensureDeguboardWorktree } from "./worktree.js";
import { resolveRepoPaths } from "./repo.js";
import { flushPending, withWrite, type WriteContext } from "./write.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

const ts = "2026-10-31T04:00:00Z";
function ctxOf(
  opened: Awaited<ReturnType<typeof openRepo>>,
  hooks?: WriteContext["hooks"],
): WriteContext {
  return { repo: opened.repo, store: opened.store, config: opened.store.config, hooks };
}
function ticketData(id: string, title = id) {
  return { id, title, status: "todo", created_at: ts, updated_at: ts };
}

describe("worktree の用意", () => {
  it("リモートがないリポジトリでも orphan ブランチ deguboard と専用 worktree を作る", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const paths = await resolveRepoPaths(local.dir);
    expect(await ensureDeguboardWorktree(paths, null, "deguboard")).toBe("orphan");
    expect(paths.dataDir).toBe(path.join(local.dir, ".git", "deguboard"));
    const head = await git(paths.dataDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(head.stdout.trim()).toBe(LOCAL_DATA_BRANCH);
    // main 側には何も入らない
    const mainFiles = await git(local.dir, ["ls-files"]);
    expect(mainFiles.stdout).toBe("");
    expect(await ensureDeguboardWorktree(paths, null, "deguboard")).toBe("existing");
  });

  it("リモートに deguboard ブランチがあれば取り込んで worktree にする", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await writeFile(path.join(a.repo.dataDir, "config.yaml"), "commit:\n  mode: each\n");
    await git(a.repo.dataDir, ["add", "-A"]);
    await git(a.repo.dataDir, ["commit", "-qm", "設定"]);
    expect(await push(a.repo)).toEqual({ ok: true });

    const pathsB = await resolveRepoPaths(f.cloneB);
    expect(await ensureDeguboardWorktree(pathsB, "origin", "deguboard")).toBe("from_remote");
    expect(await readFile(path.join(pathsB.dataDir, "config.yaml"), "utf8")).toBe(
      "commit:\n  mode: each\n",
    );
  });
});

describe("同期", () => {
  it("syncStatus が未 push と未取り込みのコミット数を返す", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await writeFile(path.join(a.repo.dataDir, "x.yaml"), "a: 1\n");
    await git(a.repo.dataDir, ["add", "-A"]);
    await git(a.repo.dataDir, ["commit", "-qm", "a"]);
    expect(await syncStatus(a.repo)).toMatchObject({ ahead: 2, behind: 0, dirty: false });
    await push(a.repo);
    expect(await syncStatus(a.repo)).toMatchObject({ ahead: 0, behind: 0 });

    const b = await openRepo(f.cloneB);
    await writeFile(path.join(b.repo.dataDir, "y.yaml"), "b: 1\n");
    await git(b.repo.dataDir, ["add", "-A"]);
    await git(b.repo.dataDir, ["commit", "-qm", "b"]);
    await push(b.repo);
    await writeFile(path.join(a.repo.dataDir, "z.yaml"), "c: 1\n");
    await fetchData(a.repo);
    expect(await syncStatus(a.repo)).toMatchObject({ ahead: 0, behind: 1, dirty: true });
  });

  // sync は入口で読んだ dirtyFiles の件数を isDirty の代わりに使う（t1046）。両者の答えが git の設定で食い違わないことを確かめる
  it("isDirty は、status.showUntrackedFiles=no のリポジトリでも追跡しないファイルを数え、dirtyFiles と同じ答えになる", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await git(a.repo.dataDir, ["config", "status.showUntrackedFiles", "no"]);
    expect(await isDirty(a.repo)).toBe(false);
    expect(await dirtyFiles(a.repo)).toEqual({});
    await mkdir(path.join(a.repo.dataDir, "tickets"), { recursive: true });
    await writeFile(path.join(a.repo.dataDir, "tickets", "t1.md"), "a\n");
    expect(await isDirty(a.repo)).toBe(true);
    expect(Object.keys(await dirtyFiles(a.repo))).toEqual(["tickets/t1.md"]);
  });

  // integrate と syncStatus は、追跡 ref があるかを先に聞かない（t1046）。ないときの結果が前と同じことを確かめる
  it("リモートにデータのブランチがまだないとき、integrate は何も取り込まず、syncStatus は手元のコミットを未 push と数える", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    const head = (await git(a.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    expect(await integrate(a.repo)).toEqual({ ok: true, changed: false });
    expect((await git(a.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect(await syncStatus(a.repo)).toEqual({
      ahead: 1,
      behind: 0,
      dirty: false,
      remote: "origin",
    });
  });

  it("同じ行を両方が変えたとき rebase を中止し、ローカルのコミットを残して競合を報告する", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await writeFile(path.join(a.repo.dataDir, "x.yaml"), "a: 1\n");
    await git(a.repo.dataDir, ["add", "-A"]);
    await git(a.repo.dataDir, ["commit", "-qm", "a1"]);
    await push(a.repo);
    const b = await openRepo(f.cloneB);
    await writeFile(path.join(b.repo.dataDir, "x.yaml"), "a: 2\n");
    await git(b.repo.dataDir, ["commit", "-qam", "b1"]);
    await push(b.repo);
    await writeFile(path.join(a.repo.dataDir, "x.yaml"), "a: 3\n");
    await git(a.repo.dataDir, ["commit", "-qam", "a2"]);
    expect(await push(a.repo)).toMatchObject({ ok: false, reason: "rejected" });
    await fetchData(a.repo);
    expect(await integrate(a.repo)).toEqual({ ok: false, conflicts: ["x.yaml"] });
    expect((await git(a.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("a2");
    expect((await git(a.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });
});

describe("書き込みの 1 単位", () => {
  it("each なら 1 操作で 1 コミットして push する", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await a.store.writeConfig({ commit: { mode: "each" } });
    const { write } = await withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t1")), {
      message: "t1 を作成",
    });
    expect(write).toMatchObject({ committed: true, pushed: true, attempts: 1 });
    expect((await git(a.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
      "t1 を作成",
    );
    expect(await syncStatus(a.repo)).toMatchObject({ ahead: 0, dirty: false });
  });

  it("batch では作業ツリーに残り、flushPending で 1 コミットにまとまる", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    const r1 = await withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t1")), {
      message: "x",
    });
    const r2 = await withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t2")), {
      message: "y",
    });
    expect(r1.write.committed).toBe(false);
    expect(r2.write.committed).toBe(false);
    expect(await syncStatus(a.repo)).toMatchObject({ dirty: true });
    expect(await flushPending(ctxOf(a))).toBe(true);
    expect(await flushPending(ctxOf(a))).toBe(false);
    const log = (await git(a.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log).toHaveLength(2);
  });

  it("即時の操作は、まとめ待ちの変更を先にコミットしてから自分をコミットする", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t1")), { message: "x" });
    const { write } = await withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t2")), {
      message: "t2 を作成",
      immediate: true,
    });
    expect(write).toMatchObject({ committed: true, pushed: true });
    const log = (await git(a.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log.slice(0, 2)).toEqual(["t2 を作成", "Commit batched changes"]);
  });

  it("2 つの clone が同時に作成すると、push を拒否された側は採番し直して次の番号になる", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    const b = await openRepo(f.cloneB);
    // A の push の直前に B が t1 を作って push する
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await withWrite(
          ctxOf(b),
          () => b.store.create("ticket", ticketData(b.store.nextId("ticket"), "B の作成")),
          {
            message: "B",
            immediate: true,
            cas: true,
          },
        );
      },
    };
    const { value, write } = await withWrite(
      ctxOf(a, hooks),
      () => a.store.create("ticket", ticketData(a.store.nextId("ticket"), "A の作成")),
      { message: "A", immediate: true, cas: true },
    );
    expect(write).toMatchObject({ committed: true, pushed: true, attempts: 2 });
    expect(value.id).toBe("t2");
    expect(a.store.tickets.get("t1")?.data.title).toBe("B の作成");
    expect(a.store.tickets.get("t2")?.data.title).toBe("A の作成");
    const log = (await git(a.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log.slice(0, 2)).toEqual(["A", "B"]);
  });

  it("別々に作った orphan の根が違っても、取り込みで空の根は落ちて履歴が 1 本になる", async () => {
    const f = await fixture();
    // 根の SHA は作成者と時刻で決まる。B の作成者を変えて、時刻によらず根が違うようにする
    await git(f.cloneB, ["config", "user.name", "別の人"]);
    const a = await openRepo(f.cloneA);
    const b = await openRepo(f.cloneB);
    const rootA = (await git(a.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    const rootB = (await git(b.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    expect(rootA).not.toBe(rootB);
    await withWrite(ctxOf(b), () => b.store.create("ticket", ticketData("t1", "B の作成")), {
      message: "B",
      immediate: true,
    });
    expect(await fetchData(a.repo)).toEqual({ ok: true, remoteBranch: true });
    expect(await integrate(a.repo)).toEqual({ ok: true, changed: true });
    const log = (await git(a.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log).toEqual(["B", "Create the deguboard branch"]);
    expect((await git(a.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
      (await git(b.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim(),
    );
  });

  it("push が続けて拒否されたら CAS の作成は失敗し、ローカルにコミットを残さない", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    const b = await openRepo(f.cloneB);
    const hooks = {
      beforePush: async () => {
        await withWrite(
          ctxOf(b),
          () => b.store.create("ticket", ticketData(b.store.nextId("ticket"))),
          {
            message: "B",
            immediate: true,
            cas: true,
          },
        );
      },
    };
    await expect(
      withWrite(
        ctxOf(a, hooks),
        () => a.store.create("ticket", ticketData(a.store.nextId("ticket"))),
        {
          message: "A",
          immediate: true,
          cas: true,
          maxAttempts: 2,
        },
      ),
    ).rejects.toMatchObject({ code: "PUSH_FAILED" } satisfies Partial<OperationError>);
    expect(await syncStatus(a.repo)).toMatchObject({ dirty: false });
    const log = (await git(a.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log.every((m) => m !== "A")).toBe(true);
  });

  it("リモートに届かないときの作成は provisional を付けてローカルにコミットする", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await git(f.cloneA, ["remote", "set-url", "origin", path.join(f.root, "nonexistent.git")]);
    const { write } = await withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t1")), {
      message: "t1 を作成",
      immediate: true,
      cas: true,
      markProvisional: async (doc) => {
        await a.store.update("ticket", doc.id, { provisional: true });
      },
    });
    expect(write).toMatchObject({ committed: true, pushed: false, provisional: true });
    expect(a.store.tickets.get("t1")?.data.provisional).toBe(true);
    expect((await git(a.repo.dataDir, ["show", "HEAD:tickets/t1.md"])).stdout).toContain(
      "provisional: true",
    );
    expect(await syncStatus(a.repo)).toMatchObject({ dirty: false });
  });

  it("user.name と user.email がなければ IDENTITY_MISSING で止まる", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await git(f.cloneA, ["config", "--unset", "user.email"]);
    await expect(
      withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t1")), {
        message: "x",
        immediate: true,
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_MISSING" });
  });
});

// 時間切れは execFile が SIGTERM で git を止めたこと（run.ts）。テストでは git の子（マージドライバ・upload-pack・receive-pack）が
// 親の git に SIGTERM を送って、時間切れと同じ止まり方を起こす（sh -c で動くので $PPID が親の git）
const KILL_PARENT = "kill -TERM $PPID";

/** x.yaml をリモートとローカルの両方で変え、取り込むと x.yaml を 3-way マージする状態にする */
async function divergeOnX(f: Fixture) {
  const a = await openRepo(f.cloneA);
  await writeFile(path.join(a.repo.dataDir, "x.yaml"), "a: 1\n");
  await git(a.repo.dataDir, ["add", "-A"]);
  await git(a.repo.dataDir, ["commit", "-qm", "a1"]);
  await push(a.repo);
  const b = await openRepo(f.cloneB);
  await writeFile(path.join(b.repo.dataDir, "x.yaml"), "a: 2\n");
  await git(b.repo.dataDir, ["commit", "-qam", "b1"]);
  await push(b.repo);
  await writeFile(path.join(a.repo.dataDir, "x.yaml"), "a: 3\n");
  await git(a.repo.dataDir, ["commit", "-qam", "a2"]);
  expect((await fetchData(a.repo)).ok).toBe(true);
  return a;
}

/** 競合で止まった rebase を残す（落ちた dg の残りか、人が始めた rebase） */
async function leaveRebase(f: Fixture, opts: { byDg: boolean }) {
  const a = await divergeOnX(f);
  const r = await runGit(a.repo.dataDir, ["rebase", "origin/deguboard"], { allowFailure: true });
  expect(r.code).not.toBe(0);
  expect(await rebaseInProgress(a.repo)).toBe(true);
  if (opts.byDg) await markRebase(a.repo);
  return a;
}

describe("rebase の途中と時間切れ", () => {
  it("rebase が時間切れで止まっても、rebase --abort してから失敗を返し、途中の状態と印を残さない", async () => {
    const f = await fixture();
    const a = await divergeOnX(f);
    const before = (await git(a.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(f.cloneA, ".git", "info", "attributes"), "x.yaml merge=killer\n");
    await git(f.cloneA, ["config", "merge.killer.driver", KILL_PARENT]);
    await expect(integrate(a.repo)).rejects.toMatchObject({
      kind: "timeout",
    } satisfies Partial<GitError>);
    expect(await rebaseInProgress(a.repo)).toBe(false);
    expect(await rebaseLeftByDg(a.repo)).toBe(false);
    expect((await git(a.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before);
    expect((await git(a.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("dg の残した rebase の途中は外の変更と報告せず、次の書き込みが取り消してから書く", async () => {
    const f = await fixture();
    const a = await leaveRebase(f, { byDg: true });
    expect(await checkOutside(a.repo)).toEqual({ kind: "rebasing", byDg: true });
    const { write } = await withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t1")), {
      message: "t1 を作成",
      immediate: true,
    });
    expect(write).toMatchObject({ committed: true });
    expect(await rebaseInProgress(a.repo)).toBe(false);
    expect(await rebaseLeftByDg(a.repo)).toBe(false);
    // 取り消した後の取り込みは x.yaml が競合するので、ローカルのコミットの上に書く
    const log = (await git(a.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log.slice(0, 2)).toEqual(["t1 を作成", "a2"]);
    expect(await checkOutside(a.repo)).toEqual({ kind: "clean", initial: false });
  });

  it("人が始めた rebase の途中は外の変更と報告せず、書き込みは取り消さずに直し方を示して止まる", async () => {
    const f = await fixture();
    const a = await leaveRebase(f, { byDg: false });
    expect(await checkOutside(a.repo)).toEqual({ kind: "rebasing", byDg: false });
    await expect(
      withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t1")), {
        message: "t1 を作成",
        immediate: true,
      }),
    ).rejects.toMatchObject({
      code: "SYNC_CONFLICT",
      message: expect.stringContaining("git rebase --continue"),
    });
    expect(await rebaseInProgress(a.repo)).toBe(true);
  });

  // 途中の rebase の状態の置き場所は GitRepo ごとに 1 回だけ git に聞いて覚える（rebase.ts の rebaseDirsOf。t1045）。
  // 覚えるのは場所だけで、途中かどうかは毎回確かめることを、同じ GitRepo で「途中でない → 途中」と変わる流れで確かめる
  it("push が拒否された後の取り込み直しの途中で git が殺されて rebase が残ったら、同じコマンドが途中と見分けて印を残し、次の書き込みが取り消す", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    const x = path.join(a.repo.dataDir, "x.yaml");
    await writeFile(x, "a: 1\n");
    await git(a.repo.dataDir, ["add", "-A"]);
    await git(a.repo.dataDir, ["commit", "-qm", "a1"]);
    await push(a.repo);
    const b = await openRepo(f.cloneB);
    // A の push の直前に B が同じ行を変えて先に push する。A の push は拒否され、取り込み直しの rebase が x.yaml をマージする。
    // マージドライバが親の git を SIGKILL で殺す（dg ごと殺されたときと同じく、git は index.lock と途中の状態を片付けられない）
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await writeFile(path.join(b.repo.dataDir, "x.yaml"), "a: 2\n");
        await git(b.repo.dataDir, ["commit", "-qam", "b1"]);
        await push(b.repo);
        await writeFile(path.join(f.cloneA, ".git", "info", "attributes"), "x.yaml merge=killer\n");
        await git(f.cloneA, ["config", "merge.killer.driver", "kill -KILL $PPID"]);
      },
    };
    // 書き込みの入口（settleRebase）は、同じ GitRepo で先に「途中でない」と確かめている
    const { write } = await withWrite(ctxOf(a, hooks), () => writeFile(x, "a: 3\n"), {
      message: "a2",
      immediate: true,
    });
    expect(write).toMatchObject({ committed: true, pushed: false });
    // 残った index.lock のために中止できず、途中の状態が残る。印は外さず、外の変更とも報告しない
    expect(await rebaseInProgress(a.repo)).toBe(true);
    expect(await rebaseLeftByDg(a.repo)).toBe(true);
    expect(await checkOutside(a.repo)).toEqual({ kind: "rebasing", byDg: true });

    // 殺された git の残した index.lock を消すと、次の書き込みが dg の残りとして取り消してから書く
    await rm(
      path.resolve(
        a.repo.dataDir,
        (await git(a.repo.dataDir, ["rev-parse", "--git-path", "index.lock"])).stdout.trim(),
      ),
    );
    await git(f.cloneA, ["config", "--unset", "merge.killer.driver"]);
    const next = await withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t1")), {
      message: "t1 を作成",
      immediate: true,
    });
    expect(next.write).toMatchObject({ committed: true });
    expect(await rebaseInProgress(a.repo)).toBe(false);
    expect(await rebaseLeftByDg(a.repo)).toBe(false);
    const log = (await git(a.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log.slice(0, 2)).toEqual(["t1 を作成", "a2"]);
  });

  it("1 回の書き込みが rebase の途中かを何度確かめても、置き場所を聞く git の起動は 1 回だけ", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    // git の起動を引数ごと記録する git を PATH の先頭に置く（runGit は呼ぶたびに process.env を読む）
    const bin = path.join(f.root, "counting-bin");
    const calls = path.join(f.root, "git-calls.log");
    const saved = process.env["PATH"];
    await mkdir(bin);
    await writeFile(
      path.join(bin, "git"),
      `#!/bin/sh\necho "$*" >> '${calls}'\nPATH='${saved ?? ""}' exec git "$@"\n`,
      { mode: 0o755 },
    );
    process.env["PATH"] = bin + path.delimiter + (saved ?? "");
    cleanups.push(async () => {
      process.env["PATH"] = saved;
    });
    // 書き込みの入口（settleRebase・checkOutside）、取り込みの後（unmarkRebase）、基準の記録（recordBaseline）が確かめる
    const { write } = await withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t1")), {
      message: "t1 を作成",
      immediate: true,
    });
    expect(write).toMatchObject({ committed: true, pushed: true });
    const asked = (await readFile(calls, "utf8"))
      .split("\n")
      .filter((line) => line.includes("--git-path rebase-"));
    expect(asked).toEqual(["rev-parse --git-path rebase-merge --git-path rebase-apply"]);
  });

  it("fetch と push の時間切れは届かないときと同じ扱いで、CAS は自分のコミットを捨てて PUSH_FAILED になる", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t1")), {
      message: "t1 を作成",
      immediate: true,
    });
    const before = (await git(a.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    await git(f.cloneA, ["config", "remote.origin.uploadpack", KILL_PARENT]);
    await git(f.cloneA, ["config", "remote.origin.receivepack", KILL_PARENT]);
    expect(await fetchData(a.repo)).toMatchObject({ ok: false });
    expect(await push(a.repo)).toMatchObject({ ok: false, reason: "unreachable" });
    await expect(
      withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t2")), {
        message: "t2 を作成",
        immediate: true,
        cas: true,
      }),
    ).rejects.toMatchObject({ code: "PUSH_FAILED" } satisfies Partial<OperationError>);
    expect((await git(a.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before);
    expect(await syncStatus(a.repo)).toMatchObject({ dirty: false });
  });
});

// 読みの git status は、index を新しくするために index.lock を取って index を書き直す（任意のロック）。書き込みのロック（withLock）の
// 外で走る読み（画面の 15 秒ごとの状態・dg status）がこれをすると、同時の dg の書き込み（add・commit）が index.lock: File exists で
// 落ちる。runGit が GIT_OPTIONAL_LOCKS=0 を付けて、読みが index.lock を取らないようにする（t944）
describe("読みの git と index.lock", () => {
  /** データの worktree の index の中身 */
  const indexOf = async (dataDir: string) =>
    readFile(
      path.resolve(
        dataDir,
        (await git(dataDir, ["rev-parse", "--git-path", "index"])).stdout.trim(),
      ),
    );

  /** 追跡しているファイルの時刻だけを変える（中身は同じ。次の status が index を新しくしたくなる状態） */
  const touch = (file: string, at: number) => utimes(file, new Date(at), new Date(at));

  /** x.yaml を 1 つコミットしたリポジトリ */
  async function withTrackedFile() {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    const file = path.join(a.repo.dataDir, "x.yaml");
    await writeFile(file, "a: 1\n");
    await git(a.repo.dataDir, ["add", "-A"]);
    await git(a.repo.dataDir, ["commit", "-qm", "a"]);
    return { a, file };
  }

  it("追跡しているファイルの時刻だけが変わっていても、読みの status は index を書き直さない", async () => {
    const { a, file } = await withTrackedFile();
    await touch(file, Date.parse("2001-01-01T00:00:00Z"));
    const before = await indexOf(a.repo.dataDir);
    expect(await syncStatus(a.repo)).toMatchObject({ dirty: false });
    expect((await indexOf(a.repo.dataDir)).equals(before)).toBe(true);
  });

  it("dg の残した rebase の途中で読みの status を走らせても、index と途中の状態を変えず、次の書き込みが取り消してから書く", async () => {
    const f = await fixture();
    const a = await leaveRebase(f, { byDg: true });
    const before = await indexOf(a.repo.dataDir);
    expect(await syncStatus(a.repo)).toMatchObject({ dirty: true });
    expect((await indexOf(a.repo.dataDir)).equals(before)).toBe(true);
    expect(await rebaseInProgress(a.repo)).toBe(true);
    expect(await rebaseLeftByDg(a.repo)).toBe(true);
    const { write } = await withWrite(ctxOf(a), () => a.store.create("ticket", ticketData("t1")), {
      message: "t1 を作成",
      immediate: true,
    });
    expect(write).toMatchObject({ committed: true });
    expect(await rebaseInProgress(a.repo)).toBe(false);
    expect(await syncStatus(a.repo)).toMatchObject({ dirty: false });
  });

  it("読みの status を繰り返しながら書き込みを続けても、書き込みが index.lock で落ちない", async () => {
    const { a, file } = await withTrackedFile();
    // 読みは書き込みのロックの外で走る。毎回ファイルの時刻を変えて、任意のロックを取る git なら index を書き直す状態にしておく
    let stop = false;
    let reads = 0;
    const readers = Array.from({ length: 2 }, async () => {
      while (!stop) {
        reads += 1;
        await touch(file, Date.parse("2001-01-01T00:00:00Z") + reads * 1000);
        await syncStatus(a.repo);
      }
    });
    const writes = 8;
    try {
      for (let i = 1; i <= writes; i++) {
        const { write } = await withWrite(
          ctxOf(a),
          () => a.store.create("ticket", ticketData(`t${i}`)),
          { message: `t${i} を作成`, immediate: true },
        );
        expect(write).toMatchObject({ committed: true });
      }
    } finally {
      stop = true;
      await Promise.all(readers);
    }
    expect(reads).toBeGreaterThan(0);
    const subjects = (await git(a.repo.dataDir, ["log", "--format=%s"])).stdout.split("\n");
    expect(subjects.filter((s) => s.endsWith(" を作成"))).toHaveLength(writes);
  });
});

describe("事実の収集", () => {
  it("ブランチの先端が base_branch の祖先なら branch_merged、リモートから消えれば branch_exists が false", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    await git(f.cloneA, ["checkout", "-qb", "feature/t1-x"]);
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "作業"]);
    expect((await collectBranchFacts(a.repo, "feature/t1-x", { needPr: false })).facts).toEqual({
      branch_exists: true,
      branch_pushed: false,
      branch_merged: false,
    });
    await git(f.cloneA, ["push", "-q", "-u", "origin", "feature/t1-x"]);
    await git(a.repo.dataDir, ["fetch", "-q", "--prune", "origin"]);
    expect(
      (await collectBranchFacts(a.repo, "feature/t1-x", { needPr: false })).facts,
    ).toMatchObject({
      branch_pushed: true,
    });
    await git(f.cloneA, ["checkout", "-q", "main"]);
    await git(f.cloneA, ["merge", "-q", "--ff-only", "feature/t1-x"]);
    // ff マージの直後は先端が base と同じなので、base が進んでから merged になる（切ったばかりのブランチと区別するため）
    await git(f.cloneA, ["commit", "-q", "--allow-empty", "-m", "次の作業"]);
    await git(f.cloneA, ["push", "-q", "origin", "main"]);
    await git(a.repo.dataDir, ["fetch", "-q", "--prune", "origin"]);
    expect(
      (await collectBranchFacts(a.repo, "feature/t1-x", { needPr: false })).facts,
    ).toMatchObject({
      branch_merged: true,
    });
    await git(f.cloneA, ["push", "-q", "origin", "--delete", "feature/t1-x"]);
    await git(f.cloneA, ["branch", "-qD", "feature/t1-x"]);
    await git(a.repo.dataDir, ["fetch", "-q", "--prune", "origin"]);
    expect(
      (await collectBranchFacts(a.repo, "feature/t1-x", { needPr: false })).facts,
    ).toMatchObject({
      branch_exists: false,
    });
  });

  it("gh がない環境では PR の事実がすべて不明になる", async () => {
    const f = await fixture();
    const a = await openRepo(f.cloneA);
    const { resetGhCache } = await import("./facts.js");
    resetGhCache();
    const savedPath = process.env["PATH"];
    process.env["PATH"] = path.join(f.root, "empty-bin") + path.delimiter + "/usr/bin:/bin";
    try {
      const { facts, pr } = await collectBranchFacts(a.repo, "none", { needPr: true });
      expect(facts.pr_open).toBeUndefined();
      expect(facts.pr_merged).toBeUndefined();
      expect(pr).toBeUndefined();
    } finally {
      process.env["PATH"] = savedPath;
      resetGhCache();
    }
  });
});
