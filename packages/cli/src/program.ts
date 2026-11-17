// core の commands を commander の木に写す。ロジックはここに書かない（CL-6）

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  GROUP_ALIASES,
  commands as allCommands,
  openContextFor,
  pickUser,
  bundleLayout,
  checkHooks,
  checkSetup,
  hookScope,
  installHooks,
  installSkill,
  runCommand,
  runMergeDriver,
  skillInstallWarnings,
  skillUninstallWarnings,
  uninstall,
  uninstallHooks,
  uninstallSkill,
  UsageError,
  type ActorInfo,
  type AnyCommand,
  type CommandResult,
  type HandlerStatus,
} from "@deguboard/core";
import { Argument, Command } from "commander";
import { parse as parseYaml } from "yaml";
import { toErrorView, type ErrorView } from "./errors.js";
import { GUIDE_TOPICS, renderGuide } from "./guide.js";
import { selfCommand, selfMergeDriver } from "./hooks.js";
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

/**
 * 同梱した web のビルド結果（packages/cli/web。build が packages/web/dist から写す）。なければ undefined。
 * VS Code 拡張に同梱した dg.mjs（dist/cli/）では、同じ相対の dist/web が拡張の Webview と共有する画面になる
 */
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
  /** dg mcp の標準入出力。既定は process.stdin / process.stdout（テスト用） */
  stdio?: { stdin: Readable; stdout: Writable } | undefined;
  /** マージドライバとして登録するコマンド。省略時は selfMergeDriver() */
  mergeDriver?: readonly string[];
  /** 先に読んだ標準入力の全体（bin/dg.js の速い経路が受け持たなかったとき。t768）。あれば - はこれを読む */
  stdinText?: string | undefined;
}

const GROUP_SUMMARY: Record<string, string> = {
  ticket: "Operations on tickets",
  iteration: "Operations on Iterations (time-boxed plans). sprint is an alias",
  epic: "Operations on Epics (groupings by purpose)",
  plan: "Operations on Plans (the order to advance tickets, and approval)",
  workflow: "Look up, validate, and rewrite Workflow definitions",
  metrics:
    "Aggregate Runs (records of actual work), and read the per-ticket data behind retrospective metrics",
  retro:
    "Perspectives of the retrospective and their approved metric definitions (the team's config.yaml)",
  run: "Record Runs (one AI execution each)",
  pr: "Advance a PR only when it meets the quality gate (dg gate)",
  flow: "Iteration flow stages and the next step",
  config: "Look up and change settings (the team's config.yaml and personal overrides)",
};

/**
 * dg の版。束ねた dg.mjs には package.json がないので、束ねたときに埋めた版を使う。
 * coreVersion は core の package.json を非同期で読むが、buildProgram は同期で CLI の版を要るため、
 * clone した配置では CLI 自身の package.json を同期で読む。core と CLI は版を揃えてリリースする。
 */
function version(): string {
  const bundled = bundleLayout()?.version;
  if (bundled !== undefined) return bundled;
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
    .description(
      "An agentic kanban inspired by Agentic-Agile, with the development flow built in. Data lives on the data branch (deguboard by default)",
    )
    .version(version(), "-v, --version", "Print the version")
    .helpOption("-h, --help", "Show usage")
    .option("--json", "Print the result as JSON (for agents)")
    .option("-C <dir>", "Run against the repository in this directory")
    .option(
      "--actor <kind>",
      "Actor kind (human / agent). Defaults to the DEGUBOARD_ACTOR environment variable, else human",
    )
    .option(
      "--user <name>",
      "Actor user name. Defaults, in order, to the DEGUBOARD_USER environment variable, git config deguboard.user, git user.name, then the OS user name. The recorded ID is <user> (human) or <user>/agent (agent)",
    )
    .helpCommand("help [command]", "Show usage for a command")
    .configureOutput({
      writeOut: (s) => streams.out(s.trimEnd()),
      // commander が writeErr に書くのは引数の誤りの案内と使い方だけ。--json のときは run() が JSON で stdout に出すので書かない
      writeErr: (s) => {
        if (!jsonMode()) streams.err(s.trimEnd());
      },
      outputError: (s, write) => {
        if (!jsonMode()) write(`Error: ${s.replace(/^error: /, "")}`);
      },
    })
    .exitOverride()
    .showHelpAfterError("(See usage with --help)");

  const groups = new Map<string, Command>();
  const groupFor = (name: string): Command => {
    let g = groups.get(name);
    if (!g) {
      g = program.command(name).description(GROUP_SUMMARY[name] ?? name);
      g.helpCommand("help [command]", "Show usage for a command")
        .exitOverride()
        .configureOutput(program.configureOutput());
      for (const [alias, target] of Object.entries(GROUP_ALIASES))
        if (target === name) g.alias(alias);
      groups.set(name, g);
    }
    return g;
  };

  // guide は core のコマンドではなく CLI の責務（本文と読み込みは Core が持ち、ここは写す。CL-5）
  program
    .command("guide")
    .description(
      "Print the steps for agents. Omit the topic to print overview. --section prints only the body of a section",
    )
    .addArgument(new Argument("[topic]", `Topic (${GUIDE_TOPICS.join(" / ")})`).default("overview"))
    .option(
      "--section <name>",
      "A section heading, or the heading's name without the parenthesized part. Prints only that section's body (a section that does not exist fails as a usage error, listing the sections). Given more than once, prints the sections joined in the order given",
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .action(async (topic: string, opts: { section?: string[] }) => {
      const global = program.opts<{ json?: boolean; C?: string }>();
      const cwd = resolve(options.cwd ?? process.cwd(), global.C ?? ".");
      try {
        const { warnings, ...guide } = await renderGuide(topic, cwd, opts.section);
        if (global.json)
          streams.out(JSON.stringify({ ok: true, data: guide, warnings, write: null }, null, 2));
        else {
          for (const w of warnings) streams.err(`Warning: ${w}`);
          streams.out(guide.text);
        }
        process.exitCode = 0;
      } catch (error) {
        const view = toErrorView(error);
        if (global.json) printJsonError(streams, view);
        else printError(streams, view);
        process.exitCode = view.exitCode;
      }
    });

  // skill も CLI だけの操作（AG-4）。Skill は guide を読ませるだけで手順を持たない（AG-2）。
  // 判定と書き込みと警告の組み立ては core の commands/skill-files.ts にあり、ここは引数と結果を写す
  const skillCmd = program
    .command("skill")
    .description("Operations on Claude Code Skills")
    .helpCommand("help [command]", "Show usage for a command")
    .exitOverride()
    .configureOutput(program.configureOutput());
  skillCmd
    .command("install")
    .description(
      "Write the Claude Code Skills that read dg guide at each stage (dgimport, dgplan, dgwork, etc.) into <repository>/.claude/skills/. Skills you have not edited are updated to the latest, and retired deguboard Skills are deleted. Each person installs the Skills on their own machine: it adds a line per Skill it installs (skills/dgwork/ and so on) to <repository>/.claude/.gitignore when the line is missing (commit that .gitignore), and warns if those Skills are already tracked by git. Your own Skills are not ignored, even when their names start with dg",
    )
    .option(
      "--personal",
      "Write to ~/.claude/skills instead of the repository (personal Claude Code Skills, used in any repository)",
    )
    .option("--force", "Also overwrite SKILL.md files you have edited")
    .option(
      "--dry-run",
      "Write and delete nothing; print where files would go and the SKILL.md contents (to check before installing). --json returns name, path, and content in data.files",
    )
    .exitOverride()
    .configureOutput(program.configureOutput())
    .action(async (opts: { personal?: boolean; force?: boolean; dryRun?: boolean }) => {
      const global = program.opts<{ json?: boolean; C?: string }>();
      try {
        const result = await installSkill({
          cwd: resolve(options.cwd ?? process.cwd(), global.C ?? "."),
          scope: opts.personal ? "personal" : "project",
          env,
          force: opts.force ?? false,
          dryRun: opts.dryRun ?? false,
        });
        const warnings = skillInstallWarnings(result);
        if (global.json)
          streams.out(JSON.stringify({ ok: true, data: result, warnings, write: null }, null, 2));
        else {
          const lines = [
            [result.dryRun ? "Would write" : "Wrote", result.written],
            [result.dryRun ? "Would update" : "Updated", result.updated],
            ["Already up to date", result.unchanged],
            [result.dryRun ? "Would retire and remove" : "Retired and removed", result.retired],
          ] as const;
          if (result.dryRun) streams.out("--dry-run: nothing was written");
          streams.out(`Skill directory: ${result.dir}`);
          if (result.ignoreFile)
            streams.out(`Added ignore lines for the dg Skills to ${result.ignoreFile}`);
          for (const [label, names] of lines)
            if (names.length > 0) streams.out(`${label}: ${names.join(", ")}`);
          for (const f of result.files) streams.out(`\n--- ${f.path}\n${f.content}`);
          for (const w of warnings) streams.err(`Warning: ${w}`);
        }
        process.exitCode = 0;
      } catch (error) {
        const view = toErrorView(error);
        if (global.json) printJsonError(streams, view);
        else printError(streams, view);
        process.exitCode = view.exitCode;
      }
    });
  skillCmd
    .command("uninstall")
    .description(
      "Remove the Claude Code Skills that dg distributes (the ones this dg installs, and retired deguboard Skills) from <repository>/.claude/skills/. Only SKILL.md is removed; a Skill folder that holds other files is kept. Your own Skills are not touched, even when their names start with dg. It does not change <repository>/.claude/.gitignore: the team commits that file and the others still use the Skills, so removing the ignore lines would let git track the Skills they installed",
    )
    .option("--personal", "Remove from ~/.claude/skills instead of the repository")
    .option("--force", "Also remove the dg Skills you have edited")
    .option(
      "--dry-run",
      "Remove nothing; print the Skills that would be removed. --json returns them in data.removed",
    )
    .exitOverride()
    .configureOutput(program.configureOutput())
    .action(async (opts: { personal?: boolean; force?: boolean; dryRun?: boolean }) => {
      const global = program.opts<{ json?: boolean; C?: string }>();
      try {
        const result = await uninstallSkill({
          cwd: resolve(options.cwd ?? process.cwd(), global.C ?? "."),
          scope: opts.personal ? "personal" : "project",
          env,
          force: opts.force ?? false,
          dryRun: opts.dryRun ?? false,
        });
        const warnings = skillUninstallWarnings(result);
        if (global.json)
          streams.out(JSON.stringify({ ok: true, data: result, warnings, write: null }, null, 2));
        else {
          if (result.dryRun) streams.out("--dry-run: nothing was removed");
          streams.out(`Skill directory: ${result.dir}`);
          if (result.removed.length > 0)
            streams.out(
              `${result.dryRun ? "Would remove" : "Removed"}: ${result.removed.join(", ")}`,
            );
          else if (result.kept.length === 0) streams.out("No dg Skills are installed here");
          for (const w of warnings) streams.err(`Warning: ${w}`);
        }
        process.exitCode = 0;
      } catch (error) {
        const view = toErrorView(error);
        if (global.json) printJsonError(streams, view);
        else printError(streams, view);
        process.exitCode = view.exitCode;
      }
    });

  // hooks も CLI だけの操作（AG-4）。判定と書き込みは core の commands/hook-settings.ts にあり、ここは引数と結果を写す。
  // 書くイベントと置き場所は Adapter の hooks が決め、フックが呼ぶのは core の hook コマンド（AG-5・AG-9）
  const hooksCmd = program
    .command("hooks")
    .description("Operations on harness (Claude Code) hooks")
    .helpCommand("help [command]", "Show usage for a command")
    .exitOverride()
    .configureOutput(program.configureOutput());
  for (const action of ["install", "uninstall"] as const) {
    hooksCmd
      .command(action)
      .description(
        action === "install"
          ? "Write hooks that call dg hook into the Claude Code settings. By default they go to <repository>/.claude/settings.local.json (not tracked by git), and call the node running this dg and its dg.js by absolute paths (or, when run through the deguboard launcher of the VS Code extension, the launcher's absolute path), so they work even when the agent's PATH has no node or dg (run it again after upgrading or moving node; dg hooks check warns). Adds settings.local.json to <repository>/.claude/.gitignore when the line is missing (commit that .gitignore). Warns if that file is already tracked by git, or if the tracked .claude/settings.json also has dg hooks. With --shared, writes to the tracked .claude/settings.json and calls dg on PATH. Check whether they are installed and working with dg hooks check. Sets the actor to agent; for a sub-agent whose prompt starts with the marker `deguboard: ticket=<id> step=<step>`, opens a Run when it starts and closes it when the step ends. Rejects gh pr merge and gh pr ready when run outside dg (dg pr merge and dg pr ready call them after dg gate passes), writes to .git/deguboard/, and Bash that contains .git/deguboard. When a response ends (Stop) and a change to the data made outside dg is found, it tells the agent to keep going and reports it. Running it again does not duplicate entries; hooks added by hand are kept"
          : "Remove only dg's hooks from the Claude Code settings. Hooks added by hand are kept. Only a person can remove them: an agent's call (--actor agent or DEGUBOARD_ACTOR=agent) is rejected with TRANSITION_REJECTED, because the hooks stop writes and PR operations that do not go through dg. This is fixed in Core, and workflow.yaml cannot change it (--dry-run writes nothing and is not rejected)",
      )
      .option(
        "--personal",
        "Write to the personal settings (~/.claude/settings.json) instead of the repository",
      )
      .option(
        "--shared",
        "Write to the repository's tracked settings (.claude/settings.json) instead of .claude/settings.local.json",
      )
      .option(
        "--command <cmd>",
        "The command hooks use to call dg (install only). Defaults to the absolute paths of node and dg.js, or of the launcher when run through it (dg with --shared)",
      )
      .option("--dry-run", "Write nothing; print the whole settings that would be written")
      .exitOverride()
      .configureOutput(program.configureOutput())
      .action(
        async (opts: {
          personal?: boolean;
          shared?: boolean;
          command?: string;
          dryRun?: boolean;
        }) => {
          const global = program.opts<{ json?: boolean; C?: string; actor?: string }>();
          try {
            const base = {
              cwd: resolve(options.cwd ?? process.cwd(), global.C ?? "."),
              scope: hookScope(opts),
              env,
              dryRun: opts.dryRun ?? false,
            };
            // 主体はほかのコマンドと同じ順で決める（--actor、DEGUBOARD_ACTOR、既定は human）。agent でなければ人として扱う
            const actor = (global.actor ?? env["DEGUBOARD_ACTOR"]) === "agent" ? "agent" : "human";
            const result =
              action === "install"
                ? await installHooks({ ...base, command: opts.command, self: selfCommand })
                : await uninstallHooks({ ...base, actor });
            const { warnings, ...data } = result;
            if (global.json)
              streams.out(JSON.stringify({ ok: true, data, warnings, write: null }, null, 2));
            else {
              if (data.dryRun) streams.out("--dry-run: nothing was written");
              streams.out(`Settings file: ${data.file}`);
              streams.out(
                data.unchanged
                  ? "No change"
                  : `${action === "install" ? "Installed" : "Removed"}: ${data.events.join(", ")}`,
              );
              if (data.ignoreFile)
                streams.out(`Added an ignore line for the settings file to ${data.ignoreFile}`);
              if (data.content) streams.out(`\n${data.content}`);
              for (const w of warnings) streams.err(`Warning: ${w}`);
            }
            process.exitCode = 0;
          } catch (error) {
            const view = toErrorView(error);
            if (global.json) printJsonError(streams, view);
            else printError(streams, view);
            process.exitCode = view.exitCode;
          }
        },
      );
  }

  hooksCmd
    .command("check")
    .description(
      "Check that dg's hooks are in the Claude Code settings (per event and matcher), that each handler (the command that calls dg) runs with --version, that no field in the most recent hook input went unreceived (only whether fields are present, not their values), and that dg has actually received each installed hook. The handler check runs in this shell, whose PATH may differ from the agent's, so the received records decide whether the hooks work: it warns about installed hooks that have never been received, and, when run inside an agent with hooks, about a session that no hook has reached. It also reports the warnings raised inside dg hook that were not reported yet (such as a Run that could not be opened, or a session where Runs were opened from the marker but no SubagentStop arrived), and the dg Skills installed in the repository or in ~/.claude/skills that are older than this dg, or that a dg of the same version wrote with different contents (update them with dg skill install; ones edited by hand need --force; Skills written by a newer dg are not reported). Warns if anything is missing. The exit code is 0 even with warnings. Input records are read only inside the repository",
    )
    .option(
      "--personal",
      "Check the personal settings (~/.claude/settings.json) instead of the repository",
    )
    .option(
      "--shared",
      "Check the repository's tracked settings (.claude/settings.json) instead of .claude/settings.local.json",
    )
    .exitOverride()
    .configureOutput(program.configureOutput())
    .action(async (opts: { personal?: boolean; shared?: boolean }) => {
      const global = program.opts<{ json?: boolean; C?: string }>();
      try {
        const { warnings, ...data } = await checkHooks({
          cwd: resolve(options.cwd ?? process.cwd(), global.C ?? "."),
          scope: hookScope(opts),
          env,
        });
        if (global.json)
          streams.out(JSON.stringify({ ok: true, data, warnings, write: null }, null, 2));
        else {
          const label: Record<HandlerStatus, string> = {
            ok: "handler works",
            missing: "handler not found",
            timeout: "handler timed out",
            failed: "handler exited abnormally",
            unverified: "handler cannot be verified",
            gone: "handler path no longer exists",
          };
          streams.out(`Settings file: ${data.file}`);
          for (const e of data.events) {
            const handler = e.handler === null ? "" : `, ${label[e.handler]}`;
            const received = e.received_at
              ? `, latest input ${e.received_at}`
              : ", no input received yet";
            streams.out(
              `${e.event}: ${e.installed ? "installed" : "not installed"}${handler}${received}`,
            );
          }
          for (const w of warnings) streams.err(`Warning: ${w}`);
        }
        process.exitCode = 0;
      } catch (error) {
        const view = toErrorView(error);
        if (global.json) printJsonError(streams, view);
        else printError(streams, view);
        process.exitCode = view.exitCode;
      }
    });

  // uninstall も CLI だけの操作（AG-4）。判定と消す処理は core の commands/uninstall.ts にあり、ここは引数と結果を写す
  program
    .command("uninstall")
    .description(
      "Remove deguboard from this clone, in this order: dg's hooks in .claude/settings.local.json (as dg hooks uninstall), the dg Skills in .claude/skills (as dg skill uninstall; Skills edited by hand are kept), the data worktree (.git/deguboard), the local data branch, the merge driver in git config (merge.deguboard), and .git/deguboard-local (personal settings, transcripts, caches). Run it while dg still works, and remove dg itself (the VS Code extension or the CLI) last: the hooks and the merge driver call dg by absolute path. " +
        "It does not touch what the team shares: the data branch on the remote, the registration of the data remote (including deguboard-data added by dg init), the committed .claude/.gitignore, and the dg hooks in .claude/settings.json. data.keeps lists what stays, with the commands to remove each by hand (commands), so dg init can take the board in again. " +
        "It removes nothing and fails with REJECTED when something exists only in this clone: data commits not pushed, changes to the data made outside dg or not committed yet, or worktrees of tickets in progress. The error's detail gives each reason and what to do next (such as dg sync). " +
        "Only a person can run it: an agent's call (--actor agent or DEGUBOARD_ACTOR=agent) is rejected with TRANSITION_REJECTED. This is fixed in Core, and workflow.yaml cannot change it (--dry-run removes nothing and is not rejected)",
    )
    .option(
      "--personal",
      "Also remove dg's hooks from the personal settings (~/.claude/settings.json) and the dg Skills from ~/.claude/skills, which other repositories on this machine may use",
    )
    .option("--force", "Remove even when something exists only in this clone (it is lost)")
    .option(
      "--dry-run",
      "Remove nothing; print what would be removed, what stays, and the reasons it would stop. --json returns them in data.removes (in the order of removal), data.keeps, and data.blockers (each with message and next), and data.proceeds tells whether the same call without --dry-run would remove",
    )
    .exitOverride()
    .configureOutput(program.configureOutput())
    .action(async (opts: { personal?: boolean; force?: boolean; dryRun?: boolean }) => {
      const global = program.opts<{ json?: boolean; C?: string; actor?: string }>();
      try {
        const data = await uninstall({
          cwd: resolve(options.cwd ?? process.cwd(), global.C ?? "."),
          env,
          // 主体は dg hooks uninstall と同じ順で決める（--actor、DEGUBOARD_ACTOR、既定は human）
          actor: (global.actor ?? env["DEGUBOARD_ACTOR"]) === "agent" ? "agent" : "human",
          personal: opts.personal ?? false,
          force: opts.force ?? false,
          dryRun: opts.dryRun ?? false,
        });
        if (global.json)
          streams.out(JSON.stringify({ ok: true, data, warnings: [], write: null }, null, 2));
        else {
          if (data.dryRun) streams.out("--dry-run: nothing was removed");
          if (data.removes.length === 0) streams.out("Nothing to remove in this clone");
          for (const item of data.removes)
            streams.out(
              `${data.dryRun ? "Would remove" : "Removed"} ${item.kind} (${item.scope}): ${item.target}${item.names ? ` (${item.names.join(", ")})` : ""}`,
            );
          for (const kept of data.keeps) {
            streams.out(`Kept ${kept.kind}: ${kept.target}. ${kept.reason}`);
            for (const command of kept.commands) streams.out(`         to remove: ${command}`);
          }
          for (const b of data.blockers) {
            streams.out(
              `${data.force ? "Overridden by --force" : "Would stop"} (${b.kind}): ${b.message}`,
            );
            for (const command of b.next) streams.out(`         next: ${command}`);
          }
        }
        process.exitCode = 0;
      } catch (error) {
        const view = toErrorView(error);
        if (global.json) printJsonError(streams, view);
        else printError(streams, view);
        process.exitCode = view.exitCode;
      }
    });

  // setup check も CLI だけの操作。判定は core の commands/setup-check.ts にあり、ここは引数と結果を写す。
  // git がない・リポジトリの外・dg init の前でも結果を返すので、文脈（リポジトリ・ストア）を開かない
  program
    .command("setup")
    .description("Check what is needed to start using deguboard")
    .helpCommand("help [command]", "Show usage for a command")
    .exitOverride()
    .configureOutput(program.configureOutput())
    .command("check")
    .description(
      "Check the setup items from the top, in this order: git (2.30 or later), the Git repository, the board, the Skills and hooks, and .claude/.gitignore. Each item (data.items) has status (ok, unmet, or pending), message (its state), level (required or recommended), and fix (the commands that fix it, in order; empty when there is none). When a required item is unmet, the items after it are not checked and come back as pending. data.ready is true when every required item is ok. It works without git, outside a Git repository, and before dg init, and writes nothing. " +
        "Before dg init, the board item checks what dg init would do and tells it in state: remote_board (the data remote was reached and has the team's board, so dg init takes it in), remote_no_board (reached, no board, so dg init creates one), remote_unreachable (not reached; no fix command, because dg init --new-board may start a board apart from the team's), no_remote (the code's remote, origin or the one given with --remote, is not in this clone, so the board stays on this machine), local_branch (a deguboard branch is left here with no worktree), data_branch_invalid (dg init rejects the --data-branch name; no fix command), or data_remote_missing (the --data-remote name is not a remote of this clone and is not a URL, so dg init would stop; no fix command). After dg init it is ready. The remote is only asked for its branch (git ls-remote, up to 30 seconds); nothing is fetched. " +
        "The Skills and hooks item only looks at whether they are installed: the dg hooks are in one of the Claude Code settings (.claude/settings.local.json, .claude/settings.json, or ~/.claude/settings.json) for every event, and dg Skills are in the repository or in ~/.claude/skills with none written by an older dg. Whether the hooks work is checked by dg hooks check. " +
        "The .claude/.gitignore item is unmet when that file has uncommitted changes; dg does not commit it. The exit code is 0 even when items are unmet",
    )
    .option(
      "--remote <name>",
      "Before dg init, the remote of the code, which is also where the board is looked for unless --data-remote is given (the value to pass to dg init --remote). Defaults to origin",
    )
    .option(
      "--data-remote <name or URL>",
      "Before dg init, the remote to look for the board on, when the data is kept in a repository other than the code's (the value to pass to dg init --data-remote). Defaults to the remote of the code",
    )
    .option(
      "--data-branch <name>",
      "Before dg init, the branch of the data remote to look for (the value to pass to dg init --data-branch). Defaults to deguboard",
    )
    .exitOverride()
    .configureOutput(program.configureOutput())
    .action(async (opts: { remote?: string; dataRemote?: string; dataBranch?: string }) => {
      const global = program.opts<{ json?: boolean; C?: string }>();
      try {
        const data = await checkSetup({
          cwd: resolve(options.cwd ?? process.cwd(), global.C ?? "."),
          env,
          remote: opts.remote,
          dataRemote: opts.dataRemote,
          dataBranch: opts.dataBranch,
        });
        if (global.json)
          streams.out(JSON.stringify({ ok: true, data, warnings: [], write: null }, null, 2));
        else
          for (const item of data.items) {
            streams.out(`${item.status.padEnd(7)}  ${item.label} (${item.level}): ${item.message}`);
            if (item.detail) streams.out(`         ${item.detail}`);
            for (const command of item.fix) streams.out(`         fix: ${command}`);
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
    .description("Merge driver for the deguboard branch (git calls it with %O %A %B %P)")
    .argument("<base>")
    .argument("<ours>")
    .argument("<theirs>")
    .argument("[path]")
    .action(async (...args: unknown[]) => {
      const files = args.slice(0, 4).filter((a): a is string => typeof a === "string");
      process.exitCode = await runMergeDriver(files, (line) => streams.err(line));
    });

  const mergeDriver = options.mergeDriver ?? selfMergeDriver(env);

  addServeCommands(program, {
    mergeDriver,
    streams,
    env,
    resolveCwd: (c) => resolve(options.cwd ?? process.cwd(), c ?? "."),
    staticDir: options.staticDir ?? webDist(),
  });

  // mcp も CLI の責務。ツールは core の commands から生成し、主体は常に agent（AG-4）
  program
    .command("mcp")
    .description(
      "Start the MCP server over stdio (the actor is <user>/agent). Tools map one-to-one to dg commands, named like ticket_create",
    )
    .action(async () => {
      const global = program.opts<{ C?: string; user?: string }>();
      try {
        // MCP の SDK とサーバーは dg mcp のときだけ読む（ほかのコマンドの起動を遅くしない。t554）
        const { serveMcp } = await import("./mcp.js");
        await serveMcp({
          cwd: resolve(options.cwd ?? process.cwd(), global.C ?? "."),
          ...pickUser(global.user, env["DEGUBOARD_USER"]),
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
    const fileField = shapes.find((s) => s.kind === "source");
    if (fileField)
      cmd.addArgument(
        new Argument("<file>", `${fileField.description} (YAML or JSON file; - for stdin)`),
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
      const actorKind = (global.actor ?? env["DEGUBOARD_ACTOR"] ?? "human") as ActorInfo["kind"];
      if (actorKind !== "human" && actorKind !== "agent") {
        command.error("--actor must be human or agent", { exitCode: 2 });
      }
      const actor = { kind: actorKind, ...pickUser(global.user, env["DEGUBOARD_USER"]) };
      const initialize =
        def.needs === "repo"
          ? {
              remote: input["remote"] as string | undefined,
              dataRemote: input["data_remote"] as string | undefined,
              dataBranch: input["data_branch"] as string | undefined,
              newBoard: input["new_board"] as boolean | undefined,
            }
          : undefined;

      let result: CommandResult<unknown>;
      try {
        const stdin = () =>
          options.stdinText !== undefined ? Promise.resolve(options.stdinText) : readStdin();
        if (fileField) {
          const file = positionals[bound.positionals.length] as string;
          input[fileField.key] = await readText(file, cwd, stdin);
        }
        // ファイルから読む値（workflow set の --file）。パスを中身に置き換える
        for (const shape of bound.options) {
          const file = input[shape.key];
          if (shape.kind === "file" && typeof file === "string")
            input[shape.key] = await readYamlFile(file, cwd, stdin);
        }
        // 入力がコマンドの storeless を満たせば（dg hook の PreToolUse）、ストアを開かない
        const ctx = await openContextFor(def, input, {
          cwd,
          actor,
          initialize,
          mergeDriver,
          // テストが渡した環境（HOME・CLAUDE_ENV_FILE など）をコマンドにも渡す。渡さなければ process.env
          ...(options.env ? { env: options.env } : {}),
        });
        result = await runCommand(def, ctx, input);
      } catch (error) {
        const view = toErrorView(error);
        // フック（dg hook）は harness の作業を止めないよう、入力の誤りも文脈を開く失敗も標準エラーに書いて 0 で返す
        // （Claude Code では 2 がツールの呼び出しやサブエージェントの終わりを止める）
        if (def.name === "hook") {
          streams.err(`dg hook: ${view.message}`);
          process.exitCode = 0;
          return;
        }
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

/** ファイル（- で標準入力）の中身を文字列で読む。読めなければ使い方の誤り。中身の検査は core の命令が行う */
async function readText(file: string, cwd: string, stdin: () => Promise<string>): Promise<string> {
  try {
    return file === "-" ? await stdin() : await readFile(resolve(cwd, file), "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read ${file}`, String(error));
  }
}

/** YAML か JSON のファイル（- で標準入力）を読む。読めなければ使い方の誤り */
async function readYamlFile(
  file: string,
  cwd: string,
  stdin: () => Promise<string>,
): Promise<unknown> {
  let text: string;
  try {
    text = file === "-" ? await stdin() : await readFile(resolve(cwd, file), "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read ${file}`, String(error));
  }
  try {
    return parseYaml(text);
  } catch (error) {
    throw new UsageError(`Cannot read ${file} as YAML`, String(error));
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
  if (view.code === "commander.help") return "Missing or unknown command (See usage with --help)";
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
    if (streams) streams.err(`Error: ${view.message}`);
    else process.stderr.write(`Error: ${view.message}\n`);
    return view.exitCode;
  }
  return Number(process.exitCode ?? 0);
}
