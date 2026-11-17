// コマンドの結合テスト（src/commands/commands*.test.ts）の共通の準備。一時リポジトリの片付けと、init 済みの文脈・制約のある Workflow・壊れた依存の書き込み

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openContext, type ContextOptions } from "../../src/commands/context.js";
import { runCommand, type CommandContext } from "../../src/commands/define.js";
import { init } from "../../src/commands/setup.js";
import { resetGhCache } from "../../src/git/facts.js";
import { recordBaseline } from "../../src/git/outside.js";
import { createFixture, createFixtureFrom, git, type Fixture } from "./git-fixture.js";

export const cleanups: Array<() => Promise<void>> = [];

/** テストごとに片付けを回す（各テストのファイルの afterEach に渡す） */
export async function runCleanups(): Promise<void> {
  await Promise.all(cleanups.splice(0).map((c) => c()));
}

export async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

/**
 * init 済み（既定の Workflow）の雛形から写す。init を毎テストで走らせないため、テストファイルごとに 1 度だけ init する。
 * 写した先の文脈は reopenInitialized で開く（initialized と同じく、init の後の文脈）
 */
export async function initializedFixture(): Promise<Fixture> {
  const f = await createFixtureFrom("initialized", async (layout) => {
    await initialized(layout.cloneA);
  });
  cleanups.push(f.cleanup);
  return f;
}

/**
 * clone A で init し、続けて clone B でも init した（リモートのカンバンを取り込んだ）雛形から写す。
 * B の文脈は reopenInitialized(f, { cwd: f.cloneB }) で開く
 */
export async function initializedBothFixture(): Promise<Fixture> {
  const f = await createFixtureFrom("initialized-both", async (layout) => {
    await initialized(layout.cloneA);
    await initialized(layout.cloneB);
  });
  cleanups.push(f.cleanup);
  return f;
}

/** initializedFixture から写した先の文脈を開く。opts は initialized と同じ */
export function reopenInitialized(
  f: Fixture,
  opts: Partial<ContextOptions> = {},
): Promise<CommandContext> {
  return openContext({ cwd: f.cloneA, actor: { kind: "human", user: "eiki" }, ...opts });
}

/**
 * 同じ文脈（同じ索引）を、主体だけ人にして返す。エージェントの文脈で進めるテストが、準備として
 * チームの設定・Workflow を書く・段を下げるとき（エージェントには人の承認が要るか拒否される。WF-7）に使う
 */
export function asHuman(ctx: CommandContext): CommandContext {
  return { ...ctx, actor: { ...ctx.actor, kind: "human" } };
}

/** workflow.yaml をデータディレクトリに置いて索引を作り直す（カンバンのどのチケットにも効く） */
export async function writeWorkflowYaml(ctx: CommandContext, lines: string[]): Promise<void> {
  await writeFile(path.join(ctx.repo.dataDir, "workflow.yaml"), [...lines, ""].join("\n"));
  // 利用者が直に置いて dg adopt で取り込んだ状態にする（dg の外の変更の検査の基準。SY-8）
  await recordBaseline(ctx.repo);
  await ctx.store.rescan();
}

/**
 * PR を使わない進め方の Workflow にする：review → done に条件を付けず、done と例外の動きを誰でも聞かずにできるようにする。
 * 既定は done に pr_merged（ブランチのあるチケット）と人の承認を求め、abandoned と done の取り消しにも人の承認を求めるので、Status を動かすのが準備でしかないテスト
 * （Run・Plan・Iteration・集計など）が、手で動かす前に呼ぶ。別の文脈は呼んだ後に store.rescan() で読む
 */
export function writeOpenWorkflow(ctx: CommandContext): Promise<void> {
  return writeWorkflowYaml(ctx, [
    "boundaries:",
    "  - { from: review, to: done, requires: [], decide: anyone }",
    "exceptions: { abandon: anyone, back: anyone, reopen: anyone }",
  ]);
}

/** チケットの depends_on の行を直接書き換える（TK-2 が拒否する循環を、壊れたデータとして作るとき）。rescan は呼び出し側で */
export async function setDependsOn(ctx: CommandContext, id: string, value: string): Promise<void> {
  const file = path.join(ctx.repo.dataDir, `tickets/${id}.md`);
  const text = await readFile(file, "utf8");
  await writeFile(file, text.replace(/^depends_on: .*$/m, `depends_on: ${value}`));
  await recordBaseline(ctx.repo);
}

/**
 * init まで済ませた文脈を開く。init は git を何十回も起動して遅いので、init の後の状態だけが要るテストは
 * initializedFixture（雛形の写し）から始め、テストファイルがこれを直に呼ぶのは init 自身か init のオプションを確かめるときだけにする
 */
export async function initialized(
  cwd: string,
  opts: Partial<ContextOptions> = {},
): Promise<CommandContext> {
  const first = await openContext({
    cwd,
    initialize: {},
    actor: { kind: "human", user: "eiki" },
    ...opts,
  });
  await runCommand(init, first, {});
  return openContext({ cwd, actor: { kind: "human", user: "eiki" }, ...opts });
}

/**
 * 実装の Run をチケットの操作で閉じるテストの agent の文脈。環境変数から claude-code と判定させる。
 * read_transcripts の既定は false で会話記録を読まない（使用量は null のまま警告になる）が、HOME も一時ディレクトリにして本物の ~/.claude に触れない
 */
export async function agentWithRuns(cwd: string, now: () => Date): Promise<CommandContext> {
  const agent = await openContext({ cwd, actor: { kind: "agent", user: "eiki" }, now });
  const home = await mkdtemp(path.join(os.tmpdir(), "dg-home-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  agent.env = { CLAUDECODE: "1", HOME: home };
  return agent;
}

/** 偽の gh を PATH の先頭に置く。pr view の番号かブランチ名ごとに返す JSON を渡す。戻り値で PATH を戻す */
export async function fakeGh(root: string, cases: Record<string, string>): Promise<() => void> {
  const bin = path.join(root, "fake-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$1" in --version) echo "gh version 0 (fake)"; exit 0;; esac',
      'case "$3" in',
      ...Object.entries(cases).map(([key, json]) => `  ${key}) echo '${json}';;`),
      '  *) echo "no pull requests found for branch $3" >&2; exit 1;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const savedPath = process.env["PATH"];
  process.env["PATH"] = bin + path.delimiter + (savedPath ?? "");
  resetGhCache();
  return () => {
    process.env["PATH"] = savedPath;
    resetGhCache();
  };
}

/** 作業ブランチに、指定した時刻のコミットを積んで push する（手直しの Run を閉じる「最後の push の時刻」を決める） */
export async function pushCommitAt(cwd: string, branch: string, at: string): Promise<void> {
  const saved = { ...process.env };
  process.env["GIT_AUTHOR_DATE"] = at;
  process.env["GIT_COMMITTER_DATE"] = at;
  try {
    await git(cwd, ["checkout", "--quiet", branch]);
    await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", `push at ${at}`]);
    await git(cwd, ["push", "--quiet", "origin", branch]);
    await git(cwd, ["checkout", "--quiet", "main"]);
  } finally {
    delete process.env["GIT_AUTHOR_DATE"];
    delete process.env["GIT_COMMITTER_DATE"];
    if (saved["GIT_AUTHOR_DATE"]) process.env["GIT_AUTHOR_DATE"] = saved["GIT_AUTHOR_DATE"];
    if (saved["GIT_COMMITTER_DATE"])
      process.env["GIT_COMMITTER_DATE"] = saved["GIT_COMMITTER_DATE"];
  }
}
