// コマンドの結合テストのうち、init・用意（setup のコマンド）・仮番号の振り直し。チケット・Epic・Iteration・Plan は commands-*.test.ts

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalOnlyRepo, git } from "../../test/helpers/git-fixture.js";
import { UsageError } from "../errors.js";
import { configFields, defaultConfig } from "../model/config.js";
import { openContext } from "./context.js";
import { runCommand } from "./define.js";
import { epicClose, epicCreate } from "./epic.js";
import { findCommand } from "./index.js";
import { iterationAdd, iterationCreate } from "./iteration.js";
import { planClose, planCreate } from "./plan.js";
import {
  configSet,
  configShow,
  configUnset,
  init,
  lint,
  sync,
  validate,
  type ConfigShowView,
} from "./setup.js";
import { ticketCheck, ticketCreate, ticketMove, ticketUpdate } from "./ticket.js";
import {
  cleanups,
  fixture,
  initialized,
  runCleanups,
} from "../../test/helpers/commands-context.js";

afterEach(runCleanups);

describe("init", () => {
  it("worktree・config・テンプレート・default プロジェクトを置いて push し、2 回目は何も作らない", async () => {
    const f = await fixture();
    const ctx = await openContext({ cwd: f.cloneA, initialize: {} });
    const r = await runCommand(init, ctx, { template: "software-development" });
    expect(r.data.worktree).toBe("orphan");
    expect(r.data.created).toEqual([
      "config.yaml",
      ".gitignore",
      ".gitattributes",
      "workflows/software-development.yaml",
      "workflows/general.yaml",
      "projects/default.yaml",
    ]);
    expect(r.write).toMatchObject({ committed: true, pushed: true });
    expect(ctx.store.projects.get("default")?.data.workflow).toBe("software-development");
    const again = await openContext({ cwd: f.cloneA, initialize: {} });
    const r2 = await runCommand(init, again, {});
    expect(r2.data.worktree).toBe("existing");
    expect(r2.data.created).toEqual([]);
    expect(r2.write).toBeUndefined();
    // 別の clone は リモートから取り込み、何も書かないので書き込みの結果を返さない
    const b = await openContext({ cwd: f.cloneB, initialize: {} });
    expect(b.worktree).toBe("from_remote");
    expect(b.store.workflows.size).toBe(2);
    const rb = await runCommand(init, b, {});
    expect(rb.data).toMatchObject({ worktree: "from_remote", created: [] });
    expect(rb.write).toBeUndefined();
  });

  it("リモートがなくても init と起票ができる", async () => {
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const ctx = await initialized(local.dir);
    expect(ctx.repo.remote).toBeNull();
    const r = await runCommand(ticketCreate, ctx, { title: "オフラインの起票" });
    expect(r.data.id).toBe("t1");
    expect(r.write).toMatchObject({ committed: true, pushed: false, provisional: false });
  });

  it("初期化していないリポジトリでは NOT_INITIALIZED になる", async () => {
    const f = await fixture();
    await expect(openContext({ cwd: f.cloneA })).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
  });
});

describe("用意", () => {
  it("validate と lint が指摘を出し、config.set が 1 項目を変える", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", body: "本文だけ\n" });
    // 雛形のまま（項目が空）
    await runCommand(ticketCreate, ctx, { title: "B", summary: "s" });
    // 概要にだけチェックリストがあっても、受け入れ条件は空
    await runCommand(ticketCreate, ctx, {
      title: "C",
      body: "## 概要\n\n- [ ] x\n\n## 受け入れ条件\n\n- [ ] \n",
    });
    // 項目があれば指摘しない。済みの項目と占位の … も項目として数える
    await runCommand(ticketCreate, ctx, { title: "D", acceptance: ["a"] });
    await runCommand(ticketCreate, ctx, {
      title: "E",
      body: "## 概要\n\ns\n\n## 受け入れ条件\n\n- [x] 済み\n- [ ] …\n",
    });
    await expect(
      runCommand(ticketCreate, ctx, { title: "F", acceptance: ["a\nb"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // done のチケットは未チェックが残っていても（F）、全部付いていても（G）指摘しない。未チェックは照合で done に進めたときだけ sync が警告する
    await runCommand(ticketCreate, ctx, { title: "F", acceptance: ["a", "b", "c"] });
    await runCommand(ticketCheck, ctx, { ticket: "t6", items: [2] });
    await runCommand(ticketMove, ctx, { ticket: "t6", status: "done" });
    await runCommand(ticketCreate, ctx, { title: "G", acceptance: ["a"] });
    await runCommand(ticketCheck, ctx, { ticket: "t7", all: true });
    await runCommand(ticketMove, ctx, { ticket: "t7", status: "done" });
    // 英語の名前の節も日本語と同じに読む（H は指摘なし、I は項目が空）
    await runCommand(ticketCreate, ctx, {
      title: "H",
      body: "## Summary\n\ns\n\n## Acceptance criteria\n\n- [ ] a\n",
    });
    await runCommand(ticketCreate, ctx, {
      title: "I",
      body: "## Summary\n\ns\n\n## Acceptance criteria\n\n- [ ] \n",
    });
    const v = await runCommand(validate, ctx, {});
    expect(v.data.ok).toBe(true);
    const l = await runCommand(lint, ctx, {});
    expect(l.data.issues.map((i) => [i.id, i.code, i.message])).toEqual([
      ["t1", "lint_summary_missing", "The body has no ## Summary (or ## 概要)"],
      [
        "t1",
        "lint_acceptance_missing",
        "The body has no ## Acceptance criteria (or ## 受け入れ条件) section",
      ],
      ["t2", "lint_acceptance_empty", "The acceptance criteria have no items"],
      ["t3", "lint_acceptance_empty", "The acceptance criteria have no items"],
      ["t9", "lint_acceptance_empty", "The acceptance criteria have no items"],
    ]);
    const c = await runCommand(configSet, ctx, { key: "commit.mode", value: "each" });
    expect(c.data.commit.mode).toBe("each");
    expect(c.data.git.remote).toBe("origin");
    // 画面は配列をそのまま渡す。config.show の fields は値と一緒に既定値と説明を返す
    const list = await runCommand(configSet, ctx, {
      key: "actions.test",
      value: ["mise", "run", "check"],
    });
    expect(list.data.actions.test).toEqual(["mise", "run", "check"]);
    const shown = (await runCommand(configShow, ctx, { fields: true })).data as ConfigShowView;
    expect(shown.config.commit.mode).toBe("each");
    expect(shown.fields.find((x) => x.key === "commit.mode")?.default).toBe("batch");
    expect((await runCommand(configShow, ctx, {})).data).toMatchObject({
      commit: { mode: "each" },
    });
    await expect(
      runCommand(configSet, ctx, { key: "commit.mode", value: "nope" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("config.set は文字列の項目に数字だけ・true だけの値を文字列のまま保存し、真偽値・数値・リストの項目は変換して保存する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    // 文字列の項目：数字だけ・true・false だけでも文字列のまま
    const year = await runCommand(configSet, ctx, { key: "git.base_branch", value: "2026" });
    expect(year.data.git.base_branch).toBe("2026");
    const t = await runCommand(configSet, ctx, { key: "git.remote", value: "true" });
    expect(t.data.git.remote).toBe("true");
    const fl = await runCommand(configSet, ctx, { key: "worktree.root", value: "false" });
    expect(fl.data.worktree.root).toBe("false");
    // 真偽値の項目："true"・"false" は真偽値に直し、ほかの文字列は拒む
    const on = await runCommand(configSet, ctx, { key: "auto.merge", value: "true" });
    expect(on.data.auto.merge).toBe(true);
    const off = await runCommand(configSet, ctx, { key: "auto.merge", value: "false" });
    expect(off.data.auto.merge).toBe(false);
    await expect(
      runCommand(configSet, ctx, { key: "auto.merge", value: "yes" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // 数値：スキーマに数値の項目はないので、スキーマにない項目（looseObject が通す）で今のとおり数値に直すことを確かめる
    const n = await runCommand(configSet, ctx, { key: "git.depth", value: "3" });
    expect((n.data.git as Record<string, unknown>).depth).toBe(3);
    // リストの項目：カンマ区切りで配列に。数字だけ・true だけの要素も文字列のまま、空文字は空の配列
    const list = await runCommand(configSet, ctx, {
      key: "actions.test",
      value: "mise, run,2026",
    });
    expect(list.data.actions.test).toEqual(["mise", "run", "2026"]);
    const one = await runCommand(configSet, ctx, { key: "actions.test", value: "true" });
    expect(one.data.actions.test).toEqual(["true"]);
    const empty = await runCommand(configSet, ctx, { key: "actions.test", value: "" });
    expect(empty.data.actions.test).toEqual([]);
    // 読み直しても保存した値のまま
    const shown = (await runCommand(configShow, ctx, {})).data as ConfigShowView["config"];
    expect(shown.git).toMatchObject({ base_branch: "2026", remote: "true", depth: 3 });
    expect(shown.auto.merge).toBe(false);
  });

  it("config.set は enum の項目（commit.mode）を空・null・値の省略にしても既定に戻さず弾き、値は変わらない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(configSet, ctx, { key: "commit.mode", value: "each" });
    for (const value of ["", null, undefined]) {
      await expect(runCommand(configSet, ctx, { key: "commit.mode", value })).rejects.toMatchObject(
        { code: "VALIDATION_FAILED" },
      );
    }
    const shown = (await runCommand(configShow, ctx, {})).data as ConfigShowView["config"];
    expect(shown.commit.mode).toBe("each");
  });

  it("config.set は空にすると既定に戻る項目（clears_to_default）を空にすると既定に戻し、既定が空の項目は空のまま、配列の項目は空の配列にする", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const defaults = defaultConfig();
    // 空の扱いは項目の定義の clears_to_default で決まる（既定が空でない文字列の項目だけ true）
    const byKey = new Map(configFields().map((x) => [x.key, x]));
    expect(byKey.get("priority.high")?.clears_to_default).toBe(true);
    expect(byKey.get("default_project")?.clears_to_default).toBe(true);
    expect(byKey.get("models.light")?.clears_to_default).toBe(false);
    expect(byKey.get("actor.human_only")?.clears_to_default).toBe(false);
    // priority.* を書き換えてから空にすると、Core の既定の文に戻る
    await runCommand(configSet, ctx, { key: "priority.high", value: "独自の基準" });
    const cleared = await runCommand(configSet, ctx, { key: "priority.high", value: "" });
    expect(cleared.data.priority.high).toBe(defaults.priority.high);
    // 読み直しても既定のまま。キーを消すので config.yaml には書かれない
    const shown = (await runCommand(configShow, ctx, {})).data as ConfigShowView["config"];
    expect(shown.priority.high).toBe(defaults.priority.high);
    // 最上位の文字列の項目（既定 "default"）も空で既定に戻る
    await runCommand(configSet, ctx, { key: "default_project", value: "other" });
    const proj = await runCommand(configSet, ctx, { key: "default_project", value: "" });
    expect(proj.data.default_project).toBe("default");
    // 既定が空の項目（models.*）は空のまま
    await runCommand(configSet, ctx, { key: "models.light", value: "sonnet" });
    const light = await runCommand(configSet, ctx, { key: "models.light", value: "" });
    expect(light.data.models.light).toBe("");
    // 配列の項目は空にすると空の配列（既定の空に一致）
    await runCommand(configSet, ctx, { key: "actor.human_only", value: "epic.close" });
    const human = await runCommand(configSet, ctx, { key: "actor.human_only", value: "" });
    expect(human.data.actor.human_only).toEqual([]);
  });

  it("config.set --local は個人の設定（deguboard-local/config.yaml）に書き、各コマンドは個人 > チーム > 既定 の値を使い、コミットも push もしない（t437）", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(configSet, ctx, { key: "models.light", value: "team-light" });
    await runCommand(configSet, ctx, { key: "commit.mode", value: "each" });
    const head = (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout;
    const status = (await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout;
    const remoteHead = (await git(f.remoteDir, ["rev-parse", "deguboard"])).stdout;
    const teamFile = await readFile(path.join(ctx.repo.dataDir, "config.yaml"), "utf8");

    const set = await runCommand(configSet, ctx, {
      key: "models.light",
      value: "my-light",
      local: true,
    });
    expect(set.data.models.light).toBe("my-light");
    expect(set.write).toBeUndefined();
    await runCommand(configSet, ctx, { key: "commit.mode", value: "manual", local: true });
    await runCommand(configSet, ctx, { key: "notify.approvals", value: "false", local: true });
    // 個人のファイルに入り、チームのファイル・コミット・リモートは変わらない
    const localFile = path.join(ctx.repo.localDir, "config.yaml");
    const text = await readFile(localFile, "utf8");
    expect(text).toContain("light: my-light");
    expect(text).toContain("mode: manual");
    expect(text).toContain("approvals: false");
    expect(await readFile(path.join(ctx.repo.dataDir, "config.yaml"), "utf8")).toBe(teamFile);
    expect((await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect((await git(ctx.repo.dataDir, ["status", "--porcelain"])).stdout).toBe(status);
    expect((await git(f.remoteDir, ["rev-parse", "deguboard"])).stdout).toBe(remoteHead);
    // 開き直した文脈（ほかのコマンド）も重ねた値を読む。チームの値はそのまま
    const again = await openContext({ cwd: f.cloneA, actor: { kind: "human", user: "eiki" } });
    expect(again.config.models.light).toBe("my-light");
    expect(again.config.commit.mode).toBe("manual");
    expect(again.config.notify.approvals).toBe(false);
    expect(again.store.teamConfig.models.light).toBe("team-light");
    expect(again.store.teamConfig.commit.mode).toBe("each");
    // 別の clone には届かない（Git に入らない）
    const other = await openContext({ cwd: f.cloneB, initialize: {} });
    expect(other.store.localConfig).toEqual({});
    expect(other.config.models.light).not.toBe("my-light");
    // 文字列の項目に空文字を入れると個人の上書きを外す（既定が空でない default_project）
    await runCommand(configSet, ctx, { key: "default_project", value: "mine", local: true });
    expect(ctx.store.config.default_project).toBe("mine");
    const cleared = await runCommand(configSet, ctx, {
      key: "default_project",
      value: "",
      local: true,
    });
    expect(cleared.data.default_project).toBe("default");
    expect(await readFile(localFile, "utf8")).not.toContain("default_project");
  });

  it("config.set --local はチーム専用・未知の項目と不正な値を VALIDATION_FAILED で拒み、個人のファイルに書かない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const localFile = path.join(ctx.repo.localDir, "config.yaml");
    for (const [key, value] of [
      ["auto.merge", "true"],
      ["metrics.read_transcripts", "true"],
      ["git.base_branch", "develop"],
      ["actor.human_only", "epic.close"],
      ["nope.key", "x"],
      ["commit.mode", "nope"],
    ]) {
      await expect(runCommand(configSet, ctx, { key, value, local: true })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }
    await expect(readFile(localFile, "utf8")).rejects.toThrow();
    // チームの値も変わっていない
    expect(ctx.store.config.auto.merge).toBe(false);
    expect(ctx.store.config.commit.mode).toBe("batch");
  });

  it("config.unset は --local で個人の上書きを外してチームの値に戻し、--local なしでチームの値を既定に戻す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const localFile = path.join(ctx.repo.localDir, "config.yaml");
    await runCommand(configSet, ctx, { key: "commit.mode", value: "each" });
    await runCommand(configSet, ctx, { key: "commit.mode", value: "manual", local: true });
    await runCommand(configSet, ctx, { key: "models.heavy", value: "opus", local: true });
    expect(ctx.store.config.commit.mode).toBe("manual");
    const head = (await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout;

    const unsetLocal = await runCommand(configUnset, ctx, { key: "commit.mode", local: true });
    expect(unsetLocal.data.commit.mode).toBe("each");
    expect(unsetLocal.write).toBeUndefined();
    expect(await readFile(localFile, "utf8")).not.toContain("commit");
    expect((await git(ctx.repo.dataDir, ["rev-parse", "HEAD"])).stdout).toBe(head);
    // 上書きが残らなければ個人のファイルを消す
    await runCommand(configUnset, ctx, { key: "models.heavy", local: true });
    await expect(readFile(localFile, "utf8")).rejects.toThrow();
    expect(ctx.store.localConfig).toEqual({});
    // チーム専用の項目は --local で外せない（個人の設定には入らない）
    await expect(
      runCommand(configUnset, ctx, { key: "auto.merge", local: true }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // --local なしはチームの config.yaml からキーを消して既定に戻す。ほかの書き込みと同じ経路（withWrite）を通る
    const unsetTeam = await runCommand(configUnset, ctx, { key: "commit.mode" });
    expect(unsetTeam.data.commit.mode).toBe("batch");
    expect(unsetTeam.write).toBeDefined();
    expect(await readFile(path.join(ctx.repo.dataDir, "config.yaml"), "utf8")).not.toContain(
      "commit",
    );
    // 選択肢の項目も unset なら既定に戻せる（set の空は弾く）。配列の項目は空の配列に
    await runCommand(configSet, ctx, { key: "actor.human_only", value: "epic.close" });
    const human = await runCommand(configUnset, ctx, { key: "actor.human_only" });
    expect(human.data.actor.human_only).toEqual([]);
  });

  it("個人のファイルにあるチーム専用・未知の項目と読めない値は無視して validate が警告し、チームの set は個人の上書きを写さない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await mkdir(ctx.repo.localDir, { recursive: true });
    await writeFile(
      path.join(ctx.repo.localDir, "config.yaml"),
      [
        "commit:",
        "  mode: each",
        "auto:",
        "  merge: true",
        "push:",
        "  mode: なし",
        "unknown_key: 1",
        "",
      ].join("\n"),
    );
    const reopened = await openContext({ cwd: f.cloneA, actor: { kind: "human", user: "eiki" } });
    expect(reopened.config.commit.mode).toBe("each");
    expect(reopened.config.auto.merge).toBe(false);
    expect(reopened.config.push.mode).toBe("auto");
    const v = await runCommand(validate, reopened, {});
    expect(v.data.ok).toBe(true);
    expect(v.data.issues.map((i) => [i.severity, i.path, i.code, i.message])).toEqual([
      [
        "warning",
        "deguboard-local/config.yaml",
        "local_config_ignored",
        "Ignored the personal setting auto.merge",
      ],
      [
        "warning",
        "deguboard-local/config.yaml",
        "local_config_ignored",
        "Ignored the personal setting push.mode",
      ],
      [
        "warning",
        "deguboard-local/config.yaml",
        "local_config_ignored",
        "Ignored the personal setting unknown_key",
      ],
    ]);
    // 同じ最上位（commit）のチームの項目を変えても、個人の上書き（each）はチームのファイルに写らない
    await runCommand(configSet, reopened, { key: "commit.extra", value: "1" });
    const teamText = await readFile(path.join(reopened.repo.dataDir, "config.yaml"), "utf8");
    expect(teamText).toContain("extra: 1");
    expect(teamText).not.toContain("each");
    expect(reopened.store.teamConfig.commit.mode).toBe("batch");
    expect(reopened.store.config.commit.mode).toBe("each");
    // 個人の set は、前から無視されていた項目を残したまま書ける
    await runCommand(configSet, reopened, { key: "models.light", value: "l", local: true });
    const localText = await readFile(path.join(reopened.repo.localDir, "config.yaml"), "utf8");
    expect(localText).toContain("unknown_key: 1");
    expect(localText).toContain("light: l");
    // YAML として読めなければ警告して無視し、チームの値で動く
    await writeFile(path.join(ctx.repo.localDir, "config.yaml"), "commit: [\n");
    const broken = await openContext({ cwd: f.cloneA, actor: { kind: "human", user: "eiki" } });
    expect(broken.config.commit.mode).toBe("batch");
    const bv = await runCommand(validate, broken, {});
    expect(bv.data.ok).toBe(true);
    expect(bv.data.issues.map((i) => [i.severity, i.code])).toEqual([["warning", "yaml_error"]]);
  });

  it("config.show --fields は項目ごとの scope と、チームの値・個人の上書きを返す", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(configSet, ctx, { key: "models.light", value: "team-light" });
    await runCommand(configSet, ctx, { key: "models.light", value: "my-light", local: true });
    await runCommand(configSet, ctx, { key: "actions.shell", value: "true", local: true });
    const shown = (await runCommand(configShow, ctx, { fields: true })).data as ConfigShowView;
    expect(shown.config.models.light).toBe("my-light");
    expect(shown.team.models.light).toBe("team-light");
    expect(shown.local).toEqual({ "models.light": "my-light", "actions.shell": true });
    const byKey = new Map(shown.fields.map((x) => [x.key, x]));
    expect(byKey.get("models.light")?.scope).toBe("local");
    expect(byKey.get("auto.merge")?.scope).toBe("team");
    // 空にすると既定に戻るか（設定画面が読む）。既定が空でない文字列の項目だけ true
    expect(byKey.get("git.remote")?.clears_to_default).toBe(true);
    expect(byKey.get("models.light")?.clears_to_default).toBe(false);
    expect(byKey.get("auto.merge")?.clears_to_default).toBe(false);
    // --fields なしは重ねた値だけ
    expect((await runCommand(configShow, ctx, {})).data).toMatchObject({
      models: { light: "my-light" },
    });
  });

  it("validate は読めない Run のファイルを指摘し、ほかの読み込みは止めない", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await runCommand(ticketCreate, ctx, { title: "A", summary: "s", acceptance: ["a"] });
    const run = {
      id: "r20261031-041500-3fa2",
      ticket: "t1",
      step: "implement",
      agent: "claude-code",
      model: null,
      started_at: "2026-10-31T04:15:00Z",
      finished_at: "2026-10-31T05:00:00Z",
      result: "success",
      error: null,
      retries: 0,
      usage: { input: 10, output: null, cache_read: null, cache_write: null, estimated: true },
    };
    await mkdir(path.join(ctx.repo.dataDir, "runs"), { recursive: true });
    await writeFile(
      path.join(ctx.repo.dataDir, "runs/r20261031-041500-3fa2.json"),
      JSON.stringify(run),
    );
    await writeFile(path.join(ctx.repo.dataDir, "runs/r20261031-041600-0000.json"), "{");
    const v = await runCommand(validate, ctx, {});
    expect(v.data.ok).toBe(false);
    expect(v.data.issues.map((i) => [i.path, i.code])).toEqual([
      ["runs/r20261031-041600-0000.json", "json_error"],
    ]);
    expect(ctx.store.runs.get("r20261031-041500-3fa2")?.data.usage.estimated).toBe(true);
    expect(ctx.store.tickets.has("t1")).toBe(true);
  });

  it("lint は閉じた Epic に残る終わっていないチケットと、すべて終わったのに開いている Epic・Plan を指摘する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const acceptance = ["a"];
    await runCommand(epicCreate, ctx, { title: "閉じた", summary: "s" });
    await runCommand(epicCreate, ctx, { title: "終わった", summary: "s" });
    await runCommand(epicCreate, ctx, { title: "途中", summary: "s" });
    await runCommand(ticketCreate, ctx, { title: "A", summary: "s", acceptance, epic: "e1" });
    await runCommand(ticketCreate, ctx, { title: "B", summary: "s", acceptance, epic: "e2" });
    await runCommand(ticketCreate, ctx, { title: "C", summary: "s", acceptance, epic: "e3" });
    await runCommand(ticketCreate, ctx, { title: "D", summary: "s", acceptance, epic: "e3" });
    await runCommand(epicClose, ctx, { epic: "e1", force: true });
    await runCommand(planCreate, ctx, { tickets: ["t2"] });
    await runCommand(planCreate, ctx, { tickets: ["t3"] });
    for (const ticket of ["t2", "t3"])
      await runCommand(ticketMove, ctx, { ticket, status: "done" });
    await runCommand(planClose, ctx, { plan: "p2" });
    const l = await runCommand(lint, ctx, {});
    expect(l.data.issues.map((i) => [i.id, i.code, i.message])).toEqual([
      ["e1", "lint_epic_closed_unfinished", "Unfinished tickets t1 remain in a closed Epic"],
      ["e2", "lint_epic_finished_open", "All tickets are finished, but the Epic is open"],
      ["p1", "lint_plan_finished_open", "All tickets are finished, but the Plan is open"],
    ]);
  });

  it("lint は Plan を作った後の depends_on の変更でできた after とまたぐ循環を、開いた Plan だけ経路つきで指摘する", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const acceptance = ["a"];
    await runCommand(ticketCreate, ctx, { title: "A", summary: "s", acceptance });
    await runCommand(ticketCreate, ctx, { title: "B", summary: "s", acceptance });
    await runCommand(planCreate, ctx, { tickets: ["t1", "t2"], after: { t1: "t2" } });
    // 作ったときは循環しないが、後から t2 が t1 を待つようにするとまたぐ循環になる（update は拒否しない）
    await runCommand(ticketUpdate, ctx, { ticket: "t2", depends_on: ["t1"] });
    const l = await runCommand(lint, ctx, {});
    expect(l.data.issues.map((i) => [i.id, i.code, i.message])).toEqual([
      [
        "p1",
        "lint_plan_wait_cycle",
        "after and depends_on form a cycle: t1 →(after) t2 →(depends_on) t1",
      ],
    ]);
    // 終わったチケットは待ちにならないので、そこを通る循環は指摘しない
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "abandoned" });
    const through = await runCommand(lint, ctx, {});
    expect(through.data.issues.map((i) => i.code)).not.toContain("lint_plan_wait_cycle");
    // Plan の外の t3 まで回る循環は経路つきで指摘し、t3 が終わると（終わったチケットへの depends_on は待ちにならないので）指摘しない
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "todo" });
    await runCommand(ticketCreate, ctx, {
      title: "C",
      summary: "s",
      acceptance,
      depends_on: ["t1"],
    });
    await runCommand(ticketUpdate, ctx, { ticket: "t2", depends_on: ["t3"] });
    const outer = await runCommand(lint, ctx, {});
    expect(outer.data.issues.map((i) => i.message)).toEqual([
      "after and depends_on form a cycle: t1 →(after) t2 →(depends_on) t3 →(depends_on) t1",
    ]);
    await runCommand(ticketMove, ctx, { ticket: "t3", status: "done" });
    const outerDone = await runCommand(lint, ctx, {});
    expect(outerDone.data.issues.map((i) => i.code)).not.toContain("lint_plan_wait_cycle");
    // 閉じた Plan は指摘しない
    await runCommand(planClose, ctx, { plan: "p1" });
    const closed = await runCommand(lint, ctx, {});
    expect(closed.data.issues.map((i) => i.code)).not.toContain("lint_plan_wait_cycle");
  });

  it("lint.require_iteration が true のときだけ、Iteration に入らずに todo・abandoned 以外に進んだチケットを指摘し、閉じた Epic の done は除く", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    const acceptance = ["a"];
    await runCommand(epicCreate, ctx, { title: "閉じた", summary: "s" });
    await runCommand(epicCreate, ctx, { title: "開いた", summary: "s" });
    await runCommand(iterationCreate, ctx, { name: "Sprint 1" });
    // t1: todo / t2: abandoned / t3: in_progress / t4: Iteration に入った in_progress
    // t5: 閉じた Epic の done / t6: 開いた Epic の done / t7: Epic のない done / t8: 閉じた Epic の in_progress
    for (const title of ["A", "B", "C", "D"])
      await runCommand(ticketCreate, ctx, { title, summary: "s", acceptance });
    await runCommand(ticketCreate, ctx, { title: "E", summary: "s", acceptance, epic: "e1" });
    await runCommand(ticketCreate, ctx, { title: "F", summary: "s", acceptance, epic: "e2" });
    await runCommand(ticketCreate, ctx, { title: "G", summary: "s", acceptance });
    await runCommand(ticketCreate, ctx, { title: "H", summary: "s", acceptance, epic: "e1" });
    await runCommand(iterationAdd, ctx, { iteration: "s1", tickets: ["t4"] });
    await runCommand(ticketMove, ctx, { ticket: "t2", status: "abandoned" });
    for (const ticket of ["t3", "t4", "t8"])
      await runCommand(ticketMove, ctx, { ticket, status: "in_progress" });
    for (const ticket of ["t5", "t6", "t7"])
      await runCommand(ticketMove, ctx, { ticket, status: "done" });
    await runCommand(epicClose, ctx, { epic: "e1", force: true });
    const missing = async () =>
      (await runCommand(lint, ctx, {})).data.issues
        .filter((i) => i.code === "lint_iteration_missing")
        .map((i) => [i.id, i.message]);
    // 既定（false）では指摘しない
    expect(ctx.store.config.lint.require_iteration).toBe(false);
    expect(await missing()).toEqual([]);
    const c = await runCommand(configSet, ctx, { key: "lint.require_iteration", value: "true" });
    expect(c.data.lint.require_iteration).toBe(true);
    expect(await missing()).toEqual([
      ["t3", "Moved to in_progress without being in an Iteration"],
      ["t6", "Moved to done without being in an Iteration"],
      ["t7", "Moved to done without being in an Iteration"],
      ["t8", "Moved to in_progress without being in an Iteration"],
    ]);
    await runCommand(configSet, ctx, { key: "lint.require_iteration", value: "false" });
    expect(await missing()).toEqual([]);
  });

  it("入力の形が違えば UsageError、sprint は iteration のエイリアス", async () => {
    const f = await fixture();
    const ctx = await initialized(f.cloneA);
    await expect(runCommand(ticketCreate, ctx, { title: "" })).rejects.toBeInstanceOf(UsageError);
    expect(findCommand("sprint.create")?.name).toBe("iteration.create");
    expect(findCommand("ticket.nope")).toBeUndefined();
  });
});

describe("仮番号の振り直し（DT-5）", () => {
  it("オフラインで起票した仮番号がリモートの番号と衝突したら、sync が番号・ファイル名・参照・コミットの題を振り直して push する", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    const b = await initialized(f.cloneB);

    // A はオフラインで t1・t2（t1 に依存）を起票する。push できないので仮番号
    await git(f.cloneA, ["remote", "set-url", "origin", path.join(f.root, "nonexistent.git")]);
    const a1 = await runCommand(ticketCreate, a, { title: "A の 1" });
    expect(a1.data.id).toBe("t1");
    expect(a1.write).toMatchObject({ pushed: false, provisional: true });
    const a2 = await runCommand(ticketCreate, a, { title: "A の 2", depends_on: ["t1"] });
    expect(a2.data).toMatchObject({ id: "t2", depends_on: ["t1"] });
    expect(a.store.tickets.get("t2")?.data.provisional).toBe(true);

    // その間に B がオンラインで t1 を起票して push する
    const b1 = await runCommand(ticketCreate, b, { title: "B の 1" });
    expect(b1.data.id).toBe("t1");
    expect(b1.write).toMatchObject({ pushed: true });

    // A がオンラインに戻って sync する。A の t1 は衝突するので次の空き番号 t3 になり、t2 の依存も追従する
    await git(f.cloneA, ["remote", "set-url", "origin", f.remoteDir]);
    const synced = await runCommand(sync, a, {});
    expect(synced.data.renumbered).toEqual([{ from: "t1", to: "t3" }]);
    expect(synced.data.conflicts).toEqual([]);
    expect(synced.data.pushed).toBe(true);
    expect(synced.data.confirmed.sort()).toEqual(["t2", "t3"]);
    expect(a.store.tickets.get("t1")?.data.title).toBe("B の 1");
    expect(a.store.tickets.get("t3")?.data.title).toBe("A の 1");
    expect(a.store.tickets.get("t3")?.data.provisional).toBeUndefined();
    expect(a.store.tickets.get("t2")?.data.depends_on).toEqual(["t3"]);
    await expect(
      readFile(path.join(a.repo.dataDir, "tickets", "t3.md"), "utf8"),
    ).resolves.toContain("id: t3");
    const log = (await git(a.repo.dataDir, ["log", "--format=%s"])).stdout.trim().split("\n");
    expect(log).toContain("File t3: A の 1");
    expect(log).toContain("File t1: B の 1");
    expect(log.some((m) => m === "File t1: A の 1")).toBe(false);

    // B が取り込むと同じ 3 件が見える
    await runCommand(sync, b, {});
    expect([...b.store.tickets.values()].map((t) => `${t.id}:${t.data.title}`).sort()).toEqual([
      "t1:B の 1",
      "t2:A の 2",
      "t3:A の 1",
    ]);
    expect(b.store.tickets.get("t2")?.data.depends_on).toEqual(["t3"]);
  });

  it("仮番号でない競合はこれまでどおり報告し、何も書き換えない", async () => {
    const f = await fixture();
    const a = await initialized(f.cloneA);
    const b = await initialized(f.cloneB);
    await runCommand(ticketCreate, a, { title: "共通" });
    await runCommand(sync, b, {});
    // 同じチケットの同じ項目を両方で変えて、まとめてコミットしてから push を競わせる
    await runCommand(ticketUpdate, a, { ticket: "t1", title: "A が変えた" });
    await runCommand(ticketUpdate, b, { ticket: "t1", title: "B が変えた" });
    expect((await runCommand(sync, b, {})).data.pushed).toBe(true);
    const synced = await runCommand(sync, a, {});
    expect(synced.data.conflicts).toEqual(["tickets/t1.md"]);
    expect(synced.data.renumbered).toEqual([]);
    expect(a.store.tickets.get("t1")?.data.title).toBe("A が変えた");
  });
});
