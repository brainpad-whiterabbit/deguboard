// 振り返りの観点と指標の定義を書くコマンド（retro.perspective・retro.metric・retro.remove。ADR-035）

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  initializedFixture,
  reopenInitialized,
  runCleanups,
} from "../../test/helpers/commands-context.js";
import { runCommand } from "./define.js";
import { retroMetric, retroPerspective, retroRemove } from "./retro.js";
import { configSet, configShow, configUnset, type ConfigShowView } from "./setup.js";

afterEach(runCleanups);

const DEFAULT_IDS = ["outcome", "review", "spec", "slicing", "stability", "cost", "improvement"];

const metric = {
  perspective: "spec",
  id: "first-pass-rate",
  definition: "手直しも重い指摘もなかったチケットの数 ÷ 実装の Run があるチケットの数",
  sources: [
    "dg metrics show --iteration <S> --by ticket (retries, reviews.heavy)",
    "dg ticket list --iteration <S>, status done",
  ],
  unmeasured: "着手の後に受け入れ条件を書き直した回数",
};

describe("振り返りの観点と指標の定義", () => {
  it("retro.metric は承認した定義をチームの config.yaml に書き、config show で読め、同じ ID は丸ごと置き換える", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    const written = await runCommand(retroMetric, ctx, metric);
    // config.set と同じ書き込み（コミットは commit.mode に従う）
    expect(written.write).toBeDefined();
    // 既定の 7 観点の並びのまま、書いた観点にだけ定義が入る
    expect(Object.keys(written.data.perspectives)).toEqual(DEFAULT_IDS);
    expect(written.data.perspectives["spec"]?.metrics).toEqual({
      "first-pass-rate": {
        definition: metric.definition,
        sources: metric.sources,
        unmeasured: metric.unmeasured,
      },
    });
    expect(written.data.perspectives["cost"]?.metrics).toEqual({});
    // ファイルにも入っている（最初の書き込みで既定の観点ごと写る）
    const file = parse(await readFile(path.join(ctx.repo.dataDir, "config.yaml"), "utf8")) as {
      retro: { perspectives: Record<string, { name: string; metrics: Record<string, unknown> }> };
    };
    expect(Object.keys(file.retro.perspectives)).toEqual(DEFAULT_IDS);
    expect(file.retro.perspectives["spec"]?.metrics["first-pass-rate"]).toMatchObject({
      sources: metric.sources,
    });
    const shown = (await runCommand(configShow, ctx, {})).data as ConfigShowView["config"];
    expect(shown.retro.perspectives["spec"]?.metrics["first-pass-rate"]?.definition).toBe(
      metric.definition,
    );
    // 同じ ID は丸ごと置き換える（前の unmeasured を残さない）
    const replaced = await runCommand(retroMetric, ctx, {
      perspective: "spec",
      id: "first-pass-rate",
      definition: "別の数え方",
      sources: ["dg run list --iteration <S>"],
    });
    expect(replaced.data.perspectives["spec"]?.metrics["first-pass-rate"]).toEqual({
      definition: "別の数え方",
      sources: ["dg run list --iteration <S>"],
    });
  });

  it("retro.metric は、ない観点と、数え方か出どころの欠けた定義を弾き、何も書かない", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await expect(
      runCommand(retroMetric, ctx, { ...metric, perspective: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const bad of [
      { ...metric, definition: "" },
      { ...metric, sources: [] },
      { ...metric, id: "First Pass" },
    ])
      await expect(runCommand(retroMetric, ctx, bad)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    const shown = (await runCommand(configShow, ctx, {})).data as ConfigShowView["config"];
    expect(shown.retro.perspectives["spec"]?.metrics).toEqual({});
  });

  it("retro.perspective は観点を足し、ある観点の名前か問いだけを変えて定義を残す。新しい観点は名前と問いの両方が要る", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(retroMetric, ctx, metric);
    const renamed = await runCommand(retroPerspective, ctx, { id: "spec", name: "チケットの質" });
    expect(renamed.data.perspectives["spec"]).toMatchObject({
      name: "チケットの質",
      question: "チケット（受け入れ条件と範囲）は、作り直しなしで通る成果を引き出せたか",
    });
    expect(Object.keys(renamed.data.perspectives["spec"]?.metrics ?? {})).toEqual([
      "first-pass-rate",
    ]);
    await expect(
      runCommand(retroPerspective, ctx, { id: "security", name: "安全" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(runCommand(retroPerspective, ctx, { id: "spec" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const added = await runCommand(retroPerspective, ctx, {
      id: "security",
      name: "安全",
      question: "脆弱性を入れずに済んだか",
    });
    expect(Object.keys(added.data.perspectives)).toEqual([...DEFAULT_IDS, "security"]);
    expect(added.data.perspectives["security"]).toEqual({
      name: "安全",
      question: "脆弱性を入れずに済んだか",
      metrics: {},
    });
  });

  it("retro.remove は指標の定義か観点を消し、config.unset retro.perspectives は既定の観点に戻す。config.set では書けない", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    await runCommand(retroMetric, ctx, metric);
    await expect(
      runCommand(retroRemove, ctx, { perspective: "spec", metric: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const noMetric = await runCommand(retroRemove, ctx, {
      perspective: "spec",
      metric: "first-pass-rate",
    });
    expect(noMetric.data.perspectives["spec"]?.metrics).toEqual({});
    const removed = await runCommand(retroRemove, ctx, { perspective: "slicing" });
    expect(Object.keys(removed.data.perspectives)).toEqual(
      DEFAULT_IDS.filter((id) => id !== "slicing"),
    );
    await expect(runCommand(retroRemove, ctx, { perspective: "slicing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      runCommand(configSet, ctx, { key: "retro.perspectives.spec.name", value: "x" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const reset = await runCommand(configUnset, ctx, { key: "retro.perspectives" });
    expect(Object.keys(reset.data.retro.perspectives)).toEqual(DEFAULT_IDS);
  });

  it("config.set --local retro.* も dg retro のコマンドを案内して弾き、個人の設定に何も書かない", async () => {
    const f = await initializedFixture();
    const ctx = await reopenInitialized(f);
    for (const key of ["retro", "retro.perspectives", "retro.perspectives.spec.name"])
      await expect(
        runCommand(configSet, ctx, { key, value: "x", local: true }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: `${key} cannot be set with config set`,
        detail: expect.stringContaining(
          "dg retro perspective, dg retro metric, and dg retro remove",
        ),
      });
    expect(ctx.store.localConfig).toEqual({});
  });
});
