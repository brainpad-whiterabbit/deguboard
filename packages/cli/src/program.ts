// core の commands を commander の木に写す。ロジックはここに書かない（CL-6）

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  GROUP_ALIASES,
  commands as allCommands,
  openContext,
  ACTION_NAMES,
  runCommand,
  runMergeDriver,
  UsageError,
  type ActorInfo,
  type AnyCommand,
  type CommandResult,
} from "@deguboard/core";
import { Argument, Command } from "commander";
import { parse as parseYaml } from "yaml";
import { toErrorView, type ErrorView } from "./errors.js";
import { GUIDE_TOPICS, renderGuide } from "./guide.js";
import { serveMcp } from "./mcp.js";
import { installSkill, skillInstallWarnings } from "./skill.js";
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

/**
 * git がマージドライバとして呼ぶ dg のコマンド（argv の前置）。PATH に dg がなくても（npx・mise run・node_modules/.bin）動くよう、
 * いま動いている node と、このパッケージの bin/dg.js を絶対パスで指す。init と sync のたびに登録し直すので、
 * npx のキャッシュや worktree が消えてパスが古くなっても次の sync で直る
 */
export function selfMergeDriver(): string[] {
  return [
    process.execPath,
    fileURLToPath(new URL("../bin/dg.js", import.meta.url)),
    "merge-driver",
  ];
}

export interface ProgramOptions {
  /** web のビルド結果。省略時は packages/web/dist（なければ API だけ） */
  staticDir?: string | undefined;
  streams?: Streams;
  /** -C の既定 */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  commands?: readonly AnyCommand[];
  /** dg mcp の標準入出力。既定は process.stdin / process.stdout（テスト用） */
  stdio?: { stdin: Readable; stdout: Writable } | undefined;
  /** マージドライバとして登録するコマンド。省略時は selfMergeDriver() */
  mergeDriver?: readonly string[];
}

const GROUP_SUMMARY: Record<string, string> = {
  project: "Project（チケットを束ねる単位）の操作",
  ticket: "チケットの操作",
  iteration: "Iteration（期間の計画）の操作。sprint はエイリアス",
  epic: "Epic（目的ごとの束ね）の操作",
  plan: "Plan（チケットを進める順と承認）の操作",
  workflow: "Workflow 定義の参照・検証・書き換え",
  metrics: "Run（作業の実績）の集計",
  run: "Run（1 回の AI 実行）の記録",
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
  const streams: Streams = options.streams ?? defaultStreams();
  const env = options.env ?? process.env;
  const program = new Command("dg");
  const jsonMode = (): boolean => program.opts<{ json?: boolean }>().json === true;
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
      // commander が writeErr に書くのは引数の誤りの案内と使い方だけ。--json のときは run() が JSON で stdout に出すので書かない
      writeErr: (s) => {
        if (!jsonMode()) streams.err(s.trimEnd());
      },
      outputError: (s, write) => {
        if (!jsonMode()) write(`エラー: ${s.replace(/^error: /, "")}`);
      },
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

  // skill も CLI の責務。Skill は guide を読ませるだけで手順を持たない（AG-2）
  program
    .command("skill")
    .description("Claude Code の Skill の操作")
    .helpCommand("help [command]", "コマンドの使い方を出す")
    .exitOverride()
    .configureOutput(program.configureOutput())
    .command("install")
    .description(
      "段階ごとに dg guide を読む Claude Code の Skill（dgimport・dgplan・dgwork など）を <リポジトリ>/.claude/skills/ に書く。手を加えていない Skill は最新にし、廃止した deguboard Skill は消す",
    )
    .option(
      "--personal",
      "リポジトリではなく ~/.claude/skills に書く（Claude Code の個人の Skill。どのリポジトリでも使う）",
    )
    .option("--force", "手を加えた SKILL.md も上書きする")
    .exitOverride()
    .configureOutput(program.configureOutput())
    .action(async (opts: { personal?: boolean; force?: boolean }) => {
      const global = program.opts<{ json?: boolean; C?: string }>();
      try {
        const result = await installSkill({
          cwd: resolve(options.cwd ?? process.cwd(), global.C ?? "."),
          scope: opts.personal ? "personal" : "project",
          home: env["HOME"] ?? homedir(),
          force: opts.force ?? false,
        });
        const warnings = skillInstallWarnings(result);
        if (global.json)
          streams.out(JSON.stringify({ ok: true, data: result, warnings, write: null }, null, 2));
        else {
          const lines = [
            ["書いた", result.written],
            ["更新した", result.updated],
            ["最新だった", result.unchanged],
            ["廃止して消した", result.retired],
          ] as const;
          streams.out(`Skill の置き場所：${result.dir}`);
          for (const [label, names] of lines)
            if (names.length > 0) streams.out(`${label}：${names.join(", ")}`);
          for (const w of warnings) streams.err(`警告: ${w}`);
        }
        process.exitCode = 0;
      } catch (error) {
        const view = toErrorView(error);
        if (global.json) printJsonError(streams, view);
        else printError(streams, view);
        process.exitCode = view.exitCode;
      }
    });

  // git が rebase の中から呼ぶマージドライバ（SY-4）。利用者が打つものではないのでヘルプに出さない。
  // 文脈（ロック・Store）を開かない：sync がロックを持ったまま rebase するので、開くと待ち合う
  program
    .command("merge-driver", { hidden: true })
    .description("deguboard ブランチのマージドライバ（git が %O %A %B %P で呼ぶ）")
    .argument("<base>")
    .argument("<ours>")
    .argument("<theirs>")
    .argument("[path]")
    .action(async (...args: unknown[]) => {
      const files = args.slice(0, 4).filter((a): a is string => typeof a === "string");
      process.exitCode = await runMergeDriver(files, (line) => streams.err(line));
    });

  const mergeDriver = options.mergeDriver ?? selfMergeDriver();

  addServeCommands(program, {
    mergeDriver,
    streams,
    resolveCwd: (c) => resolve(options.cwd ?? process.cwd(), c ?? "."),
    staticDir: options.staticDir ?? webDist(),
  });

  // mcp も CLI の責務。ツールは core の commands から生成し、主体は常に agent（AG-4）
  program
    .command("mcp")
    .description(
      "MCP サーバーを stdio で起動する（主体は <ユーザ>/agent）。ツールは dg のコマンドと 1 対 1 で、名前は ticket_create の形",
    )
    .action(async () => {
      const global = program.opts<{ C?: string; user?: string }>();
      try {
        await serveMcp({
          cwd: resolve(options.cwd ?? process.cwd(), global.C ?? "."),
          user: global.user ?? env["DEGUBOARD_USER"],
          version: version(),
          commands: options.commands,
          mergeDriver,
          stdin: options.stdio?.stdin,
          stdout: options.stdio?.stdout,
        });
      } catch (error) {
        // 標準出力は MCP の通信路なので、起動の失敗は標準エラーに出す
        printError(streams, toErrorView(error));
        process.exitCode = 1;
      }
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
        // ファイルから読む値（workflow set の --file）。パスを中身に置き換える
        for (const shape of bound.options) {
          const file = input[shape.key];
          if (shape.kind === "file" && typeof file === "string")
            input[shape.key] = await readYamlFile(file, cwd);
        }
        const ctx = await openContext({
          cwd,
          actor,
          initialize,
          mergeDriver,
          actions: ACTION_NAMES,
        });
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

/** YAML か JSON のファイル（- で標準入力）を読む。読めなければ使い方の誤り */
async function readYamlFile(file: string, cwd: string): Promise<unknown> {
  let text: string;
  try {
    text = file === "-" ? await readStdin() : await readFile(resolve(cwd, file), "utf8");
  } catch (error) {
    throw new UsageError(`${file} を読めない`, String(error));
  }
  try {
    return parseYaml(text);
  } catch (error) {
    throw new UsageError(`${file} を YAML として読めない`, String(error));
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function defaultStreams(): Streams {
  return {
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
  };
}

/**
 * commander のエラーの文言から接頭辞を除く。commander.help（`dg ticket` のようにコマンドを省いたときと、
 * `dg help nosuch` のように help に知らないコマンドを渡したとき）は文言がないので、どちらにも合う文言を補う
 */
function commanderMessage(view: ErrorView): string {
  if (view.code === "commander.help")
    return "コマンドが足りないか、知らないコマンドを指定した（--help で使い方を見る）";
  return view.message.replace(/^error: /, "");
}

/** argv を実行して終了コードを返す。テストからも呼ぶ */
export async function run(argv: readonly string[], options: ProgramOptions = {}): Promise<number> {
  const program = buildProgram(options);
  process.exitCode = 0;
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    const view = toErrorView(error);
    const streams = options.streams;
    // --help / --version は exitCode 0 の CommanderError。それ以外の commander のエラーは引数の誤りなので 2
    if (view.code.startsWith("commander.")) {
      if (view.exitCode === 0) return 0;
      if (program.opts<{ json?: boolean }>().json === true)
        printJsonError(streams ?? defaultStreams(), {
          code: "INVALID_INPUT",
          message: commanderMessage(view),
          exitCode: 2,
        });
      return 2;
    }
    // アクションの外で投げた commander 以外の例外（--port の値の検査など）も --json なら JSON で返す
    if (program.opts<{ json?: boolean }>().json === true) {
      printJsonError(streams ?? defaultStreams(), view);
      return view.exitCode;
    }
    if (streams) streams.err(`エラー: ${view.message}`);
    else process.stderr.write(`エラー: ${view.message}\n`);
    return view.exitCode;
  }
  return Number(process.exitCode ?? 0);
}
