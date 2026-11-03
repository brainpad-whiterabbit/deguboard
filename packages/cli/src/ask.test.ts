// dg ask（依頼文）を CLI から確かめる。Skill の名前は guide のトピックを持つ cli 側で照合する

import { afterEach, describe, expect, it } from "vitest";
import {
  ASK_ACTIONS,
  ASK_SKILLS,
  askCandidates,
  createLocalClient,
  init,
  openContext,
  runCommand,
  type AskSubject,
  type AskView,
} from "@deguboard/core";
import { startServer } from "@deguboard/server";
import { createFixture } from "../../core/test/helpers/git-fixture.js";
import { run } from "./program.js";
import { buildSkills } from "./skill.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function dg(cwd: string, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd,
    env: {},
    streams: { out: (t) => out.push(t), err: (t) => err.push(t) },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("dg ask", () => {
  it("依頼文に使う Skill の名前は、すべて dg skill install で配る名前（guide のトピック）にある", async () => {
    const installed = new Set((await buildSkills()).map((s) => s.name));
    expect(ASK_SKILLS.length).toBeGreaterThan(0);
    for (const name of ASK_SKILLS) expect(installed, name).toContain(name);
    // 候補の 1 行目に出る形（/dg<トピック>）も同じ名前から作る
    const subjects: AskSubject[][] = [
      [],
      [
        {
          kind: "ticket",
          id: "t1",
          title: "A",
          status: "review",
          iteration: "s1",
          iteration_status: "active",
          deps_done: true,
          running: false,
        },
      ],
      [{ kind: "iteration", id: "s1", title: "S", status: "active", complete: true }],
    ];
    for (const s of subjects)
      for (const c of askCandidates(s))
        if (c.skill) expect(installed, c.skill).toContain(c.skill.slice(1));
    expect(ASK_ACTIONS).toContain("free");
  });

  it("CLI・HTTP・Webview（プロセス内の CommandClient）が同じ依頼文を返し、人向けの出力は文だけを標準出力に出す", async () => {
    const f = await createFixture();
    cleanups.push(f.cleanup);
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    expect((await dg(f.cloneA, ["ticket", "create", "画面の直し"])).code).toBe(0);

    const input = { targets: ["t1"], action: "fix", note: "文言だけ", format: "text" };
    const cli = await dg(f.cloneA, [
      "--json",
      "ask",
      "t1",
      "--action",
      "fix",
      "--note",
      "文言だけ",
      "--format",
      "text",
    ]);
    expect(cli.code).toBe(0);
    const fromCli = JSON.parse(cli.out) as { ok: boolean; data: AskView };

    const server = await startServer({ cwd: f.cloneA, port: 0, user: "ui" });
    cleanups.push(server.close);
    const res = await fetch(`${server.url}api/commands/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
    const fromHttp = (await res.json()) as { ok: boolean; data: AskView };

    const fromWebview = await createLocalClient({ cwd: f.cloneA, user: "ui" }).run<AskView>(
      "ask",
      input,
    );

    expect(fromCli.ok).toBe(true);
    expect(fromHttp).toEqual(fromCli);
    expect(fromWebview.data).toEqual(fromCli.data);
    expect(fromCli.data.text).toContain("次のチケットを指示のとおりに直してください。");

    const human = await dg(f.cloneA, ["ask", "t1", "--action", "fix"]);
    expect(human.out).toBe(
      "/dgimport t1\n次のチケットを指示のとおりに直してください。\n\n対象:\n- t1「画面の直し」（todo, Iteration なし）",
    );
    expect(human.err).toContain("★割り当てる（assign）");
    // 候補にない頼むことは使い方の誤り（終了コード 2）
    expect((await dg(f.cloneA, ["ask", "t1", "--action", "release"])).code).toBe(2);
  });
});
