// すべてのコマンド。入口（CLI・HTTP・Webview）はこの配列を写す

import type { AnyCommand } from "./define.js";
import { epicCommands } from "./epic.js";
import { iterationCommands } from "./iteration.js";
import { projectCommands } from "./project.js";
import { setupCommands } from "./setup.js";
import { ticketCommands } from "./ticket.js";
import { workflowCommands } from "./workflow.js";

export const commands: readonly AnyCommand[] = [
  ...setupCommands,
  ...projectCommands,
  ...ticketCommands,
  ...iterationCommands,
  ...epicCommands,
  ...workflowCommands,
] as AnyCommand[];

/** 群のエイリアス（`sprint` は `iteration`） */
export const GROUP_ALIASES: Readonly<Record<string, string>> = { sprint: "iteration" };

export function findCommand(name: string): AnyCommand | undefined {
  const [group, ...rest] = name.split(".");
  const canonical = [GROUP_ALIASES[group ?? ""] ?? group, ...rest].join(".");
  return commands.find((c) => c.name === canonical);
}
