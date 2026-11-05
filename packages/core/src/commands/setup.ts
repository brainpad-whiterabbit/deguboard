// 用意と同期：init・sync・commit・validate・lint・config（show・set・unset）・whoami

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OperationError } from "../errors.js";
import { collectBranchFacts } from "../git/facts.js";
import { withLock } from "../git/lock.js";
import { renumberProvisional, type Renumbered } from "../git/renumber.js";
import { ensureGitattributes, ensureMergeDriver } from "../git/merge.js";
import {
  commitAll,
  commitPaths,
  fetchAll,
  integrate,
  isDirty,
  push,
  syncStatus,
} from "../git/sync.js";
import { CONFLICT_REMEDY, flushPending, withWrite } from "../git/write.js";
import { ownActorIds, type ActorKind, type UserSource } from "../model/actor.js";
import { isTerminal } from "../model/common.js";
import {
  configFields,
  configSchema,
  nestedConfigValue,
  type Config,
  type ConfigField,
} from "../model/config.js";
import type { Iteration } from "../model/iteration.js";
import { parseAcceptance, type Ticket } from "../model/ticket.js";
import type { Doc } from "../storage/documents.js";
import { pathExists } from "../storage/exists.js";
import { checkReferences } from "../storage/integrity.js";
import type { Issue } from "../storage/issue.js";
import { CONFIG_FILE, workflowPath } from "../storage/paths.js";
import type { WorkflowEntry } from "../storage/store.js";
import { cyclePath, findCrossingCycle } from "../storage/wait-cycle.js";
import { reconcileStatus, regressionWarnings } from "../workflow/reconcile.js";
import { WORKFLOW_TEMPLATES } from "../workflow/templates/index.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { nowIso, sortedDocs } from "./helpers.js";

const TEMPLATE_IDS = WORKFLOW_TEMPLATES.map((t) => t.id) as [string, ...string[]];

export const init = defineCommand({
  name: "init",
  group: "setup",
  summary:
    "deguboard ブランチと専用 worktree を用意し、default プロジェクトとテンプレートの Workflow を置く",
  input: z.object({
    template: z
      .enum(TEMPLATE_IDS)
      .optional()
      .describe("default プロジェクトの Workflow。省略時は general"),
    remote: z.string().optional().describe("同期先のリモート。省略時は origin"),
    base_branch: z.string().optional().describe("作業ブランチの元。省略時は main"),
  }),
  write: true,
  needs: "repo",
  async run(ctx, input) {
    await ensureMergeDriver(ctx.repo, ctx.mergeDriver);
    const result = await withWrite(
      ctx,
      async () => {
        const store = ctx.store;
        const created: string[] = [];
        const configPath = path.join(store.root, CONFIG_FILE);
        if (!(await pathExists(configPath))) {
          await store.writeConfig({
            default_project: "default",
            git: { remote: input.remote ?? "origin", base_branch: input.base_branch ?? "main" },
          });
          created.push(CONFIG_FILE);
        }
        const ignorePath = path.join(store.root, ".gitignore");
        if (!(await pathExists(ignorePath))) {
          // 原子的書き込みの一時ファイルをコミットに入れない
          await writeFile(ignorePath, "*.tmp\n");
          created.push(".gitignore");
        }
        // frontmatter のフィールド単位のマージドライバ（SY-4）
        if (await ensureGitattributes(store.root)) created.push(".gitattributes");
        for (const t of WORKFLOW_TEMPLATES) {
          // 誤りがあって索引から外れた Workflow も、ファイルがあれば書き換えない（WF-4）
          if (await pathExists(path.join(store.root, workflowPath(t.id)))) continue;
          await store.writeWorkflow(
            t as Record<string, unknown>,
            `${t.name} のワークフロー。dg init が同梱のテンプレートから置いた`,
          );
          created.push(workflowPath(t.id));
        }
        if (!store.projects.has("default")) {
          await store.create("project", {
            id: "default",
            name: "Default",
            description: "",
            workflow: input.template ?? "general",
            status: "active",
          });
          created.push("projects/default.yaml");
        }
        return created;
      },
      { message: "deguboard を初期化", immediate: true },
    );
    return ok(
      {
        data_dir: ctx.repo.dataDir,
        worktree: ctx.worktree ?? "existing",
        remote: ctx.repo.remote,
        created: result.value,
      },
      // 何も書かなかった init（2 回目や、リモートから取り込んだ 2 人目の clone）は書き込みの結果を返さない。
      // committed: false を返すと入口が「作業ツリーに残した」と案内してしまう。取り込みの警告は残す
      result.write.committed ? result.write : undefined,
      result.write.committed ? [] : result.write.warnings,
    );
  },
});

/** Workflow が pr_* を参照していれば gh を呼ぶ */
function needsPr(wf: WorkflowEntry): boolean {
  const refs = [
    ...wf.resolved.reconcile.flatMap((r) => r.when),
    ...wf.resolved.transitions.flatMap((t) => t.requires),
  ];
  return refs.some((c) => c.replace(/^!/, "").startsWith("pr_"));
}

export interface ReconciledTicket {
  id: string;
  from: string;
  to: string;
  /** 当てはまった reconcile 規則の条件（根拠の事実。例：["pr_merged"]） */
  when: string[];
}

export interface Reconciled {
  /** 状態を進めたチケット */
  changed: ReconciledTicket[];
  /** PR 番号を記録したチケット（ST-6） */
  prRecorded: Array<{ id: string; pr: number }>;
}

/** 照合（ST-4〜ST-6）。状態を進めたチケットと、PR 番号を記録したチケットを返す */
async function reconcileAll(ctx: CommandContext, warnings: string[]): Promise<Reconciled> {
  const changed: ReconciledTicket[] = [];
  const prRecorded: Array<{ id: string; pr: number }> = [];
  const targets = [...ctx.store.tickets.values()].filter(
    (t): t is Doc<Ticket> & { data: Ticket & { branch: string } } =>
      t.data.branch !== undefined && !isTerminal(t.data.status),
  );
  for (const doc of targets) {
    const wf = ctx.store.workflowFor(doc.data);
    if (!wf) {
      warnings.push(`${doc.id}: Workflow が読めないので照合しない`);
      continue;
    }
    const { facts, pr, prMissing, ignoredPr } = await collectBranchFacts(
      ctx.repo,
      doc.data.branch,
      {
        pr: doc.data.pr,
        needPr: needsPr(wf),
        status: doc.data.status,
        since: doc.data.branch_at ?? doc.data.created_at,
      },
    );
    facts.deps_done = ctx.store.depsDone(doc.data);
    if (ignoredPr) {
      warnings.push(
        `${doc.id}: ブランチ名で見つけた PR #${ignoredPr.number} は branch を記録する前（${ignoredPr.mergedAt}）にマージされたので、同じ名前の前の作業の PR とみなして照合に使わない。このチケットの PR なら ticket update --pr ${ignoredPr.number} で記録すれば照合する`,
      );
    }
    const outcome = reconcileStatus(wf.resolved, doc.data.status, facts);
    // done に進むなら、消えたブランチは正常（マージ後に消した）なので警告しない
    if (!(outcome.kind === "advance" && outcome.to === "done")) {
      for (const w of regressionWarnings(doc.data.status, facts, { prMissing }))
        warnings.push(`${doc.id}: ${w}`);
    }
    // ブランチ名で見つけた PR の番号は、状態が進まなくても記録する（記録済みなら触れない）
    const patch: Record<string, unknown> = {};
    if (pr !== undefined && doc.data.pr === undefined) {
      patch["pr"] = pr;
      prRecorded.push({ id: doc.id, pr });
    }
    if (outcome.kind === "advance") {
      patch["status"] = outcome.to;
      changed.push({
        id: doc.id,
        from: doc.data.status,
        to: outcome.to,
        when: [...outcome.rule.when],
      });
    }
    if (Object.keys(patch).length > 0) {
      await ctx.store.update("ticket", doc.id, { ...patch, updated_at: nowIso(ctx) });
    }
    if (outcome.kind === "advance") {
      // 遷移は止めず、受け入れ条件の確認が残っていることだけ知らせる（TK-5）
      const left = uncheckedAcceptance(doc);
      if (outcome.to === "done" && left.length > 0) {
        warnings.push(
          `${doc.id}: 受け入れ条件 ${left.join(", ")} が未チェックのまま done になった`,
        );
      }
    } else if (outcome.kind === "blocked") {
      warnings.push(
        `${doc.id}: 事実は ${outcome.to} を指すが、Workflow が照合にその遷移を許していない`,
      );
    }
  }
  return { changed, prRecorded };
}

/** 未チェックの受け入れ条件の番号 */
function uncheckedAcceptance(doc: Doc<Ticket>): number[] {
  return (parseAcceptance(doc.body) ?? []).filter((i) => !i.checked).map((i) => i.index);
}

export const sync = defineCommand({
  name: "sync",
  group: "setup",
  summary:
    "リモートの deguboard を取り込み、未 push のコミットを送り、作業ブランチの事実でチケットの状態を進める",
  input: z.object({}),
  write: true,
  needs: "store",
  async run(ctx) {
    return withLock(ctx.repo.localDir, "write", async () => {
      const warnings: string[] = [];
      const repo = ctx.repo;
      let flushed = false;
      // 取り込みの前にマージドライバの登録を揃える（init より前に作ったリポジトリでも効くように。SY-4）
      await ensureMergeDriver(repo, ctx.mergeDriver);
      if (await ensureGitattributes(repo.dataDir))
        await commitPaths(repo, [".gitattributes"], "マージドライバの .gitattributes を置く");
      const dirty = await isDirty(repo);
      if (dirty && ctx.config.commit.mode !== "manual") flushed = await flushPending(ctx);

      const fetched = await fetchAll(repo);
      let conflicts: string[] = [];
      let integrated = false;
      let renumbered: Renumbered[] = [];
      if (!fetched.ok) {
        warnings.push(`リモートから取り込めない: ${fetched.detail}`);
      } else if (fetched.remoteBranch) {
        const r = await integrate(repo, { autostash: dirty && !flushed });
        if (r.ok) integrated = r.changed;
        else {
          // 仮番号の衝突（オフラインで起票した番号がリモートで使われた）なら振り直して積み直す（DT-5）。
          // 作業ツリーに未コミットが残る manual のときは、巻き戻しで消えるので扱わない
          const fixed = dirty && !flushed ? null : await renumberProvisional(repo, r.conflicts);
          if (fixed) {
            renumbered = fixed;
            integrated = true;
          } else conflicts = r.conflicts;
        }
      }
      if (conflicts.length > 0) {
        warnings.push(`リモートの変更と競合している: ${conflicts.join(", ")}。${CONFLICT_REMEDY}`);
      }
      if (integrated) await ctx.store.rescan();

      let pushed = false;
      const before = await syncStatus(repo);
      if (repo.remote && conflicts.length === 0 && before.ahead > 0) {
        const r = await push(repo);
        if (r.ok) pushed = true;
        else warnings.push(`push できない: ${r.detail}`);
      }

      // push が済んだ仮番号は確定する（DT-5）
      let confirmed: string[] = [];
      if (repo.remote && (pushed || before.ahead === 0)) {
        for (const t of ctx.store.tickets.values()) {
          if (t.data.provisional) {
            await ctx.store.update("ticket", t.id, { provisional: undefined });
            confirmed.push(t.id);
          }
        }
      }
      const { changed: reconciled, prRecorded } =
        conflicts.length === 0
          ? await reconcileAll(ctx, warnings)
          : { changed: [], prRecorded: [] };
      if (reconciled.length > 0 || prRecorded.length > 0 || confirmed.length > 0) {
        const parts = [
          ...(reconciled.length > 0
            ? [
                `照合で ${reconciled
                  .map((r) => `${r.id}: ${r.from} → ${r.to}（${r.when.join(", ")}）`)
                  .join(", ")}`,
              ]
            : []),
          ...(prRecorded.length > 0
            ? [`PR 番号を記録: ${prRecorded.map((r) => `${r.id}: #${r.pr}`).join(", ")}`]
            : []),
          ...(confirmed.length > 0 ? [`仮番号を確定: ${confirmed.join(", ")}`] : []),
        ];
        await commitAll(repo, parts.join("。"));
        if (repo.remote) {
          const r = await push(repo);
          if (r.ok) pushed = true;
          else warnings.push(`照合の結果を push できない: ${r.detail}`);
        }
      }
      const status = await syncStatus(repo);
      return ok(
        {
          fetched: fetched.ok,
          integrated,
          pushed,
          conflicts,
          renumbered,
          reconciled,
          pr_recorded: prRecorded,
          confirmed,
          status,
        },
        undefined,
        warnings,
      );
    });
  },
});

export const commit = defineCommand({
  name: "commit",
  group: "setup",
  summary:
    "まとめ待ちの変更を 1 コミットにする（commit.mode が batch / manual のとき）。push.mode が auto なら push する",
  input: z.object({ message: z.string().min(1).optional().describe("コミットメッセージ") }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    return withLock(ctx.repo.localDir, "write", async () => {
      const warnings: string[] = [];
      const committed = await flushPending(ctx, input.message);
      let pushed = false;
      if (committed && ctx.repo.remote && ctx.config.push.mode === "auto") {
        const r = await push(ctx.repo);
        if (r.ok) pushed = true;
        else warnings.push(`push できない。次の dg sync で再送する（${r.detail}）`);
      }
      return ok({ committed, pushed }, undefined, warnings);
    });
  },
});

export const validate = defineCommand({
  name: "validate",
  group: "setup",
  summary: "読めないファイルと参照の不整合を出す。エラーがあれば ok: false",
  input: z.object({}),
  write: false,
  needs: "store",
  async run(ctx) {
    await ctx.store.rescan();
    const issues = [...ctx.store.issues, ...checkReferences(ctx.store)];
    return ok({ ok: issues.every((i) => i.severity !== "error"), issues });
  },
});

export const lint = defineCommand({
  name: "lint",
  group: "setup",
  summary:
    "本文の推奨の節（## 概要・## 受け入れ条件）の欠けと空、Workflow の fields に合わない値、閉じた Epic に残る終わっていないチケット、lint.require_iteration が true なら Iteration に入らずに todo・abandoned 以外に進んだチケット（閉じた Epic の done は除く）、チケットがすべて終わったのに開いている Epic・Plan、開いた Plan の after と depends_on をまたぐ循環、同じ Project に 2 つ以上ある active の Iteration を指摘する。done のチケットの未チェックの受け入れ条件は指摘しない",
  input: z.object({
    project: z.string().optional().describe("Project で絞る。省略時はすべて"),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const issues: Issue[] = [];
    const warn = (path: string, id: string, code: string, message: string) =>
      issues.push({ severity: "warning", code, path, id, message });
    for (const doc of ctx.store.tickets.values()) {
      if (input.project && doc.data.project !== input.project) continue;
      if (!/^## 概要\s*$/m.test(doc.body))
        warn(doc.path, doc.id, "lint_summary_missing", "本文に ## 概要 がない");
      const acceptance = parseAcceptance(doc.body);
      if (acceptance === undefined)
        warn(doc.path, doc.id, "lint_acceptance_missing", "本文に ## 受け入れ条件 がない");
      else if (acceptance.length === 0)
        warn(doc.path, doc.id, "lint_acceptance_empty", "受け入れ条件に項目がない");
      const wf = ctx.store.workflowFor(doc.data);
      for (const f of wf?.resolved.fields ?? []) {
        const v = doc.data[f.id];
        if (v === undefined) continue;
        const okType =
          f.type === "number"
            ? typeof v === "number"
            : f.type === "boolean"
              ? typeof v === "boolean"
              : f.type === "enum"
                ? typeof v === "string" && (f.options ?? []).includes(v)
                : f.type === "date"
                  ? typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
                  : typeof v === "string";
        if (!okType)
          warn(
            doc.path,
            doc.id,
            "lint_field_type",
            `フィールド ${f.id} の値が型 ${f.type} に合わない`,
          );
      }
      if (ctx.store.config.lint.require_iteration && !doc.data.iteration) {
        const status = doc.data.status;
        const closedEpic =
          doc.data.epic !== undefined &&
          ctx.store.epics.get(doc.data.epic)?.data.status === "closed";
        if (status !== "todo" && status !== "abandoned" && !(status === "done" && closedEpic))
          warn(
            doc.path,
            doc.id,
            "lint_iteration_missing",
            `Iteration に入らずに ${status} に進んでいる`,
          );
      }
    }
    for (const doc of ctx.store.epics.values()) {
      if (input.project && doc.data.project !== input.project) continue;
      if (!/^## 概要\s*$/m.test(doc.body))
        warn(doc.path, doc.id, "lint_summary_missing", "本文に ## 概要 がない");
    }
    // Epic・Plan の状態と、所属するチケットの状態の食い違い。Iteration は閉じると終わっていないチケットを外すので見ない
    const tickets = [...ctx.store.tickets.values()].filter(
      (t) => !input.project || t.data.project === input.project,
    );
    const finished = (t: Doc<Ticket>) => isTerminal(t.data.status);
    const unfinished = (members: Doc<Ticket>[]) =>
      members
        .filter((t) => !finished(t))
        .map((t) => t.id)
        .join(", ");
    for (const doc of ctx.store.epics.values()) {
      if (input.project && doc.data.project !== input.project) continue;
      const members = tickets.filter((t) => t.data.epic === doc.id);
      const left = unfinished(members);
      if (doc.data.status === "closed" && left)
        warn(
          doc.path,
          doc.id,
          "lint_epic_closed_unfinished",
          `閉じた Epic に終わっていないチケット ${left} が残る`,
        );
      if (doc.data.status === "open" && members.some((t) => t.data.status === "done") && !left)
        warn(
          doc.path,
          doc.id,
          "lint_epic_finished_open",
          "チケットがすべて終わったが Epic が開いている",
        );
    }
    for (const doc of ctx.store.plans.values()) {
      if (input.project && doc.data.project !== input.project) continue;
      if (doc.data.closed_at !== undefined || doc.data.tickets.length === 0) continue;
      const members = doc.data.tickets.map((id) => ctx.store.tickets.get(id));
      if (members.every((t) => t !== undefined && finished(t)))
        warn(
          doc.path,
          doc.id,
          "lint_plan_finished_open",
          "チケットがすべて終わったが Plan が開いている",
        );
    }
    // 開いた Plan の after と depends_on をまたぐ循環（PL-3）。Plan を作った後の depends_on の変更でできたものを拾う
    for (const doc of ctx.store.plans.values()) {
      if (input.project && doc.data.project !== input.project) continue;
      if (doc.data.closed_at !== undefined) continue;
      const crossing = findCrossingCycle(ctx.store, doc.data.tickets, doc.data.after);
      if (crossing)
        warn(
          doc.path,
          doc.id,
          "lint_plan_wait_cycle",
          `after と depends_on が循環している: ${cyclePath(crossing, true)}`,
        );
    }
    // active の Iteration は Project に 1 つ（IT-1）。同時の start や直接の編集・マージで 2 つになったものを拾う
    const activeByProject = new Map<string, Doc<Iteration>[]>();
    for (const doc of sortedDocs([...ctx.store.iterations.values()])) {
      if (input.project && doc.data.project !== input.project) continue;
      if (doc.data.status !== "active") continue;
      activeByProject.set(doc.data.project, [
        ...(activeByProject.get(doc.data.project) ?? []),
        doc,
      ]);
    }
    for (const docs of activeByProject.values()) {
      if (docs.length < 2) continue;
      const ids = docs.map((d) => d.id).join(", ");
      for (const doc of docs)
        warn(
          doc.path,
          doc.id,
          "lint_iteration_multiple_active",
          `同じ Project に active の Iteration が ${docs.length} つある（${ids}）`,
        );
    }
    return ok({ ok: issues.length === 0, issues });
  },
});

export const configShow = defineCommand({
  name: "config.show",
  group: "setup",
  summary:
    "設定を既定値で補って出す。個人の上書き（deguboard-local/config.yaml）> チームの config.yaml > 既定 の順に重ねた、各コマンドが使う値",
  input: z.object({
    fields: z
      .boolean()
      .optional()
      .describe(
        "値と一緒に全項目のキー・型・既定値・説明・範囲（scope：team はチーム専用、local は個人で上書きできる）と、チームの値・個人の上書きも出す（{ config, team, local, fields } の形。設定画面が使う）",
      ),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    // 同じ文脈で config.set した後も今の値を出すよう、ctx.config（開いたときの写し）でなく store から読む
    const config = ctx.store.config;
    if (input.fields) {
      return ok<ConfigShowView | Config>({
        config,
        team: ctx.store.teamConfig,
        local: ctx.store.localConfig,
        fields: configFields(),
      });
    }
    return ok<ConfigShowView | Config>(config);
  },
});

/** config.show --fields の出力。設定画面が値・既定値・説明・範囲を一度に読む */
export interface ConfigShowView {
  /** 個人 > チーム > 既定 を重ねた、各コマンドが使う値 */
  config: Config;
  /** チームの config.yaml を既定で補った値（個人の上書きを含まない） */
  team: Config;
  /** 個人の上書き（ドット区切りの項目名 → 値）。上書きできる項目でスキーマに合うものだけ */
  local: Record<string, unknown>;
  fields: ConfigField[];
}

/** whoami の出力。操作している主体と、その人本人とみなす主体の ID */
export interface WhoamiView {
  /** 主体の ID（`eiki` か `eiki/agent`） */
  id: string;
  /** ユーザ名（`eiki`） */
  user: string;
  /** ユーザ名の出どころ（flag・env・git-config・user.name・os） */
  user_source: UserSource;
  kind: ActorKind;
  /** そのユーザ本人とみなす主体の ID（`eiki` と `eiki/agent`）。担当者が自分か自分の agent かはこれに含まれるかで決める */
  own_ids: string[];
}

export const whoami = defineCommand({
  name: "whoami",
  group: "setup",
  summary: "操作している主体（ユーザ名とその出どころ・種別・ID）と、本人とみなす主体の ID を出す",
  input: z.object({}),
  write: false,
  needs: "store",
  async run(ctx) {
    const { id, user, userSource, kind } = ctx.actor;
    return ok<WhoamiView>({ id, user, user_source: userSource, kind, own_ids: ownActorIds(user) });
  },
});

/** "true"/"false"/数字の文字列は値に直す（CLI から来る）。文字列の項目に合わなければ config.set は元の文字列で試し直す */
function coerce(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** CLI から来た配列の項目。カンマ区切りで、空文字は空の配列 */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** 項目の名前を最上位と残りに分け、--local なら個人で上書きできる項目かも確かめる */
function splitKey(
  key: string,
  local: boolean,
): { top: string; rest: string[]; field?: ConfigField } {
  const [top, ...rest] = key.split(".");
  if (!top) throw new OperationError("VALIDATION_FAILED", "key が空");
  const field = configFields().find((f) => f.key === key);
  if (local && field?.scope !== "local") {
    throw new OperationError(
      "VALIDATION_FAILED",
      `${key} は個人の設定に書けない`,
      field
        ? "チーム専用の項目。--local を外してチームの config.yaml を変える"
        : `スキーマにない項目。上書きできる項目：${configFields()
            .filter((f) => f.scope === "local")
            .map((f) => f.key)
            .join("・")}`,
    );
  }
  return { top, rest, ...(field ? { field } : {}) };
}

/**
 * 入力の値を、スキーマに合う葉の値に直す。base（チームの値か、個人を重ねた値）に当てて確かめる。
 * 既定が空でない文字列の項目（priority.* など）を空にしたら undefined（キーを消して既定か、チームの値に戻す）
 */
function resolveLeaf(
  key: string,
  rawValue: unknown,
  field: ConfigField | undefined,
  rest: string[],
  base: Config,
): unknown {
  const top = key.split(".")[0]!;
  // enum の項目は空文字・null と同じく、値を省いた（undefined）呼び出しも誤りとして弾く。
  // 通すと葉が undefined になり、スキーマの既定で補われて黙って既定に戻ってしまう（戻すのは config.unset）
  if (field?.type === "enum" && rawValue === undefined)
    throw new OperationError(
      "VALIDATION_FAILED",
      `${key} の値が正しくない`,
      `値を省けない。選択肢：${(field.options ?? []).join("・")}`,
    );
  const clearsToDefault =
    field?.type === "string" &&
    typeof field.default === "string" &&
    field.default !== "" &&
    (rawValue === "" || rawValue === undefined || rawValue === null);
  // CLI の文字列は値に直したもの・元の文字列・カンマ区切りの配列の順に試す。元の文字列も試すので、文字列の項目に "2026"・"true" を入れられる
  const candidates: unknown[] = clearsToDefault ? [undefined] : [coerce(rawValue)];
  if (!clearsToDefault && typeof rawValue === "string")
    candidates.push(rawValue, splitList(rawValue));
  let error: z.ZodError | undefined;
  for (const leaf of candidates) {
    const next = nestedConfigValue((base as Record<string, unknown>)[top], rest, leaf);
    const probe = configSchema.safeParse({ ...base, [top]: next });
    if (probe.success) return leaf;
    error ??= probe.error;
  }
  throw new OperationError("VALIDATION_FAILED", `${key} の値が正しくない`, z.prettifyError(error!));
}

const LOCAL_FLAG_DESCRIPTION =
  "個人の設定（<git-common-dir>/deguboard-local/config.yaml。Git に入らず、コミットも push もしない）に書く。個人で上書きできる項目（config show --fields の scope が local）だけ。値は個人 > チーム > 既定 の順に読まれる";

export const configSet = defineCommand({
  name: "config.set",
  positionals: ["key", "value"],
  group: "setup",
  summary:
    "config.yaml の 1 項目を変える（commit.mode のようにドットで指す）。配列の項目はカンマ区切りで、空文字で空にする。既定が空でない文字列の項目（priority.* など）は空文字で既定に戻す。選択肢の項目（commit.mode など）は空・null・省略を弾く。--local で個人の設定に書く",
  input: z.object({
    key: z.string().min(1).describe("項目。例: commit.mode"),
    value: z.unknown().describe("値"),
    local: z.boolean().optional().describe(LOCAL_FLAG_DESCRIPTION),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    if (input.local) {
      // 個人の設定は Git 管理外なので withWrite（取り込み・コミット・push）を通さず、同じマシンの書き込みの排他だけ取る
      const config = await withLock(ctx.repo.localDir, "write", async () => {
        const { rest, field } = splitKey(input.key, true);
        const leaf = resolveLeaf(input.key, input.value, field, rest, ctx.store.config);
        return ctx.store.writeLocalConfig(input.key, leaf);
      });
      return ok(config);
    }
    const result = await withWrite(
      ctx,
      async () => {
        const { top, rest, field } = splitKey(input.key, false);
        // チームの値を元にする（個人の上書きを重ねた値を元にすると、上書きがチームのファイルに写ってしまう）
        const team = ctx.store.teamConfig;
        let leaf = resolveLeaf(input.key, input.value, field, rest, team);
        if (input.key === "actor.human_only") {
          // コマンド名の存在を確かめ、エイリアス（sprint.close）は正式名に直す。registry と循環するので動的 import
          const { findCommand } = await import("./registry.js");
          const names = leaf as string[];
          const unknown = names.filter((n) => !findCommand(n));
          if (unknown.length > 0)
            throw new OperationError(
              "VALIDATION_FAILED",
              `actor.human_only にないコマンドがある: ${unknown.join(", ")}`,
            );
          leaf = names.map((n) => findCommand(n)!.name);
        }
        const value = nestedConfigValue((team as Record<string, unknown>)[top], rest, leaf);
        return ctx.store.writeConfig({ [top]: value });
      },
      { message: `config の ${input.key} を変更` },
    );
    return ok(result.value, result.write);
  },
});

export const configUnset = defineCommand({
  name: "config.unset",
  positionals: ["key"],
  group: "setup",
  summary:
    "config.yaml の 1 項目を消して既定に戻す（commit.mode のようにドットで指す）。--local なら個人の上書きを外してチームの値に戻す",
  input: z.object({
    key: z.string().min(1).describe("項目。例: commit.mode"),
    local: z.boolean().optional().describe(LOCAL_FLAG_DESCRIPTION),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    if (input.local) {
      const config = await withLock(ctx.repo.localDir, "write", async () => {
        splitKey(input.key, true);
        return ctx.store.writeLocalConfig(input.key, undefined);
      });
      return ok(config);
    }
    const result = await withWrite(
      ctx,
      async () => {
        const { top, rest } = splitKey(input.key, false);
        const team = ctx.store.teamConfig as Record<string, unknown>;
        return ctx.store.writeConfig({ [top]: nestedConfigValue(team[top], rest, undefined) });
      },
      { message: `config の ${input.key} を既定に戻す` },
    );
    return ok(result.value, result.write);
  },
});

export const setupCommands = [
  init,
  sync,
  commit,
  validate,
  lint,
  configShow,
  configSet,
  configUnset,
  whoami,
];
