// 任意のシェルの Action（AG-7）。actions.shell が true のときだけ使え、実行のたびに確認する

import { z } from "zod";
import { runProcess } from "../git/run.js";
import { defineAction } from "./define.js";

export const shellAction = defineAction({
  name: "shell",
  summary:
    "Run an arbitrary shell command with sh -c. Usable only when actions.shell is true; asks for confirmation before each run",
  input: z.object({
    command: z.string().min(1),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .default(10 * 60_000),
  }),
  confirm: true,
  allowed: (config) =>
    config.actions.shell
      ? null
      : "The arbitrary shell Action is not allowed by the config (actions.shell)",
  async run(ctx, input) {
    const result = await runProcess(ctx.cwd, "sh", ["-c", input.command], {
      allowFailure: true,
      timeoutMs: input.timeout_ms,
    });
    return { ...result };
  },
});
