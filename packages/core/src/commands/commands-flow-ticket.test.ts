// チケットの流れのうち、遷移の制約・依存・担当・起票者・import・update・check と、Epic と Iteration

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../test/helpers/git-fixture.js";
import { UsageError } from "../errors.js";
import { pickUser } from "../model/actor.js";
import { recordBaseline } from "../git/outside.js";
import { osUserName } from "../git/repo.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { epicAdd, epicClose, epicCreate, epicReopen, epicShow, epicUpdate } from "./epic.js";
import {
  iterationAdd,
  iterationClose,
  iterationCreate,
  iterationReopen,
  iterationUpdate,
  iterationShow,
  iterationStart,
} from "./iteration.js";
import { projectCreate } from "./project.js";
import { configSet, lint, sync, whoami } from "./setup.js";
import {
  ticketCheck,
  ticketClaim,
  ticketCreate,
  ticketDelete,
  ticketImport,
  ticketList,
  ticketMove,
  ticketShow,
  ticketUnclaim,
  ticketUpdate,
} from "./ticket.js";
import {
  fixture,
  writeStrictWorkflow,
  initialized,
  runCleanups,
} from "../../test/helpers/commands-context.js";

afterEach(runCleanups);

describe("チケットの流れ（遷移・担当・編集）", () => {
  it("既定ではどの遷移も通り、制約を書いた Workflow では by: []・by: [human]・requires: [deps_done] で拒否される", async () => {
    const f = await fixture();
    const human = await initialized(f.cloneA);
    // 既定（general）：todo → done も、依存が終わっていない claim も、agent の abandoned も通る
    await runCommand(ticketCreate, human, { title: "A" });
    await runCommand(ticketCreate, human, { title: "B", depends_on: ["t1"] });
    const agent = await openContext({
      cwd: f.cloneA,
      actor: { kind: "agent", user: "claude" },
    });
    expect(
      (await runCommand(ticketMove, human, { ticket: "t1", status: "done" })).data.status,
    ).toBe("done");
    expect(
      (await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t2" })).data.status,
    ).toBe("in_progress");
    const dropped = (await runCommand(ticketMove, agent, { ticket: "t2", status: "abandoned" }))
      .data;
    expect(dropped.status).toBe("abandoned");
    expect(dropped.assignee).toBeUndefined();

    // strict：制約に当たる遷移だけが拒否される
    await writeStrictWorkflow(human);
    await runCommand(ticketCreate, human, { title: "C", workflow: "strict" });
    await runCommand(ticketCreate, human, { title: "D", depends_on: ["t3"], workflow: "strict" });
    await agent.store.rescan();
    await expect(
      runCommand(ticketMove, human, { ticket: "t3", status: "done" }),
    ).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "todo から done への遷移は Workflow がこの主体に許していない",
    });
    await expect(
      runCommand(ticketClaim, human, { no_worktree: true, ticket: "t4" }),
    ).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "todo から in_progress への遷移の条件を満たしていない: deps_done",
    });
    await expect(
      runCommand(ticketMove, agent, { ticket: "t3", status: "abandoned" }),
    ).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    const abandoned = await runCommand(ticketMove, human, { ticket: "t3", status: "abandoned" });
    expect(abandoned.data.status).toBe("abandoned");
    const list = await runCommand(ticketList, human, {});
    expect(list.data.map((t) => t.id)).toEqual(["t1", "t4"]);
    const all = await runCommand(ticketList, human, { include_abandoned: true });
    expect(all.data.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
    // 依存先が abandoned なら deps_done は満たされ、着手できる（WF-2）
    const ready = await runCommand(ticketList, human, { ready: true });
    expect(ready.data.map((t) => t.id)).toEqual(["t4"]);
    const claimed = await runCommand(ticketClaim, human, { no_worktree: true, ticket: "t4" });
    expect(claimed.data.status).toBe("in_progress");
  });

  it("list は各行に deps_done を載せ、show と同じく別の Project の依存先も見る", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(projectCreate, ctx, { id: "other" });
    await runCommand(ticketCreate, ctx, { title: "別の Project", project: "other" });
    await runCommand(ticketCreate, ctx, { title: "B", depends_on: ["t1"] });
    await runCommand(ticketCreate, ctx, { title: "C", depends_on: ["t2"] });
    const depsDone = async () =>
      (await runCommand(ticketList, ctx, { project: "default" })).data.map((t) => [
        t.id,
        t.deps_done,
      ]);
    expect(await depsDone()).toEqual([
      ["t2", false],
      ["t3", false],
    ]);
    // 依存先は default の一覧に出ないが、done になれば deps_done は真になる
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    expect(await depsDone()).toEqual([
      ["t2", true],
      ["t3", false],
    ]);
    const shown = await runCommand(ticketShow, ctx, { ticket: "t2" });
    expect(shown.data.deps_done).toBe(true);
    expect(shown.data.pending_deps).toEqual([]);
  });

  it("show は終わっていない依存先を ID と Status で出し、別の Project の終わった依存先は出さず、見つからない依存先は Status を null で出す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(projectCreate, ctx, { id: "other" });
    await runCommand(ticketCreate, ctx, { title: "別の Project・済み", project: "other" });
    await runCommand(ticketCreate, ctx, { title: "別の Project・途中", project: "other" });
    await runCommand(ticketCreate, ctx, { title: "やめた" });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "in_progress" });
    await runCommand(ticketMove, ctx, { ticket: "t3", status: "abandoned" });
    await runCommand(ticketCreate, ctx, { title: "待ち", depends_on: ["t1", "t2", "t3"] });
    const shown = await runCommand(ticketShow, ctx, { ticket: "t4" });
    expect(shown.data.pending_deps).toEqual([{ id: "t2", status: "in_progress" }]);
    expect(shown.data.deps_done).toBe(false);
    // 依存先を消すと Status の分からない待ちとして残る（deps_done と同じく待つ）
    await runCommand(ticketDelete, ctx, { ticket: "t1" });
    expect((await runCommand(ticketShow, ctx, { ticket: "t4" })).data.pending_deps).toEqual([
      { id: "t1", status: null },
      { id: "t2", status: "in_progress" },
    ]);
  });

  it("unclaim は自分（同じユーザの人と AI）の claim だけ外し、他人のものは force が要る", async () => {
    const f = await fixture();
    const eiki = await initialized(f.cloneA);
    await runCommand(ticketCreate, eiki, { title: "A" });
    await runCommand(ticketClaim, eiki, { no_worktree: true, ticket: "t1", branch: "feature/a" });
    const other = await openContext({ cwd: f.cloneA, actor: { kind: "human", user: "other" } });
    await expect(runCommand(ticketUnclaim, other, { ticket: "t1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    const r = await runCommand(ticketUnclaim, other, { ticket: "t1", force: true });
    expect(r.data).toMatchObject({ status: "todo" });
    expect(r.data.assignee).toBeUndefined();
    expect(r.data.branch).toBeUndefined();
    expect(r.data.pr).toBeUndefined();

    // eiki の AI が claim したものは eiki 本人が force なしで外せる
    const eikiAgent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    const byAgent = await runCommand(ticketClaim, eikiAgent, { no_worktree: true, ticket: "t1" });
    expect(byAgent.data.assignee).toBe("eiki/agent");
    await eiki.store.rescan();
    const released = await runCommand(ticketUnclaim, eiki, { ticket: "t1" });
    expect(released.data.status).toBe("todo");
  });

  it("todo に残った前の作業の PR（unclaim 前の記録）は、新しい claim で外れ、もう一度の claim の判定にならない（ST-3・ST-7・ST-9）", async () => {
    const f = await fixture();
    const eiki = await initialized(f.cloneA);
    await runCommand(ticketCreate, eiki, { title: "A" });
    // 前の作業の PR を記録したまま todo に残ったチケット（pr を外す前の unclaim で残ったもの）
    await runCommand(ticketUpdate, eiki, { ticket: "t1", pr: 7 });
    const claimed = await runCommand(ticketClaim, eiki, {
      no_worktree: true,
      ticket: "t1",
      branch: "feature/a",
    });
    expect(claimed.data).toMatchObject({ status: "in_progress", assignee: "eiki" });
    expect(claimed.data.pr).toBeUndefined();
    expect(claimed.warnings.some((w) => w.includes("手直しの開始"))).toBe(false);
  });

  it("whoami は操作している主体の ID・ユーザ名・種別と、本人とみなす ID（人とその AI）を返す", async () => {
    const f = await fixture();
    const human = await initialized(f.cloneA);
    expect((await runCommand(whoami, human, {})).data).toEqual({
      id: "eiki",
      user: "eiki",
      user_source: "flag",
      kind: "human",
      own_ids: ["eiki", "eiki/agent"],
    });
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    expect((await runCommand(whoami, agent, {})).data).toEqual({
      id: "eiki/agent",
      user: "eiki",
      user_source: "flag",
      kind: "agent",
      own_ids: ["eiki", "eiki/agent"],
    });
  });

  it("主体のユーザ名は --user > DEGUBOARD_USER > git config の deguboard.user > git の user.name > OS のユーザ名の順で決まり、whoami が出どころを返す（t217）", async () => {
    const f = await fixture();
    await initialized(f.cloneA);
    const who = async (actor: Parameters<typeof openContext>[0]["actor"]) => {
      const ctx = await openContext({ cwd: f.cloneA, ...(actor ? { actor } : {}) });
      const { user, user_source } = (await runCommand(whoami, ctx, {})).data;
      return { user, user_source };
    };
    // 入口が渡すもの：--user と DEGUBOARD_USER（pickUser）
    expect(await who(pickUser("flag-u", "env-u"))).toEqual({ user: "flag-u", user_source: "flag" });
    expect(await who(pickUser(undefined, "env-u"))).toEqual({ user: "env-u", user_source: "env" });
    // 入口が何も渡さなければ git から決める
    expect(await who(pickUser(undefined, undefined))).toEqual({
      user: "テスト",
      user_source: "user.name",
    });
    await git(f.cloneA, ["config", "deguboard.user", "deg"]);
    expect(await who(undefined)).toEqual({ user: "deg", user_source: "git-config" });
    expect(await who(pickUser(undefined, "env-u"))).toEqual({ user: "env-u", user_source: "env" });
    // どちらも空なら OS のユーザ名（passwd に項目がない環境では USER などの代わりの値。osUserName のテストで確かめる）
    await git(f.cloneA, ["config", "deguboard.user", ""]);
    await git(f.cloneA, ["config", "user.name", ""]);
    expect(await who(undefined)).toEqual({ user: osUserName(), user_source: "os" });
  });

  it("起票者は既定で操作した主体、created_by: human でユーザ本人になり、担当者は create / update / claim で付く", async () => {
    const f = await fixture();
    const human = await initialized(f.cloneA);
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    const byAgent = await runCommand(ticketCreate, agent, { title: "A" });
    expect(byAgent.data.created_by).toBe("eiki/agent");
    const directed = await runCommand(ticketCreate, agent, {
      title: "B",
      created_by: "human",
      assignee: "agent",
    });
    expect(directed.data).toMatchObject({ created_by: "eiki", assignee: "eiki/agent" });

    await human.store.rescan();
    const assigned = await runCommand(ticketUpdate, human, { ticket: "t1", assignee: "other" });
    expect(assigned.data.assignee).toBe("other");
    // 事前の担当者と別のユーザが claim すると上書きし、warnings で知らせる
    const claimed = await runCommand(ticketClaim, human, { no_worktree: true, ticket: "t1" });
    expect(claimed.data.assignee).toBe("eiki");
    expect(claimed.warnings).toContain("担当者を other から eiki に変えた");
    // todo に戻すと担当者は消える。起票者は残る
    const back = await runCommand(ticketMove, human, { ticket: "t1", status: "todo" });
    expect(back.data.assignee).toBeUndefined();
    expect(back.data.created_by).toBe("eiki/agent");
    const cleared = await runCommand(ticketUpdate, human, { ticket: "t2", assignee: null });
    expect(cleared.data.assignee).toBeUndefined();

    // 絞り込み（human / agent は自分に解く）
    await runCommand(ticketUpdate, human, { ticket: "t2", assignee: "agent" });
    const mine = await runCommand(ticketList, human, { assignee: "agent" });
    expect(mine.data.map((t) => t.id)).toEqual(["t2"]);
    const filed = await runCommand(ticketList, human, { created_by: "human" });
    expect(filed.data.map((t) => t.id)).toEqual(["t2"]);
    // 事前に担当者が付いていても ready には出る
    const ready = await runCommand(ticketList, human, { ready: true });
    expect(ready.data.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("旧名の claimed_by は assignee として読め、担当者を書く操作で消える", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    const file = path.join(ctx.repo.dataDir, "tickets/t1.md");
    const text = await readFile(file, "utf8");
    await writeFile(
      file,
      text.replace("status: todo", "status: in_progress\nclaimed_by: eiki@laptop"),
    );
    // 古い版の dg が書いた形を模すので、検査の基準をここに置く（SY-8）
    await recordBaseline(ctx.repo);
    await ctx.store.rescan();
    const shown = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(shown.data.assignee).toBe("eiki@laptop");
    expect("claimed_by" in shown.data).toBe(false);
    // 旧 ID はホスト名を含むので別のユーザに見える。force で外すとファイルから claimed_by も消える
    const released = await runCommand(ticketUnclaim, ctx, { ticket: "t1", force: true });
    expect(released.data.assignee).toBeUndefined();
    expect(await readFile(file, "utf8")).not.toContain("claimed_by");
  });

  it("同じチケットを 2 つの clone が claim すると、負けた側は CLAIM_LOST で assignee を書き換えない", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    await runCommand(ticketCreate, a, { title: "A" });
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "agent", user: "b" },
    });
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await runCommand(ticketClaim, b, { no_worktree: true, ticket: "t1" });
      },
    };
    const racer = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "a" }, hooks });
    await expect(
      runCommand(ticketClaim, racer, { no_worktree: true, ticket: "t1" }),
    ).rejects.toMatchObject({
      code: "CLAIM_LOST",
    });
    expect(racer.store.tickets.get("t1")?.data.assignee).toBe("b/agent");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("ticket list の query は前後の空白を除き大文字小文字を区別せず、番号・タイトル・ラベルの部分一致で当たり、空白だけならすべてに当たる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketImport, ctx, {
      drafts: Array.from({ length: 12 }, (_, i) => ({
        title: `チケット ${i + 1}`,
        labels: i === 4 ? ["Frontend"] : [],
      })),
    });
    const ids = async (query: string) =>
      (await runCommand(ticketList, ctx, { query })).data.map((t) => t.id);
    expect(await ids(" T1 ")).toEqual(["t1", "t10", "t11", "t12"]);
    expect(await ids("frontEND")).toEqual(["t5"]);
    expect(await ids("チケット 12")).toEqual(["t12"]);
    const all = (await runCommand(ticketList, ctx, {})).data.map((t) => t.id);
    expect(all).toHaveLength(12);
    expect(await ids("   ")).toEqual(all);
  });

  it("import は仮キーを depends_on から参照でき、1 コミットで採番する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const r = await runCommand(ticketImport, ctx, {
      drafts: [
        { key: "schema", title: "スキーマ", acceptance: ["表が決まる"] },
        { key: "api", title: "API", depends_on: ["schema"] },
        { title: "画面", depends_on: ["api", "schema"] },
      ],
    });
    expect(r.data.map((t) => [t.id, t.depends_on])).toEqual([
      ["t1", []],
      ["t2", ["t1"]],
      ["t3", ["t2", "t1"]],
    ]);
    const shown = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(shown.data.body).toContain("- [ ] 表が決まる\n");
    const log = (await git(ctx.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log[0]).toBe("3 件のチケットを取り込み: t1, t2, t3");
    await expect(
      runCommand(ticketImport, ctx, {
        drafts: [
          { key: "x", title: "x", depends_on: ["y"] },
          { key: "y", title: "y", depends_on: ["x"] },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const ready = await runCommand(ticketList, ctx, { ready: true });
    expect(ready.data.map((t) => t.id)).toEqual(["t1"]);
  });

  it("import の本文は、本文の項目の引用しない値に行末コメントがあると INVALID_INPUT で起票しない（drafts と一緒の指定も拒む）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const head = async () => (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    const before = await head();
    const cases: Array<[string, string]> = [
      ["- title: 設定 #/config の画面\n", "1 件目の title"],
      ["- title: A\n- title: B\n  summary: 戻る #/board へ\n", "2 件目の summary"],
      [
        "- title: A\n  acceptance:\n    - 条件 1\n    - 歯車で #/config # 開く\n",
        "1 件目の acceptance",
      ],
      ["drafts:\n  - title: A\n    body: 本文 #/config\n", "1 件目の body"],
      ["- title: A\n  body: 複数行の\n    最後の行 #/config\n", "1 件目の body"],
    ];
    for (const [source, field] of cases) {
      await expect(runCommand(ticketImport, ctx, { source })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(runCommand(ticketImport, ctx, { source })).rejects.toThrow(field);
    }
    await expect(
      runCommand(ticketImport, ctx, {
        drafts: [{ title: "A" }],
        source: "- title: B\n",
      }),
    ).rejects.toThrow("一緒に");
    expect(await head()).toBe(before);
  });

  it("import の本文は、ほかの項目の行末コメント・行だけのコメント・引用した値・body の | の中の # を本文として残す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const source = [
      "# 行だけのコメント",
      "- key: a # 仮キー",
      '  title: "設定 #/config の画面" # 引用の後ろ',
      "  priority: high # 優先度",
      "  # 項目の間のコメント",
      "  acceptance: ['歯車で #/config を開く', \"戻る #/board\"] # 条件",
      "- key: b",
      "  title: 本文を書く",
      "  depends_on: [a] # 依存",
      "  body: | # 見出しの後ろ",
      "    ## 概要",
      "",
      "    #/config を開く # 中の #",
      "",
    ].join("\n");
    const imported = await runCommand(ticketImport, ctx, { source });
    const shown = await Promise.all(
      imported.data.map(async (t) => (await runCommand(ticketShow, ctx, { ticket: t.id })).data),
    );
    const a = shown[0]!;
    const b = shown[1]!;
    expect(a).toMatchObject({ title: "設定 #/config の画面", priority: "high" });
    expect(a.body).toContain("- [ ] 歯車で #/config を開く");
    expect(a.body).toContain("- [ ] 戻る #/board");
    expect(b).toMatchObject({ title: "本文を書く", depends_on: [a.id] });
    expect(b.body).toContain("#/config を開く # 中の #");
  });

  it("import の本文は、引用しない値の次の行の深く字下げした行だけのコメントを拒まない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const source of [
      "- title: A\n  body: x\n    # c\n",
      "- title: A\n      # c\n  body: y\n",
    ]) {
      const imported = await runCommand(ticketImport, ctx, { source });
      expect(imported.data).toMatchObject([{ title: "A" }]);
    }
  });

  it("update は属性と本文を直し、循環する依存と未定義のフィールドを拒否する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", workflow: "software-development" });
    await runCommand(ticketCreate, ctx, { title: "B", depends_on: ["t1"] });
    const r = await runCommand(ticketUpdate, ctx, {
      ticket: "t1",
      priority: "high",
      fields: { estimate: 3 },
      body: "## 概要\n\n直した\n",
    });
    expect(r.data).toMatchObject({ priority: "high", estimate: 3, body: "## 概要\n\n直した\n" });
    // acceptance は受け入れ条件の節だけを置き換え、節がなければ足す。body とは同時に指定できない
    const a1 = await runCommand(ticketUpdate, ctx, { ticket: "t1", acceptance: ["a", "b"] });
    expect(a1.data.body).toBe("## 概要\n\n直した\n\n## 受け入れ条件\n\n- [ ] a\n- [ ] b\n");
    await runCommand(ticketUpdate, ctx, {
      ticket: "t1",
      body: "## 概要\n\n直した\n\n## 受け入れ条件\n\n- [x] a\n- [ ] b\n",
    });
    const a2 = await runCommand(ticketUpdate, ctx, { ticket: "t1", acceptance: ["b", "a", "c"] });
    expect(a2.data.body).toBe(
      "## 概要\n\n直した\n\n## 受け入れ条件\n\n- [ ] b\n- [x] a\n- [ ] c\n",
    );
    // 英語の名前の節も同じに置き換える
    await runCommand(ticketUpdate, ctx, {
      ticket: "t1",
      body: "## Summary\n\ns\n\n## Acceptance criteria\n\n- [x] a\n\n## References\n\n- x.ts\n",
    });
    const a3 = await runCommand(ticketUpdate, ctx, { ticket: "t1", acceptance: ["a", "b"] });
    expect(a3.data.body).toBe(
      "## Summary\n\ns\n\n## Acceptance criteria\n\n- [x] a\n- [ ] b\n\n## References\n\n- x.ts\n",
    );
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t1", body: "x", acceptance: ["a"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t1", depends_on: ["t2"] }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t1", fields: { nope: 1 } }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const shown = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(shown.data.dependents).toEqual(["t2"]);
    const text = await readFile(path.join(ctx.repo.dataDir, "tickets/t1.md"), "utf8");
    expect(text).toContain("estimate: 3");
  });

  it("check は番号で受け入れ条件に印を付け外しし、show が acceptance を出す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", summary: "s", acceptance: ["a", "b", "c"] });
    const shown = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(shown.data.acceptance).toEqual([
      { index: 1, text: "a", checked: false },
      { index: 2, text: "b", checked: false },
      { index: 3, text: "c", checked: false },
    ]);
    const checked = await runCommand(ticketCheck, ctx, { ticket: "t1", items: [3, 1, 1] });
    expect(checked.data.body).toBe(
      "## Summary\n\ns\n\n## Acceptance criteria\n\n- [x] a\n- [ ] b\n- [x] c\n",
    );
    expect(checked.data.acceptance.map((i) => i.checked)).toEqual([true, false, true]);
    // 前の版の雛形の日本語の名前の節も同じに読み、印を付ける
    await runCommand(ticketCreate, ctx, {
      title: "J",
      body: "## 概要\n\ns\n\n## 受け入れ条件\n\n- [ ] a\n- [ ] b\n",
    });
    expect((await runCommand(ticketShow, ctx, { ticket: "t2" })).data.acceptance).toHaveLength(2);
    const ja = await runCommand(ticketCheck, ctx, { ticket: "t2", items: [2] });
    expect(ja.data.body).toBe("## 概要\n\ns\n\n## 受け入れ条件\n\n- [ ] a\n- [x] b\n");
    expect(checked.write).toMatchObject({ committed: false });
    const undone = await runCommand(ticketCheck, ctx, { ticket: "t1", items: [1], undo: true });
    expect(undone.data.acceptance.map((i) => i.checked)).toEqual([false, false, true]);
    const none = await runCommand(ticketCheck, ctx, { ticket: "t1", all: true, undo: true });
    expect(none.data.acceptance.some((i) => i.checked)).toBe(false);
    const all = await runCommand(ticketCheck, ctx, { ticket: "t1", all: true });
    expect(all.data.acceptance.every((i) => i.checked)).toBe(true);
    // batch なので作業ツリーに残り、sync がまとめてコミットする
    await runCommand(sync, ctx, {});
    const log = (await git(ctx.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log[0]).toBe("変更をまとめてコミット");
  });

  it("check は all と番号の同時指定・無指定を INVALID_INPUT、節や項目がない・範囲外を NOT_FOUND で拒否する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", acceptance: ["a", "b", "c"] });
    await runCommand(ticketCreate, ctx, { title: "B", body: "本文だけ\n" });
    await runCommand(ticketCreate, ctx, { title: "C", summary: "雛形のまま" });
    await expect(
      runCommand(ticketCheck, ctx, { ticket: "t1", all: true, items: [1] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(runCommand(ticketCheck, ctx, { ticket: "t1", items: [] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(runCommand(ticketCheck, ctx, { ticket: "t2", items: [1] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(runCommand(ticketCheck, ctx, { ticket: "t3", all: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      runCommand(ticketCheck, ctx, { ticket: "t1", items: [2, 4] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("4") });
  });

  it("check は base が今の本文と同じなら書き、読んだ後に本文が変わっていれば REJECTED で書かない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", summary: "s", acceptance: ["a", "b"] });
    const read = (await runCommand(ticketShow, ctx, { ticket: "t1" })).data.body;
    const checked = await runCommand(ticketCheck, ctx, { ticket: "t1", items: [2], base: read });
    expect(checked.data.body).toBe(
      "## Summary\n\ns\n\n## Acceptance criteria\n\n- [ ] a\n- [x] b\n",
    );
    // 画面が古い本文（read）のまま 1 を押した：間に 2 の書き込みがあったので拒否し、本文は変えない
    await expect(
      runCommand(ticketCheck, ctx, { ticket: "t1", items: [1], base: read }),
    ).rejects.toMatchObject({ code: "REJECTED", message: expect.stringContaining("読み直して") });
    const shown = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(shown.data.body).toBe(checked.data.body);
    // 読み直した本文なら外せる
    const undone = await runCommand(ticketCheck, ctx, {
      ticket: "t1",
      items: [2],
      undo: true,
      base: shown.data.body,
    });
    expect(undone.data.body).toBe(read);
  });
});

describe("Epic と Iteration", () => {
  it("Epic の雛形は ## Summary を書き、lint は英語と日本語のどちらの名前の節も読む", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const created = await runCommand(epicCreate, ctx, { title: "E", summary: "目的" });
    expect((await runCommand(epicShow, ctx, { epic: created.data.id })).data.body).toBe(
      "## Summary\n\n目的\n",
    );
    await runCommand(epicCreate, ctx, { title: "F", body: "## 概要\n\n前の版\n" });
    await runCommand(epicCreate, ctx, { title: "G", body: "本文だけ\n" });
    const issues = (await runCommand(lint, ctx, {})).data.issues.filter(
      (i) => i.code === "lint_summary_missing",
    );
    expect(issues.map((i) => i.id)).toEqual(["e3"]);
  });

  it("Epic は進捗を都度求め、終わっていないチケットが残ると force なしでは閉じられない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const epic = await runCommand(epicCreate, ctx, { title: "ログインの刷新", summary: "目的" });
    expect(epic.data).toMatchObject({ id: "e1", status: "open" });
    await runCommand(ticketCreate, ctx, { title: "A", epic: "e1" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(epicAdd, ctx, { epic: "1", tickets: ["t2"] });
    const shown = await runCommand(epicShow, ctx, { epic: "e1" });
    expect(shown.data.progress).toEqual({
      total: 2,
      done: 0,
      by_status: { todo: 2, in_progress: 0, review: 0, done: 0, abandoned: 0 },
    });
    await expect(runCommand(epicClose, ctx, { epic: "e1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    // 既定では agent も閉じられる（actor.human_only が空）
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    const closed = await runCommand(epicClose, agent, { epic: "e1", force: true });
    expect(closed.data.status).toBe("closed");
    expect(closed.data.closed_at).toBeDefined();
    expect(closed.warnings).toHaveLength(1);
    await expect(runCommand(ticketCreate, agent, { title: "C", epic: "e1" })).rejects.toMatchObject(
      { code: "REJECTED" },
    );
    const reopened = await runCommand(epicReopen, agent, { epic: "e1" });
    expect(reopened.data.closed_at).toBeUndefined();
  });

  it("actor.human_only に入れたコマンドだけが agent から拒否され、人は通る", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(epicCreate, ctx, { title: "E", summary: "目的" });
    await runCommand(iterationCreate, ctx, { name: "Sprint 1" });
    // カンマ区切りで配列に入り、エイリアスは正式名に直る
    const set = await runCommand(configSet, ctx, {
      key: "actor.human_only",
      value: "epic.close, sprint.close",
    });
    expect(set.data.actor.human_only).toEqual(["epic.close", "iteration.close"]);
    await expect(
      runCommand(configSet, ctx, { key: "actor.human_only", value: "epic.nope" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    await expect(runCommand(epicClose, agent, { epic: "e1" })).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    await expect(runCommand(iterationClose, agent, { iteration: "s1" })).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    // 一覧にない操作はそのまま行える
    await runCommand(epicUpdate, agent, { epic: "e1", title: "E2" });
    const human = await openContext({ cwd: f.cloneA });
    expect((await runCommand(epicClose, human, { epic: "e1" })).data.status).toBe("closed");
    // 空文字で空に戻ると、agent も閉じる・再開できる（文脈ごとに store を持つので開き直す）
    const cleared = await runCommand(configSet, human, { key: "actor.human_only", value: "" });
    expect(cleared.data.actor.human_only).toEqual([]);
    const agent2 = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    expect((await runCommand(epicReopen, agent2, { epic: "e1" })).data.status).toBe("open");
    expect((await runCommand(iterationClose, agent2, { iteration: "s1" })).data.status).toBe(
      "closed",
    );
  });

  it("Iteration は開始・終了でき、閉じるときに完了と持ち越しを数える", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const it1 = await runCommand(iterationCreate, ctx, {
      name: "Sprint 1",
      start: "2026-11-01",
      end: "2026-11-14",
    });
    expect(it1.data).toMatchObject({ id: "s1", status: "planned" });
    expect(it1.data).not.toHaveProperty("tickets");
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B", priority: "high" });
    const added = await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t2", "t1"] });
    expect(added.data).toEqual({ iteration: "s1", tickets: ["t2", "t1"] });
    await runCommand(iterationStart, ctx, { iteration: "1" });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "in_progress" });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    // 所属はチケットの iteration だけで表し、並びは優先度と番号（IT-2・IT-3）
    const shown = await runCommand(iterationShow, ctx, { iteration: "s1" });
    expect(shown.data.items.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(shown.data).not.toHaveProperty("tickets");
    // 進捗は Epic と同じ形で、abandoned を除いた件数と done の件数（EP-3）
    expect(shown.data.progress).toEqual({
      total: 2,
      done: 1,
      by_status: { todo: 1, in_progress: 0, review: 0, done: 1, abandoned: 0 },
    });
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    const closed = await runCommand(iterationClose, agent, { iteration: "s1" });
    expect(closed.data).toMatchObject({ status: "closed", completed: 1, carried_over: 1 });
    expect(agent.store.tickets.get("t2")?.data.iteration).toBeUndefined();
    expect(agent.store.tickets.get("t1")?.data.iteration).toBe("s1");
  });

  it("update は指定した属性だけを直し、閉じた Iteration も直せる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(iterationCreate, ctx, {
      name: "Sprint 1",
      start: "2026-12-13",
      end: "2026-12-26",
    });
    const updated = await runCommand(iterationUpdate, ctx, { iteration: "1", goal: "履歴を読む" });
    expect(updated.data).toMatchObject({
      name: "Sprint 1",
      goal: "履歴を読む",
      start: "2026-12-13",
      end: "2026-12-26",
      status: "planned",
    });
    // start と end の形の誤りは入力の誤り（UsageError）で、どちらも記録を変えない
    for (const dates of [{ end: "12/27" }, { start: "2026-12-1" }, { start: "2026/12/13" }]) {
      await expect(
        runCommand(iterationUpdate, ctx, { iteration: "s1", ...dates }),
      ).rejects.toBeInstanceOf(UsageError);
    }
    expect(ctx.store.iterations.get("s1")?.data).toMatchObject({
      start: "2026-12-13",
      end: "2026-12-26",
    });
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    const renamed = await runCommand(iterationUpdate, ctx, {
      iteration: "s1",
      name: "Sprint 1b",
      goal: "",
      end: "2026-12-27",
    });
    expect(renamed.data).toMatchObject({
      name: "Sprint 1b",
      goal: "",
      end: "2026-12-27",
      status: "closed",
    });
  });

  it("start は開始日を始めた日（手元の暦日）に書き換えて終了日は変えず、reopen では開始日を変えない", async () => {
    const f = await fixture();
    // 手元の暦日で数えるので、時差によらず同じ日になる昼の時刻にする
    let clock = new Date(2026, 10, 3, 12, 0, 0);
    const ctx = await initialized(f.cloneA, { now: () => clock });
    // 予定の開始日が後でも前でも、開始日がなくても始めた日になる
    for (const dates of [
      { start: "2026-11-10", end: "2026-11-20" },
      { start: "2026-10-20", end: "2026-11-01" },
      {},
    ]) {
      await runCommand(iterationCreate, ctx, { name: "Sprint", ...dates });
    }
    const expected = [
      { id: "s1", end: "2026-11-20" },
      { id: "s2", end: "2026-11-01" },
      { id: "s3", end: undefined },
    ];
    for (const { id, end } of expected) {
      const started = await runCommand(iterationStart, ctx, { iteration: id });
      expect(started.data.start).toBe("2026-11-03");
      expect(started.data.end).toBe(end);
      // active は Project に 1 つなので、次を始める前に閉じる
      await runCommand(iterationClose, ctx, { iteration: id });
    }
    clock = new Date(2026, 10, 5, 12, 0, 0);
    const reopened = await runCommand(iterationReopen, ctx, { iteration: "s3" });
    expect(reopened.data).toMatchObject({ start: "2026-11-03", end: "2026-11-03" });
  });

  it("close は終了日を閉じた日（手元の暦日）に書き換え、開始日が後なら開始日も揃え、reopen しても終了日はそのまま", async () => {
    const f = await fixture();
    // 手元の暦日で数えるので、時差によらず同じ日になる昼の時刻にする
    const clock = new Date(2026, 10, 3, 12, 0, 0);
    const ctx = await initialized(f.cloneA, { now: () => clock });
    // 予定の終了日が閉じた日より後でも、終了日がなくても閉じた日になる
    await runCommand(iterationCreate, ctx, {
      name: "Sprint 1",
      start: "2026-11-01",
      end: "2026-11-14",
    });
    await runCommand(iterationCreate, ctx, { name: "Sprint 2" });
    // 予定の終了日を過ぎてから閉じても閉じた日になる
    await runCommand(iterationCreate, ctx, {
      name: "Sprint 3",
      start: "2026-10-20",
      end: "2026-11-01",
    });
    // 始める前に閉じたときは、期間が逆にならないよう開始日も閉じた日になる
    await runCommand(iterationCreate, ctx, {
      name: "Sprint 4",
      start: "2026-11-10",
      end: "2026-11-20",
    });
    const first = await runCommand(iterationClose, ctx, { iteration: "s1" });
    expect(first.data).toMatchObject({ start: "2026-11-01", end: "2026-11-03" });
    const second = await runCommand(iterationClose, ctx, { iteration: "s2" });
    expect(second.data.end).toBe("2026-11-03");
    expect(second.data.start).toBeUndefined();
    const third = await runCommand(iterationClose, ctx, { iteration: "s3" });
    expect(third.data).toMatchObject({ start: "2026-10-20", end: "2026-11-03" });
    const fourth = await runCommand(iterationClose, ctx, { iteration: "s4" });
    expect(fourth.data).toMatchObject({ start: "2026-11-03", end: "2026-11-03" });
    const reopened = await runCommand(iterationReopen, ctx, { iteration: "s1" });
    expect(reopened.data.end).toBe("2026-11-03");
  });

  it("閉じた Iteration は reopen で active に戻り、件数が消えてチケットを入れ直せる", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(iterationCreate, ctx, { name: "Sprint 1" });
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] });
    // 閉じていなければ拒否
    await expect(runCommand(iterationReopen, ctx, { iteration: "s1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    const closed = await runCommand(iterationClose, ctx, { iteration: "s1" });
    expect(closed.data).toMatchObject({ status: "closed", completed: 0, carried_over: 1 });
    await expect(
      runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t1"] }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    // 既定では agent も再開できる。持ち越しがあれば入れ直しを促す
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    const reopened = await runCommand(iterationReopen, agent, { iteration: "1" });
    expect(reopened.data.status).toBe("active");
    expect(reopened.data.closed_at).toBeUndefined();
    expect(reopened.data.completed).toBeUndefined();
    expect(reopened.data.carried_over).toBeUndefined();
    // 再開は即座に push するので、まとめ待ちの変更を先にコミットした警告も並ぶ
    expect(reopened.warnings).toEqual([
      "まとめ待ちの変更を先にコミットした",
      "閉じたときに外した 1 件は戻らない。iteration add で入れ直す",
    ]);
    // 持ち越したチケットは戻らないので入れ直す
    expect(agent.store.tickets.get("t1")?.data.iteration).toBeUndefined();
    await runCommand(iterationAdd, agent, { iteration: "s1", tickets: ["t1"] });
    expect(agent.store.tickets.get("t1")?.data.iteration).toBe("s1");
    // 持ち越しがなければ警告は出ない
    await runCommand(ticketMove, agent, { ticket: "t1", status: "in_progress" });
    await runCommand(ticketMove, agent, { ticket: "t1", status: "done" });
    await runCommand(iterationClose, agent, { iteration: "s1" });
    const again = await runCommand(iterationReopen, agent, { iteration: "s1" });
    expect(again.warnings).toEqual(["まとめ待ちの変更を先にコミットした"]);
  });

  it("active の Iteration は Project に 1 つで、ほかに active があれば start と reopen を拒否する（IT-1）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(projectCreate, ctx, { id: "other" });
    for (const name of ["Sprint 1", "Sprint 2", "Sprint 3"])
      await runCommand(iterationCreate, ctx, { name });
    await runCommand(iterationCreate, ctx, { name: "別の Project", project: "other" });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    // 拒否のメッセージに今 active の Iteration を出し、記録は変えない
    await expect(runCommand(iterationStart, ctx, { iteration: "s2" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s1 が active"),
    });
    expect(ctx.store.iterations.get("s2")?.data.status).toBe("planned");
    // 別の Project の Iteration は数えない
    expect((await runCommand(iterationStart, ctx, { iteration: "s4" })).data.status).toBe("active");
    // 閉じれば次を始められ、閉じた方を再開するのは今の active を閉じてから
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    await runCommand(iterationStart, ctx, { iteration: "s2" });
    await expect(runCommand(iterationReopen, ctx, { iteration: "s1" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s2 が active"),
    });
    expect(ctx.store.iterations.get("s1")?.data.status).toBe("closed");
    await runCommand(iterationClose, ctx, { iteration: "s2" });
    expect((await runCommand(iterationReopen, ctx, { iteration: "s1" })).data.status).toBe(
      "active",
    );
  });

  it("2 つの clone が同時に別の Iteration を start すると、push で負けた側は検査からやり直して拒否される", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    for (const name of ["Sprint 1", "Sprint 2"]) await runCommand(iterationCreate, a, { name });
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "agent", user: "b" },
    });
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await runCommand(iterationStart, b, { iteration: "s2" });
      },
    };
    const racer = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "a" }, hooks });
    await expect(runCommand(iterationStart, racer, { iteration: "s1" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s2 が active"),
    });
    expect(racer.store.iterations.get("s1")?.data.status).toBe("planned");
    expect(racer.store.iterations.get("s2")?.data.status).toBe("active");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("reopen で push に負けても、相手が別の変更なら検査からやり直して成功し、警告を重ねない", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    await runCommand(iterationCreate, a, { name: "Sprint 1" });
    await runCommand(ticketCreate, a, { title: "A" });
    await runCommand(iterationAdd, a, { iteration: "s1", tickets: ["t1"] });
    await runCommand(iterationClose, a, { iteration: "s1" });
    await runCommand(sync, a, {});
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "agent", user: "b" },
    });
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await runCommand(iterationCreate, b, { name: "Sprint 2" });
      },
    };
    const racer = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "a" }, hooks });
    const reopened = await runCommand(iterationReopen, racer, { iteration: "s1" });
    expect(reopened.data.status).toBe("active");
    expect(reopened.warnings).toEqual([
      "閉じたときに外した 1 件は戻らない。iteration add で入れ直す",
    ]);
    // 相手の変更も取り込んでいる
    expect(racer.store.iterations.get("s2")?.data.name).toBe("Sprint 2");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("reopen で push に負け、相手が別の Iteration を start していれば、検査からやり直して拒否される", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    for (const name of ["Sprint 1", "Sprint 2"]) await runCommand(iterationCreate, a, { name });
    await runCommand(iterationClose, a, { iteration: "s1" });
    await runCommand(sync, a, {});
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "agent", user: "b" },
    });
    const hooks = {
      beforePush: async () => {
        hooks.beforePush = async () => {};
        await runCommand(iterationStart, b, { iteration: "s2" });
      },
    };
    const racer = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "a" }, hooks });
    await expect(runCommand(iterationReopen, racer, { iteration: "s1" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s2 が active"),
    });
    expect(racer.store.iterations.get("s1")?.data.status).toBe("closed");
    expect(racer.store.iterations.get("s2")?.data.status).toBe("active");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("lint は同じ Project に 2 つ以上ある active の Iteration を指摘し、別の Project の active は数えない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(projectCreate, ctx, { id: "other" });
    for (const name of ["Sprint 1", "Sprint 2", "Sprint 3"])
      await runCommand(iterationCreate, ctx, { name });
    await runCommand(iterationCreate, ctx, { name: "別の Project", project: "other" });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    await runCommand(iterationStart, ctx, { iteration: "s4" });
    const multiple = async () =>
      (await runCommand(lint, ctx, {})).data.issues
        .filter((i) => i.code === "lint_iteration_multiple_active")
        .map((i) => [i.id, i.message]);
    expect(await multiple()).toEqual([]);
    // 手の編集やマージで 2 つ目の active ができた場合（start の検査を通らない）
    await ctx.store.update("iteration", "s3", { status: "active" });
    const message = "同じ Project に active の Iteration が 2 つある（s1, s3）";
    expect(await multiple()).toEqual([
      ["s1", message],
      ["s3", message],
    ]);
    expect(
      (await runCommand(lint, ctx, { project: "other" })).data.issues.filter(
        (i) => i.code === "lint_iteration_multiple_active",
      ),
    ).toEqual([]);
  });
});
