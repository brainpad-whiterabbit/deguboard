// Plan のコマンド（create・show・list・approve・close と着手できるかの判断）

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import {
  planApprove,
  planClose,
  planCreate,
  planList,
  planReadiness,
  planShow,
  type ReadinessTicket,
} from "./plan.js";
import { projectCreate } from "./project.js";
import { configSet } from "./setup.js";
import { ticketCreate, ticketDelete, ticketMove, ticketShow } from "./ticket.js";
import {
  fixture,
  setDependsOn,
  initialized,
  runCleanups,
} from "../../test/helpers/commands-context.js";

afterEach(runCleanups);

describe("Plan", () => {
  it("create は承認待ちで作って即 push し、存在しない・終わった・別の開いた Plan のチケットを拒否する（PL-3）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C", "D", "E"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(ticketMove, ctx, { ticket: "t4", status: "done" });
    await runCommand(ticketMove, ctx, { ticket: "t5", status: "abandoned" });
    const created = await runCommand(planCreate, ctx, {
      tickets: ["t1", "2"],
      after: { t2: "t1" },
      scope: { t1: "API だけ" },
      approach: { t1: "既存の型を使う", t2: "画面は作らない" },
    });
    expect(created.data).toMatchObject({
      id: "p1",
      project: "default",
      tickets: ["t1", "t2"],
      after: { t2: ["t1"] },
      pending_approval: true,
      details: {
        t1: { scope: "API だけ", approach: "既存の型を使う" },
        t2: { approach: "画面は作らない" },
      },
    });
    expect(created.write).toMatchObject({ committed: true, pushed: true });
    const yaml = await readFile(path.join(ctx.repo.dataDir, "plans/p1.yaml"), "utf8");
    expect(yaml).toContain("pending_approval: true");
    // 同じチケットを 2 つの開いた Plan に入れられない
    await expect(runCommand(planCreate, ctx, { tickets: ["t3", "t1"] })).rejects.toMatchObject({
      code: "REJECTED",
    });
    // done と abandoned のチケットは入れられない
    await expect(runCommand(planCreate, ctx, { tickets: ["t4"] })).rejects.toMatchObject({
      code: "REJECTED",
    });
    await expect(runCommand(planCreate, ctx, { tickets: ["t5"] })).rejects.toMatchObject({
      code: "REJECTED",
    });
    // 存在しないチケットは NOT_FOUND
    await expect(runCommand(planCreate, ctx, { tickets: ["t99"] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // after は Plan の中のチケットだけで、循環できない
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t3"], after: { t3: "t4" } }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t3"], after: { t3: "t3" } }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(ctx.store.plans.size).toBe(1);
    // 閉じた Plan のチケットは別の Plan に入れられる
    await runCommand(planClose, ctx, { plan: "p1" });
    const next = await runCommand(planCreate, ctx, { tickets: ["t1", "t3"] });
    expect(next.data).toMatchObject({ id: "p2", tickets: ["t1", "t3"] });
  });

  it("create は after の循環と、Plan の外のチケットへの scope を拒否する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, ctx, { title });
    await expect(
      runCommand(planCreate, ctx, {
        tickets: ["t1", "t2", "t3"],
        after: { t1: ["t3"], t2: "t1", t3: "t2" },
      }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t1"], scope: { t2: "外" } }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(ctx.store.plans.size).toBe(0);
  });

  it("create は after と depends_on（Plan の外の終わっていないチケットを含む）をまたぐ循環を拒否し、経路をメッセージに出す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B", depends_on: ["t1"] });
    await runCommand(ticketCreate, ctx, { title: "C", depends_on: ["t2"] });
    // t1 が after で t2 を待ち、t2 は depends_on で t1 を待つ
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t1", "t2"], after: { t1: "t2" } }),
    ).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("t1 →(after) t2 →(depends_on) t1"),
    });
    // Plan の外のチケット（t2）の depends_on を回って戻る循環も拒否する
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t1", "t3"], after: { t1: "t3" } }),
    ).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("t1 →(after) t3 →(depends_on) t2 →(depends_on) t1"),
    });
    // after だけの循環は今までどおりの言い方で拒否する
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t1", "t2"], after: { t1: "t2", t2: "t1" } }),
    ).rejects.toMatchObject({
      code: "REJECTED",
      message: expect.stringContaining("after が循環している: t1 → t2 → t1"),
    });
    expect(ctx.store.plans.size).toBe(0);
    // depends_on と同じ向きの after は循環しない
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2", "t3"], after: { t3: "t1" } });
    await runCommand(planClose, ctx, { plan: "p1" });
    // 終わった依存先は待たないので、そこを通る循環はない
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "abandoned" });
    await runCommand(planCreate, ctx, { tickets: ["t1", "t3"], after: { t1: "t3" } });
    expect(ctx.store.plans.size).toBe(2);
  });

  it("create は after が空の Plan を、depends_on だけの循環があっても拒否しない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B"]) await runCommand(ticketCreate, ctx, { title });
    // TK-2 は作成時に循環を拒否するので、ファイルを直接書いて壊れたデータ（t1 と t2 が互いを待つ）を作る
    await setDependsOn(ctx, "t1", "[t2]");
    await setDependsOn(ctx, "t2", "[t1]");
    await ctx.store.rescan();
    const created = await runCommand(planCreate, ctx, { tickets: ["t1", "t2"] });
    expect(created.data).toMatchObject({ id: "p1", tickets: ["t1", "t2"] });
    expect(ctx.store.plans.size).toBe(1);
  });

  it("create は after があっても、見つかる循環が after の辺を含まない（depends_on だけ）なら拒否しない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, ctx, { title });
    // t1 と t2 は depends_on だけで互いを待つ（壊れたデータ）。t3 は after で t1 を待つ（after の辺は循環しない）
    await setDependsOn(ctx, "t1", "[t2]");
    await setDependsOn(ctx, "t2", "[t1]");
    await ctx.store.rescan();
    const created = await runCommand(planCreate, ctx, {
      tickets: ["t1", "t2", "t3"],
      after: { t3: "t1" },
    });
    expect(created.data).toMatchObject({ id: "p1", tickets: ["t1", "t2", "t3"] });
    expect(created.data).toMatchObject({ after: { t3: ["t1"] } });
  });

  it("create は段階（tier）を details に記録し、不正な値と Plan の外のチケットを拒否する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B"]) await runCommand(ticketCreate, ctx, { title });
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t1"], tier: { t1: "huge" as "light" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runCommand(planCreate, ctx, { tickets: ["t1"], tier: { t2: "light" } }),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(ctx.store.plans.size).toBe(0);
    await runCommand(planCreate, ctx, {
      tickets: ["t1", "t2"],
      scope: { t1: "範囲" },
      tier: { t1: "light", t2: "heavy" },
    });
    const shown = await runCommand(planShow, ctx, { plan: "p1" });
    expect(shown.data.details).toEqual({
      t1: { scope: "範囲", tier: "light" },
      t2: { tier: "heavy" },
    });
  });

  it("show は進捗を Plan に書かず、チケットの状態から求めて待ちを出す（PL-2）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2", "t3"], after: { t2: ["t1"] } });
    const yaml = path.join(ctx.repo.dataDir, "plans/p1.yaml");
    const before = await readFile(yaml, "utf8");
    const first = await runCommand(planShow, ctx, { plan: "1" });
    expect(first.data.progress).toMatchObject({ total: 3, done: 0 });
    expect(first.data.items.map((t) => [t.id, t.waiting])).toEqual([
      ["t1", []],
      ["t2", ["t1"]],
      ["t3", []],
    ]);
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    await runCommand(ticketMove, ctx, { ticket: "t3", status: "abandoned" });
    const second = await runCommand(planShow, ctx, { plan: "p1" });
    expect(second.data.progress).toEqual({
      total: 2,
      done: 1,
      by_status: { todo: 1, in_progress: 0, review: 0, done: 1, abandoned: 1 },
    });
    expect(second.data.items.find((t) => t.id === "t2")?.waiting).toEqual([]);
    // Plan のファイルは書き換わらない
    expect(await readFile(yaml, "utf8")).toBe(before);
    expect(await readFile(yaml, "utf8")).not.toContain("progress");
  });

  it("show は状態を Plan に書かず、list と同じく pending_approval と closed_at から求める（PL-5）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(planCreate, ctx, { tickets: ["t1"] });
    const statuses = async () => {
      const shown = await runCommand(planShow, ctx, { plan: "p1" });
      const listed = await runCommand(planList, ctx, {});
      expect(shown.data.status).toBe(listed.data[0]!.status);
      return shown.data.status;
    };
    expect(await statuses()).toBe("pending");
    await runCommand(planApprove, ctx, { plan: "p1" });
    expect(await statuses()).toBe("approved");
    await runCommand(planClose, ctx, { plan: "p1" });
    expect(await statuses()).toBe("closed");
    expect(await readFile(path.join(ctx.repo.dataDir, "plans/p1.yaml"), "utf8")).not.toContain(
      "status",
    );
  });

  it("show と list は、待ちの相手を after が先・depends_on が後で出し、着手できるものと次を Plan の順で決める（PL-6）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C", "D"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(ticketCreate, ctx, { title: "E", depends_on: ["t3", "t4"] });
    // items が [t1(after t2), t2, t3, t5(after t3、depends_on t3・t4)]
    await runCommand(planCreate, ctx, {
      tickets: ["t1", "t2", "t3", "t5"],
      after: { t1: "t2", t5: "t3" },
    });
    const first = await runCommand(planShow, ctx, { plan: "p1" });
    expect(first.data.items.map((t) => [t.id, t.waiting, t.ready])).toEqual([
      ["t1", ["t2"], false],
      ["t2", [], true],
      ["t3", [], true],
      ["t5", ["t3", "t4"], false],
    ]);
    expect(first.data.ready).toEqual(["t2", "t3"]);
    expect(first.data.next).toEqual({ id: "t2", waiting: [] });
    // t2 が終われば、段の浅い t3 より Plan の順で先の t1 が次になる
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "done" });
    const second = await runCommand(planShow, ctx, { plan: "p1" });
    expect(second.data.next).toEqual({ id: "t1", waiting: [] });
    // list の行も同じ値を持つ
    const [row] = (await runCommand(planList, ctx, {})).data;
    expect(row).toMatchObject({
      waiting: { t1: [], t2: [], t3: [], t5: ["t3", "t4"] },
      ready: ["t1", "t3"],
      next: { id: "t1", waiting: [] },
    });
    // 着手できる todo がなければ、Plan の順で先頭の todo とその待ちの相手を次に出す
    for (const id of ["t1", "t3"])
      await runCommand(ticketMove, ctx, { ticket: id, status: "in_progress" });
    const third = await runCommand(planShow, ctx, { plan: "p1" });
    expect(third.data.ready).toEqual([]);
    expect(third.data.next).toEqual({ id: "t5", waiting: ["t3", "t4"] });
  });

  it("消したチケットを after が指しても待たない。depends_on は deps_done と同じく待つ（PL-6）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2"], after: { t2: "t1" } });
    await runCommand(ticketDelete, ctx, { ticket: "t1" });
    const shown = await runCommand(planShow, ctx, { plan: "p1" });
    expect(shown.warnings).toEqual(["t1 が見つからない（削除された）"]);
    expect(shown.data.items.map((t) => [t.id, t.waiting, t.ready])).toEqual([["t2", [], true]]);
    expect(shown.data.next).toEqual({ id: "t2", waiting: [] });
    const [row] = (await runCommand(planList, ctx, {})).data;
    expect(row?.waiting).toEqual({ t2: [] });
  });

  it("depends_on は abandoned の依存先と別の Project の終わった依存先を待たず、消した依存先は deps_done と同じく待つ（PL-6）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(projectCreate, ctx, { id: "other" });
    // t1 は別の Project、t2 は abandoned にし、t3 は消す
    await runCommand(ticketCreate, ctx, { title: "別の Project", project: "other" });
    for (const title of ["やめる", "消す"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(ticketCreate, ctx, { title: "D", depends_on: ["t1"] });
    await runCommand(ticketCreate, ctx, { title: "E", depends_on: ["t2"] });
    await runCommand(ticketCreate, ctx, { title: "F", depends_on: ["t3"] });
    await runCommand(planCreate, ctx, { tickets: ["t4", "t5", "t6"] });
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "abandoned" });
    await runCommand(ticketDelete, ctx, { ticket: "t3" });
    const waits = async () =>
      (await runCommand(planShow, ctx, { plan: "p1" })).data.items.map((t) => [t.id, t.waiting]);
    expect(await waits()).toEqual([
      ["t4", ["t1"]],
      ["t5", []],
      ["t6", ["t3"]],
    ]);
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    expect(await waits()).toEqual([
      ["t4", []],
      ["t5", []],
      ["t6", ["t3"]],
    ]);
  });

  it("after が Plan の外を指しても待たず、閉じた Plan は着手できるものも次も出さない（PL-6）", () => {
    const rows: ReadinessTicket[] = [
      { id: "t1", status: "todo", depends_on: [] },
      { id: "t2", status: "todo", depends_on: [] },
      { id: "t3", status: "in_progress", depends_on: [] },
    ];
    const tickets = new Map<string, ReadinessTicket>(rows.map((t) => [t.id, t]));
    const ticketOf = (id: string) => tickets.get(id);
    // t3 は Plan に入っていない（壊れたデータ）。画面の依存グラフも辺を出さない
    const open = planReadiness(
      { tickets: ["t1", "t2"], after: { t1: ["t3"], t2: ["t1"] } },
      ticketOf,
    );
    expect(open).toEqual({
      waiting: { t1: [], t2: ["t1"] },
      ready: ["t1"],
      next: { id: "t1", waiting: [] },
    });
    const closed = planReadiness(
      { tickets: ["t1", "t2"], after: { t2: ["t1"] }, closed_at: "2026-11-02T00:00:00Z" },
      ticketOf,
    );
    expect(closed).toEqual({ waiting: { t1: [], t2: ["t1"] }, ready: [], next: null });
  });

  it("approve は approved_by と approved_at を書いて pending_approval を外し、close は closed_at を書く", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(planCreate, ctx, { tickets: ["t1"] });
    const approved = await runCommand(planApprove, ctx, { plan: "p1" });
    expect(approved.data).toMatchObject({ pending_approval: false, approved_by: "eiki" });
    expect(approved.data.approved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 二度目の承認は拒否する
    await expect(runCommand(planApprove, ctx, { plan: "p1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    const closed = await runCommand(planClose, ctx, { plan: "p1" });
    expect(closed.data.closed_at).toBeDefined();
    expect(closed.warnings).toEqual(["t1 を残したまま閉じた"]);
    await expect(runCommand(planClose, ctx, { plan: "p1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    await expect(runCommand(planApprove, ctx, { plan: "p1" })).rejects.toMatchObject({
      code: "REJECTED",
    });
    await expect(runCommand(planShow, ctx, { plan: "p9" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("list は状態と進捗を出して open・pending・approved・closed と Project で絞り、ticket show は開いた Plan を出す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    for (const title of ["A", "B", "C"]) await runCommand(ticketCreate, ctx, { title });
    await runCommand(planCreate, ctx, { tickets: ["t1"] });
    await runCommand(planClose, ctx, { plan: "p1" });
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2"] });
    await runCommand(planApprove, ctx, { plan: "p2" });
    await runCommand(planCreate, ctx, { tickets: ["t3"] });
    await runCommand(ticketMove, ctx, { ticket: "t1", status: "done" });
    const all = await runCommand(planList, ctx, {});
    expect(all.data.map((p) => [p.id, p.status])).toEqual([
      ["p1", "closed"],
      ["p2", "approved"],
      ["p3", "pending"],
    ]);
    expect(all.data[1]?.progress).toMatchObject({ total: 2, done: 1 });
    const ids = async (input: {
      status?: "open" | "pending" | "approved" | "closed";
      project?: string;
    }) => (await runCommand(planList, ctx, input)).data.map((p) => p.id);
    expect(await ids({ status: "open" })).toEqual(["p2", "p3"]);
    expect(await ids({ status: "pending" })).toEqual(["p3"]);
    expect(await ids({ status: "approved" })).toEqual(["p2"]);
    expect(await ids({ status: "closed" })).toEqual(["p1"]);
    expect(await ids({ project: "default" })).toEqual(["p1", "p2", "p3"]);
    expect(await ids({ project: "other" })).toEqual([]);
    // 閉じた Plan は出さず、開いた Plan だけを出す
    const shown = async (ticket: string) =>
      (await runCommand(ticketShow, ctx, { ticket })).data.plan;
    expect(await shown("t1")).toBe("p2");
    expect(await shown("t3")).toBe("p3");
    await runCommand(planClose, ctx, { plan: "p3" });
    expect(await shown("t3")).toBeNull();
  });

  it("agent の承認は agent の ID を記録し、actor.human_only に plan.approve を入れると拒否される", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A" });
    await runCommand(ticketCreate, ctx, { title: "B" });
    await runCommand(planCreate, ctx, { tickets: ["t1"] });
    await runCommand(planCreate, ctx, { tickets: ["t2"] });
    const agent = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    const approved = await runCommand(planApprove, agent, { plan: "p1" });
    expect(approved.data.approved_by).toBe("eiki/agent");
    await runCommand(configSet, ctx, { key: "actor.human_only", value: "plan.approve" });
    const agent2 = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "eiki" } });
    await expect(runCommand(planApprove, agent2, { plan: "p2" })).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    });
  });
});
