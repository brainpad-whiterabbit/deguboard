// 同梱した dg（dist/cli/dg.mjs）を拡張の外から呼ぶための、版の付かない起動ファイルと行き先（UI-11）。
// 拡張のフォルダは版付きで更新のたびに変わるので、外（ターミナル・フック・エージェント）は ~/.local/share/deguboard/dg だけを呼ぶ。
// 起動ファイルは中身が固定の sh で、隣の current（node と dg.mjs の場所、版）を読んで動かす。拡張は起動のたびに current を書き直す。
// node は拡張ホストの実行ファイル（process.execPath）を使う。デスクトップでは VS Code 本体（Electron）で、ELECTRON_RUN_AS_NODE=1 で
// node として動く。リモート（SSH・WSL・Dev Containers）では拡張ホストが server の node で動くので、そのまま node になる。
// Windows は sh がないので書かない

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** 起動ファイルと current の置き場所。XDG_DATA_HOME は見ない（GUI から起動した VS Code とシェルで値が違いうるので、起動ファイルと揃わなくなる） */
export function launcherDir(home: string = homedir()): string {
  return path.join(home, ".local", "share", "deguboard");
}

// 中身は版によらず固定にする（更新で書き換えなくてよいように）。current の node、PATH の node 24 以上、案内の順に試す。
// ELECTRON_RUN_AS_NODE はふつうの node には効かないので、node の種類によらず付ける。dg が子に node を起こすとき
// （process.execPath を呼ぶマージドライバなど）も Electron が node として動くよう、子にも引き継がせる。
// DEGUBOARD_LAUNCHER は dg に起動ファイルの場所を渡す（フックとマージドライバが起動ファイルを書くため。t735）。
// 起動ファイルから起動した dg の環境にだけ付け、起動ファイルを通らない dg（clone の dg など）には付けない
export const LAUNCHER_SCRIPT = `#!/bin/sh
# deguboard launcher, written by the deguboard VS Code extension. Do not edit.
# It runs the dg bundled in the extension, as recorded in "current" next to this file.
launcher="$HOME/.local/share/deguboard/dg"
current="$HOME/.local/share/deguboard/current"
node=
dg=
if [ -r "$current" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      node) node=$value ;;
      dg) dg=$value ;;
    esac
  done < "$current"
fi
if [ -n "$dg" ] && [ -f "$dg" ]; then
  if [ -n "$node" ] && [ -x "$node" ]; then
    DEGUBOARD_LAUNCHER=$launcher ELECTRON_RUN_AS_NODE=1 exec "$node" "$dg" "$@"
  fi
  if command -v node >/dev/null 2>&1; then
    major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
    if [ "$major" -ge 24 ] 2>/dev/null; then
      DEGUBOARD_LAUNCHER=$launcher exec node "$dg" "$@"
    fi
  fi
fi
echo "deguboard: dg could not be started because the deguboard VS Code extension that installed it has moved or been removed. Open VS Code with the deguboard extension once, then try again." >&2
exit 1
`;

export interface Current {
  version: string;
  node: string;
  dg: string;
}

/** 起動ファイルが 1 行ずつ key=value で読める形。値の中の = はそのまま残る（read の最後の変数が行の残りを受け取る） */
export function formatCurrent(current: Current): string {
  return `version=${current.version}\nnode=${current.node}\ndg=${current.dg}\n`;
}

export function parseCurrent(text: string): Partial<Current> {
  const parsed: Partial<Current> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at);
    if (key === "version" || key === "node" || key === "dg") parsed[key] = line.slice(at + 1);
  }
  return parsed;
}

function parseVersion(v: string): number[] | undefined {
  return /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number);
}

/** major.minor.patch を比べる。読めない版は undefined */
export function compareVersions(a: string, b: string): number | undefined {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/**
 * current を書き直すか。版の新しい拡張（Insiders・Cursor などが別の版を入れているとき）が書いた current は、
 * その node と dg.mjs が残っている間は書き換えない。どちらかが消えていれば（古い版のフォルダが消された・リモートの server が
 * 更新された）、起動ファイルが動かないので版が古くても書き直す
 */
export function shouldWriteCurrent(
  existing: Partial<Current> | undefined,
  mine: Current,
  exists: (file: string) => boolean = existsSync,
): boolean {
  if (!existing?.version || !existing.node || !existing.dg) return true;
  if (!exists(existing.node) || !exists(existing.dg)) return true;
  const order = compareVersions(existing.version, mine.version);
  // 読めないのが既存の版なら書き直す。自分の版が読めない（packageJSON に version がない）ときは、
  // 生きている current の方が新しいかもしれないので残す
  if (order === undefined) return parseVersion(existing.version) === undefined;
  return order <= 0;
}

/**
 * 一時ファイルに書いてから rename で置き換える。複数のウィンドウが同時に書いても、読む側は前か後のどちらかの全体だけを見る
 * （同じディレクトリの rename は原子的）。一時ファイルの名前はプロセスと乱数で分け、書き手どうしで踏まない
 */
async function writeAtomic(file: string, content: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, content, { mode });
    await chmod(tmp, mode);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

async function readOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

export type LauncherResult = "written" | "kept" | "unsupported";

/**
 * 起動ファイルと current を書く。current を書かないとき（版の新しい拡張のものが生きている）は、起動ファイルもないときだけ書く
 * （将来の版が起動ファイルの中身を変えても、古い版が戻さないように）。
 * 古い版と新しい版のウィンドウがほぼ同時に起動すると、古い版が読んだ後に新しい版が書き、古い版がそれを上書きしうる。
 * そのときも current は壊れず起動ファイルは動き、新しい版の次の起動で直る
 */
export async function installLauncher(
  mine: Current,
  options: { dir?: string; platform?: NodeJS.Platform } = {},
): Promise<LauncherResult> {
  if ((options.platform ?? process.platform) === "win32") return "unsupported";
  // 改行を含むパスは 1 行ずつ読む current に書けない
  if (/[\n\r]/.test(mine.node + mine.dg + mine.version)) return "unsupported";
  const dir = options.dir ?? launcherDir();
  await mkdir(dir, { recursive: true });
  const launcher = path.join(dir, "dg");
  const currentFile = path.join(dir, "current");
  const existingText = await readOrUndefined(currentFile);
  const write = shouldWriteCurrent(
    existingText === undefined ? undefined : parseCurrent(existingText),
    mine,
  );
  const launcherText = await readOrUndefined(launcher);
  if (write ? launcherText !== LAUNCHER_SCRIPT : launcherText === undefined) {
    await writeAtomic(launcher, LAUNCHER_SCRIPT, 0o755);
  }
  if (!write) return "kept";
  const content = formatCurrent(mine);
  if (existingText !== content) await writeAtomic(currentFile, content, 0o644);
  return "written";
}

/**
 * 拡張の同期が git config に登録するマージドライバ（dg を呼ぶ argv の前置。SY-4、t759）。
 * 起動ファイルを書ける環境では起動ファイルを指す（拡張のフォルダは版付きで更新のたびに変わるが、起動ファイルのパスは変わらない。
 * CLI が起動ファイル経由で登録するもの（t735）と同じ行になる）。書けない環境（Windows）では、拡張ホストの node と同梱の dg.mjs を
 * 直に指す。拡張ホストの node は VS Code 本体（Electron）のことがあるので、git の sh に ELECTRON_RUN_AS_NODE=1 を付けさせる。
 * 同期のたびに登録し直すので、拡張を更新して古いフォルダが消えても次の同期で直る
 */
export function mergeDriverOf(
  mine: Current,
  options: { home?: string; platform?: NodeJS.Platform } = {},
): string[] {
  if ((options.platform ?? process.platform) !== "win32") {
    return [launcherFileOf(options.home), "merge-driver"];
  }
  return ["ELECTRON_RUN_AS_NODE=1", mine.node, mine.dg, "merge-driver"];
}

/** PATH に通す dg のリンク（~/.local/bin/dg）。「dg コマンドを入れる」が張り、「外す」と拡張の片付けが外す */
export function linkPathOf(home: string = homedir()): string {
  return path.join(home, ".local", "bin", "dg");
}

/** 起動ファイル本体のパス。linkDg と unlinkDg はこれを指すリンクだけを自分のものとみなし、始め方のボタンは絶対パスで呼ぶ */
export function launcherFileOf(home: string = homedir()): string {
  return path.join(launcherDir(home), "dg");
}

/** lstat で見る。張り先が消えた壊れたリンクも、リンクとして見つける（張り先の存在は見ない） */
async function linkStateOf(
  link: string,
): Promise<{ kind: "none" } | { kind: "link"; target: string } | { kind: "other" }> {
  try {
    const stat = await lstat(link);
    if (!stat.isSymbolicLink()) return { kind: "other" };
    return { kind: "link", target: await readlink(link) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    throw error;
  }
}

export type LinkOutcome =
  | { kind: "linked" }
  | { kind: "already" }
  /** 別の dg のリンク（target あり）か通常のファイルなど（target なし）。消さずに止める */
  | { kind: "occupied"; target?: string };

/**
 * ~/.local/bin/dg を起動ファイルへ張る。既に起動ファイルを指していれば何もしない。
 * ほかの dg（mise run dg:link が張ったリンクや通常のファイル）は上書きせず、張り先を返して止める（t668 の dg:link と同じ扱い）
 */
export async function linkDg(options: { home?: string } = {}): Promise<LinkOutcome> {
  const home = options.home ?? homedir();
  const launcher = launcherFileOf(home);
  const link = linkPathOf(home);
  const state = await linkStateOf(link);
  if (state.kind === "link" && state.target === launcher) return { kind: "already" };
  if (state.kind !== "none") {
    return state.kind === "link"
      ? { kind: "occupied", target: state.target }
      : { kind: "occupied" };
  }
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(launcher, link);
  return { kind: "linked" };
}

export type UnlinkOutcome =
  | { kind: "removed" }
  | { kind: "absent" }
  /** 起動ファイルを指さないもの。消さない */
  | { kind: "foreign"; target?: string };

/** ~/.local/bin/dg が起動ファイルを指すリンクなら外す。起動ファイル本体は残す（フックが使う） */
export async function unlinkDg(options: { home?: string } = {}): Promise<UnlinkOutcome> {
  const home = options.home ?? homedir();
  const link = linkPathOf(home);
  const state = await linkStateOf(link);
  if (state.kind === "none") return { kind: "absent" };
  if (state.kind === "link" && state.target === launcherFileOf(home)) {
    await rm(link);
    return { kind: "removed" };
  }
  return state.kind === "link" ? { kind: "foreign", target: state.target } : { kind: "foreign" };
}

/**
 * 同じファイルか。実パス（シンボリックリンクを解いたもの）で比べる。拡張のフォルダがシンボリックリンクのとき、
 * node（uninstall.ts の import.meta.url）は解いたパスを、VS Code（current を書く側）は解いていないパスを使うため。
 * どちらかが消えていれば（古い版のフォルダが消された）絶対パスで比べる
 */
async function isSameFile(a: string, b: string): Promise<boolean> {
  const [realA, realB] = await Promise.all([
    realpath(a).catch(() => path.resolve(a)),
    realpath(b).catch(() => path.resolve(b)),
  ]);
  return realA === realB;
}

/**
 * 拡張を消したときの片付け（vscode:uninstall の uninstall.ts が呼ぶ）。current がこの拡張の dg.mjs を指すときだけ、
 * 起動ファイル・current・起動ファイルを指すリンクを消す。版の新しい拡張やほかのエディタの拡張が使っているものは消さない。
 * 消したら true
 */
export async function removeLauncherOf(
  dgFile: string,
  options: { home?: string } = {},
): Promise<boolean> {
  const home = options.home ?? homedir();
  const dir = launcherDir(home);
  const currentFile = path.join(dir, "current");
  const text = await readOrUndefined(currentFile);
  if (text === undefined) return false;
  const current = parseCurrent(text);
  if (!current.dg || !(await isSameFile(current.dg, dgFile))) return false;
  await unlinkDg({ home });
  await rm(launcherFileOf(home), { force: true });
  await rm(currentFile, { force: true });
  return true;
}

/** PATH（の文字列）に dir があるか。末尾の / などの違いはパスとして比べる */
export function onPath(dir: string, pathEnv: string | undefined = process.env.PATH): boolean {
  return (pathEnv ?? "")
    .split(path.delimiter)
    .some((entry) => entry !== "" && path.resolve(entry) === path.resolve(dir));
}
