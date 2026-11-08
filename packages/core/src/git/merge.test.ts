import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git, type Fixture } from "../../test/helpers/git-fixture.js";
import { openContext } from "../commands/context.js";
import { runCommand, type CommandContext } from "../commands/define.js";
import { init, sync } from "../commands/setup.js";
import { ticketCreate, ticketUpdate } from "../commands/ticket.js";
import { mergeDocuments, mergeDriverCommandLine } from "./merge.js";
import { recordBaseline } from "./outside.js";
import { CONFLICT_REMEDY, withWrite } from "./write.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

/** ビルドせずに src の runMergeDriver を呼ぶドライバ（test/helpers/merge-driver.mjs） */
const DRIVER = [
  process.execPath,
  "--no-warnings",
  "--experimental-transform-types",
  fileURLToPath(new URL("../../test/helpers/merge-driver.mjs", import.meta.url)),
];

function doc(fields: Record<string, string>, body = "## 概要\n\n本文\n"): string {
  const yaml = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${yaml}\n---\n${body}`;
}

const BASE = {
  id: "t1",
  title: "ログイン",
  priority: "medium",
  updated_at: "2026-11-01T00:00:00Z",
};

describe("frontmatter の 3-way マージ", () => {
  it("片側だけ変えたフィールドはその値を採り、updated_at は両側が変えても新しい方を採る", async () => {
    const r = await mergeDocuments(
      doc(BASE),
      doc({ ...BASE, priority: "high", updated_at: "2026-11-01T00:00:05Z" }),
      doc({ ...BASE, title: "ログイン画面", updated_at: "2026-11-01T00:00:09Z" }),
    );
    expect(r).toEqual({
      ok: true,
      text: doc({
        ...BASE,
        title: "ログイン画面",
        priority: "high",
        updated_at: "2026-11-01T00:00:09Z",
      }),
    });
  });

  it("片側が足したフィールドと消したフィールドを反映し、frontmatter が ours のままならそのバイト列を保つ", async () => {
    const base = doc({ ...BASE, labels: "[web]" });
    const added = await mergeDocuments(base, base, doc({ ...BASE, labels: "[web]", epic: "e1" }));
    expect(added).toEqual({ ok: true, text: doc({ ...BASE, labels: "[web]", epic: "e1" }) });
    const removed = await mergeDocuments(base, base, doc(BASE));
    expect(removed).toEqual({ ok: true, text: doc(BASE) });
    const ours = "---\nid: t1 # コメント\n---\n本文\n";
    expect(
      await mergeDocuments("---\nid: t1\n---\n本文\n", ours, "---\nid: t1\n---\n本文\n"),
    ).toEqual({ ok: true, text: ours });
  });

  it("両側が同じフィールドを違う値に変えたら、そのフィールドを競合として返す", async () => {
    const r = await mergeDocuments(
      doc(BASE),
      doc({ ...BASE, priority: "high" }),
      doc({ ...BASE, priority: "low" }),
    );
    expect(r).toEqual({ ok: false, conflicts: ["priority"] });
  });

  it("本文は別々の行の変更なら両方を残し、同じ行の変更なら競合にする", async () => {
    const body = "## 概要\n\n一\n二\n三\n四\n五\n";
    const merged = await mergeDocuments(
      doc(BASE, body),
      doc(BASE, body.replace("一", "いち")),
      doc(BASE, body.replace("五", "ご")),
    );
    expect(merged).toEqual({
      ok: true,
      text: doc(BASE, body.replace("一", "いち").replace("五", "ご")),
    });
    const clash = await mergeDocuments(
      doc(BASE, body),
      doc(BASE, body.replace("三", "さん")),
      doc(BASE, body.replace("三", "サン")),
    );
    expect(clash).toEqual({ ok: false, conflicts: ["本文"] });
  });

  it("frontmatter がない・base が空（add/add）なら undefined を返して行単位のマージに任せる", async () => {
    expect(await mergeDocuments("", doc(BASE), doc({ ...BASE, title: "別" }))).toBeUndefined();
    expect(await mergeDocuments("a\n", "b\n", "c\n")).toBeUndefined();
  });

  it("登録するコマンド行は空白や引用符を含むパスをシェル向けにクォートし、%O %A %B %P を付ける", () => {
    expect(mergeDriverCommandLine(["/usr/bin/node", "/a b/it's/dg.js", "merge-driver"])).toBe(
      `/usr/bin/node '/a b/it'\\''s/dg.js' merge-driver %O %A %B %P`,
    );
  });
});

/** init まで済ませた 2 つの clone の文脈。時刻は呼び出しごとに 1 秒進める */
async function twoClones(f: Fixture): Promise<{ a: CommandContext; b: CommandContext }> {
  let tick = Date.parse("2026-11-01T00:00:00Z");
  const now = () => new Date((tick += 1000));
  const open = (cwd: string, initialize?: object) =>
    openContext({
      cwd,
      actor: { kind: "human", user: "eiki" },
      now,
      mergeDriver: DRIVER,
      initialize,
    });
  await runCommand(init, await open(f.cloneA, {}), {});
  const a = await open(f.cloneA);
  await runCommand(ticketCreate, a, { title: "ログイン" });
  await runCommand(sync, a, {});
  await runCommand(init, await open(f.cloneB, {}), {});
  const b = await open(f.cloneB);
  return { a, b };
}

const t1 = (ctx: CommandContext) => readFile(path.join(ctx.repo.dataDir, "tickets/t1.md"), "utf8");

describe("同期のマージドライバ", () => {
  it("init が git config と deguboard ブランチの .gitattributes にドライバを登録する", async () => {
    const f = await fixture();
    const { a, b } = await twoClones(f);
    for (const ctx of [a, b]) {
      const driver = await git(ctx.repo.dataDir, ["config", "--get", "merge.deguboard.driver"]);
      expect(driver.stdout.trim()).toBe(mergeDriverCommandLine(DRIVER));
      const attr = await git(ctx.repo.dataDir, ["check-attr", "merge", "tickets/t1.md"]);
      expect(attr.stdout.trim()).toBe("tickets/t1.md: merge: deguboard");
    }
    const tracked = await git(a.repo.dataDir, ["ls-files", ".gitattributes"]);
    expect(tracked.stdout.trim()).toBe(".gitattributes");
  });

  it("既存のリポジトリでは sync が取り込みの前にドライバを登録し、.gitattributes をコミットする", async () => {
    const f = await fixture();
    const { a } = await twoClones(f);
    await git(a.repo.dataDir, ["config", "--unset", "merge.deguboard.driver"]);
    await git(a.repo.dataDir, ["rm", "-q", ".gitattributes"]);
    await git(a.repo.dataDir, ["commit", "-qm", "古いリポジトリを模す"]);
    // 古い版の dg が作った（印のない）コミットを模すので、検査の基準をここに置く（ADR-026）
    await recordBaseline(a.repo);
    await runCommand(sync, a, {});
    const driver = await git(a.repo.dataDir, ["config", "--get", "merge.deguboard.driver"]);
    expect(driver.stdout.trim()).toBe(mergeDriverCommandLine(DRIVER));
    const log = await git(a.repo.dataDir, ["log", "-1", "--format=%s", "--", ".gitattributes"]);
    expect(log.stdout.trim()).toBe("マージドライバの .gitattributes を置く");
  });

  it("同じチケットの別のフィールドを双方で変えた競合を、sync が両方の変更を残して自動で解く", async () => {
    const f = await fixture();
    const { a, b } = await twoClones(f);
    await runCommand(ticketUpdate, a, { ticket: "t1", priority: "high" });
    await runCommand(sync, a, {});
    await runCommand(ticketUpdate, b, { ticket: "t1", title: "ログイン画面" });
    // b の更新は a の push より後の時刻
    const synced = await runCommand(sync, b, {});
    expect(synced.data.conflicts).toEqual([]);
    expect(synced.data.pushed).toBe(true);
    const text = await t1(b);
    expect(text).toContain("title: ログイン画面");
    expect(text).toContain("priority: high");
    expect(b.store.tickets.get("t1")?.data).toMatchObject({
      title: "ログイン画面",
      priority: "high",
    });
    // a も取り込めば同じ内容になる
    await runCommand(sync, a, {});
    expect(await t1(a)).toBe(text);
  });

  it("同じフィールドを双方で変えた競合は、rebase を中止してローカルのコミットを残し報告する", async () => {
    const f = await fixture();
    const { a, b } = await twoClones(f);
    await runCommand(ticketUpdate, a, { ticket: "t1", title: "A の題" });
    await runCommand(sync, a, {});
    await runCommand(ticketUpdate, b, { ticket: "t1", title: "B の題" });
    const synced = await runCommand(sync, b, {});
    expect(synced.data.conflicts).toEqual(["tickets/t1.md"]);
    expect(synced.data.pushed).toBe(false);
    expect(synced.warnings.join("\n")).toContain("リモートの変更と競合している: tickets/t1.md");
    // ローカルのコミット（まとめ待ちを sync がコミットしたもの）は push されずに残る
    expect(synced.data.status).toMatchObject({ ahead: 1, behind: 1, dirty: false });
    expect((await git(b.repo.dataDir, ["show", "HEAD:tickets/t1.md"])).stdout).toContain(
      "title: B の題",
    );
    expect((await git(b.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
    expect(await t1(b)).toContain("title: B の題");
  });

  it("競合が残る間の sync の警告と起票の SYNC_CONFLICT は、同じ戻し方（人が deguboard worktree で解消する）を案内する", async () => {
    const f = await fixture();
    const { a, b } = await twoClones(f);
    await runCommand(ticketUpdate, a, { ticket: "t1", title: "A の題" });
    await runCommand(sync, a, {});
    await runCommand(ticketUpdate, b, { ticket: "t1", title: "B の題" });
    const synced = await runCommand(sync, b, {});
    expect(synced.warnings.join("\n")).toContain(CONFLICT_REMEDY);
    // 戻し方は、自分では解かずに人に伝えること、解いて続ける手と捨てる手を含む
    expect(CONFLICT_REMEDY).toContain("自分では解かず人に伝える");
    expect(CONFLICT_REMEDY).toContain("git rebase --continue");
    expect(CONFLICT_REMEDY).toContain("git reset --hard <remote>/deguboard");
    await expect(runCommand(ticketCreate, b, { title: "新しい題" })).rejects.toMatchObject({
      code: "SYNC_CONFLICT",
      message: expect.stringContaining(CONFLICT_REMEDY),
    });
    // CAS でない即時の書き込みは、取り込みと push の両方で競合しても戻し方を 1 回だけ案内する
    const written = await withWrite(
      b,
      async () => {
        await b.store.update("ticket", "t1", { priority: "high" });
      },
      { message: "t1 を更新", immediate: true },
    );
    expect(written.write.pushed).toBe(false);
    expect(written.write.warnings.join("\n").split(CONFLICT_REMEDY)).toHaveLength(2);
  });
});
