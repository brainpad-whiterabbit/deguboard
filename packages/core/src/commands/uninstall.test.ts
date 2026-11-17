// dg uninstall（commands/uninstall.ts。CL-10）を、bare リモート付きの一時リポジトリと一時の HOME で確かめる。
// 本物のリポジトリとホームディレクトリには触れない（cwd は雛形の clone、env.HOME は一時ディレクトリ）

import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanups,
  initialized,
  initializedFixture,
  reopenInitialized,
  runCleanups,
} from "../../test/helpers/commands-context.js";
import { git, type Fixture } from "../../test/helpers/git-fixture.js";
import { ensureMergeDriver } from "../git/merge.js";
import { DG_COMMIT_TRAILER } from "../git/outside.js";
import { DATA_REMOTE_NAME } from "../git/repo.js";
import { pathExists } from "../storage/exists.js";
import { runCommand, type CommandContext } from "./define.js";
import { installHooks } from "./hook-settings.js";
import { installSkill } from "./skill-files.js";
import { ticketClaim, ticketCreate } from "./ticket.js";
import { uninstall } from "./uninstall.js";

afterEach(runCleanups);

const SELF = ["/opt/node/bin/node", "/opt/dg/bin/dg.js"];

interface Installed {
  f: Fixture;
  ctx: CommandContext;
  cwd: string;
  env: { HOME: string };
  /** リポジトリの追跡しない設定・追跡する設定・個人の設定 */
  local: string;
  shared: string;
  personal: string;
}

/** init 済みの clone に、dg が入れるものをひととおり入れる（フックと Skill はリポジトリと個人の両方、マージドライバ、deguboard-data のリモート） */
async function installed(): Promise<Installed> {
  const f = await initializedFixture();
  const ctx = await reopenInitialized(f);
  const cwd = f.cloneA;
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-home-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home };
  await ensureMergeDriver(ctx.repo, [...SELF, "merge-driver"]);
  for (const scope of ["local", "project", "personal"] as const)
    await installHooks({ cwd, scope, env, self: () => SELF });
  for (const scope of ["project", "personal"] as const)
    await installSkill({ cwd, scope, env, force: false });
  await git(cwd, ["remote", "add", DATA_REMOTE_NAME, f.remoteDir]);
  return {
    f,
    ctx,
    cwd,
    env,
    local: path.join(cwd, ".claude", "settings.local.json"),
    shared: path.join(cwd, ".claude", "settings.json"),
    personal: path.join(home, ".claude", "settings.json"),
  };
}

const hasDgHooks = async (file: string) =>
  (await readFile(file, "utf8")).includes("--actor agent hook");
const skillOf = (base: string) => path.join(base, ".claude", "skills", "dgwork", "SKILL.md");
const succeeds = async (cwd: string, args: string[]) =>
  (await git(cwd, args).then(
    () => true,
    () => false,
  )) as boolean;
const hasMergeConfig = (cwd: string) =>
  succeeds(cwd, ["config", "--local", "--get-regexp", "^merge\\.deguboard\\."]);
const hasDataBranch = (cwd: string) =>
  succeeds(cwd, ["show-ref", "--verify", "--quiet", "refs/heads/deguboard"]);
const remoteTip = async (f: Fixture) =>
  (await git(f.remoteDir, ["rev-parse", "refs/heads/deguboard"])).stdout.trim();

/** 何も消えていない */
async function expectUntouched(i: Installed): Promise<void> {
  expect(await hasDgHooks(i.local)).toBe(true);
  expect(await pathExists(skillOf(i.cwd))).toBe(true);
  expect(await pathExists(path.join(i.ctx.repo.dataDir, ".git"))).toBe(true);
  expect(await hasDataBranch(i.cwd)).toBe(true);
  expect(await hasMergeConfig(i.cwd)).toBe(true);
  expect(await pathExists(i.ctx.repo.localDir)).toBe(true);
}

describe("dg uninstall（CL-10）", () => {
  it("クローンの中の dg のフック・Skill・データの worktree・手元のデータブランチ・マージドライバの登録・deguboard-local を順に消し、リモートと共有のものと個人のものは残して消し方を返す", async () => {
    const i = await installed();
    const { cwd, env, ctx, f } = i;
    // 手を加えた Skill は dg skill uninstall と同じく残す
    const edited = path.join(cwd, ".claude", "skills", "dgplan", "SKILL.md");
    await writeFile(edited, `${await readFile(edited, "utf8")}\nmine\n`);
    const tip = await remoteTip(f);

    const result = await uninstall({ cwd, env, actor: "human" });

    expect(result).toMatchObject({ dryRun: false, proceeds: true, blockers: [] });
    expect(result.removes.map((r) => `${r.kind}:${r.scope}`)).toEqual([
      "hooks:repository",
      "skills:repository",
      "data_worktree:repository",
      "data_branch:repository",
      "merge_driver:repository",
      "local_dir:repository",
    ]);
    expect(await hasDgHooks(i.local)).toBe(false);
    expect(await pathExists(skillOf(cwd))).toBe(false);
    expect(await pathExists(edited)).toBe(true);
    expect(await pathExists(ctx.repo.dataDir)).toBe(false);
    expect((await git(cwd, ["worktree", "list", "--porcelain"])).stdout).not.toContain(
      ctx.repo.dataDir,
    );
    expect(await hasDataBranch(cwd)).toBe(false);
    expect(await hasMergeConfig(cwd)).toBe(false);
    expect(await pathExists(ctx.repo.localDir)).toBe(false);

    // なぜ残す：リモートとコミットしたファイルはチームで共有していて、消すとほかの人に効き、データブランチは戻せない
    expect(await remoteTip(f)).toBe(tip);
    expect((await git(cwd, ["remote"])).stdout.split("\n")).toEqual(
      expect.arrayContaining(["origin", DATA_REMOTE_NAME]),
    );
    expect(await pathExists(path.join(cwd, ".claude", ".gitignore"))).toBe(true);
    expect(await hasDgHooks(i.shared)).toBe(true);
    // --personal を付けなければ、ほかのリポジトリでも使う個人のフックと Skill は残す
    expect(await hasDgHooks(i.personal)).toBe(true);
    expect(await pathExists(skillOf(env.HOME))).toBe(true);
    const kept = Object.fromEntries(result.keeps.map((k) => [k.kind, k]));
    expect(Object.keys(kept).sort()).toEqual([
      "data_remote",
      "edited_skills",
      "ignore_file",
      "personal_hooks",
      "personal_skills",
      "remote_data_branch",
      "shared_hooks",
    ]);
    expect(kept["remote_data_branch"]).toMatchObject({
      target: "origin/deguboard",
      commands: ["git push origin --delete deguboard"],
    });
    expect(kept["remote_data_branch"]!.reason).toContain("stays on the remote");
    expect(kept["data_remote"]).toMatchObject({
      target: DATA_REMOTE_NAME,
      commands: [`git remote remove ${DATA_REMOTE_NAME}`],
    });
    expect(kept["shared_hooks"]!.commands).toEqual(["dg hooks uninstall --shared"]);
    expect(kept["edited_skills"]!.commands).toEqual(["dg skill uninstall --force"]);

    // リモートにデータが残っているので、dg init でまた取り込める
    const again = await initialized(cwd);
    expect(await pathExists(path.join(again.repo.dataDir, "config.yaml"))).toBe(true);
  });

  it("--personal を付けると、個人の設定のフックとホームディレクトリの下の Skill も消す", async () => {
    const i = await installed();
    const result = await uninstall({ cwd: i.cwd, env: i.env, actor: "human", personal: true });
    expect(result.removes.filter((r) => r.scope === "personal").map((r) => r.kind)).toEqual([
      "hooks",
      "skills",
    ]);
    expect(await hasDgHooks(i.personal)).toBe(false);
    expect(await pathExists(skillOf(i.env.HOME))).toBe(false);
    expect(result.keeps.map((k) => k.kind)).not.toContain("personal_hooks");
  });

  it("送っていないデータのコミット・dg の外の変更・作業中のチケットの worktree があると、何も消さずに理由と次にすることを返して止まり、--force で越える", async () => {
    const i = await installed();
    const { cwd, env, ctx } = i;
    await runCommand(ticketCreate, ctx, { title: "A" });
    const claimed = await runCommand(ticketClaim, ctx, { ticket: "t1" });
    expect(claimed.data.worktree).not.toBeNull();
    // dg のコミット（印つき）を push せずに残し、dg を通さずにファイルを置く
    await git(ctx.repo.dataDir, [
      "commit",
      "--allow-empty",
      "-m",
      `local only\n\n${DG_COMMIT_TRAILER}`,
    ]);
    await writeFile(path.join(ctx.repo.dataDir, "stray.txt"), "x\n");

    const stopped = await uninstall({ cwd, env, actor: "human" }).catch((e: unknown) => e);
    expect(stopped).toMatchObject({ code: "REJECTED" });
    const detail = (stopped as { detail: string }).detail;
    expect(detail).toContain("1 commit(s) of the board data are not pushed to origin/deguboard");
    expect(detail).toContain("Next: dg sync");
    expect(detail).toContain("stray.txt");
    expect(detail).toContain(`t1 (${claimed.data.worktree})`);
    await expectUntouched(i);

    const dry = await uninstall({ cwd, env, actor: "human", dryRun: true });
    expect(dry.proceeds).toBe(false);
    expect(dry.blockers.map((b) => b.kind)).toEqual([
      "unpushed",
      "outside_changes",
      "active_worktrees",
    ]);
    expect(dry.blockers.every((b) => b.next.length > 0)).toBe(true);

    const forced = await uninstall({ cwd, env, actor: "human", force: true });
    expect(forced).toMatchObject({ proceeds: true, force: true });
    expect(forced.blockers).toHaveLength(3);
    expect(await pathExists(ctx.repo.dataDir)).toBe(false);
    expect(await hasDataBranch(cwd)).toBe(false);
    // 作業中のチケットの worktree と作業ブランチは dg のものではないので、--force でも消さない
    expect(await pathExists(claimed.data.worktree!)).toBe(true);
  });

  it("人だけが実行できる（Core の固定）：エージェントの呼び出しは TRANSITION_REJECTED で何も消さず、何も消さない --dry-run は消すもの・残すもの・止める理由を返す", async () => {
    const i = await installed();
    const base = { cwd: i.cwd, env: i.env, actor: "agent" as const };
    // なぜ人だけ：フックを外す操作を含み（hooks_uninstall と同じ守り）、手元のデータと個人の設定を消す。--force でも越えられない
    for (const force of [false, true])
      await expect(uninstall({ ...base, force })).rejects.toMatchObject({
        code: "TRANSITION_REJECTED",
        message:
          "dg limits removing deguboard from a clone to a person (fixed in Core, uninstall: human_only)",
      });
    await expectUntouched(i);

    const local = await readFile(i.local, "utf8");
    const dry = await uninstall({ ...base, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, proceeds: true, blockers: [] });
    expect(dry.removes.map((r) => r.kind)).toEqual([
      "hooks",
      "skills",
      "data_worktree",
      "data_branch",
      "merge_driver",
      "local_dir",
    ]);
    expect(dry.removes[1]!.names).toContain("dgwork");
    expect(dry.keeps.map((k) => k.kind)).toContain("remote_data_branch");
    expect(await readFile(i.local, "utf8")).toBe(local);
    await expectUntouched(i);
  });

  it("deguboard を入れていないリポジトリでは、何も消さずに空の結果を返す", async () => {
    const i = await installed();
    await uninstall({ cwd: i.cwd, env: i.env, actor: "human", personal: true });
    const again = await uninstall({ cwd: i.cwd, env: i.env, actor: "human", personal: true });
    expect(again.removes).toEqual([]);
    expect(again.blockers).toEqual([]);
  });
});
