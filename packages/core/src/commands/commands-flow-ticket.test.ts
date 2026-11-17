// チケットの流れのうち、遷移の制約・依存・担当・起票者・import・update・check と、Epic と Iteration

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../test/helpers/git-fixture.js";
import { pickUser } from "../model/actor.js";
import { recordBaseline } from "../git/outside.js";
import { osUserName } from "../git/repo.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { history } from "./history.js";
import { epicAdd, epicClose, epicCreate, epicReopen, epicShow } from "./epic.js";
import {
  iterationAdd,
  iterationClose,
  iterationCreate,
  iterationReopen,
  iterationUpdate,
  iterationShow,
  iterationStart,
} from "./iteration.js";
import { configSet, configUnset, lint, sync, whoami } from "./setup.js";
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
  initializedFixture,
  reopenInitialized,
  writeWorkflowYaml,
  runCleanups,
} from "../../test/helpers/commands-context.js";

afterEach(runCleanups);

describe("チケットの流れ（遷移・担当・編集）", () => {
  /** 人と agent の文脈。agent の --approved-by human は自分のユーザ本人（claude）になる */
  async function humanAndAgent() {
    const f = await initializedFixture();
    const human = await reopenInitialized(f);
    // 主体だけが違う文脈（索引は人の文脈と同じものを使い、相手が書いた変更を読み直さずに済ませる）
    const opened = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    const agent = { ...human, actor: opened.actor };
    const workflow = (lines: string[]) => writeWorkflowYaml(human, lines);
    const subject = async () =>
      (await git(human.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim();
    return { f, human, agent, workflow, subject };
  }
  const rejected = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e: unknown) => e as { code: string; message: string; detail?: string },
    );

  it("既定の Workflow：claim と前へ進む move は境目の requires と decide で、abandoned・戻す・done の取り消しは exceptions の値で判定される", async () => {
    const { human, agent, subject } = await humanAndAgent();
    await runCommand(ticketCreate, human, { title: "A" });
    await runCommand(ticketCreate, human, { title: "B", depends_on: ["t1"] });
    // todo → in_progress（requires: deps_done、decide: anyone）：依存が終わるまで claim は誰でも拒否される
    for (const ctx of [agent, human]) {
      expect(
        await rejected(runCommand(ticketClaim, ctx, { no_worktree: true, ticket: "t2" })),
      ).toMatchObject({
        code: "TRANSITION_REJECTED",
        message:
          "The conditions for claiming t2 are not met: deps_done (requires of boundaries todo → in_progress)",
      });
    }
    const started = (await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t1" }))
      .data;
    expect(started.status).toBe("in_progress");
    expect(started.branch_base).toBeDefined();
    // abandon は always_ask：エージェントは人の承認（--approved-by）がなければ拒否される
    expect(
      await rejected(runCommand(ticketMove, agent, { ticket: "t1", status: "abandoned" })),
    ).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for moving t1 from in_progress to abandoned (exceptions.abandon: always_ask)",
    });
    // in_progress → review（条件なし、anyone）と、戻す動き（back: anyone）は、エージェントが聞かずにできる
    expect(
      (await runCommand(ticketMove, agent, { ticket: "t1", status: "review" })).data.status,
    ).toBe("review");
    expect(
      (await runCommand(ticketMove, agent, { ticket: "t1", status: "in_progress" })).data.status,
    ).toBe("in_progress");
    await runCommand(ticketMove, agent, { ticket: "t1", status: "review" });
    // review → done（requires: pr_merged、decide: ask_unless_auto）：ブランチのあるチケットは、エージェントは承認が要り、承認があっても条件を満たさなければ拒否される
    expect(
      await rejected(runCommand(ticketMove, agent, { ticket: "t1", status: "done" })),
    ).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for moving t1 from review to done (boundaries review → done: ask_unless_auto)",
    });
    const unmet = await rejected(
      runCommand(ticketMove, agent, { ticket: "t1", status: "done", approved_by: "human" }),
    );
    expect(unmet).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The conditions for moving t1 from review to done are not met: pr_merged (requires of boundaries review → done)",
    });
    expect(unmet!.detail).toContain("Only a person");
    // 人も条件を満たさなければ拒否され、--override の理由で越える。理由はコミットの文（履歴）に残る
    const byHuman = await rejected(runCommand(ticketMove, human, { ticket: "t1", status: "done" }));
    expect(byHuman).toMatchObject({ code: "TRANSITION_REJECTED" });
    // 画面からは理由を渡せないので、CLI の手順だと案内する
    expect(byHuman!.detail).toBe(
      'To go ahead anyway, run the command from the dg CLI with --override "reason" (the board cannot pass it)',
    );
    const forced = await runCommand(ticketMove, human, {
      ticket: "t1",
      status: "done",
      override: "PR を使わない\n作業",
    });
    expect(forced.data.status).toBe("done");
    expect(await subject()).toBe(
      "Move t1 from review to done (override by eiki: PR を使わない 作業)",
    );
    const events = (await runCommand(history, human, { ticket: "t1" })).data.events;
    expect(events.at(-1)).toMatchObject({
      subject: "Move t1 from review to done (override by eiki: PR を使わない 作業)",
      changes: [{ field: "status", from: "review", to: "done" }],
    });
    // reopen は always_ask：done を戻すのも、エージェントは人の承認がなければ拒否され、承認者を記録して進める
    expect(
      await rejected(runCommand(ticketMove, agent, { ticket: "t1", status: "review" })),
    ).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for moving t1 from done to review (exceptions.reopen: always_ask)",
    });
    await runCommand(ticketMove, agent, {
      ticket: "t1",
      status: "in_progress",
      approved_by: "human",
    });
    expect(await subject()).toBe("Move t1 from done to in_progress (approved by claude)");
    const dropped = (
      await runCommand(ticketMove, agent, {
        ticket: "t1",
        status: "abandoned",
        approved_by: "human",
      })
    ).data;
    expect(await subject()).toBe("Move t1 from in_progress to abandoned (approved by claude)");
    expect(dropped.status).toBe("abandoned");
    expect(dropped.assignee).toBeUndefined();
    // ブランチの起点も消す（ST-4）
    expect(dropped.branch_base).toBeUndefined();
    const list = await runCommand(ticketList, human, {});
    expect(list.data.map((t) => t.id)).toEqual(["t2"]);
    const all = await runCommand(ticketList, human, { include_abandoned: true });
    expect(all.data.map((t) => t.id)).toEqual(["t1", "t2"]);
    // 依存先が abandoned なら deps_done は満たされ、着手できる（WF-2）
    const ready = await runCommand(ticketList, human, { ready: true });
    expect(ready.data.map((t) => t.id)).toEqual(["t2"]);
    const claimed = await runCommand(ticketClaim, agent, { no_worktree: true, ticket: "t2" });
    expect(claimed.data.status).toBe("in_progress");
  });

  it("既定の Workflow：ブランチなしで着手したチケット（PR の要らない作業）には pr_merged を当てず、エージェントが人の承認を記録して done にできる（ST-10）", async () => {
    const { human, agent, subject } = await humanAndAgent();
    await runCommand(ticketCreate, human, { title: "A" });
    await runCommand(ticketCreate, human, { title: "B" });
    await runCommand(ticketClaim, agent, { ticket: "t1", without_branch: true, no_run: true });
    await runCommand(ticketMove, agent, { ticket: "t1", status: "review" });
    // decide（ask_unless_auto）は当たる：承認がなければ拒否される。満たさない条件（pr_merged）では拒否されない
    expect(
      await rejected(runCommand(ticketMove, agent, { ticket: "t1", status: "done" })),
    ).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for moving t1 from review to done (boundaries review → done: ask_unless_auto)",
    });
    const done = await runCommand(ticketMove, agent, {
      ticket: "t1",
      status: "done",
      approved_by: "human",
    });
    expect(done.data.status).toBe("done");
    expect(await subject()).toBe("Move t1 from review to done (approved by claude)");
    // 境目を飛ばす in_progress → done も同じ。人は --override なしで進める
    await runCommand(ticketClaim, human, { ticket: "t2", without_branch: true });
    expect(
      (await runCommand(ticketMove, human, { ticket: "t2", status: "done" })).data.status,
    ).toBe("done");
  });

  it("ticket move は境目の decide の 5 つの値の表どおりに、通す・承認を求める・拒否する。承認者と強制の理由はコミットの文に残る", async () => {
    const { human, agent, workflow, subject } = await humanAndAgent();
    await runCommand(ticketCreate, human, { title: "A" });
    await runCommand(ticketClaim, agent, { ticket: "t1", without_branch: true, no_run: true });
    const boundary = (decide: string) =>
      workflow(["boundaries:", `  - { from: in_progress, to: review, decide: ${decide} }`]);
    /** in_progress → review を試し、通ったら戻す（back は anyone）。結果は通ったか、拒否の文の先頭 */
    const attempt = async (
      ctx: typeof human,
      extra: { approved_by?: string; override?: string } = {},
    ) => {
      const err = await rejected(
        runCommand(ticketMove, ctx, { ticket: "t1", status: "review", ...extra }),
      );
      if (err) {
        expect(err.code).toBe("TRANSITION_REJECTED");
        return err.message.replace(/ for moving .*| moving .*/, "");
      }
      // 承認者か強制の理由を渡した move は、まとめ待ちにせずその場でコミットし、文に記録を残す
      const recorded = extra.approved_by !== undefined || extra.override !== undefined;
      const note = recorded
        ? (await subject()).replace("Move t1 from in_progress to review", "passed")
        : "passed";
      await runCommand(ticketMove, human, {
        ticket: "t1",
        status: "in_progress",
        override: "戻す",
      });
      return note;
    };
    const asks = "The Workflow asks for a person's approval";
    const limits = "The Workflow limits";
    const leaves = "The Workflow leaves";
    const approved = "passed (approved by claude)";
    const forced = "passed (override by eiki: 急ぎ)";
    // [値, 人, 人（--override）, エージェント, エージェント（--approved-by）]
    const expected = [
      ["human_only", "passed", forced, limits, limits],
      ["always_ask", "passed", forced, asks, approved],
      ["ask_unless_auto", "passed", forced, asks, approved],
      ["anyone", "passed", forced, "passed", approved],
      ["agent_only", leaves, forced, "passed", approved],
    ];
    const actual: string[][] = [];
    for (const [decide] of expected) {
      await boundary(decide!);
      actual.push([
        decide!,
        await attempt(human),
        await attempt(human, { override: "急ぎ" }),
        await attempt(agent),
        await attempt(agent, { approved_by: "human" }),
      ]);
    }
    expect(actual).toEqual(expected);
    // エージェントの --override は、値が何でも拒否される。--approved-by に agent の ID は渡せない
    await boundary("anyone");
    expect(
      await rejected(
        runCommand(ticketMove, agent, { ticket: "t1", status: "review", override: "急ぎ" }),
      ),
    ).toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "--override is for a person only, and an agent cannot use it",
    });
    expect(
      await rejected(
        runCommand(ticketMove, agent, { ticket: "t1", status: "review", approved_by: "agent" }),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await runCommand(ticketShow, human, { ticket: "t1" })).data.status).toBe("in_progress");
  });

  it("claim も todo → in_progress の decide で判定され、承認者と強制の理由が claim のコミットの文に残る", async () => {
    const { human, agent, workflow, subject } = await humanAndAgent();
    for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, human, { title });
    const boundary = (decide: string) =>
      workflow(["boundaries:", `  - { from: todo, to: in_progress, decide: ${decide} }`]);
    const claim = (ctx: typeof human, ticket: string, extra = {}) =>
      runCommand(ticketClaim, ctx, { ticket, without_branch: true, no_run: true, ...extra });

    await boundary("always_ask");
    expect(await rejected(claim(agent, "t1"))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for claiming t1 (boundaries todo → in_progress: always_ask)",
    });
    expect((await claim(agent, "t1", { approved_by: "human" })).data.status).toBe("in_progress");
    expect(await subject()).toBe("Claim t1: claude/agent (approved by claude)");

    await boundary("human_only");
    expect(await rejected(claim(agent, "t2", { approved_by: "human" }))).toMatchObject({
      code: "TRANSITION_REJECTED",
    });
    expect((await claim(human, "t2")).data.status).toBe("in_progress");

    await boundary("agent_only");
    expect(await rejected(claim(human, "t3"))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow leaves claiming t3 to an agent (boundaries todo → in_progress: agent_only)",
    });
    expect((await claim(human, "t3", { override: "担当が不在" })).data.status).toBe("in_progress");
    expect(await subject()).toBe("Claim t3: eiki (override by eiki: 担当が不在)");
  });

  it("abandoned へ・戻す（unclaim を含む）・終わった Status から戻す動きは、exceptions の abandon・back・reopen の値で判定される", async () => {
    const { human, agent, workflow, subject } = await humanAndAgent();
    await workflow([
      "exceptions:",
      "  abandon: always_ask",
      "  back: agent_only",
      "  reopen: anyone",
    ]);
    await runCommand(ticketCreate, human, { title: "A" });
    const claim = (ctx: typeof human) =>
      runCommand(ticketClaim, ctx, { ticket: "t1", without_branch: true, no_run: true });
    await claim(human);
    // back（agent_only）：人の unclaim と move は拒否され、--override で越える。エージェントは聞かずにできる
    expect(await rejected(runCommand(ticketUnclaim, human, { ticket: "t1" }))).toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "The Workflow leaves unclaiming t1 to an agent (exceptions.back: agent_only)",
    });
    expect(
      await rejected(runCommand(ticketMove, human, { ticket: "t1", status: "todo" })),
    ).toMatchObject({ code: "TRANSITION_REJECTED" });
    await runCommand(ticketUnclaim, human, { ticket: "t1", override: "取り違え" });
    expect(await subject()).toBe("Unclaim t1 (override by eiki: 取り違え)");
    await claim(agent);
    expect((await runCommand(ticketUnclaim, agent, { ticket: "t1" })).data.status).toBe("todo");
    // abandon（always_ask）：エージェントは人の承認があればできる
    expect(
      await rejected(runCommand(ticketMove, agent, { ticket: "t1", status: "abandoned" })),
    ).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for moving t1 from todo to abandoned (exceptions.abandon: always_ask)",
    });
    await runCommand(ticketMove, agent, { ticket: "t1", status: "abandoned", approved_by: "eiki" });
    expect(await subject()).toBe("Move t1 from todo to abandoned (approved by eiki)");
    // reopen（anyone）：abandoned から戻すのも、エージェントが聞かずにできる
    expect(
      (await runCommand(ticketMove, agent, { ticket: "t1", status: "todo" })).data.status,
    ).toBe("todo");
  });

  it("境目を飛ばす動きは、間の境目をすべて越えたものとして、厳しいほうの値とすべての requires で判定される", async () => {
    const { human, agent, workflow } = await humanAndAgent();
    await workflow([
      "boundaries:",
      "  - { from: todo, to: in_progress, requires: [deps_done], decide: anyone }",
      "  - { from: in_progress, to: review, decide: human_only }",
      "  - { from: review, to: done, decide: anyone }",
    ]);
    await runCommand(ticketCreate, human, { title: "A" });
    await runCommand(ticketCreate, human, { title: "B", depends_on: ["t1"] });
    await runCommand(ticketClaim, agent, { ticket: "t1", without_branch: true, no_run: true });
    // in_progress → done は in_progress → review（human_only）も越えるので、review → done が anyone でもエージェントは拒否される
    expect(
      await rejected(runCommand(ticketMove, agent, { ticket: "t1", status: "done" })),
    ).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow limits moving t1 from in_progress to done to a person (boundaries in_progress → review, review → done: human_only, anyone)",
    });
    // 1 つずつ越えれば、review → done はエージェントが聞かずにできる
    await runCommand(ticketMove, human, { ticket: "t1", status: "review" });
    await runCommand(ticketMove, human, { ticket: "t1", status: "in_progress" });
    await runCommand(ticketMove, human, { ticket: "t1", status: "review" });
    await runCommand(ticketMove, agent, { ticket: "t1", status: "in_progress" });
    // 飛ばす動きの条件は、越える境目の requires の和：todo → review は todo → in_progress の deps_done も要る
    expect(
      await rejected(runCommand(ticketMove, human, { ticket: "t2", status: "review" })),
    ).toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The conditions for moving t2 from todo to review are not met: deps_done (requires of boundaries todo → in_progress, in_progress → review)",
    });
    await runCommand(ticketMove, human, { ticket: "t1", status: "done" });
    expect(
      (await runCommand(ticketMove, human, { ticket: "t2", status: "review" })).data.status,
    ).toBe("review");
  });

  it("チケットは workflow も任意フィールドも受けず、前の版が書いた workflow・任意フィールドの値・config の default_workflow は誤りにせずに読む", async () => {
    const f = await initializedFixture();
    const human = await reopenInitialized(f);
    // 入力に workflow と fields を渡しても、チケットには書かない
    const created = await runCommand(ticketCreate, human, {
      title: "A",
      workflow: "strict",
      fields: { estimate: 3 },
    });
    expect(created.data).not.toHaveProperty("workflow");
    expect(created.data).not.toHaveProperty("estimate");
    const file = path.join(human.repo.dataDir, "tickets/t1.md");
    expect(await readFile(file, "utf8")).not.toMatch(/^(project|workflow|estimate):/m);

    // 前の版が書いたチケット（workflow と任意フィールドの値）と config（default_workflow）
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(/^status:/m, "workflow: strict\nestimate: 3\nstatus:"),
    );
    const config = path.join(human.repo.dataDir, "config.yaml");
    await writeFile(config, `${await readFile(config, "utf8")}default_workflow: strict\n`);
    await recordBaseline(human.repo);
    await human.store.rescan();
    expect(human.store.issues).toEqual([]);
    // workflow は値に出さない。任意フィールドの値はスキーマにない項目として残る（DT-2）
    const shown = (await runCommand(ticketShow, human, { ticket: "t1" })).data;
    expect(shown).not.toHaveProperty("workflow");
    expect(shown).toMatchObject({ estimate: 3 });
    expect(human.store.config).not.toHaveProperty("default_workflow");
    // どちらも Workflow を選ばない：カンバンの workflow.yaml（既定。todo → done は pr_merged が要る）に従う
    await expect(
      runCommand(ticketMove, human, { ticket: "t1", status: "done" }),
    ).rejects.toMatchObject({ code: "TRANSITION_REJECTED" });

    // チケットを書くと workflow は消え、任意フィールドの値は残る
    await runCommand(ticketUpdate, human, { ticket: "t1", title: "A2" });
    const written = await readFile(file, "utf8");
    expect(written).not.toMatch(/^workflow:/m);
    expect(written).toMatch(/^estimate: 3$/m);
    // config を書くと default_workflow は消える
    await runCommand(configSet, human, { key: "work.parallel", value: "4" });
    expect(await readFile(config, "utf8")).not.toContain("default_workflow");
  });

  it("config unset default_workflow は、前の版が書いた default_workflow を config.yaml から消す", async () => {
    const f = await initializedFixture();
    const human = await reopenInitialized(f);
    const config = path.join(human.repo.dataDir, "config.yaml");
    await writeFile(config, `${await readFile(config, "utf8")}default_workflow: strict\n`);
    await recordBaseline(human.repo);
    await human.store.rescan();
    await runCommand(configUnset, human, { key: "default_workflow" });
    expect(await readFile(config, "utf8")).not.toContain("default_workflow");
    // 値は書けない（書いても消える）
    await runCommand(configSet, human, { key: "default_workflow", value: "strict" }).catch(
      () => undefined,
    );
    expect(await readFile(config, "utf8")).not.toContain("default_workflow");
  });

  it("list は各行に deps_done を載せ、show と同じく絞り込みに合わない依存先も見る。show は終わっていない依存先を ID と Status で出し、終わった依存先は出さず、見つからない依存先は Status を null で出す", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "絞り込みの外", labels: ["other"] });
    await runCommand(ticketCreate, ctx, { title: "B", labels: ["mine"], depends_on: ["t1"] });
    await runCommand(ticketCreate, ctx, { title: "C", labels: ["mine"], depends_on: ["t2"] });
    const depsDone = async () =>
      (await runCommand(ticketList, ctx, { label: ["mine"], include_abandoned: true })).data.map(
        (t) => [t.id, t.deps_done],
      );
    expect(await depsDone()).toEqual([
      ["t2", false],
      ["t3", false],
    ]);
    // 依存先は絞り込んだ一覧に出ないが、done になれば deps_done は真になる
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done", override: "PR なし" });
    expect(await depsDone()).toEqual([
      ["t2", true],
      ["t3", false],
    ]);
    const shown = await runCommand(ticketShow, ctx, { ticket: "t2" });
    expect(shown.data.deps_done).toBe(true);
    expect(shown.data.pending_deps).toEqual([]);

    // show は終わっていない依存先を ID と Status で出し、終わった（done・abandoned）依存先は出さない
    await runCommand(ticketCreate, ctx, { title: "済み" });
    await runCommand(ticketCreate, ctx, { title: "途中" });
    await runCommand(ticketCreate, ctx, { title: "やめた" });
    await runCommand(ticketMove, ctx, { ticket: "t4", status: "done", override: "PR なし" });
    await runCommand(ticketMove, ctx, { ticket: "t5", status: "in_progress" });
    await runCommand(ticketMove, ctx, { ticket: "t6", status: "abandoned" });
    await runCommand(ticketCreate, ctx, { title: "待ち", depends_on: ["t4", "t5", "t6"] });
    const waiting = await runCommand(ticketShow, ctx, { ticket: "t7" });
    expect(waiting.data.pending_deps).toEqual([{ id: "t5", status: "in_progress" }]);
    expect(waiting.data.deps_done).toBe(false);
    // 依存先を消すと Status の分からない待ちとして残る（deps_done と同じく待つ）
    await runCommand(ticketDelete, ctx, { ticket: "t4" });
    expect((await runCommand(ticketShow, ctx, { ticket: "t7" })).data.pending_deps).toEqual([
      { id: "t4", status: null },
      { id: "t5", status: "in_progress" },
    ]);
  });

  it("unclaim は自分（同じユーザの人と AI）の claim だけ外し、他人のものは force が要る", async () => {
    const f = await initializedFixture();
    const eiki = await reopenInitialized(f);
    await runCommand(ticketCreate, eiki, { title: "A" });
    await runCommand(ticketClaim, eiki, { no_worktree: true, ticket: "t1", branch: "t1-a" });
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
    const f = await initializedFixture();
    const eiki = await reopenInitialized(f);
    await runCommand(ticketCreate, eiki, { title: "A" });
    // 前の作業の PR を記録したまま todo に残ったチケット（pr を外す前の unclaim で残ったもの）
    await runCommand(ticketUpdate, eiki, { ticket: "t1", pr: 7 });
    const claimed = await runCommand(ticketClaim, eiki, {
      no_worktree: true,
      ticket: "t1",
      branch: "t1-a",
    });
    expect(claimed.data).toMatchObject({ status: "in_progress", assignee: "eiki" });
    expect(claimed.data.pr).toBeUndefined();
    expect(claimed.warnings.some((w) => w.includes("the start of a fix"))).toBe(false);
  });

  it("whoami は操作している主体の ID・ユーザ名・種別と、本人とみなす ID（人とその AI）を返す。主体のユーザ名は --user > DEGUBOARD_USER > git config の deguboard.user > git の user.name > OS のユーザ名の順で決まり、whoami が出どころを返す（t217）", async () => {
    const f = await initializedFixture();
    const human = await reopenInitialized(f);
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

    // 主体のユーザ名は --user > DEGUBOARD_USER > git config の deguboard.user > git の user.name > OS のユーザ名の順で決まる（t217）
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
    const f = await initializedFixture();
    const human = await reopenInitialized(f);
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
    expect(claimed.warnings).toContain("Changed the assignee from other to eiki");
    expect(claimed.data.branch_base).toBeDefined();
    // todo に戻すと担当者とブランチの起点は消える。起票者は残る
    const back = await runCommand(ticketMove, human, { ticket: "t1", status: "todo" });
    expect(back.data.assignee).toBeUndefined();
    expect(back.data.branch_base).toBeUndefined();
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
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
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
    const f = await initializedFixture();
    const a = await reopenInitialized(f);
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
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
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
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
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
    expect(log[0]).toBe("Import 3 tickets: t1, t2, t3");
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

  it("import の本文は、本文の項目の引用しない値に行末コメントがあると INVALID_INPUT で起票しない（drafts と一緒の指定も拒む）。ほかの項目の行末コメント・行だけのコメント・引用した値・body の | の中の # と、引用しない値の次の行の深く字下げした行だけのコメントは拒まずに本文として残す", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    const head = async () => (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    const before = await head();
    const cases: Array<[string, string]> = [
      ["- title: 設定 #/config の画面\n", "title of draft 1"],
      ["- title: A\n- title: B\n  summary: 戻る #/board へ\n", "summary of draft 2"],
      [
        "- title: A\n  acceptance:\n    - 条件 1\n    - 歯車で #/config # 開く\n",
        "acceptance of draft 1",
      ],
      ["drafts:\n  - title: A\n    body: 本文 #/config\n", "body of draft 1"],
      ["- title: A\n  body: 複数行の\n    最後の行 #/config\n", "body of draft 1"],
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
    ).rejects.toThrow("cannot be passed together");
    expect(await head()).toBe(before);

    // ほかの項目の行末コメント・行だけのコメント・引用した値・body の | の中の # は本文として残す
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

    // 引用しない値の次の行の深く字下げした行だけのコメントは拒まない
    for (const source of [
      "- title: A\n  body: x\n    # c\n",
      "- title: A\n      # c\n  body: y\n",
    ]) {
      const imported = await runCommand(ticketImport, ctx, { source });
      expect(imported.data).toMatchObject([{ title: "A" }]);
    }
  });

  it("update は属性と本文を直し、循環する依存を拒否する", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B", depends_on: ["t1"] });
    const r = await runCommand(ticketUpdate, ctx, {
      ticket: "t1",
      priority: "high",
      body: "## 概要\n\n直した\n",
    });
    expect(r.data).toMatchObject({ priority: "high", body: "## 概要\n\n直した\n" });
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
    const shown = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(shown.data.dependents).toEqual(["t2"]);
  });

  it("ゲートの段（gate。TK-9）は create・import・update で付き、update の null で外れ、段にない値は拒む", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    const created = await runCommand(ticketCreate, ctx, { title: "A", gate: "low" });
    expect(created.data).toMatchObject({ gate: "low" });
    // 付けなければ gate を書かない（判定では high として扱う）
    const plain = await runCommand(ticketCreate, ctx, { title: "B" });
    expect(plain.data).not.toHaveProperty("gate");
    const imported = await runCommand(ticketImport, ctx, {
      source: "- title: C\n  gate: free\n",
    });
    expect(imported.data).toMatchObject([{ gate: "free" }]);
    const updated = await runCommand(ticketUpdate, ctx, { ticket: "t2", gate: "free" });
    expect(updated.data).toMatchObject({ gate: "free" });
    const removed = await runCommand(ticketUpdate, ctx, { ticket: "t2", gate: null });
    expect(removed.data).not.toHaveProperty("gate");
    const text = await readFile(path.join(ctx.repo.dataDir, "tickets/t2.md"), "utf8");
    expect(text).not.toContain("gate:");
    // 段にない値（none など）は、どの入口でも拒む
    await expect(
      runCommand(ticketCreate, ctx, { title: "D", gate: "none" as never }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runCommand(ticketImport, ctx, { source: "- title: D\n  gate: none\n" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t1", gate: "none" as never }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await runCommand(ticketShow, ctx, { ticket: "t1" })).data).toMatchObject({
      gate: "low",
    });
  });

  it("元のチケットと原因の種類（origin・origin_cause。TK-12）は create・import・update で付き、update の空の配列と null で外れる", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    // 付けなければ書かない（不具合を直すチケットでなければ持たない）
    expect((await runCommand(ticketShow, ctx, { ticket: "t1" })).data).not.toHaveProperty("origin");
    // ID は番号だけでも受け、同じ ID は 1 回にまとめる
    const created = await runCommand(ticketCreate, ctx, {
      title: "A の直し",
      origin: ["t1", "2", "t1"],
      origin_cause: "tests",
    });
    expect(created.data).toMatchObject({ id: "t3", origin: ["t1", "t2"], origin_cause: "tests" });
    const imported = await runCommand(ticketImport, ctx, {
      source: "- title: B の直し\n  origin: [t2]\n  origin_cause: unknown\n",
    });
    expect(imported.data).toMatchObject([{ id: "t4", origin: ["t2"], origin_cause: "unknown" }]);
    // update は一覧をまるごと置き換える
    const updated = await runCommand(ticketUpdate, ctx, {
      ticket: "t4",
      origin: ["t1"],
      origin_cause: "documents",
    });
    expect(updated.data).toMatchObject({ origin: ["t1"], origin_cause: "documents" });
    const text = await readFile(path.join(ctx.repo.dataDir, "tickets/t4.md"), "utf8");
    expect(text).toContain("origin_cause: documents");
    // ほかの項目だけを直す update は、元のチケットと原因を変えない
    const kept = await runCommand(ticketUpdate, ctx, { ticket: "t4", priority: "high" });
    expect(kept.data).toMatchObject({ origin: ["t1"], origin_cause: "documents" });
    const removed = await runCommand(ticketUpdate, ctx, {
      ticket: "t4",
      origin: [],
      origin_cause: null,
    });
    expect(removed.data).not.toHaveProperty("origin");
    expect(removed.data).not.toHaveProperty("origin_cause");
    expect(await readFile(path.join(ctx.repo.dataDir, "tickets/t4.md"), "utf8")).not.toContain(
      "origin",
    );
  });

  it("元のチケットにないチケットの ID と自分自身の ID、原因の種類にない値、origin のない origin_cause は、どの入口でも拒み、書き込まない（TK-12）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, {
      title: "A の直し",
      origin: ["t1"],
      origin_cause: "plan",
    });
    // ないチケットの ID
    await expect(
      runCommand(ticketCreate, ctx, { title: "C", origin: ["t99"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      runCommand(ticketImport, ctx, { source: "- title: C\n  origin: [t99]\n" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t2", origin: ["t1", "t99"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // 自分自身の ID。作成と取り込みでは、これから振られる自分の番号（t3）も、同じ下書きの仮のキーも、まだないチケットとして拒む
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t2", origin: ["t1", "t2"] }),
    ).rejects.toMatchObject({ code: "REJECTED", message: expect.stringContaining("itself (t2)") });
    await expect(
      runCommand(ticketCreate, ctx, { title: "C", origin: ["t3"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      runCommand(ticketImport, ctx, { source: "- key: c\n  title: C\n  origin: [c]\n" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // 原因の種類にない値
    await expect(
      runCommand(ticketCreate, ctx, { title: "C", origin: ["t1"], origin_cause: "code" as never }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runCommand(ticketImport, ctx, {
        source: "- title: C\n  origin: [t1]\n  origin_cause: code\n",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t2", origin_cause: "code" as never }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // origin のない origin_cause（原因の種類は元のチケットの変更のもの）。update は書き込んだ後の値で照らす
    const withoutOrigin = { code: "REJECTED", message: expect.stringContaining("needs origin") };
    await expect(
      runCommand(ticketCreate, ctx, { title: "C", origin_cause: "tests" }),
    ).rejects.toMatchObject(withoutOrigin);
    await expect(
      runCommand(ticketImport, ctx, { source: "- title: C\n  origin_cause: tests\n" }),
    ).rejects.toMatchObject(withoutOrigin);
    await expect(
      runCommand(ticketImport, ctx, {
        source: "- title: C\n  origin: []\n  origin_cause: tests\n",
      }),
    ).rejects.toMatchObject(withoutOrigin);
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t1", origin_cause: "tests" }),
    ).rejects.toMatchObject(withoutOrigin);
    await expect(runCommand(ticketUpdate, ctx, { ticket: "t2", origin: [] })).rejects.toMatchObject(
      withoutOrigin,
    );
    await expect(
      runCommand(ticketUpdate, ctx, { ticket: "t2", origin: [], origin_cause: "tests" }),
    ).rejects.toMatchObject(withoutOrigin);
    // 拒んだ操作は何も書かない
    expect((await runCommand(ticketList, ctx, {})).data.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect((await runCommand(ticketShow, ctx, { ticket: "t1" })).data).not.toHaveProperty(
      "origin_cause",
    );
    expect((await runCommand(ticketShow, ctx, { ticket: "t2" })).data).toMatchObject({
      origin: ["t1"],
      origin_cause: "plan",
    });
  });

  it("空か空白だけの body は create・import・update のどの入口でも INVALID_INPUT で拒み、書き込まない（理由と直し方を出す）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "A", summary: "s", acceptance: ["a"] });
    const head = async () => (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout.trim();
    const before = await head();
    const text = () => readFile(path.join(ctx.repo.dataDir, "tickets/t1.md"), "utf8");
    const original = await text();

    // update：空・空白だけは書かず、理由と直し方を示す。body を省けば現在の本文のまま
    for (const body of ["", "   \n\t"]) {
      const err = await runCommand(ticketUpdate, ctx, { ticket: "t1", body }).catch((e) => e);
      expect(err).toMatchObject({ code: "INVALID_INPUT" });
      expect(String(err.detail)).toContain("body is empty or only spaces");
      expect(String(err.detail)).toContain("keeps the current body");
    }
    expect(await text()).toBe(original);
    expect(await head()).toBe(before);
    expect((await runCommand(ticketUpdate, ctx, { ticket: "t1", title: "A2" })).data.title).toBe(
      "A2",
    );

    // create：summary があっても、body が空なら拒む（body を省けば雛形で作る）
    await expect(
      runCommand(ticketCreate, ctx, { title: "B", body: "  ", summary: "s" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(runCommand(ticketCreate, ctx, { title: "B", body: "" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect((await runCommand(ticketCreate, ctx, { title: "C", summary: "s" })).data.id).toBe("t2");

    // import：drafts でも source（YAML）でも、空か空白だけの body は 1 件も起票しない
    await expect(
      runCommand(ticketImport, ctx, { drafts: [{ title: "D" }, { title: "E", body: " " }] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runCommand(ticketImport, ctx, { source: '- title: F\n  body: ""\n' }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await runCommand(ticketList, ctx, {})).data.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("check は番号で受け入れ条件に印を付け外しし、show が acceptance を出す。all と番号の同時指定・無指定を INVALID_INPUT、節や項目がない・範囲外を NOT_FOUND で拒否する", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
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
    expect(log[0]).toBe("Commit batched changes");

    // all と番号の同時指定・無指定は INVALID_INPUT、節や項目がない・範囲外は NOT_FOUND で拒否する
    await runCommand(ticketCreate, ctx, { title: "B", body: "本文だけ\n" });
    await runCommand(ticketCreate, ctx, { title: "C", summary: "雛形のまま" });
    await expect(
      runCommand(ticketCheck, ctx, { ticket: "t1", all: true, items: [1] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(runCommand(ticketCheck, ctx, { ticket: "t1", items: [] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(runCommand(ticketCheck, ctx, { ticket: "t3", items: [1] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(runCommand(ticketCheck, ctx, { ticket: "t4", all: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      runCommand(ticketCheck, ctx, { ticket: "t1", items: [2, 4] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("4") });
  });

  it("check と update は base が今の本文と同じなら書き、読んだ後に本文が変わっていれば REJECTED で書かない。update は base を渡さなければ今までどおり書く", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(ticketCreate, ctx, { title: "A", summary: "s", acceptance: ["a", "b"] });
    const read = (await runCommand(ticketShow, ctx, { ticket: "t1" })).data.body;
    const checked = await runCommand(ticketCheck, ctx, { ticket: "t1", items: [2], base: read });
    expect(checked.data.body).toBe(
      "## Summary\n\ns\n\n## Acceptance criteria\n\n- [ ] a\n- [x] b\n",
    );
    // 画面が古い本文（read）のまま 1 を押した：間に 2 の書き込みがあったので拒否し、本文は変えない
    await expect(
      runCommand(ticketCheck, ctx, { ticket: "t1", items: [1], base: read }),
    ).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("Read it again"),
    });
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

    // update も base が今の本文と違えば REJECTED で書かない。本文は外した後の read に戻っている
    // 画面が読んだ後に、別の書き込み（エージェントの印）が本文を変えた
    const changed = await runCommand(ticketCheck, ctx, { ticket: "t1", items: [2] });
    // 読んだ本文（read）を base にして題を直そうとすると、書き込まずに拒否する
    await expect(
      runCommand(ticketUpdate, ctx, {
        ticket: "t1",
        title: "B",
        body: "## Summary\n\n上書き\n",
        base: read,
      }),
    ).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("Nothing was written"),
    });
    const reread = await runCommand(ticketShow, ctx, { ticket: "t1" });
    expect(reread.data.title).toBe("A");
    expect(reread.data.body).toBe(changed.data.body);
    // 読み直した本文を base にすれば書ける
    const saved = await runCommand(ticketUpdate, ctx, {
      ticket: "t1",
      title: "B",
      body: "## Summary\n\n直した\n",
      base: reread.data.body,
    });
    expect(saved.data.title).toBe("B");
    expect(saved.data.body).toBe("## Summary\n\n直した\n");
    // base を渡さない呼び出し（CLI など）は今までどおり書ける
    const plain = await runCommand(ticketUpdate, ctx, { ticket: "t1", priority: "low" });
    expect(plain.data.priority).toBe("low");
  });
});

describe("Epic と Iteration", () => {
  it("Epic の雛形は ## Summary を書き、lint は英語と日本語のどちらの名前の節も読む", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
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
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
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
    // 閉じる・再開するのは既定ではエージェントに人の承認が要る（Workflow の governance.epic。値ごとの判定は governance.test.ts）
    const closed = await runCommand(epicClose, ctx, { epic: "e1", force: true });
    expect(closed.data.status).toBe("closed");
    expect(closed.data.closed_at).toBeDefined();
    expect(closed.warnings).toHaveLength(1);
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    await expect(runCommand(ticketCreate, agent, { title: "C", epic: "e1" })).rejects.toMatchObject(
      { code: "REJECTED" },
    );
    const reopened = await runCommand(epicReopen, ctx, { epic: "e1" });
    expect(reopened.data.closed_at).toBeUndefined();
  });

  it("Iteration は開始・終了でき、閉じるときに完了と持ち越しを数える", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    const it1 = await runCommand(iterationCreate, ctx, { name: "Sprint 1" });
    expect(it1.data).toMatchObject({ id: "s1", status: "planned" });
    expect(it1.data).not.toHaveProperty("tickets");
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B", priority: "high" });
    const added = await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t2", "t1"] });
    expect(added.data).toEqual({ iteration: "s1", tickets: ["t2", "t1"] });
    await runCommand(iterationStart, ctx, { iteration: "1" });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "in_progress" });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done", override: "PR なし" });
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
    // 閉じるのは既定で人だけ（flow.release。判定は flow-permission.test.ts）
    const closed = await runCommand(iterationClose, ctx, { iteration: "s1" });
    expect(closed.data).toMatchObject({ status: "closed", completed: 1, carried_over: 1 });
    expect(ctx.store.tickets.get("t2")?.data.iteration).toBeUndefined();
    expect(ctx.store.tickets.get("t1")?.data.iteration).toBe("s1");
  });

  it("update は指定した属性だけを直し、閉じた Iteration も直せる", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(iterationCreate, ctx, { name: "Sprint 1", goal: "読む" });
    const updated = await runCommand(iterationUpdate, ctx, { iteration: "1", goal: "履歴を読む" });
    expect(updated.data).toMatchObject({
      name: "Sprint 1",
      goal: "履歴を読む",
      status: "planned",
    });
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    const renamed = await runCommand(iterationUpdate, ctx, {
      iteration: "s1",
      name: "Sprint 1b",
      goal: "",
    });
    expect(renamed.data).toMatchObject({ name: "Sprint 1b", goal: "", status: "closed" });
  });

  it("予定の期間（start・end）は持たない。古いファイルの start・end は読んだ値に出ず、Iteration を書くと（引数なしの update でも）形を問わず（null・数・配列でも）ファイルから消え、goal・started_at とスキーマにない項目は残る", async () => {
    const f = await initializedFixture();
    const clock = new Date("2026-11-03T01:02:03Z");
    const ctx = await reopenInitialized(f, { now: () => clock });
    for (const name of ["Sprint 1", "Sprint 2", "Sprint 3"])
      await runCommand(iterationCreate, ctx, { name });
    const fileOf = (id: string) => path.join(ctx.repo.dataDir, `iterations/${id}.yaml`);
    // 作ったファイルには書かない
    expect(await readFile(fileOf("s1"), "utf8")).not.toMatch(/^(start|end):/m);
    // 古い版の dg が書いた形を模す（日付と日時の両方）。検査の基準もここに置く（SY-8）
    for (const id of ["s1", "s2", "s3"]) {
      const text = await readFile(fileOf(id), "utf8");
      await writeFile(fileOf(id), `${text}start: 2026-11-01\nend: "2026-11-14T00:00:00Z"\n`);
    }
    await recordBaseline(ctx.repo);
    await ctx.store.rescan();
    const shown = (await runCommand(iterationShow, ctx, { iteration: "s1" })).data;
    expect(shown).not.toHaveProperty("start");
    expect(shown).not.toHaveProperty("end");
    // start・close・update のどれで書いても消え、ほかの項目は残る
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    await runCommand(iterationUpdate, ctx, { iteration: "s2" });
    for (const id of ["s1", "s2"]) {
      const text = await readFile(fileOf(id), "utf8");
      expect(text).not.toMatch(/^(start|end):/m);
      expect(text).toContain(`id: ${id}`);
    }
    // 書いていない Iteration には残る（移すのは書いたときだけ）
    expect(await readFile(fileOf("s3"), "utf8")).toMatch(/^start:/m);

    // 古い start・end は形を問わず（null・数・配列でも）書き直すと消え、goal・started_at とスキーマにない項目は残る
    await runCommand(iterationCreate, ctx, { name: "Sprint 4", goal: "読む" });
    await runCommand(iterationStart, ctx, { iteration: "s4" });
    // 古い版の dg が書いた形のほかに、値の形が違うものと、スキーマにない項目を足す
    const legacyText = await readFile(fileOf("s4"), "utf8");
    await writeFile(fileOf("s4"), `${legacyText}start: null\nend: [1, 2]\nmemo: 残す\n`);
    await recordBaseline(ctx.repo);
    await ctx.store.rescan();
    // 読んだ値には出ず、引数なしの update で書き直すとファイルからも消える
    expect((await runCommand(iterationShow, ctx, { iteration: "s4" })).data).not.toHaveProperty(
      "start",
    );
    await runCommand(iterationUpdate, ctx, { iteration: "s4" });
    const rewritten = await readFile(fileOf("s4"), "utf8");
    expect(rewritten).not.toMatch(/^(start|end):/m);
    expect(rewritten).toContain("memo: 残す");
    const legacy = (await runCommand(iterationShow, ctx, { iteration: "s4" })).data;
    expect(legacy).toMatchObject({
      goal: "読む",
      started_at: "2026-11-03T01:02:03Z",
      memo: "残す",
    });
    expect(legacy).not.toHaveProperty("end");
  });

  it("start は実績の開始の日時 started_at を書き、close は closed_at を足し、reopen は started_at を変えずに closed_at を消す（IT-1）", async () => {
    const f = await initializedFixture();
    let clock = new Date("2026-11-03T01:02:03Z");
    const ctx = await reopenInitialized(f, { now: () => clock });
    await runCommand(iterationCreate, ctx, { name: "Sprint" });
    expect((await runCommand(iterationShow, ctx, { iteration: "s1" })).data.started_at).toBe(
      undefined,
    );
    const started = await runCommand(iterationStart, ctx, { iteration: "s1" });
    expect(started.data.started_at).toBe("2026-11-03T01:02:03Z");
    clock = new Date("2026-11-04T05:00:00Z");
    const closed = await runCommand(iterationClose, ctx, { iteration: "s1" });
    expect(closed.data).toMatchObject({
      started_at: "2026-11-03T01:02:03Z",
      closed_at: "2026-11-04T05:00:00Z",
    });
    clock = new Date("2026-11-05T05:00:00Z");
    const reopened = await runCommand(iterationReopen, ctx, { iteration: "s1" });
    expect(reopened.data.started_at).toBe("2026-11-03T01:02:03Z");
    expect(reopened.data.closed_at).toBeUndefined();
  });

  it("閉じた Iteration は reopen で active に戻り、件数が消えてチケットを入れ直せる", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
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
    // 別の文脈（同じ clone のもう 1 人）から再開する。持ち越しがあれば入れ直しを促す
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "human", user: "claude" } });
    const reopened = await runCommand(iterationReopen, agent, { iteration: "1" });
    expect(reopened.data.status).toBe("active");
    expect(reopened.data.closed_at).toBeUndefined();
    expect(reopened.data.completed).toBeUndefined();
    expect(reopened.data.carried_over).toBeUndefined();
    // 再開は即座に push するので、まとめ待ちの変更を先にコミットした警告も並ぶ
    expect(reopened.warnings).toEqual([
      "Committed the pending changes first",
      "The 1 tickets removed when it was closed do not come back. Add them again with iteration add",
    ]);
    // 持ち越したチケットは戻らないので入れ直す
    expect(agent.store.tickets.get("t1")?.data.iteration).toBeUndefined();
    await runCommand(iterationAdd, agent, { iteration: "s1", tickets: ["t1"] });
    expect(agent.store.tickets.get("t1")?.data.iteration).toBe("s1");
    // 持ち越しがなければ警告は出ない（done は pr_merged が要るので、人が理由を付けて動かす）
    await runCommand(ticketMove, agent, { ticket: "t1", status: "in_progress" });
    await ctx.store.rescan();
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done", override: "PR なし" });
    await agent.store.rescan();
    await runCommand(iterationClose, agent, { iteration: "s1" });
    const again = await runCommand(iterationReopen, agent, { iteration: "s1" });
    expect(again.warnings).toEqual(["Committed the pending changes first"]);
  });

  it("active の Iteration はカンバンに 1 つで、ほかに active があれば start と reopen を拒否する（IT-1）", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    for (const name of ["Sprint 1", "Sprint 2", "Sprint 3"])
      await runCommand(iterationCreate, ctx, { name });
    // 前の版が別の Project に作った Iteration（project を持つファイル）も、同じカンバンの 1 つとして数える
    await runCommand(iterationCreate, ctx, { name: "前の版の別の Project" });
    const legacy = path.join(ctx.repo.dataDir, "iterations/s4.yaml");
    await writeFile(legacy, `${await readFile(legacy, "utf8")}project: other\n`);
    await recordBaseline(ctx.repo);
    await ctx.store.rescan();
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    // 拒否のメッセージに今 active の Iteration を出し、記録は変えない
    await expect(runCommand(iterationStart, ctx, { iteration: "s2" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s1 is active"),
    });
    expect(ctx.store.iterations.get("s2")?.data.status).toBe("planned");
    await expect(runCommand(iterationStart, ctx, { iteration: "s4" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s1 is active"),
    });
    // 閉じれば次を始められ、閉じた方を再開するのは今の active を閉じてから
    await runCommand(iterationClose, ctx, { iteration: "s1" });
    await runCommand(iterationStart, ctx, { iteration: "s2" });
    await expect(runCommand(iterationReopen, ctx, { iteration: "s1" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s2 is active"),
    });
    expect(ctx.store.iterations.get("s1")?.data.status).toBe("closed");
    await runCommand(iterationClose, ctx, { iteration: "s2" });
    expect((await runCommand(iterationReopen, ctx, { iteration: "s1" })).data.status).toBe(
      "active",
    );
  });

  it("2 つの clone が同時に別の Iteration を start すると、push で負けた側は検査からやり直して拒否される", async () => {
    const f = await initializedFixture();
    const a = await reopenInitialized(f);
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
      message: expect.stringContaining("s2 is active"),
    });
    expect(racer.store.iterations.get("s1")?.data.status).toBe("planned");
    expect(racer.store.iterations.get("s2")?.data.status).toBe("active");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("reopen で push に負けても、相手が別の変更なら検査からやり直して成功し、警告を重ねない", async () => {
    const f = await initializedFixture();
    const a = await reopenInitialized(f);
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
    const racer = await openContext({ cwd: f.cloneA, actor: { kind: "human", user: "a" }, hooks });
    const reopened = await runCommand(iterationReopen, racer, { iteration: "s1" });
    expect(reopened.data.status).toBe("active");
    expect(reopened.warnings).toEqual([
      "The 1 tickets removed when it was closed do not come back. Add them again with iteration add",
    ]);
    // 相手の変更も取り込んでいる
    expect(racer.store.iterations.get("s2")?.data.name).toBe("Sprint 2");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("reopen で push に負け、相手が別の Iteration を start していれば、検査からやり直して拒否される", async () => {
    const f = await initializedFixture();
    const a = await reopenInitialized(f);
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
    const racer = await openContext({ cwd: f.cloneA, actor: { kind: "human", user: "a" }, hooks });
    await expect(runCommand(iterationReopen, racer, { iteration: "s1" })).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("s2 is active"),
    });
    expect(racer.store.iterations.get("s1")?.data.status).toBe("closed");
    expect(racer.store.iterations.get("s2")?.data.status).toBe("active");
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("lint は 2 つ以上ある active の Iteration を指摘する", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    for (const name of ["Sprint 1", "Sprint 2", "Sprint 3"])
      await runCommand(iterationCreate, ctx, { name });
    await runCommand(iterationStart, ctx, { iteration: "s1" });
    const multiple = async () =>
      (await runCommand(lint, ctx, {})).data.issues
        .filter((i) => i.code === "lint_iteration_multiple_active")
        .map((i) => [i.id, i.message]);
    expect(await multiple()).toEqual([]);
    // 手の編集やマージで 2 つ目の active ができた場合（start の検査を通らない）
    await ctx.store.update("iteration", "s3", { status: "active" });
    const message = "There are 2 active Iterations (s1, s3)";
    expect(await multiple()).toEqual([
      ["s1", message],
      ["s3", message],
    ]);
  });
});
