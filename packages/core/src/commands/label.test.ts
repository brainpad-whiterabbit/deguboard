// ラベルの軸を読み書きするコマンド（label.axis.set・label.axis.remove・label.axis.list。ADR-037）と、語彙を読む label.list
// 同期を確かめないので、すべてデータのリモートのない initializedLocalFixture で回す

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { git } from "../../test/helpers/git-fixture.js";
import {
  initializedLocalFixture,
  reopenInitialized,
  runCleanups,
  writeWorkflowYaml,
} from "../../test/helpers/commands-context.js";
import { withWrite } from "../git/write.js";
import { LABEL_AXIS_CANDIDATES } from "../model/label-axes.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import { labelAxisList, labelAxisRemove, labelAxisSet, labelList } from "./label.js";
import {
  configSet,
  configShow,
  configUnset,
  lint,
  validate,
  type ConfigShowView,
} from "./setup.js";
import { ticketCreate } from "./ticket.js";

afterEach(runCleanups);

const area = { name: "area", description: "Which part of the product the ticket touches" };
const kind = { name: "kind", description: "何をする変更か" };

/** config.yaml に書いてある labels（書いていなければ undefined） */
async function fileLabels(ctx: CommandContext): Promise<unknown> {
  const file = parse(await readFile(path.join(ctx.repo.dataDir, "config.yaml"), "utf8")) as {
    labels?: unknown;
  } | null;
  return file?.labels;
}

const list = async (ctx: CommandContext, input: { candidates?: boolean } = {}) =>
  (await runCommand(labelAxisList, ctx, input)).data;

describe("ラベルの軸", () => {
  it("書いていないボードは undecided で、label.axis.set が軸をチームの config.yaml に足し、ある軸は場所を変えずに説明だけを替える", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    expect(await list(ctx)).toEqual({ state: "undecided", axes: [] });
    expect(await fileLabels(ctx)).toBeUndefined();

    const first = await runCommand(labelAxisSet, ctx, area);
    // config.set と同じ書き込み（コミットは commit.mode に従う）
    expect(first.write).toBeDefined();
    expect(first.data).toEqual({ state: "on", axes: [area] });
    await runCommand(labelAxisSet, ctx, kind);
    const replaced = await runCommand(labelAxisSet, ctx, { name: "area", description: "触る部分" });
    expect(replaced.data).toEqual({
      state: "on",
      axes: [{ name: "area", description: "触る部分" }, kind],
    });
    expect(await fileLabels(ctx)).toEqual({ axes: replaced.data.axes });
    expect(await list(ctx)).toEqual(replaced.data);
    // config show でも読める（効く値とチームの値は同じ。fields には出ない）
    const shown = (await runCommand(configShow, ctx, { fields: true })).data as ConfigShowView;
    expect(shown.config.labels.axes).toEqual(replaced.data.axes);
    expect(shown.team.labels.axes).toEqual(replaced.data.axes);
    expect(shown.defaults.labels).toEqual({});
    expect(shown.fields.some((field) => field.key.startsWith("labels"))).toBe(false);
    expect(shown.label_axis_candidates).toEqual(LABEL_AXIS_CANDIDATES);
  });

  it("label.axis.set は名前が slug でない軸と説明のない軸を弾き、何も書かない", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    for (const bad of [
      { name: "area" },
      { name: "area", description: "" },
      { name: "Area Of", description: "d" },
      { description: "d" },
    ])
      await expect(runCommand(labelAxisSet, ctx, bad)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    expect(await list(ctx)).toEqual({ state: "undecided", axes: [] });
    expect(await fileLabels(ctx)).toBeUndefined();
  });

  it("label.axis.remove は軸を消し、最後の軸を消すと [] （off）が残る。config.unset labels.axes は undecided に戻す", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    // 書いていないボードの軸は消せない
    await expect(runCommand(labelAxisRemove, ctx, { name: "area" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await fileLabels(ctx)).toBeUndefined();
    await runCommand(labelAxisSet, ctx, area);
    await runCommand(labelAxisSet, ctx, kind);
    await expect(runCommand(labelAxisRemove, ctx, { name: "impact" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      detail: "Axes: area, kind",
    });
    expect((await runCommand(labelAxisRemove, ctx, { name: "area" })).data).toEqual({
      state: "on",
      axes: [kind],
    });
    expect((await runCommand(labelAxisRemove, ctx, { name: "kind" })).data).toEqual({
      state: "off",
      axes: [],
    });
    // off は [] としてファイルに残り、書いていないのと見分けられる
    expect(await fileLabels(ctx)).toEqual({ axes: [] });
    expect(await list(ctx)).toEqual({ state: "off", axes: [] });
    const reset = await runCommand(configUnset, ctx, { key: "labels.axes" });
    expect(reset.data.labels).toEqual({});
    expect(await fileLabels(ctx)).toBeUndefined();
    expect(await list(ctx)).toEqual({ state: "undecided", axes: [] });
  });

  it("label.axis.remove --all は、書いていないボードにも [] を書いて使わないと決めたことを残す。名前と --all は片方だけを受ける", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    for (const bad of [{}, { name: "area", all: true }, { all: false }])
      await expect(runCommand(labelAxisRemove, ctx, bad)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "Give either the name of an axis or --all",
      });
    expect(await fileLabels(ctx)).toBeUndefined();
    expect((await runCommand(labelAxisRemove, ctx, { all: true })).data).toEqual({
      state: "off",
      axes: [],
    });
    expect(await fileLabels(ctx)).toEqual({ axes: [] });
    await runCommand(labelAxisSet, ctx, area);
    await runCommand(labelAxisSet, ctx, kind);
    expect((await runCommand(labelAxisRemove, ctx, { all: true })).data).toEqual({
      state: "off",
      axes: [],
    });
  });

  it("label.axis.list --candidates は、今の軸に dg の持つ候補と kind の推薦の語彙を添えて出す（候補は書かれない）", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    const shown = await list(ctx, { candidates: true });
    expect(shown).toEqual({ state: "undecided", axes: [], candidates: LABEL_AXIS_CANDIDATES });
    expect(shown.candidates?.map((c) => `${c.group}:${c.name}`)).toEqual([
      "default:area",
      "default:kind",
      "recommended:impact",
      "recommended:platform",
      "recommended:audience",
    ]);
    expect(
      shown.candidates?.find((c) => c.name === "kind")?.recommended_labels?.map((l) => l.name),
    ).toEqual(["feature", "bug", "refactor"]);
    // --candidates を付けなければ候補は出さない
    expect(await list(ctx)).not.toHaveProperty("candidates");
    expect(await fileLabels(ctx)).toBeUndefined();
  });

  it("config.set は labels.* を書かず、--local でも dg label axis のコマンドを案内して弾く。個人の設定に何も書かない", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    for (const local of [false, true])
      for (const key of ["labels", "labels.axes", "labels.axes.0.name"])
        await expect(
          runCommand(configSet, ctx, { key, value: "area", local }),
        ).rejects.toMatchObject({
          code: "VALIDATION_FAILED",
          message: `${key} cannot be set with config set`,
          detail: expect.stringContaining("dg label axis set and dg label axis remove"),
        });
    expect(ctx.store.localConfig).toEqual({});
    expect(await fileLabels(ctx)).toBeUndefined();
  });

  it("軸を書く操作は Workflow の governance.config で判定する：エージェントは人の承認が要り、承認者が履歴に残る。読むだけの list は判定しない", async () => {
    const f = await initializedLocalFixture();
    const human = await reopenInitialized(f);
    const opened = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    const agent = { ...human, actor: opened.actor };
    const governance = (value: string) =>
      writeWorkflowYaml(human, ["governance:", `  config: ${value}`]);
    const subject = async () =>
      (await git(human.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim();

    await governance("always_ask");
    await expect(runCommand(labelAxisSet, agent, area)).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for setting the label axis area (governance.config: always_ask)",
    });
    await expect(runCommand(labelAxisRemove, agent, { all: true })).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow asks for a person's approval for removing every label axis (governance.config: always_ask)",
    });
    expect(await list(agent)).toEqual({ state: "undecided", axes: [] });
    await runCommand(labelAxisSet, agent, { ...area, approved_by: "human" });
    expect(await subject()).toBe("Set the label axis area (approved by claude)");
    await runCommand(labelAxisRemove, agent, { name: "area", approved_by: "human" });
    expect(await subject()).toBe("Remove the label axis area (approved by claude)");
    // 人は聞かずに書ける
    expect((await runCommand(labelAxisSet, human, kind)).data.state).toBe("on");

    await governance("human_only");
    await expect(
      runCommand(labelAxisSet, agent, { ...area, approved_by: "human" }),
    ).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
      message:
        "The Workflow limits setting the label axis area to a person (governance.config: human_only)",
    });
    expect((await list(agent)).axes).toEqual([kind]);

    await governance("anyone");
    expect((await runCommand(labelAxisSet, agent, area)).data.axes).toEqual([kind, area]);
  });
});

/** labels.yaml をデータのディレクトリに置いて索引を作り直す（語彙を書くコマンドはまだないので、dg の書き込みとして直に書く） */
async function writeLabels(ctx: CommandContext, lines: string[]): Promise<void> {
  await withWrite(
    ctx,
    () => writeFile(path.join(ctx.repo.dataDir, "labels.yaml"), `${lines.join("\n")}\n`),
    { message: "語彙を書く" },
  );
  await ctx.store.rescan();
}

describe("ラベルの語彙（labels.yaml）", () => {
  const at = "2026-11-01T00:00:00Z";
  const vocabulary = [
    "ui:",
    "  axis: area",
    "  description: The board and its panels",
    `  created_at: ${at}`,
    "bug:",
    "  axis: kind",
    "  description: A defect",
    `  created_at: ${at}`,
    "web:",
    "  axis: area",
    "  description: The web UI",
    `  created_at: ${at}`,
    "  merged_into: ui",
    `  merged_at: ${at}`,
  ];

  it("labels.yaml のないボードの label.list は、軸だけを語彙なしで出す", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    expect((await runCommand(labelList, ctx, {})).data).toEqual({ state: "undecided", axes: [] });
    await runCommand(labelAxisSet, ctx, area);
    expect((await runCommand(labelList, ctx, { merged: true, undefined: true })).data).toEqual({
      state: "on",
      axes: [{ ...area, labels: [] }],
      merged: [],
      undefined: [],
    });
  });

  it("label.list は軸ごとの語彙に件数と最後に使われた時刻を添え、--merged で統合の記録、--undefined で語彙にない名前と件数を出す", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(labelAxisSet, ctx, area);
    await runCommand(labelAxisSet, ctx, kind);
    await writeLabels(ctx, vocabulary);
    await runCommand(ticketCreate, ctx, { title: "一", labels: ["ui", "tooling"] });
    const second = await runCommand(ticketCreate, ctx, { title: "二", labels: ["ui", "web"] });
    await runCommand(ticketCreate, ctx, { title: "三", labels: ["tooling"] });
    // 期待する時刻は、用意したチケットの記録から取る
    const lastUsed = second.data.created_at;

    const plain = (await runCommand(labelList, ctx, {})).data;
    expect(plain).toEqual({
      state: "on",
      axes: [
        {
          ...area,
          labels: [
            {
              name: "ui",
              description: "The board and its panels",
              created_at: at,
              count: 2,
              last_used_at: lastUsed,
            },
          ],
        },
        {
          ...kind,
          labels: [
            { name: "bug", description: "A defect", created_at: at, count: 0, last_used_at: null },
          ],
        },
      ],
    });
    const full = (await runCommand(labelList, ctx, { merged: true, undefined: true })).data;
    expect(full.axes).toEqual(plain.axes);
    expect(full.merged).toEqual([
      {
        name: "web",
        axis: "area",
        description: "The web UI",
        merged_into: "ui",
        merged_at: at,
      },
    ]);
    expect(full.undefined).toEqual([
      { name: "tooling", count: 2 },
      { name: "web", count: 1 },
    ]);
    // 語彙は正しいので、検証は誤りを出さない
    expect((await runCommand(validate, ctx, {})).data).toEqual({ ok: true, issues: [] });
  });

  it("読めない項目は止めずに外し、dg validate が名前つきで報告する。ほかの語彙は読める", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    await writeLabels(ctx, [
      ...vocabulary,
      "no-description:",
      "  axis: area",
      `  created_at: ${at}`,
      "half-merged:",
      "  axis: area",
      "  description: x",
      `  created_at: ${at}`,
      "  merged_into: ui",
    ]);
    expect([...ctx.store.labels.keys()]).toEqual(["ui", "bug", "web"]);
    const checked = (await runCommand(validate, ctx, {})).data;
    expect(checked.ok).toBe(false);
    expect(checked.issues).toMatchObject([
      {
        severity: "error",
        code: "schema_error",
        path: "labels.yaml",
        message:
          "The label no-description does not match the schema, so it is not read as vocabulary",
      },
      {
        severity: "error",
        code: "schema_error",
        path: "labels.yaml",
        message: "The label half-merged does not match the schema, so it is not read as vocabulary",
        detail: expect.stringContaining("merged_into and merged_at go together"),
      },
    ]);
    // 読めない項目があっても、一覧とほかの書き込みは止まらない
    const listed = (await runCommand(labelList, ctx, {})).data;
    expect(listed.axes.flatMap((a) => a.labels.map((l) => l.name))).toEqual(["ui", "bug"]);
    await expect(runCommand(ticketCreate, ctx, { title: "続けて書ける" })).resolves.toBeDefined();
  });

  it("同じ名前を 2 回書いた（軸が違っても）ファイルと、最上位がマッピングでないファイルは、語彙なしにして dg validate が報告する", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    await writeLabels(ctx, [
      ...vocabulary,
      "ui:",
      "  axis: kind",
      "  description: The same name on another axis",
      `  created_at: ${at}`,
    ]);
    expect(ctx.store.labels.size).toBe(0);
    expect((await runCommand(validate, ctx, {})).data.issues).toMatchObject([
      { severity: "error", code: "yaml_error", path: "labels.yaml" },
    ]);

    await writeLabels(ctx, ["- ui", "- bug"]);
    expect(ctx.store.labels.size).toBe(0);
    expect((await runCommand(validate, ctx, {})).data.issues).toMatchObject([
      { severity: "error", code: "schema_error", path: "labels.yaml" },
    ]);
    // 直せば読める
    await writeLabels(ctx, vocabulary);
    expect([...ctx.store.labels.keys()]).toEqual(["ui", "bug", "web"]);
    expect((await runCommand(validate, ctx, {})).data.issues).toEqual([]);
  });

  it("lint は軸がオンのボードでだけ、チケットの指摘をチケットに、語彙の指摘を labels.yaml に置く（組み合わせは model/label-lint.test.ts）", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    await writeLabels(ctx, vocabulary);
    const created = await runCommand(ticketCreate, ctx, {
      title: "一",
      labels: ["web", "tooling"],
    });
    const labelIssues = async () =>
      (await runCommand(lint, ctx, {})).data.issues
        .filter((i) => i.code.startsWith("lint_label_"))
        .map((i) => [i.code, i.path, i.id]);
    // 軸を書いていない（undecided）ボードは見ない
    expect(await labelIssues()).toEqual([]);
    await runCommand(labelAxisSet, ctx, area);
    await runCommand(labelAxisSet, ctx, kind);
    expect(await labelIssues()).toEqual([
      ["lint_label_undefined", "labels.yaml", undefined],
      ["lint_label_unused", "labels.yaml", undefined],
      ["lint_label_unused", "labels.yaml", undefined],
      ["lint_label_merged", ctx.store.tickets.get(created.data.id)?.path, created.data.id],
    ]);
  });
});
