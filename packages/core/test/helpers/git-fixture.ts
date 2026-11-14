// Git のテスト用：一時ディレクトリに bare リモートと 2 つの clone を作る（CLAUDE.md の規約）

import { afterAll } from "vitest";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRepoPaths, resolveRemote, type GitRepo } from "../../src/git/repo.js";
import { runGit } from "../../src/git/run.js";
import { ensureDeguboardWorktree } from "../../src/git/worktree.js";
import { Store } from "../../src/storage/store.js";

// 開発者のグローバル設定（hooksPath・gpgsign・defaultBranch）に影響されないようにする
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

// 裏の git maintenance・gc を起こさない。git は commit・fetch の後に maintenance run --auto --detach を起動し、
// 呼んだ git が終わっても一時ディレクトリに書き続けるため、後片付けの rm と競合する（ENOTEMPTY）
const backgroundOff: [string, string][] = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
];
process.env["GIT_CONFIG_COUNT"] = String(backgroundOff.length);
backgroundOff.forEach(([key, value], i) => {
  process.env[`GIT_CONFIG_KEY_${i}`] = key;
  process.env[`GIT_CONFIG_VALUE_${i}`] = value;
});

/** 裏の処理が残っていても消せるよう、rm を再試行させる */
const removeDir = (dir: string) =>
  rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/** push を受けた receive-pack には環境変数が渡らないので、bare リモート自身の設定で止める */
async function disableBackgroundOnRemote(remoteDir: string): Promise<void> {
  const settings: [string, string][] = [...backgroundOff, ["receive.autogc", "false"]];
  for (const [key, value] of settings) {
    await runGit(remoteDir, ["config", key, value]);
  }
}

export interface Fixture {
  root: string;
  remoteDir: string;
  cloneA: string;
  cloneB: string;
  cleanup(): Promise<void>;
}

/** 雛形の場所（cleanup を除いた Fixture） */
export type Layout = Omit<Fixture, "cleanup">;

async function configureIdentity(dir: string): Promise<void> {
  await runGit(dir, ["config", "user.name", "テスト"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
}

function layoutOf(root: string): Layout {
  return {
    root,
    remoteDir: path.join(root, "remote.git"),
    cloneA: path.join(root, "a"),
    cloneB: path.join(root, "b"),
  };
}

/** 雛形（キーごと）。既定のキーは空文字。テストファイルの中で 1 度だけ作る */
const DEFAULT_KEY = "";
const templates = new Map<string, Promise<string>>();

/** bare リモートと clone 2 つ、最初のコミット入りの雛形を作る */
async function buildBase(): Promise<Layout> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-git-template-")));
  const layout = layoutOf(root);
  await runGit(root, ["init", "--quiet", "--bare", "-b", "main", layout.remoteDir]);
  await disableBackgroundOnRemote(layout.remoteDir);
  await runGit(root, ["clone", "--quiet", layout.remoteDir, layout.cloneA]);
  await configureIdentity(layout.cloneA);
  await runGit(layout.cloneA, ["commit", "--quiet", "--allow-empty", "-m", "最初のコミット"]);
  await runGit(layout.cloneA, ["push", "--quiet", "origin", "main"]);
  await runGit(root, ["clone", "--quiet", layout.remoteDir, layout.cloneB]);
  await configureIdentity(layout.cloneB);
  return layout;
}

/**
 * key の雛形の場所を返す。まだなければ作り、setup があれば雛形の clone A で 1 度だけ走らせる。
 * 同じ key には最初の setup だけが効く（key はテストファイルの中で一意にする）
 */
function templateOf(key: string, setup?: (f: Layout) => Promise<void>): Promise<string> {
  let template = templates.get(key);
  if (!template) {
    template = (async () => {
      const base = await buildBase();
      try {
        await setup?.(base);
      } catch (e) {
        await removeDir(base.root);
        throw e;
      }
      return base.root;
    })();
    templates.set(key, template);
  }
  return template;
}

/** 既定の雛形のディレクトリ。まだ作っていなければ undefined（テストが雛形を消せたかを確かめるため） */
export async function fixtureTemplateDir(key = DEFAULT_KEY): Promise<string | undefined> {
  const template = templates.get(key);
  return template && (await template);
}

/** 雛形をすべて消す。2 回目以降は何もしない */
export async function disposeFixtureTemplate(): Promise<void> {
  const all = [...templates.values()];
  templates.clear();
  const settled = await Promise.allSettled(all);
  await Promise.all(settled.flatMap((r) => (r.status === "fulfilled" ? [removeDir(r.value)] : [])));
}

// テストファイルが終わったら雛形を消す（写したものは各テストの cleanup が消す）
afterAll(disposeFixtureTemplate);

/**
 * 雛形を写し、写した先に残る雛形の場所を写した先の場所に置き換える。雛形の場所は、remote.origin.url（config）、
 * linked worktree の向き（管理ディレクトリの gitdir と worktree の .git）、reflog の clone の行に残る。
 * `git worktree repair` は使わない（雛形の中で両向きが揃って見え、古い場所を正しいと認めて直さないことを確かめた）
 */
async function copyOf(templateRoot: string): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-git-")));
  await cp(templateRoot, root, { recursive: true, verbatimSymlinks: true });
  await replacePathIn(root, templateRoot, root);
  return { ...layoutOf(root), cleanup: () => removeDir(root) };
}

/** dir の中のファイルで from を含むものは、from を to に置き換える。git の object は圧縮されていて含まないので読まない */
async function replacePathIn(dir: string, from: string, to: string): Promise<void> {
  const fromBytes = Buffer.from(from);
  const toBytes = Buffer.from(to);
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name === "objects") continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isSymbolicLink()) {
        // verbatimSymlinks で写したリンクの絶対パスは雛形を指したまま残るので、雛形を指すものは張り直す
        const target = await readlink(p);
        if (target.includes(from)) {
          await rm(p);
          await symlink(target.replaceAll(from, to), p);
        }
      } else if (entry.isFile()) {
        const bytes = await readFile(p);
        if (bytes.includes(fromBytes)) await writeFile(p, replaceBytes(bytes, fromBytes, toBytes));
      }
    }
  };
  await walk(dir);
}

/** バイト列の中の from を to に置き換える。バイナリでも from 以外のバイトは変えない */
function replaceBytes(bytes: Buffer, from: Buffer, to: Buffer): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = bytes.indexOf(from); i !== -1; i = bytes.indexOf(from, start)) {
    parts.push(bytes.subarray(start, i), to);
    start = i + from.length;
  }
  parts.push(bytes.subarray(start));
  return Buffer.concat(parts);
}

/** 既定の雛形から写す。何も足さない、一から作ったものと同じ状態 */
export async function createFixture(): Promise<Fixture> {
  return copyOf(await templateOf(DEFAULT_KEY));
}

/**
 * setup を済ませた雛形から写す（init・チケット・commit など、テストファイルで毎回同じ準備をする場合）。
 * setup はキーごとに 1 度だけ、雛形の clone A で走る。写したものは setup の後の状態から始まる。
 * key はテストファイルの中で一意にする（同じ key の 2 回目の setup は無視される）
 */
export async function createFixtureFrom(
  key: string,
  setup: (f: Layout) => Promise<void>,
): Promise<Fixture> {
  if (key === DEFAULT_KEY) throw new Error("雛形のキーは空にできない");
  return copyOf(await templateOf(key, setup));
}

/** リモートのないリポジトリ */
export async function createLocalOnlyRepo(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "deguboard-local-")));
  const dir = path.join(root, "work");
  await runGit(root, ["init", "--quiet", "-b", "main", dir]);
  await configureIdentity(dir);
  return { dir, cleanup: () => removeDir(root) };
}

export interface OpenedRepo {
  repo: GitRepo;
  store: Store;
}

/**
 * データ用の bare リモート（コードのリモート origin とは別のリポジトリ）を f.root に作り、clones にリモート name として足す。
 * 返すのは bare リモートの場所（データを別のリポジトリに置くテスト用）
 */
export async function addDataRemote(
  f: Pick<Fixture, "root">,
  clones: readonly string[],
  name = "data",
): Promise<string> {
  const dir = path.join(f.root, "data.git");
  await runGit(f.root, ["init", "--quiet", "--bare", "-b", "main", dir]);
  await disableBackgroundOnRemote(dir);
  for (const clone of clones) await runGit(clone, ["remote", "add", name, dir]);
  return dir;
}

/** worktree を用意して Store を開く。init コマンドを通さずに git モジュールを単体で試すため。remote はコードとデータの両方のリモート */
export async function openRepo(
  dir: string,
  opts: { remote?: string | null; baseBranch?: string } = {},
): Promise<OpenedRepo> {
  const paths = await resolveRepoPaths(dir);
  const remote = opts.remote === undefined ? await resolveRemote(paths, "origin") : opts.remote;
  await ensureDeguboardWorktree(paths, remote);
  const repo: GitRepo = {
    ...paths,
    codeRemote: remote,
    dataRemote: remote,
    baseBranch: opts.baseBranch ?? "main",
  };
  const store = await Store.open(repo.dataDir, { localDir: repo.localDir });
  return { repo, store };
}

export const git = (dir: string, args: string[]) => runGit(dir, args);
