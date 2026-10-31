// プロセス内の CommandClient。入口（server・vscode）はこれを HTTP や postMessage に写すだけで、文脈の管理を持たない（ADR-007）。
//   - 文脈は最初の呼び出しで開き、以後は呼び出しごとに再走査して他のプロセス（CLI）の変更を取り込む
//   - 呼び出しは 1 つずつ順に処理する（同じプロセスの中で Store の再走査と書き込みが重ならないように）
//   - 画面からの操作は常に人（ADR-006）。init（needs: repo）は出さない

import { DeguboardError, OperationError } from "../errors.js";
import { syncStatus } from "../git/sync.js";
import type { CommandClient, CommandFailure, StatusView } from "./client.js";
import { openContext } from "./context.js";
import type { AnyCommand, CommandContext, CommandResult } from "./define.js";
import { commands as allCommands, findCommand } from "./registry.js";
import { runCommand } from "./define.js";

export interface LocalClientOptions {
  /** 対象のリポジトリ */
  cwd: string;
  /** 主体のユーザ名。省略時は git の user.name */
  user?: string | undefined;
  commands?: readonly AnyCommand[] | undefined;
}

export interface LocalClient extends CommandClient {
  /** 入口が出すコマンド（store の要るものだけ） */
  readonly commands: readonly AnyCommand[];
}

export function createLocalClient(options: LocalClientOptions): LocalClient {
  const commands = (options.commands ?? allCommands).filter((c) => c.needs === "store");
  const actor = { kind: "human" as const, ...(options.user ? { user: options.user } : {}) };
  let ctxPromise: Promise<CommandContext> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const context = async (): Promise<CommandContext> => {
    ctxPromise ??= openContext({ cwd: options.cwd, actor });
    try {
      const ctx = await ctxPromise;
      await ctx.store.rescan();
      ctx.config = ctx.store.config;
      return ctx;
    } catch (error) {
      ctxPromise = undefined;
      throw error;
    }
  };

  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    commands,
    run<O>(name: string, input: unknown = {}): Promise<CommandResult<O>> {
      const def = findCommand(name);
      if (!def || !commands.includes(def))
        return Promise.reject(new OperationError("UNKNOWN_COMMAND", `コマンド ${name} はない`));
      return serialized(
        async () => (await runCommand(def, await context(), input)) as CommandResult<O>,
      );
    },
    status(): Promise<StatusView> {
      return serialized(async () => {
        const ctx = await context();
        const status = await syncStatus(ctx.repo);
        return { ...status, issues: ctx.store.issues.length, data_dir: ctx.repo.dataDir };
      });
    },
  };
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
