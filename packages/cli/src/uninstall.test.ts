// dg uninstall の CLI の写し方（引数・主体・出力・終了コード）。判定と消す処理は packages/core/src/commands/uninstall.test.ts が確かめる。
// 一時リポジトリと一時の HOME だけで動かす

import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalOnlyRepo } from "../../core/test/helpers/git-fixture.js";
import { run } from "./program.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function dg(cwd: string, argv: string[], env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd,
    env,
    streams: { out: (t) => out.push(t), err: (t) => err.push(t) },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("dg uninstall（CL-10）", () => {
  it("--dry-run は agent でも通って --json で消すもの・残すもの・止める理由を返し、実行は agent を拒み、人でも手元にしかないボードがあれば --force まで止まる", async () => {
    const r = await createLocalOnlyRepo();
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-home-")));
    cleanups.push(r.cleanup, () => rm(home, { recursive: true, force: true }));
    const human = { HOME: home };
    const agent = { HOME: home, DEGUBOARD_ACTOR: "agent" };
    const dataDir = path.join(r.dir, ".git", "deguboard");
    expect((await dg(r.dir, ["init"], human)).code).toBe(0);
    expect((await dg(r.dir, ["hooks", "install"], human)).code).toBe(0);

    const dry = await dg(r.dir, ["--json", "uninstall", "--dry-run"], agent);
    expect(dry.code).toBe(0);
    const { data } = JSON.parse(dry.out) as {
      data: {
        proceeds: boolean;
        removes: Array<{ kind: string }>;
        keeps: Array<{ kind: string }>;
        blockers: Array<{ kind: string; next: string[] }>;
      };
    };
    expect(data.proceeds).toBe(false);
    expect(data.removes.map((x) => x.kind)).toEqual([
      "hooks",
      "data_worktree",
      "data_branch",
      "merge_driver",
      "local_dir",
    ]);
    expect(data.keeps.map((x) => x.kind)).toEqual(["ignore_file"]);
    // リモートのないボードは手元にしかないので、消す前にリモートへ送るよう案内する
    expect(data.blockers).toMatchObject([
      { kind: "unpushed", next: ["git remote add origin <URL>", "dg sync"] },
    ]);

    const refused = await dg(r.dir, ["--json", "uninstall", "--force"], agent);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({ error: { code: "TRANSITION_REJECTED" } });
    // human と agent 以外の主体は人とみなさず、ほかのコマンドと同じ引数の誤りにする
    const unknown = await dg(r.dir, ["--json", "--actor", "robot", "uninstall", "--force"], human);
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.out)).toMatchObject({ error: { code: "INVALID_INPUT" } });
    await access(dataDir);
    const stopped = await dg(r.dir, ["uninstall"], human);
    expect(stopped.code).toBe(1);
    expect(stopped.err).toContain("dg uninstall removed nothing");
    expect(stopped.err).toContain("Next: git remote add origin <URL>, dg sync");
    await access(dataDir);

    const forced = await dg(r.dir, ["uninstall", "--force"], human);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain(`Removed data_worktree (repository): ${dataDir}`);
    expect(forced.out).toContain("Overridden by --force (unpushed)");
    await expect(access(dataDir)).rejects.toThrow();
    expect((await dg(r.dir, ["uninstall"], human)).out).toContain(
      "Nothing to remove in this clone",
    );
  });
});
