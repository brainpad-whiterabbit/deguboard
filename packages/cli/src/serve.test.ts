import { afterEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { init, openContext, runCommand } from "@deguboard/core";
import { createFixture, type Fixture } from "../../core/test/helpers/git-fixture.js";
import { addServeCommands } from "./serve.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

describe("dg serve / dg open", () => {
  it("serve と open の --help は開発用と書く（画面は VS Code 拡張で開く。ADR-023）", () => {
    const program = new Command("dg");
    addServeCommands(program, { streams: { out: () => {}, err: () => {} }, resolveCwd: () => "." });
    for (const name of ["serve", "open"]) {
      const command = program.commands.find((c) => c.name() === name)!;
      expect(command.helpInformation(), name).toContain("開発用");
      expect(command.description(), name).toContain("画面は VS Code 拡張で開く");
    }
  });

  it("serve は 127.0.0.1 で API を配信し、--open でブラウザを開く", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const out: string[] = [];
    const opened: string[] = [];
    let seen: unknown;
    const program = new Command("dg").option("--json").exitOverride();
    addServeCommands(program, {
      streams: { out: (t) => out.push(t), err: () => {} },
      resolveCwd: () => f.cloneA,
      openUrl: async (url) => {
        opened.push(url);
      },
      onListening: async (url) => {
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        seen = await (await fetch(`${url}api/commands`)).json();
      },
    });
    await program.parseAsync(["serve", "--port", "0", "--open"], { from: "user" });
    expect(out[0]).toContain("deguboard server: http://127.0.0.1:");
    expect(opened).toHaveLength(1);
    expect(seen).toMatchObject({ ok: true });
  });

  it("serve は差し替えた env の DEGUBOARD_USER を読み、whoami の user_source が env になる", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    let seen: any;
    const program = new Command("dg").option("--json").option("--user <name>").exitOverride();
    addServeCommands(program, {
      streams: { out: () => {}, err: () => {} },
      resolveCwd: () => f.cloneA,
      env: { DEGUBOARD_USER: "eiki" },
      onListening: async (url) => {
        const res = await fetch(`${url}api/commands/whoami`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: {} }),
        });
        seen = await res.json();
      },
    });
    await program.parseAsync(["serve", "--port", "0"], { from: "user" });
    expect(seen.data).toMatchObject({ id: "eiki", user: "eiki", user_source: "env" });
  });

  it("open は既定の URL をブラウザで開く", async () => {
    const opened: string[] = [];
    const out: string[] = [];
    const program = new Command("dg").exitOverride();
    addServeCommands(program, {
      streams: { out: (t) => out.push(t), err: () => {} },
      resolveCwd: () => ".",
      openUrl: async (u) => void opened.push(u),
    });
    await program.parseAsync(["open", "--port", "7575"], { from: "user" });
    expect(opened).toEqual(["http://127.0.0.1:7575/"]);
    expect(out).toEqual(["http://127.0.0.1:7575/"]);
    const jsonProgram = new Command("dg").option("--json").exitOverride();
    const jsonOut: string[] = [];
    addServeCommands(jsonProgram, {
      streams: { out: (t) => jsonOut.push(t), err: () => {} },
      resolveCwd: () => ".",
      openUrl: async () => {},
    });
    await jsonProgram.parseAsync(["--json", "open"], { from: "user" });
    expect(JSON.parse(jsonOut[0]!)).toMatchObject({
      ok: true,
      data: { url: "http://127.0.0.1:7474/" },
    });
  });
});
