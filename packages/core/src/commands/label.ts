// ラベルの軸（config.yaml の labels.axes。requirements.md 5.10、ADR-037）。
// 軸の一覧は入れ子で config.set の 1 項目に収まらないので、ここのコマンドがスキーマで検査してチームの config.yaml に書く。
// チームの設定の変更なので、config.set と同じく Workflow の governance.config で判定する。
// 軸の候補と推薦の語彙は model/label-axes.ts が持ち、label.axis.list の --candidates で出す。
// 語彙（データのブランチの labels.yaml。requirements.md 5.1）は label.list が読む。一覧を作る判定は model/labels.ts

import { z } from "zod";
import { OperationError } from "../errors.js";
import { withWrite } from "../git/write.js";
import { slugSchema } from "../model/common.js";
import type { LabelAxis } from "../model/config.js";
import {
  LABEL_AXIS_CANDIDATES,
  labelAxesState,
  type LabelAxesState,
  type LabelAxisCandidate,
} from "../model/label-axes.js";
import { labelListView, type LabelListView } from "../model/labels.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import {
  hasRecord,
  permissionFields,
  recordNote,
  requireOperation,
  type PermissionInput,
} from "./permission.js";

/** 軸の読みと書き込みの出力。axes は書いていないときも空の配列で返し、書いていないか `[]` かは state で見分ける */
export interface LabelAxesView {
  state: LabelAxesState;
  axes: LabelAxis[];
  /** 軸の候補（--candidates を付けたときだけ） */
  candidates?: readonly LabelAxisCandidate[];
}

function viewOf(axes: LabelAxis[] | undefined): LabelAxesView {
  return { state: labelAxesState(axes), axes: axes ?? [] };
}

const AXES_NOTE =
  "The axes are in the team's config.yaml (labels.axes) and cannot be overridden in personal settings. labels.axes has three states: not written (not decided yet, the default), an empty list (decided not to use axes), and a list of axes. dg config unset labels.axes returns to not decided. Changing them is judged by the Workflow's governance.config, as for dg config set (dg workflow show gives its value): an agent passes --approved-by after a person approved the change, and the approver is recorded in the commit message";

/**
 * チームの config.yaml の軸を書き換える。個人の設定では上書きできないので、元も書く先もチームの値。
 * 判定は書き込みのロックの中（取り込んだ後の Workflow）で呼び、承認者と強制の理由はその操作のコミットに残す（config.set と同じ）
 */
async function writeAxes(
  ctx: CommandContext,
  command: "label.axis.set" | "label.axis.remove",
  input: PermissionInput,
  /** 軸を指す句（"label axis area"・"every label axis"）。判定の文とコミットメッセージに使う */
  target: string,
  change: (axes: LabelAxis[] | undefined) => LabelAxis[],
) {
  const [verb, doing] = command === "label.axis.set" ? ["Set", "setting"] : ["Remove", "removing"];
  return withWrite(
    ctx,
    async () => {
      const team = ctx.store.teamConfig;
      const axes = change(team.labels.axes);
      requireOperation(ctx, { command, governs: "config" }, input, `${doing} ${target}`);
      const written = await ctx.store.writeConfig({ labels: { ...team.labels, axes } });
      return viewOf(written.labels.axes);
    },
    {
      message: `${verb} ${target}${recordNote(ctx, input)}`,
      ...(hasRecord(input) ? { immediate: true } : {}),
    },
  );
}

export const labelAxisSet = defineCommand({
  name: "label.axis.set",
  positionals: ["name"],
  group: "label",
  summary:
    "Add an axis that the labels of a ticket follow (such as area: which part the ticket touches), or change the description of one that exists. The first axis turns the axes on. See the candidates dg holds with dg label axis list --candidates. " +
    AXES_NOTE,
  input: z.object({
    name: slugSchema.describe("Name of the axis (a slug, such as area)"),
    description: z
      .string()
      .min(1)
      .describe("What the axis tells about a ticket, in one line. Required"),
    ...permissionFields,
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await writeAxes(
      ctx,
      "label.axis.set",
      input,
      `the label axis ${input.name}`,
      (axes = []) => {
        const axis = { name: input.name, description: input.description };
        // ある軸は並びの場所を変えずに説明だけを替え、新しい軸は末尾に足す
        return axes.some((a) => a.name === input.name)
          ? axes.map((a) => (a.name === input.name ? { ...a, ...axis } : a))
          : [...axes, axis];
      },
    );
    return ok<LabelAxesView>(result.value, result.write);
  },
});

export const labelAxisRemove = defineCommand({
  name: "label.axis.remove",
  positionals: ["name"],
  group: "label",
  summary:
    "Remove an axis of the labels. Removing the last axis leaves an empty list (decided not to use axes). --all removes every axis and writes the empty list, also when no axis was written yet: use it to record the decision not to use axes. " +
    AXES_NOTE,
  input: z.object({
    name: slugSchema.optional().describe("Name of the axis to remove. Omit with --all"),
    all: z
      .boolean()
      .optional()
      .describe("Remove every axis and write an empty list (decided not to use axes)"),
    ...permissionFields,
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const { name } = input;
    if ((name === undefined) !== (input.all === true))
      throw new OperationError(
        "VALIDATION_FAILED",
        "Give either the name of an axis or --all",
        "dg label axis remove <name> removes one axis, and dg label axis remove --all removes every axis",
      );
    const result = await writeAxes(
      ctx,
      "label.axis.remove",
      input,
      name === undefined ? "every label axis" : `the label axis ${name}`,
      (axes = []) => {
        if (name === undefined) return [];
        if (!axes.some((a) => a.name === name))
          throw new OperationError(
            "NOT_FOUND",
            `No label axis ${name}`,
            `Axes: ${axes.map((a) => a.name).join(", ") || "(none)"}`,
          );
        return axes.filter((a) => a.name !== name);
      },
    );
    return ok<LabelAxesView>(result.value, result.write);
  },
});

export const labelAxisList = defineCommand({
  name: "label.axis.list",
  group: "label",
  summary:
    "Show the axes that the labels of a ticket follow (the team's config.yaml, labels.axes). state tells the three states apart: undecided (not written, the default), off (an empty list: decided not to use axes), and on (axes holds them). Write the axes with dg label axis set and dg label axis remove",
  input: z.object({
    candidates: z
      .boolean()
      .optional()
      .describe(
        "Also show the candidate axes that dg holds, in English (candidates): group default (area and kind) fits any project, and group recommended (impact, platform, audience) fits only some, so propose one only with a basis in the repository. kind also has recommended labels (recommended_labels) to start its labels from. The candidates are proposals: an axis works only once it is written",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    // 同じ文脈で書いた後も今の値を出すよう、ctx.config（開いたときの写し）でなく store から読む
    const view = viewOf(ctx.store.teamConfig.labels.axes);
    return ok<LabelAxesView>(
      input.candidates ? { ...view, candidates: LABEL_AXIS_CANDIDATES } : view,
    );
  },
});

export const labelList = defineCommand({
  name: "label.list",
  group: "label",
  summary:
    "Show the vocabulary of the labels (labels.yaml on the data branch) by axis. state is the state of the axes (see dg label axis list). axes lists the axes in the order of labels.axes, each with its labels (name, description, created_at), the number of tickets that carry the label (count: done and abandoned tickets count too), and when it was last used (last_used_at: the created_at of the newest ticket that carries it, or null when no ticket does). An axis whose description is null is not in labels.axes: only labels point to it. Labels recorded as merged into another are not vocabulary and are left out. Entries of labels.yaml that cannot be read are left out too: dg validate reports them",
  input: z.object({
    merged: z
      .boolean()
      .optional()
      .describe(
        "Also show the records of merged labels (merged: name, axis, description, merged_into, merged_at)",
      ),
    undefined: z
      .boolean()
      .optional()
      .describe(
        "Also show the names that tickets carry but the vocabulary does not have, with the number of tickets (undefined: name, count). A name recorded as merged counts as not in the vocabulary",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const tickets = [...ctx.store.tickets.values()].map((doc) => doc.data);
    return ok<LabelListView>(
      labelListView(ctx.store.teamConfig.labels.axes, ctx.store.labels, tickets, input),
    );
  },
});

export const labelCommands = [labelAxisSet, labelAxisRemove, labelAxisList, labelList];
