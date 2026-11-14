// プロセス内の CommandClient。入口（server・vscode）はこれを HTTP や postMessage に写すだけで、文脈の管理を持たない（ADR-033）。
//   - 文脈は最初の呼び出しで開き、以後は他のプロセス（CLI）の変更を取り込むために再走査する（Store.rescan は変わったファイルだけを読み直す）。
//     config のリモートの名前とデータのブランチ名（git.remote・git.data_remote・git.data_branch）が変わったときだけ、文脈を開き直す。
//     読み（書かないコマンドと status）は、届いた後に始まった再走査が成功して終わっていればその結果を使い回す。同じ瞬間に届いた読みは 1 回の走査に乗る。
//     なぜ届いた後の走査だけか: 届く前に始まった走査は、要求の前に終わった変更を読み漏らしているかもしれない。「他のプロセスの変更は、
//     要求が届く前に終わったものなら見える」という約束を保つために、それより前の走査は使わない。書き込みは毎回自分で再走査し、
//     終わったら使い回しを無効にする（後に続く読みは新しく走査する）。経過（history）は HEAD が同じあいだ解析結果を使い回す
//   - 呼び出しは 1 つずつ順に処理する（同じプロセスの中で Store の再走査と書き込みが重ならないように）
//   - 主体は既定で人（画面からの操作。AG-1）。MCP は agent を渡す。init（needs: repo）は出さない

import { DeguboardError, OperationError } from "../errors.js";
import { createHistoryCache } from "../git/history.js";
import { remoteWebUrl } from "../git/repo.js";
import { withLock } from "../git/lock.js";
import { fetchData, syncStatus } from "../git/sync.js";
import type { CommandClient, CommandFailure, StatusView } from "./client.js";
import { openContext } from "./context.js";
import type { ActorKind, UserSource } from "../model/actor.js";
import { dataRemoteNameOf, type Config } from "../model/config.js";
import type { AnyCommand, CommandContext, CommandResult } from "./define.js";
import { commands as allCommands, findCommand } from "./registry.js";
import { runCommand } from "./define.js";

export interface LocalClientOptions {
  /** 対象のリポジトリ */
  cwd: string;
  /** 主体のユーザ名。省略時は git config の deguboard.user、git の user.name、OS のユーザ名の順 */
  user?: string | undefined;
  /** user の出どころ（flag か env）。省けば flag */
  userSource?: UserSource | undefined;
  /** 主体の種別。既定は human（画面）。dg mcp は agent */
  actor?: ActorKind | undefined;
  commands?: readonly AnyCommand[] | undefined;
  /** マージドライバとして登録する、dg を呼ぶ argv の前置（dg serve・dg mcp・VS Code 拡張が渡す） */
  mergeDriver?: readonly string[] | undefined;
  /** Workflow の steps に書ける Action の名前（ContextOptions.actions） */
  actions?: readonly string[] | undefined;
  /** status がリモートを fetch する間隔（既定は STATUS_FETCH_INTERVAL_MS。テストで縮める） */
  statusFetchIntervalMs?: number | undefined;
}

/** 画面は 15 秒ごとに status を読む。そのたびに fetch するとリモートへの負荷が大きいので、間を空ける（UI-6） */
export const STATUS_FETCH_INTERVAL_MS = 60_000;
/**
 * status の後ろの fetch の時間の上限。書き込みのロックを持って fetch するので、ほかの dg の書き込みがロックを待つ上限（lock.ts の WAIT_MS）より短くする
 */
const STATUS_FETCH_TIMEOUT_MS = 8_000;

export interface LocalClient extends CommandClient {
  /** 入口が出すコマンド（store の要るものだけ） */
  readonly commands: readonly AnyCommand[];
}

export function createLocalClient(options: LocalClientOptions): LocalClient {
  const commands = (options.commands ?? allCommands).filter((c) => c.needs === "store");
  const actor = {
    kind: options.actor ?? "human",
    ...(options.user ? { user: options.user, userSource: options.userSource ?? "flag" } : {}),
  };
  let ctxPromise: Promise<CommandContext> | undefined;
  // 文脈を開いたときの config のリモートの名前とデータのブランチ名（remoteNamesOf）。変わったら context が開き直す
  let openedRemotes: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  // 経過の解析結果は deguboard ブランチの HEAD が同じあいだ使い回す（画面は詳細を開くたびに history を呼ぶ）
  const readHistory = createHistoryCache();
  // 再走査の共有。scanGen は始めた走査の番号（始めるたびに増やす）、scanned は最後に成功して終わった走査の番号（0 は無効）。
  // 失敗した走査は scanned に記録しない。書き込みは終わったあと scanned を 0 にする
  let scanGen = 0;
  let scanned = 0;
  // 届いて順番を待っている呼び出しの数。0 のときに届いた読みは、同じ瞬間の残りの読みを同じ走査に乗せるため setImmediate を 1 回待つ
  let pending = 0;
  // status の後ろで最後に fetch を始めた時刻（失敗しても次の間隔まで試さない）
  const fetchInterval = options.statusFetchIntervalMs ?? STATUS_FETCH_INTERVAL_MS;
  let lastFetch: number | undefined;

  /** arrivedAt が undefined（書き込み）なら必ず再走査する。読みは届いた後に始まった走査が成功していればそれを使う */
  const context = async (arrivedAt: number | undefined): Promise<CommandContext> => {
    try {
      for (;;) {
        ctxPromise ??= openContext({
          cwd: options.cwd,
          actor,
          mergeDriver: options.mergeDriver,
          actions: options.actions,
        }).then((opened) => {
          openedRemotes = remoteNamesOf(opened.store.config);
          return opened;
        });
        const ctx = await ctxPromise;
        ctx.readHistory = readHistory;
        if (arrivedAt === undefined || scanned <= arrivedAt) {
          const id = ++scanGen;
          await ctx.store.rescan();
          scanned = id;
        }
        // リモート（repo.codeRemote・repo.dataRemote・repo.dataBranch）は文脈を開いたときの config で決める。その後に config のリモートの名前かデータのブランチ名が
        // 変わっていたら（このプロセスの config set・unset（--local を含む）、ほかのプロセスの書き込み、取り込み）、開き直して
        // 新しいリモートを使う。開き直さないと、設定を変えた後の書き込みと sync が元のリモートへ送り続ける
        if (remoteNamesOf(ctx.store.config) === openedRemotes) {
          ctx.config = ctx.store.config;
          return ctx;
        }
        ctxPromise = undefined;
        scanned = 0;
      }
    } catch (error) {
      ctxPromise = undefined;
      throw error;
    }
  };

  /**
   * 順番に実行する。読みは届いたとき（この呼び出しの中、同期的に）の走査の番号を持ち、順番が来たときに context が使う。
   * 列が空だった読みは、setImmediate を 1 回待ってから走査を始める（同じ瞬間に届く残りの読みを同じ走査に乗せるため）
   */
  const serialized = <T>(
    read: boolean,
    fn: (arrivedAt: number | undefined) => Promise<T>,
  ): Promise<T> => {
    const arrivedAt = read ? scanGen : undefined;
    const idle = pending === 0;
    pending++;
    const start = async () => {
      if (read && idle) await new Promise<void>((resolve) => setImmediate(resolve));
      return fn(arrivedAt);
    };
    const next = queue.then(start, start);
    const done = () => {
      pending--;
    };
    next.then(done, done);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    commands,
    run<O>(name: string, input: unknown = {}): Promise<CommandResult<O>> {
      const def = findCommand(name, commands);
      if (!def)
        return Promise.reject(new OperationError("UNKNOWN_COMMAND", `There is no command ${name}`));
      return serialized(!def.write, async (arrivedAt) => {
        try {
          return (await runCommand(def, await context(arrivedAt), input)) as CommandResult<O>;
        } catch (error) {
          // 名指ししたデータのリモートがクローンにない：人が git remote add で足しても config は変わらないので、次の呼び出しで
          // 開き直してリモートを解決し直す（取り込んだ config でリモートが変わったとき（DATA_REMOTE_CHANGED）は、context が名前の違いで開き直す）
          if (error instanceof OperationError && error.code === "DATA_REMOTE_MISSING")
            ctxPromise = undefined;
          throw error;
        } finally {
          // 成否に関わらず、後に続く読みは新しく走査する
          if (def.write) scanned = 0;
        }
      });
    },
    status(): Promise<StatusView> {
      // store からは Issue の件数だけを使う（同期の状態は git から毎回読む）ので、読みとして走査を使い回してよい
      const view = serialized(true, async (arrivedAt) => {
        const ctx = await context(arrivedAt);
        const status = await syncStatus(ctx.repo);
        return {
          ...status,
          issues: ctx.store.issues.length,
          data_dir: ctx.repo.dataDir,
          web_url: await remoteWebUrl(ctx.repo),
        };
      });
      // 未取り込みの数は fetch しないと増えない（ほかの clone の push が見えない）。間を空けて、この status の後ろで fetch する。
      // 結果はこの status ではなく次の status に出る（画面は 15 秒ごとに読む）。状態の表示を fetch で待たせないため
      const now = Date.now();
      if (lastFetch === undefined || now - lastFetch >= fetchInterval) {
        lastFetch = now;
        void serialized(false, backgroundFetch).catch(() => undefined);
      }
      return view;
    },
  };

  /**
   * status の後ろの fetch。失敗（届かない・時間切れ・ロックを取れない）は捨てる（状態の表示を止めない。次の間隔でまた試す）。
   * 同じマシンの dg（CLI）の書き込みも fetch するので、書き込みのロックを待たずに取れたときだけ fetch する
   * （同じ追跡ブランチの ref を同時に書くと片方の fetch が失敗する。取れないのはほかの dg が書き込み中で、その書き込みが fetch する）
   */
  async function backgroundFetch(): Promise<void> {
    const ctx = await ctxPromise;
    if (!ctx?.repo.dataRemote) return;
    const repo = ctx.repo;
    await withLock(repo.localDir, "write", () => fetchData(repo, STATUS_FETCH_TIMEOUT_MS), {
      waitMs: 0,
    });
  }
}

/** config が決めるコードのリモートとデータのリモートの名前とデータのブランチ名（比べるための 1 つの文字列。改行はリモートとブランチの名前に入らない） */
function remoteNamesOf(config: Config): string {
  return `${config.git.remote}\n${dataRemoteNameOf(config)}\n${config.git.data_branch}`;
}

/** 入口が失敗を data として返すための形（CLI の --json のエラーと同じ） */
export function toCommandFailure(error: unknown): CommandFailure {
  if (error instanceof DeguboardError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
    };
  }
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}
