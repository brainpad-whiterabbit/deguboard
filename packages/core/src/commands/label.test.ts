// ラベルの軸を読み書きするコマンド（label.axis.set・label.axis.remove・label.axis.list。ADR-037）と、
// 語彙を読む label.list、語彙を書く label.add・label.update・label.remove、ラベルを統合する label.merge、
// 統合済みの名前を書くときと絞るときに統合先へ読み替える ticket.create・update・import・list
// 同期を確かめないテストは、データのリモートのない initializedLocalFixture で回す。リモート付きは、統合の push が拒否される 1 件だけ

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { git } from "../../test/helpers/git-fixture.js";
import {
  initializedFixture,
  initializedLocalFixture,
  reopenInitialized,
  runCleanups,
  writeWorkflowYaml,
} from "../../test/helpers/commands-context.js";
import { withWrite } from "../git/write.js";
import { LABEL_AXIS_CANDIDATES } from "../model/label-axes.js";
import { openContext } from "./context.js";
import { runCommand, type CommandContext } from "./define.js";
import {
  labelAdd,
  labelAxisList,
  labelAxisRemove,
  labelAxisSet,
  labelList,
  labelMerge,
  labelRemove,
  labelUpdate,
} from "./label.js";
import {
  configSet,
  configShow,
  configUnset,
  lint,
  validate,
  type ConfigShowView,
} from "./setup.js";
import {
  ticketCreate,
  ticketDelete,
  ticketImport,
  ticketList,
  ticketMove,
  ticketUpdate,
} from "./ticket.js";

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

/** config.show --fields（設定画面が読む値）の軸の状態 */
const shownAxesState = async (ctx: CommandContext) =>
  ((await runCommand(configShow, ctx, { fields: true })).data as ConfigShowView).label_axes_state;

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
    // 設定画面は軸の状態を自分で見分けず、label.axis.list と同じ state を config.show から受け取る
    expect(shown.label_axes_state).toBe("on");
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

  // 判定の組み合わせは model/label-axes.test.ts。ここは経路の代表（判定の誤りをそのまま返す・消した軸を書く）だけ
  it("label.axis.remove は軸を消し、最後の軸を消すと [] （off）が残る。config.unset labels.axes は undecided に戻す", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(labelAxisSet, ctx, area);
    await runCommand(labelAxisSet, ctx, kind);
    await expect(runCommand(labelAxisRemove, ctx, { name: "impact" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "No label axis impact",
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
    expect(await shownAxesState(ctx)).toBe("off");
    const reset = await runCommand(configUnset, ctx, { key: "labels.axes" });
    expect(reset.data.labels).toEqual({});
    expect(await fileLabels(ctx)).toBeUndefined();
    expect(await list(ctx)).toEqual({ state: "undecided", axes: [] });
    expect(await shownAxesState(ctx)).toBe("undecided");
  });

  it("label.axis.remove --all は、書いていないボードにも [] を書いて使わないと決めたことを残す。名前と --all は片方だけを受ける", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    await expect(runCommand(labelAxisRemove, ctx, {})).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Give either the name of an axis or --all",
    });
    expect(await fileLabels(ctx)).toBeUndefined();
    expect((await runCommand(labelAxisRemove, ctx, { all: true })).data).toEqual({
      state: "off",
      axes: [],
    });
    expect(await fileLabels(ctx)).toEqual({ axes: [] });
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

/** labels.yaml をデータのディレクトリに置いて索引を作り直す（統合の記録と読めない項目は語彙を書くコマンドでは作れないので、dg の書き込みとして直に書く） */
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
    await runCommand(ticketCreate, ctx, { title: "一", labels: ["ui", "tooling"] });
    const second = await runCommand(ticketCreate, ctx, { title: "二", labels: ["ui", "web"] });
    await runCommand(ticketCreate, ctx, { title: "三", labels: ["tooling"] });
    // 統合済みの名前は書くときに置き換わるので、統合の前に書いたチケットに残った名前として、語彙はチケットの後に書く
    await writeLabels(ctx, vocabulary);
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
    // 統合済みの名前は書くときに置き換わるので、統合の前に書いたチケットに残った名前として、語彙はチケットの後に書く
    const created = await runCommand(ticketCreate, ctx, {
      title: "一",
      labels: ["web", "tooling"],
    });
    await writeLabels(ctx, vocabulary);
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

// 書いてよいかの判定の組み合わせは model/labels.test.ts。ここは書き込みの経路の代表だけを確かめる
describe("語彙を書く（label.add・label.update・label.remove）", () => {
  /** labels.yaml の中身（なければ undefined） */
  const fileVocabulary = async (ctx: CommandContext): Promise<unknown> =>
    parse(await readFile(path.join(ctx.repo.dataDir, "labels.yaml"), "utf8").catch(() => ""));
  const subject = async (ctx: CommandContext) =>
    (await git(ctx.repo.dataDir, ["log", "-1", "--format=%s"])).stdout.trim();

  it("add は名前を小文字にそろえて labels.yaml に足し、update は説明だけを替え、remove は消す。日本語の名前も書ける", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(labelAxisSet, ctx, area);
    const added = await runCommand(labelAdd, ctx, {
      name: "UI",
      axis: "area",
      description: "The board and its panels",
    });
    expect(added.write).toBeDefined();
    expect(added.data).toMatchObject({
      name: "ui",
      axis: "area",
      description: "The board and its panels",
    });
    await runCommand(labelAdd, ctx, { name: "画面", axis: "area", description: "日本語の名前" });
    // 書いた時刻は、書いた記録から取る
    const createdAt = added.data.created_at;
    expect(await fileVocabulary(ctx)).toMatchObject({
      ui: { axis: "area", description: "The board and its panels", created_at: createdAt },
      画面: { axis: "area", description: "日本語の名前" },
    });

    const updated = await runCommand(labelUpdate, ctx, { name: "Ui", description: "画面の全体" });
    expect(updated.data).toEqual({ ...added.data, description: "画面の全体" });
    const removed = await runCommand(labelRemove, ctx, { name: "画面" });
    expect(removed.data).toMatchObject({ name: "画面", axis: "area" });
    expect(await fileVocabulary(ctx)).toEqual({
      ui: { axis: "area", description: "画面の全体", created_at: createdAt },
    });
    // 開き直しても同じ語彙を読み、検証は誤りを出さない
    const again = await reopenInitialized(f);
    expect((await runCommand(labelList, again, {})).data.axes).toEqual([
      {
        ...area,
        labels: [
          {
            name: "ui",
            description: "画面の全体",
            created_at: createdAt,
            count: 0,
            last_used_at: null,
          },
        ],
      },
    ]);
    expect((await runCommand(validate, again, {})).data).toEqual({ ok: true, issues: [] });
  });

  it("拒む語彙は書かない：軸にない語彙・手順の接頭辞・もうある名前・統合済みの名前・説明のない語彙、チケットが使っている語彙の remove、読めない項目の上書き", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(labelAxisSet, ctx, area);
    await runCommand(labelAxisSet, ctx, kind);
    await writeLabels(ctx, [
      "ui:",
      "  axis: area",
      "  description: The board",
      "  created_at: 2026-11-01T00:00:00Z",
      "web:",
      "  axis: area",
      "  description: The web UI",
      "  created_at: 2026-11-01T00:00:00Z",
      "  merged_into: ui",
      "  merged_at: 2026-11-01T00:00:00Z",
      "broken:",
      "  axis: area",
    ]);
    const before = await fileVocabulary(ctx);
    const d = "説明";
    for (const [input, code] of [
      [{ name: "core", axis: "impact", description: d }, "VALIDATION_FAILED"],
      [{ name: "audit-s3", axis: "area", description: d }, "VALIDATION_FAILED"],
      [{ name: "a b", axis: "area", description: d }, "VALIDATION_FAILED"],
      [{ name: "a,b", axis: "area", description: d }, "VALIDATION_FAILED"],
      [{ name: "ui", axis: "kind", description: d }, "ALREADY_EXISTS"],
      [{ name: "web", axis: "area", description: d }, "REJECTED"],
      // 読めなかった項目は語彙にないが、黙って上書きしない
      [{ name: "broken", axis: "area", description: d }, "VALIDATION_FAILED"],
      [{ name: "core", axis: "area", description: "" }, "INVALID_INPUT"],
      [{ name: "core", axis: "area" }, "INVALID_INPUT"],
    ] as const)
      await expect(runCommand(labelAdd, ctx, input)).rejects.toMatchObject({ code });
    await expect(
      runCommand(labelUpdate, ctx, { name: "none", description: d }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const ticket = await runCommand(ticketCreate, ctx, { title: "一", labels: ["ui"] });
    await expect(runCommand(labelRemove, ctx, { name: "ui" })).rejects.toMatchObject({
      code: "REJECTED",
      message: "1 ticket carries the label ui, so it cannot be removed",
      detail: expect.stringContaining(ticket.data.id),
    });
    expect(await fileVocabulary(ctx)).toEqual(before);
  });

  // 語彙の残り方の組み合わせ（--all・統合の記録）は model/label-axes.test.ts。ここは書いた語彙を判定が読む経路の代表だけ
  it("label.axis.remove は語彙が残っている軸を拒み、語彙を消せば消せる", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(labelAxisSet, ctx, area);
    await runCommand(labelAdd, ctx, { name: "ui", axis: "area", description: "The board" });
    await runCommand(labelAdd, ctx, { name: "core", axis: "area", description: "The core" });
    await expect(runCommand(labelAxisRemove, ctx, { name: "area" })).rejects.toMatchObject({
      code: "REJECTED",
      message: "The label axis area still has labels, so it cannot be removed",
      detail: "area: core, ui. Remove the labels first with dg label remove",
    });
    expect((await list(ctx)).axes).toEqual([area]);
    await runCommand(labelRemove, ctx, { name: "ui" });
    await runCommand(labelRemove, ctx, { name: "core" });
    expect((await runCommand(labelAxisRemove, ctx, { name: "area" })).data).toEqual({
      state: "off",
      axes: [],
    });
  });

  it("語彙を書く操作は Workflow の governance.labels で判定する：エージェントは人の承認が要り、承認者が履歴に残る。読むだけの list は判定しない", async () => {
    const f = await initializedLocalFixture();
    const human = await reopenInitialized(f);
    const opened = await openContext({ cwd: f.cloneA, actor: { kind: "agent", user: "claude" } });
    const agent = { ...human, actor: opened.actor };
    const governance = (value: string) =>
      writeWorkflowYaml(human, ["governance:", `  labels: ${value}`]);
    await runCommand(labelAxisSet, human, area);
    const ui = { name: "ui", axis: "area", description: "The board" };

    // workflow.yaml のないボード（Core の既定）でも、エージェントには人の承認が要る
    const asks = (command: string) => ({
      code: "TRANSITION_REJECTED",
      message: `The Workflow asks for a person's approval for dg label ${command} (governance.labels: always_ask)`,
    });
    await expect(runCommand(labelAdd, agent, ui)).rejects.toMatchObject(asks("add"));
    await governance("always_ask");
    await expect(runCommand(labelAdd, agent, ui)).rejects.toMatchObject(asks("add"));
    await expect(
      runCommand(labelUpdate, agent, { name: "ui", description: "d" }),
    ).rejects.toMatchObject(asks("update"));
    await expect(runCommand(labelRemove, agent, { name: "ui" })).rejects.toMatchObject(
      asks("remove"),
    );
    expect((await runCommand(labelList, agent, {})).data.axes).toEqual([{ ...area, labels: [] }]);

    await runCommand(labelAdd, agent, { ...ui, approved_by: "human" });
    expect(await subject(human)).toBe("Add the label ui (approved by claude)");
    await runCommand(labelUpdate, agent, { name: "ui", description: "d", approved_by: "human" });
    expect(await subject(human)).toBe("Update the label ui (approved by claude)");
    await runCommand(labelAdd, human, { name: "web", axis: "area", description: "The web UI" });
    await expect(runCommand(labelMerge, agent, { names: ["web", "ui"] })).rejects.toMatchObject(
      asks("merge"),
    );
    expect(human.store.labels.get("web")?.merged_into).toBeUndefined();
    await runCommand(labelMerge, agent, { names: ["web", "ui"], approved_by: "human" });
    expect(await subject(human)).toBe("Merge the label web into ui (approved by claude)");
    await runCommand(labelRemove, agent, { name: "ui", approved_by: "human" });
    expect(await subject(human)).toBe("Remove the label ui (approved by claude)");
    // 人は聞かずに書ける
    expect((await runCommand(labelAdd, human, ui)).data.name).toBe("ui");

    await governance("human_only");
    await expect(
      runCommand(labelRemove, agent, { name: "ui", approved_by: "human" }),
    ).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
      message: "The Workflow limits dg label remove to a person (governance.labels: human_only)",
    });
    await governance("anyone");
    expect((await runCommand(labelRemove, agent, { name: "ui" })).data.name).toBe("ui");
  });
});

// 統合してよいかの判定の組み合わせは model/labels.test.ts（judgeLabelMerge）。ここは書き込みの経路の代表だけを確かめる
describe("ラベルを統合する（label.merge）", () => {
  const at = "2026-11-01T00:00:00Z";
  const label = (name: string, more: string[] = []) => [
    `${name}:`,
    "  axis: area",
    `  description: The ${name}`,
    `  created_at: ${at}`,
    ...more,
  ];
  const fileVocabulary = async (ctx: CommandContext) =>
    parse(await readFile(path.join(ctx.repo.dataDir, "labels.yaml"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
  const labelsOf = (ctx: CommandContext) =>
    Object.fromEntries([...ctx.store.tickets].map(([id, doc]) => [id, doc.data.labels]));
  const commits = async (ctx: CommandContext) =>
    Number((await git(ctx.repo.dataDir, ["rev-list", "--count", "HEAD"])).stdout.trim());

  it("元を持つチケット（done・abandoned も。墓標は除く）を 1 コミットで書き換え、updated_at は進めない。元は統合の記録になり、行き先が元だった記録は付け替わる", async () => {
    const f = await initializedLocalFixture();
    // 書き込みのたびにコミットする（統合が 1 コミットになることを数える）。文脈は設定を開いたときに読むので、書いてから開く
    await runCommand(configSet, await reopenInitialized(f), {
      key: "commit.mode",
      value: "each",
      local: true,
    });
    const ctx = await reopenInitialized(f);
    await runCommand(labelAxisSet, ctx, area);
    await writeLabels(ctx, [
      ...label("ui"),
      ...label("web"),
      ...label("frontend"),
      ...label("old", ["  merged_into: web", `  merged_at: ${at}`]),
    ]);
    for (const labels of [["web", "bug"], ["frontend", "ui", "web"], ["ui"], ["web"], ["web"]])
      await runCommand(ticketCreate, ctx, { title: "チケット", labels });
    await runCommand(ticketCreate, ctx, { title: "消すチケット", labels: ["web"] });
    await runCommand(ticketMove, ctx, { ticket: "t4", status: "in_progress" });
    await runCommand(ticketMove, ctx, { ticket: "t4", status: "done", override: "PR なし" });
    await runCommand(ticketMove, ctx, { ticket: "t5", status: "abandoned" });
    await runCommand(ticketDelete, ctx, { ticket: "t6" });

    // 統合の時刻を、用意したチケットのどの updated_at よりも後にする（進めていれば値が変わる）
    const mergedAt = "2030-01-01T00:00:00Z";
    const later = await reopenInitialized(f, { now: () => new Date(mergedAt) });
    const updatedAt = Object.fromEntries(
      [...later.store.tickets].map(([id, doc]) => [id, doc.data.updated_at]),
    );
    const before = await commits(later);
    const merged = await runCommand(labelMerge, later, { names: ["Web", "frontend", "UI"] });
    expect(merged.data).toEqual({
      to: { name: "ui", axis: "area", description: "The ui", created_at: at },
      created: false,
      merged: ["web", "frontend"],
      repointed: ["old"],
      count: 4,
      tickets: ["t1", "t2", "t4", "t5"],
    });
    expect(merged.write).toMatchObject({ committed: true });
    // 語彙とチケットの書き換えは 1 コミットに入る
    expect(await commits(later)).toBe(before + 1);
    expect((await git(later.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
    const changed = (
      await git(later.repo.dataDir, ["show", "--name-only", "--format=", "HEAD"])
    ).stdout
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(changed).toEqual(
      [
        "labels.yaml",
        ...[...later.store.tickets.values()]
          .filter((doc) => merged.data.tickets.includes(doc.id))
          .map((doc) => doc.path),
      ].sort(),
    );

    // 開き直して、ファイルに書かれた値を読む
    const again = await reopenInitialized(f);
    expect(labelsOf(again)).toEqual({
      t1: ["ui", "bug"],
      t2: ["ui"],
      t3: ["ui"],
      t4: ["ui"],
      t5: ["ui"],
    });
    expect(again.store.tickets.get("t4")?.data.status).toBe("done");
    expect(again.store.tickets.get("t5")?.data.status).toBe("abandoned");
    expect(
      Object.fromEntries([...again.store.tickets].map(([id, doc]) => [id, doc.data.updated_at])),
    ).toEqual(updatedAt);
    expect(await fileVocabulary(again)).toEqual({
      ui: { axis: "area", description: "The ui", created_at: at },
      web: {
        axis: "area",
        description: "The web",
        created_at: at,
        merged_into: "ui",
        merged_at: mergedAt,
      },
      frontend: {
        axis: "area",
        description: "The frontend",
        created_at: at,
        merged_into: "ui",
        merged_at: mergedAt,
      },
      // 連鎖（old → web → ui）を残さない。統合した時刻は元のまま
      old: {
        axis: "area",
        description: "The old",
        created_at: at,
        merged_into: "ui",
        merged_at: at,
      },
    });
    expect((await runCommand(validate, again, {})).data).toEqual({ ok: true, issues: [] });
  });

  it("語彙にない行き先は --axis と --description で作り（改名）、どちらもなければ拒んで何も書かない。名前が 1 つだけの呼び出しは入力の誤り", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(labelAxisSet, ctx, area);
    await writeLabels(ctx, label("web"));
    const ticket = await runCommand(ticketCreate, ctx, { title: "一", labels: ["web"] });
    const before = await fileVocabulary(ctx);

    await expect(runCommand(labelMerge, ctx, { names: ["web", "site"] })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "No label site to merge into",
    });
    await expect(runCommand(labelMerge, ctx, { names: ["web"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await fileVocabulary(ctx)).toEqual(before);
    expect(labelsOf(ctx)).toEqual({ [ticket.data.id]: ["web"] });

    const renamed = await runCommand(labelMerge, ctx, {
      names: ["web", "Site"],
      axis: "area",
      description: "The site",
    });
    expect(renamed.data).toMatchObject({
      to: { name: "site", axis: "area", description: "The site" },
      created: true,
      merged: ["web"],
      count: 1,
      tickets: [ticket.data.id],
    });
    expect(labelsOf(ctx)).toEqual({ [ticket.data.id]: ["site"] });
    // 書いた時刻は、書いた記録から取る
    expect(await fileVocabulary(ctx)).toEqual({
      web: { ...before["web"], merged_into: "site", merged_at: renamed.data.to.created_at },
      site: { axis: "area", description: "The site", created_at: renamed.data.to.created_at },
    });
    const listed = (await runCommand(labelList, ctx, { merged: true })).data;
    expect(listed.axes[0]?.labels.map((l) => [l.name, l.count])).toEqual([["site", 1]]);
    expect(listed.merged?.map((m) => [m.name, m.merged_into])).toEqual([["web", "site"]]);
  });

  // 一部のチケットだけが新しい名前になった状態を残さない：語彙とすべてのチケットが 1 コミットなので、
  // push が拒否された後の取り込み直しで止まると、書き込みの経路がそのコミットごと捨てる（git/write.ts の dropOwnCommit）
  it("push が拒否されてリモートの変更を取り込み直すあいだに止まったら、自分のコミットを捨てて、どのチケットも語彙も書き換える前に戻る。もう一度呼べば、取り込んだチケットも含めて書き換える", async () => {
    const f = await initializedFixture();
    const a = await reopenInitialized(f);
    await runCommand(labelAxisSet, a, area);
    await writeLabels(a, [...label("ui"), ...label("web")]);
    for (const labels of [["web"], ["web", "ui"], ["web", "bug"]])
      await runCommand(ticketCreate, a, { title: "チケット", labels });
    const b = await openContext({
      cwd: f.cloneB,
      initialize: {},
      actor: { kind: "human", user: "b" },
    });
    // A は書き込みのたびにコミットして push する
    await runCommand(configSet, a, { key: "commit.mode", value: "each", local: true });
    const stopped = new Error("取り込み直しの後で止まる");
    const hooks = {
      beforePush: async () => {
        // A の push の直前に B が先に push し、A の push を拒否させる。取り込み直しの後、もう一度の push の直前で止める
        hooks.beforePush = async () => {
          throw stopped;
        };
        await runCommand(ticketCreate, b, { title: "リモートの変更", labels: ["web"] });
      },
    };
    const racer = await openContext({
      cwd: f.cloneA,
      actor: { kind: "human", user: "eiki" },
      hooks,
    });
    const original = labelsOf(racer);
    const vocabulary = await fileVocabulary(racer);
    await expect(runCommand(labelMerge, racer, { names: ["web", "ui"] })).rejects.toBe(stopped);

    // 取り込んだリモートのチケットは残り、自分の書き換えはどのチケットにも語彙にも残らない（索引もファイルも）
    for (const ctx of [racer, await reopenInitialized(f)]) {
      expect(labelsOf(ctx)).toEqual({ ...original, t4: ["web"] });
      expect(ctx.store.labels.get("web")?.merged_into).toBeUndefined();
      expect(await fileVocabulary(ctx)).toEqual(vocabulary);
    }
    expect((await git(racer.repo.dataDir, ["status", "--porcelain"])).stdout).toBe("");
    expect(
      (await git(racer.repo.dataDir, ["log", "--format=%s", "origin/deguboard..HEAD"])).stdout,
    ).toBe("");

    const again = await reopenInitialized(f);
    const merged = await runCommand(labelMerge, again, { names: ["web", "ui"] });
    expect(merged.write).toMatchObject({ committed: true, pushed: true });
    expect(merged.data).toMatchObject({ count: 4, tickets: ["t1", "t2", "t3", "t4"] });
    expect(labelsOf(again)).toEqual({ t1: ["ui"], t2: ["ui"], t3: ["ui", "bug"], t4: ["ui"] });
  });
});

// 読み替えの組み合わせ（重なり・連鎖・語彙にない名前）は model/labels.test.ts（normalizeLabelNames）。ここは入口ごとの経路の代表だけ
describe("統合済みの名前を統合先へ読み替える（ticket create・update・import・list）", () => {
  const vocabularyLines = [
    "ui:",
    "  axis: area",
    "  description: The board",
    "  created_at: 2026-11-01T00:00:00Z",
    "web:",
    "  axis: area",
    "  description: Old name",
    "  created_at: 2026-11-01T00:00:00Z",
    "  merged_into: ui",
    "  merged_at: 2026-11-02T00:00:00Z",
  ];
  const warning = (use: string) =>
    `The label web was merged into ui, so ui is ${use} instead. Use ui from now on`;

  it("書くときは統合先に置き換えて警告を返し、--label の絞り込みは統合先で探して警告を添える", async () => {
    const f = await initializedLocalFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(labelAxisSet, ctx, area);
    await writeLabels(ctx, vocabularyLines);

    const created = await runCommand(ticketCreate, ctx, { title: "一", labels: ["web", "bug"] });
    expect(created.data.labels).toEqual(["ui", "bug"]);
    expect(created.warnings).toContain(warning("written"));

    const plain = await runCommand(ticketCreate, ctx, { title: "二", labels: ["bug"] });
    expect(plain.warnings).not.toContain(warning("written"));
    const updated = await runCommand(ticketUpdate, ctx, {
      ticket: plain.data.id,
      labels: ["ui", "web"],
    });
    expect(updated.data.labels).toEqual(["ui"]);
    expect(updated.warnings).toContain(warning("written"));

    const imported = await runCommand(ticketImport, ctx, {
      source:
        "- title: 三\n  labels: [web]\n- title: 四\n  labels: [bug]\n- title: 五\n  labels: [web]\n",
    });
    // 同じ古い名前を使う下書きが 2 つあっても、警告は 1 つにまとめる
    expect(imported.data.map((t) => t.labels)).toEqual([["ui"], ["bug"], ["ui"]]);
    expect(imported.warnings.filter((w) => w === warning("written"))).toHaveLength(1);

    // 開き直して、ファイルに書かれた値を読む
    const again = await reopenInitialized(f);
    const listed = await runCommand(ticketList, again, { label: ["web"] });
    expect(listed.data.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t5"]);
    expect(listed.warnings).toEqual([warning("used for the filter")]);
    expect((await runCommand(ticketList, again, { label: ["bug"] })).warnings).toEqual([]);
  });
});
