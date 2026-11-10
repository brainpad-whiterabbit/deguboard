import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, git, type Fixture } from "../../test/helpers/git-fixture.js";
import { openContext } from "../commands/context.js";
import { runCommand, type CommandContext } from "../commands/define.js";
import { planApprove, planClose, planCreate } from "../commands/plan.js";
import { configSet, init, sync } from "../commands/setup.js";
import { ticketCreate, ticketUpdate } from "../commands/ticket.js";
import { attributesFile, mergeDocuments, mergeDriverCommandLine } from "./merge.js";
import { checkOutside, recordBaseline } from "./outside.js";
import { CONFLICT_REMEDY, UNRESOLVABLE_REMEDY, withWrite } from "./write.js";

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
      resolved: [],
    });
  });

  it("片側が足したフィールドと消したフィールドを反映し、frontmatter が ours のままならそのバイト列を保つ", async () => {
    const base = doc({ ...BASE, labels: "[web]" });
    const added = await mergeDocuments(base, base, doc({ ...BASE, labels: "[web]", epic: "e1" }));
    expect(added).toEqual({
      ok: true,
      text: doc({ ...BASE, labels: "[web]", epic: "e1" }),
      resolved: [],
    });
    const removed = await mergeDocuments(base, base, doc(BASE));
    expect(removed).toEqual({ ok: true, text: doc(BASE), resolved: [] });
    const ours = "---\nid: t1 # コメント\n---\n本文\n";
    expect(
      await mergeDocuments("---\nid: t1\n---\n本文\n", ours, "---\nid: t1\n---\n本文\n"),
    ).toEqual({ ok: true, text: ours, resolved: [] });
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
      resolved: [],
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

  it("frontmatter のない YAML は、両側が別のフィールドを変えたらフィールド単位で解き、書式とコメントを保つ", async () => {
    const base = [
      "# Plan のコメント",
      "id: p1",
      "tickets:",
      "  - t1 # 先に進める",
      "  - t2",
      'approved_by: ""',
      "updated_at: 2026-11-01T00:00:00Z",
      "",
    ].join("\n");
    const ours = base
      .replace('approved_by: ""', "approved_by: eiki")
      .replace("00:00:00Z", "00:00:05Z");
    const theirs = `${base.replace("00:00:00Z", "00:00:09Z")}closed_at: 2026-11-01T00:00:09Z\n`;
    const merged = await mergeDocuments(base, ours, theirs);
    expect(merged).toEqual({
      ok: true,
      text: `${ours.replace("00:00:05Z", "00:00:09Z")}closed_at: 2026-11-01T00:00:09Z\n`,
      resolved: [],
    });
    // 片側だけの変更なら、その側の YAML を 1 バイトも変えずに返す
    expect(await mergeDocuments(base, ours, base)).toEqual({ ok: true, text: ours, resolved: [] });
  });

  it("frontmatter のない YAML でも、両側が同じフィールドを違う値に変えたら競合として返し、形の揃わない 3 つは行単位に任せる", async () => {
    const base = "id: p1\nclosed_at: null\n";
    const r = await mergeDocuments(
      base,
      "id: p1\nclosed_at: 2026-11-01T00:00:01Z\n",
      "id: p1\nclosed_at: 2026-11-01T00:00:02Z\n",
    );
    expect(r).toEqual({ ok: false, conflicts: ["closed_at"] });
    expect(await mergeDocuments(base, doc({ id: "p1" }), base)).toBeUndefined();
  });

  it("採る側を渡すと、競合したフィールドと本文のぶつかった行だけその側を採り、採った値と捨てた値を返す", async () => {
    const body = "## 概要\n\n一\n二\n三\n四\n五\n";
    const base = doc(BASE, body);
    const ours = doc({ ...BASE, title: "ours の題", priority: "high" }, body.replace("三", "さん"));
    const theirs = doc(
      { ...BASE, title: "theirs の題", epic: "e1" },
      body.replace("三", "サン").replace("五", "ご"),
    );
    // prefer がなければ今までどおり競合
    expect(await mergeDocuments(base, ours, theirs)).toEqual({
      ok: false,
      conflicts: ["title", "本文"],
    });
    const byOurs = await mergeDocuments(base, ours, theirs, "ours");
    expect(byOurs).toEqual({
      ok: true,
      text: doc(
        { ...BASE, title: "ours の題", priority: "high", epic: "e1" },
        body.replace("三", "さん").replace("五", "ご"),
      ),
      resolved: [
        { field: "title", taken: "ours の題", discarded: "theirs の題" },
        {
          field: "本文",
          taken: body.replace("三", "さん"),
          discarded: body.replace("三", "サン").replace("五", "ご"),
        },
      ],
    });
    const byTheirs = await mergeDocuments(base, ours, theirs, "theirs");
    expect(byTheirs).toMatchObject({
      ok: true,
      text: doc(
        { ...BASE, title: "theirs の題", priority: "high", epic: "e1" },
        body.replace("三", "サン").replace("五", "ご"),
      ),
      resolved: [
        { field: "title", taken: "theirs の題", discarded: "ours の題" },
        { field: "本文" },
      ],
    });
    // add/add（base が空）は採る側があっても行単位に任せる（仮番号の衝突を 1 つのチケットにまとめない）
    expect(await mergeDocuments("", ours, theirs, "ours")).toBeUndefined();
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
    // 古い版の dg が作った（印のない）コミットを模すので、検査の基準をここに置く（SY-8）
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
    expect(synced.warnings.join("\n")).toContain("Conflicts with remote changes: tickets/t1.md");
    // ローカルのコミット（まとめ待ちを sync がコミットしたもの）は push されずに残る
    expect(synced.data.status).toMatchObject({ ahead: 1, behind: 1, dirty: false });
    expect((await git(b.repo.dataDir, ["show", "HEAD:tickets/t1.md"])).stdout).toContain(
      "title: B の題",
    );
    expect((await git(b.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
    expect(await t1(b)).toContain("title: B の題");
  });

  it("前の版の .gitattributes には、sync が Plan・Iteration・Project の行を足してコミットする", async () => {
    const f = await fixture();
    const { a } = await twoClones(f);
    const file = path.join(a.repo.dataDir, ".gitattributes");
    const old = [
      "# dg のマージドライバ（frontmatter をフィールド単位でマージする）",
      "tickets/*.md merge=deguboard",
      "tickets/deleted/*.md merge=deguboard",
      "epics/*.md merge=deguboard",
      "",
    ].join("\n");
    await writeFile(file, old);
    await git(a.repo.dataDir, ["commit", "-qam", "前の版の .gitattributes を模す"]);
    await recordBaseline(a.repo);
    await runCommand(sync, a, {});
    const text = await readFile(file, "utf8");
    expect(text.startsWith(old)).toBe(true);
    // .gitattributes がまだリモートにないときに rebase へ渡すローカルの属性ファイルにも入る
    const local = await readFile(attributesFile(a.repo), "utf8");
    for (const p of ["plans/p1.yaml", "iterations/s1.yaml", "projects/default.yaml"]) {
      const line = `${p.split("/")[0]}/*.yaml merge=deguboard`;
      expect(text).toContain(line);
      expect(local).toContain(line);
      const attr = await git(a.repo.dataDir, ["check-attr", "merge", p]);
      expect(attr.stdout.trim()).toBe(`${p}: merge: deguboard`);
    }
    expect((await git(a.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
    const log = await git(a.repo.dataDir, ["log", "-1", "--format=%s", "--", ".gitattributes"]);
    expect(log.stdout.trim()).toBe("マージドライバの .gitattributes を置く");
  });

  it("同じ Plan の別のフィールドを双方で変えた分岐を、sync が競合なしで揃える", async () => {
    const f = await fixture();
    const { a, b } = await twoClones(f);
    const created = await runCommand(planCreate, a, { tickets: ["t1"] });
    const id = created.data.id;
    await runCommand(sync, a, {});
    await runCommand(sync, b, {});
    await runCommand(planApprove, a, { plan: id });
    await runCommand(sync, a, {});
    await runCommand(planClose, b, { plan: id });
    const synced = await runCommand(sync, b, {});
    expect(synced.data.conflicts).toEqual([]);
    expect(synced.data.pushed).toBe(true);
    expect(b.store.plans.get(id)?.data).toMatchObject({
      pending_approval: false,
      approved_by: "eiki",
      closed_at: expect.any(String),
    });
    await runCommand(sync, a, {});
    const file = `plans/${id}.yaml`;
    expect(await readFile(path.join(a.repo.dataDir, file), "utf8")).toBe(
      await readFile(path.join(b.repo.dataDir, file), "utf8"),
    );
  });

  it("同じ Plan の同じフィールドを双方で違う値にした分岐は、今までどおり競合として報告する", async () => {
    const f = await fixture();
    const { a, b } = await twoClones(f);
    const created = await runCommand(planCreate, a, { tickets: ["t1"] });
    const id = created.data.id;
    await runCommand(sync, a, {});
    await runCommand(sync, b, {});
    await runCommand(planClose, a, { plan: id });
    await runCommand(sync, a, {});
    await runCommand(planClose, b, { plan: id });
    const synced = await runCommand(sync, b, {});
    expect(synced.data.conflicts).toEqual([`plans/${id}.yaml`]);
    expect(synced.data.pushed).toBe(false);
  });

  it("競合が残る間の sync の警告と起票の SYNC_CONFLICT は、同じ戻し方（人に remote か local を聞いて --resolve を 1 回呼ぶ）を案内する", async () => {
    const f = await fixture();
    const { a, b } = await twoClones(f);
    await runCommand(ticketUpdate, a, { ticket: "t1", title: "A の題" });
    await runCommand(sync, a, {});
    await runCommand(ticketUpdate, b, { ticket: "t1", title: "B の題" });
    const synced = await runCommand(sync, b, {});
    expect(synced.warnings.join("\n")).toContain(CONFLICT_REMEDY);
    // 戻し方は、自分では選ばずに人に remote か local を聞き、--resolve を 1 回呼ぶこと（--auto でも自動で選ばない）
    expect(CONFLICT_REMEDY).toContain("Do not choose yourself");
    expect(CONFLICT_REMEDY).toContain("dg sync --resolve <remote|local> once");
    expect(CONFLICT_REMEDY).toContain("It is not chosen automatically even with --auto");
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

describe("dg sync --resolve（SY-4）", () => {
  /** 同じ Plan を両側で閉じた分岐。b は閉じる前に承認し（競合したファイルの競合しないフィールド）、別のチケットも変える（競合しないコミット） */
  async function closedOnBothSides(f: Fixture) {
    const { a, b } = await twoClones(f);
    const id = (await runCommand(planCreate, a, { tickets: ["t1"] })).data.id;
    await runCommand(sync, a, {});
    await runCommand(sync, b, {});
    await runCommand(planClose, a, { plan: id });
    await runCommand(sync, a, {});
    const remoteClosedAt = a.store.plans.get(id)?.data.closed_at;
    await runCommand(planApprove, b, { plan: id });
    await runCommand(planClose, b, { plan: id });
    await runCommand(sync, b, {}); // 競合で止まり、まとめ待ちはコミットされて残る
    await runCommand(ticketUpdate, b, { ticket: "t1", priority: "high" });
    await runCommand(sync, b, {});
    const localClosedAt = b.store.plans.get(id)?.data.closed_at;
    expect(remoteClosedAt).not.toBe(localClosedAt);
    return { a, b, id, remoteClosedAt, localClosedAt };
  }

  for (const side of ["remote", "local"] as const) {
    it(`--resolve ${side} は競合したフィールドだけ ${side} の値を採り、照合と push まで済ませて ahead 0 / behind 0 にする`, async () => {
      const f = await fixture();
      const { a, b, id, remoteClosedAt, localClosedAt } = await closedOnBothSides(f);
      const before = await git(b.repo.dataDir, ["rev-list", "--count", "HEAD"]);
      const synced = await runCommand(sync, b, { resolve: side });
      expect(synced.data.conflicts).toEqual([]);
      expect(synced.data.pushed).toBe(true);
      expect(synced.data.status).toMatchObject({ ahead: 0, behind: 0, dirty: false });
      const [taken, discarded] =
        side === "remote" ? [remoteClosedAt, localClosedAt] : [localClosedAt, remoteClosedAt];
      expect(synced.data.resolved).toEqual([
        { file: `plans/${id}.yaml`, field: "closed_at", taken, discarded },
      ]);
      // 競合しないフィールド（承認）と競合しないコミット（t1 の優先度）は残る
      expect(b.store.plans.get(id)?.data).toMatchObject({
        closed_at: taken,
        approved_by: "eiki",
        pending_approval: false,
      });
      expect(b.store.tickets.get("t1")?.data.priority).toBe("high");
      // コミットは捨てずに積み直す（ローカルの 2 コミットがリモートの 1 コミットの上に載る）
      const after = await git(b.repo.dataDir, ["rev-list", "--count", "HEAD"]);
      expect(Number(after.stdout)).toBe(Number(before.stdout) + 1);
      // 基準はロックの中で更新されるので、次の書き込みが OUTSIDE_CHANGES で止まらない
      expect((await checkOutside(b.repo)).kind).toBe("clean");
      await expect(
        runCommand(ticketUpdate, b, { ticket: "t1", title: "続けて書ける" }),
      ).resolves.toBeDefined();
      // a が取り込むと同じ Plan になる
      await runCommand(sync, a, {});
      const file = `plans/${id}.yaml`;
      expect(await readFile(path.join(a.repo.dataDir, file), "utf8")).toBe(
        await readFile(path.join(b.repo.dataDir, file), "utf8"),
      );
    });
  }

  it("仮番号の衝突とまとめ待ちの変更が混ざっても、振り直し → まとめ待ちのコミット → resolve の順で 1 回で揃える", async () => {
    const f = await fixture();
    const { a, b } = await twoClones(f);
    // b はオフラインで t2 を起票する（仮番号）
    await git(f.cloneB, ["remote", "set-url", "origin", path.join(f.root, "nonexistent.git")]);
    const created = await runCommand(ticketCreate, b, { title: "B の 2" });
    expect(created.data.id).toBe("t2");
    expect(created.write).toMatchObject({ provisional: true });
    // その間に a が t2 を起票し、t1 の題を変えて push する
    await runCommand(ticketCreate, a, { title: "A の 2" });
    await runCommand(ticketUpdate, a, { ticket: "t1", title: "A の題" });
    await runCommand(sync, a, {});
    // b のまとめ待ち（未コミット）：仮番号の t2 の優先度と、a と競合する t1 の題
    await runCommand(ticketUpdate, b, { ticket: "t2", priority: "high" });
    await runCommand(ticketUpdate, b, { ticket: "t1", title: "B の題" });
    await git(f.cloneB, ["remote", "set-url", "origin", f.remoteDir]);

    const synced = await runCommand(sync, b, { resolve: "local" });
    expect(synced.data.renumbered).toEqual([{ from: "t2", to: "t3" }]);
    expect(synced.data.conflicts).toEqual([]);
    expect(synced.data.resolved).toEqual([
      { file: "tickets/t1.md", field: "title", taken: "B の題", discarded: "A の題" },
    ]);
    expect(synced.data.status).toMatchObject({ ahead: 0, behind: 0, dirty: false });
    expect([...b.store.tickets.values()].map((t) => `${t.id}:${t.data.title}`).sort()).toEqual([
      "t1:B の題",
      "t2:A の 2",
      "t3:B の 2",
    ]);
    // まとめ待ちの変更は振り直した番号のファイルに入り、振り直した起票の後にコミットされる
    expect(b.store.tickets.get("t3")?.data).toMatchObject({ priority: "high" });
    expect(b.store.tickets.get("t3")?.data.provisional).toBeUndefined();
    const log = (await git(b.repo.dataDir, ["log", "--format=%s", "-4"])).stdout.trim().split("\n");
    expect(log.slice(1, 3)).toEqual(["変更をまとめてコミット", "t3 を起票: B の 2"]);
    expect((await checkOutside(b.repo)).kind).toBe("clean");
  });

  it("config.yaml を両側で同じ行変えた分岐は、--resolve でも解けず data.conflicts に残し、push せず作業ツリーを clean にして rebase を中止する", async () => {
    const f = await fixture();
    const { a, b } = await twoClones(f);
    await runCommand(configSet, a, { key: "commit.mode", value: "each" });
    await runCommand(sync, a, {});
    // b は同じ行（commit.mode）を別の値にする。batch なので未コミットのまま sync が 1 コミットにする
    await runCommand(configSet, b, { key: "commit.mode", value: "manual" });
    const synced = await runCommand(sync, b, { resolve: "remote" });
    expect(synced.data.conflicts).toEqual(["config.yaml"]);
    expect(synced.data.resolved).toEqual([]);
    expect(synced.data.pushed).toBe(false);
    expect(synced.data.status).toMatchObject({ ahead: 1, behind: 1, dirty: false });
    expect(synced.warnings.join("\n")).toContain("Conflicts that --resolve cannot resolve remain");
    expect(synced.warnings.join("\n")).toContain("config.yaml");
    expect(synced.warnings.join("\n")).toContain(UNRESOLVABLE_REMEDY);
    expect((await git(b.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
    // 途中で止めず rebase を中止したので、REBASE_HEAD が残らない
    const rebasing = await git(b.repo.dataDir, ["rev-parse", "-q", "--verify", "REBASE_HEAD"]).then(
      () => true,
      () => false,
    );
    expect(rebasing).toBe(false);
  });

  it("commit.mode が manual で未コミットの変更を持ったまま --resolve を呼ぶと、まとめてコミットしてから競合を解き、push して揃える", async () => {
    const f = await fixture();
    const { a, b } = await twoClones(f);
    await runCommand(ticketUpdate, a, { ticket: "t1", title: "A の題" });
    await runCommand(sync, a, {});
    // 個人の設定で manual にする（チームの config.yaml は変えない）。開き直して、新しい設定で書く
    await runCommand(configSet, b, { key: "commit.mode", value: "manual", local: true });
    const bManual = await openContext({
      cwd: f.cloneB,
      actor: { kind: "human", user: "eiki" },
      mergeDriver: DRIVER,
    });
    await runCommand(ticketUpdate, bManual, { ticket: "t1", title: "B の題" });
    // manual なので書き込みはコミットされず、作業ツリーに残ったまま
    expect((await git(bManual.repo.dataDir, ["status", "--porcelain"])).stdout).not.toBe("");
    const synced = await runCommand(sync, bManual, { resolve: "local" });
    expect(synced.data.conflicts).toEqual([]);
    expect(synced.data.resolved).toEqual([
      { file: "tickets/t1.md", field: "title", taken: "B の題", discarded: "A の題" },
    ]);
    expect(synced.data.pushed).toBe(true);
    expect(synced.data.status).toMatchObject({ ahead: 0, behind: 0, dirty: false });
    expect((await git(bManual.repo.dataDir, ["show", "HEAD:tickets/t1.md"])).stdout).toContain(
      "title: B の題",
    );
    await runCommand(sync, a, {});
    expect(await t1(a)).toContain("title: B の題");
  });
});
