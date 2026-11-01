// core の commands を commander の木に写す。ロジックはここに書かない（CL-6）

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GROUP_ALIASES,
  commands as allCommands,
  openContext,
  runCommand,
  type ActorInfo,
  type AnyCommand,
  type CommandResult,
} from "@deguboard/core";
import { Argument, Command } from "commander";
import { parse as parseYaml } from "yaml";
import { toErrorView } from "./errors.js";
import { GUIDE_TOPICS, renderGuide } from "./guide.js";
import { addServeCommands } from "./serve.js";
import { bindInputs, collectInput, shapesOf } from "./options.js";
import {
  exitCodeOf,
  printError,
  printHuman,
  printJsonError,
  printJsonResult,
  type Streams,
} from "./output.js";

/** 同梱した web のビルド結果（packages/cli/web。build が packages/web/dist から写し、npm のパッケージにも入る）。なければ undefined */
function webDist(): string | undefined {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
  return existsSync(resolve(dir, "index.html")) ? dir : undefined;
}

export interface ProgramOptions {
  /** web のビルド結果。省略時は packages/web/dist（なければ API だけ） */
  staticDir?: string | undefined;
  streams?: Streams;
  /** -C の既定 */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  commands?: readonly AnyCommand[];
}

const GROUP_SUMMARY: Record<string, string> = {
  project: "Project（チケットを束ねる単位）の操作",
  ticket: "チケットの操作",
  iteration: "Iteration（期間の計画）の操作。sprint はエイリアス",
  epic: "Epic（目的ごとの束ね）の操作",
  plan: "Plan（チケットを進める順と承認）の操作",
  workflow: "Workflow 定義の参照と検証",
  config: "config.yaml の参照と変更",
};

function version(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

export function buildProgram(options: ProgramOptions = {}): Command {
  const streams: Streams = options.streams ?? {
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
  };
  const env = options.env ?? process.env;
  const program = new Command("dg");
  program
    .description("Git-native な AI ワークフロー・チケット管理。データは deguboard ブランチに置く")
    .version(version(), "-v, --version", "版を出す")
    .helpOption("-h, --help", "使い方を出す")
    .option("--json", "結果を JSON で出す（エージェント向け）")
    .option("-C <dir>", "このディレクトリのリポジトリに対して実行する")
    .option(
      "--actor <kind>",
      "操作の主体（human / agent）。既定は環境変数 DEGUBOARD_ACTOR か human",
    )
    .option(
      "--user <name>",
      "主体のユーザ名。既定は環境変数 DEGUBOARD_USER か git の user.name。記録される ID は <ユーザ>（human）か <ユーザ>/agent（agent）",
    )
    .helpCommand("help [command]", "コマンドの使い方を出す")
    .configureOutput({
      writeOut: (s) => streams.out(s.trimEnd()),
      writeErr: (s) => streams.err(s.trimEnd()),
      outputError: (s, write) => write(`エラー: ${s.replace(/^error: /, "")}`),
    })
    .exitOverride()
    .showHelpAfterError("（--help で使い方を見る）");

  const groups = new Map<string, Command>();
  const groupFor = (name: string): Command => {
    let g = groups.get(name);
    if (!g) {
      g = program.command(name).description(GROUP_SUMMARY[name] ?? name);
      g.helpCommand("help [command]", "コマンドの使い方を出す")
        .exitOverride()
        .configureOutput(program.configureOutput());
      for (const [alias, target] of Object.entries(GROUP_ALIASES))
        if (target === name) g.alias(alias);
      groups.set(name, g);
    }
    return g;
  };

  // guide は core のコマンドではなく CLI の責務（手順の正本は CLI に同梱する。CL-5）
  program
    .command("guide")
    .description("エージェント向けの手順を出す。トピックを省くと overview")
    .addArgument(
      new Argument("[topic]", `トピック（${GUIDE_TOPICS.join(" / ")}）`).default("overview"),
    )
    .action(async (topic: string) => {
      const global = program.opts<{ json?: boolean; C?: string }>();
      const cwd = resolve(options.cwd ?? process.cwd(), global.C ?? ".");
      try {
        const guide = await renderGuide(topic, cwd);
        if (global.json)
          streams.out(
            JSON.stringify({ ok: true, data: guide, warnings: [], write: null }, null, 2),
          );
        else streams.out(guide.text);
        process.exitCode = 0;
      } catch (error) {
        const view = toErrorView(error);
        if (global.json) printJsonError(streams, view);
        else printError(streams, view);
        process.exitCode = view.exitCode;
      }
    });

  addServeCommands(program, {
    streams,
    resolveCwd: (c) => resolve(options.cwd ?? process.cwd(), c ?? "."),
    staticDir: options.staticDir ?? webDist(),
  });

  for (const def of options.commands ?? allCommands) {
    const [group, op] = def.name.split(".") as [string, string | undefined];
    const parent = op === undefined ? program : groupFor(group);
    const cmd = parent.command(op ?? group).description(def.summary);
    cmd.exitOverride().configureOutput(program.configureOutput());
    const shapes = shapesOf(def);
    const bound = bindInputs(cmd, def, shapes);
    const fileField = shapes.find((s) => s.kind === "objects");
    if (fileField)
      cmd.addArgument(
        new Argument("<file>", `${fileField.description}（YAML か JSON のファイル。- で標準入力）`),
      );

    cmd.action(async (...args: unknown[]) => {
      // commander は (位置引数..., options, command) の順で渡す
      const command = args[args.length - 1] as Command;
      const opts = args[args.length - 2] as Record<string, unknown>;
      const positionals = args.slice(0, -2);
      const global = program.opts<{
        json?: boolean;
        C?: string;
        actor?: string;
        user?: string;
      }>();
      const cwd = resolve(options.cwd ?? process.cwd(), global.C ?? ".");
      const input = collectInput(bound, positionals, opts);
      if (fileField) {
        const file = positionals[bound.positionals.length] as string;
        input[fileField.key] = await readDrafts(file, cwd);
      }
      const actorKind = (global.actor ?? env["DEGUBOARD_ACTOR"] ?? "human") as ActorInfo["kind"];
      if (actorKind !== "human" && actorKind !== "agent") {
        command.error("--actor は human か agent", { exitCode: 2 });
      }
      const user = global.user ?? env["DEGUBOARD_USER"];
      const actor = { kind: actorKind, ...(user ? { user } : {}) };
      const initialize =
        def.needs === "repo" ? { remote: input["remote"] as string | undefined } : undefined;

      let result: CommandResult<unknown>;
      try {
        const ctx = await openContext({ cwd, actor, initialize });
        result = await runCommand(def, ctx, input);
      } catch (error) {
        const view = toErrorView(error);
        if (global.json) printJsonError(streams, view);
        else printError(streams, view);
        process.exitCode = view.exitCode;
        return;
      }
      if (global.json) printJsonResult(streams, result);
      else printHuman(streams, def.name, result);
      process.exitCode = exitCodeOf(result);
    });
  }
  return program;
}

async function readDrafts(file: string, cwd: string): Promise<unknown> {
  const text = file === "-" ? await readStdin() : await readFile(resolve(cwd, file), "utf8");
  const parsed: unknown = parseYaml(text);
  // 配列でも { drafts: [...] } でも受ける
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "drafts" in parsed) {
    return (parsed as { drafts: unknown }).drafts;
  }
  return parsed;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** argv を実行して終了コードを返す。テストからも呼ぶ */
export async function run(argv: readonly string[], options: ProgramOptions = {}): Promise<number> {
  const program = buildProgram(options);
  process.exitCode = 0;
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    const view = toErrorView(error);
    // --help / --version は exitCode 0 の CommanderError。それ以外の commander のエラーは引数の誤りなので 2
    if (view.code.startsWith("commander.")) return view.exitCode === 0 ? 0 : 2;
    const streams = options.streams;
    if (streams) streams.err(`エラー: ${view.message}`);
    else process.stderr.write(`エラー: ${view.message}\n`);
    return view.exitCode;
  }
  return Number(process.exitCode ?? 0);
}
