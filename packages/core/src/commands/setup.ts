// 用意と同期：init・sync・commit・validate・lint・config

import { writeFile, access } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OperationError } from "../errors.js";
import { collectBranchFacts } from "../git/facts.js";
import { withLock } from "../git/lock.js";
import { renumberProvisional, type Renumbered } from "../git/renumber.js";
import { commitAll, fetchAll, integrate, isDirty, push, syncStatus } from "../git/sync.js";
import { flushPending, withWrite } from "../git/write.js";
import { configSchema } from "../model/config.js";
import { acceptanceSection, type Ticket } from "../model/ticket.js";
import type { Doc } from "../storage/documents.js";
import { checkReferences } from "../storage/integrity.js";
import type { Issue } from "../storage/issue.js";
import { CONFIG_FILE } from "../storage/paths.js";
import type { WorkflowEntry } from "../storage/store.js";
import { reconcileStatus, regressionWarnings } from "../workflow/reconcile.js";
import { WORKFLOW_TEMPLATES } from "../workflow/templates/index.js";
import { defineCommand, ok, type CommandContext } from "./define.js";
import { nowIso } from "./helpers.js";

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
    const result = await withWrite(
      ctx,
      async () => {
        const store = ctx.store;
        const created: string[] = [];
        const configPath = path.join(store.root, CONFIG_FILE);
        if (!(await exists(configPath))) {
          await store.writeConfig({
            default_project: "default",
            git: { remote: input.remote ?? "origin", base_branch: input.base_branch ?? "main" },
          });
          created.push(CONFIG_FILE);
        }
        const ignorePath = path.join(store.root, ".gitignore");
        if (!(await exists(ignorePath))) {
          // 原子的書き込みの一時ファイルをコミットに入れない
          await writeFile(ignorePath, "*.tmp\n");
          created.push(".gitignore");
        }
        for (const t of WORKFLOW_TEMPLATES) {
          if (store.workflows.has(t.id)) continue;
          await store.writeWorkflow(
            t as Record<string, unknown>,
            `${t.name} のワークフロー。dg init が同梱のテンプレートから置いた`,
          );
          created.push(`workflows/${t.id}.yaml`);
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
      result.write,
    );
  },
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

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
}

/** 照合（ST-4〜ST-6）。書き換えた件数を返す */
async function reconcileAll(ctx: CommandContext, warnings: string[]): Promise<ReconciledTicket[]> {
  const changed: ReconciledTicket[] = [];
  const targets = [...ctx.store.tickets.values()].filter(
    (t): t is Doc<Ticket> & { data: Ticket & { branch: string } } =>
      t.data.branch !== undefined && t.data.status !== "done" && t.data.status !== "abandoned",
  );
  for (const doc of targets) {
    const wf = ctx.store.workflowFor(doc.data);
    if (!wf) {
      warnings.push(`${doc.id}: Workflow が読めないので照合しない`);
      continue;
    }
    const facts = await collectBranchFacts(ctx.repo, doc.data.branch, {
      pr: doc.data.pr,
      needPr: needsPr(wf),
    });
    facts.deps_done = ctx.store.depsDone(doc.data);
    const outcome = reconcileStatus(wf.resolved, doc.data.status, facts);
    // done に進むなら、消えたブランチは正常（マージ後に消した）なので警告しない
    if (!(outcome.kind === "advance" && outcome.to === "done")) {
      for (const w of regressionWarnings(doc.data.status, facts)) warnings.push(`${doc.id}: ${w}`);
    }
    if (outcome.kind === "advance") {
      await ctx.store.update("ticket", doc.id, { status: outcome.to, updated_at: nowIso(ctx) });
      changed.push({ id: doc.id, from: doc.data.status, to: outcome.to });
    } else if (outcome.kind === "blocked") {
      warnings.push(
        `${doc.id}: 事実は ${outcome.to} を指すが、Workflow が照合にその遷移を許していない`,
      );
    }
  }
  return changed;
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
        warnings.push(
          `リモートの変更と競合している: ${conflicts.join(", ")}。deguboard worktree で解消する`,
        );
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
      const reconciled = conflicts.length === 0 ? await reconcileAll(ctx, warnings) : [];
      if (reconciled.length > 0 || confirmed.length > 0) {
        const parts = [
          ...(reconciled.length > 0
            ? [`照合で ${reconciled.map((r) => `${r.id}: ${r.from} → ${r.to}`).join(", ")}`]
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
    "本文の推奨の節（## 概要・## 受け入れ条件）の欠けと空、Workflow の fields に合わない値を指摘する",
  input: z.object({ project: z.string().optional() }),
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
      const acceptance = acceptanceSection(doc.body);
      if (acceptance === undefined)
        warn(doc.path, doc.id, "lint_acceptance_missing", "本文に ## 受け入れ条件 がない");
      else if (!/^- \[[ xX]\] \S/m.test(acceptance))
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
    }
    for (const doc of ctx.store.epics.values()) {
      if (input.project && doc.data.project !== input.project) continue;
      if (!/^## 概要\s*$/m.test(doc.body))
        warn(doc.path, doc.id, "lint_summary_missing", "本文に ## 概要 がない");
    }
    return ok({ ok: issues.length === 0, issues });
  },
});

export const configShow = defineCommand({
  name: "config.show",
  group: "setup",
  summary: "config.yaml を既定値で補って出す",
  input: z.object({}),
  write: false,
  needs: "store",
  async run(ctx) {
    return ok(ctx.config);
  },
});

/** "true"/"false"/数字の文字列は値に直す（CLI から来る） */
function coerce(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export const configSet = defineCommand({
  name: "config.set",
  positionals: ["key", "value"],
  group: "setup",
  summary: "config.yaml の 1 項目を変える（commit.mode のようにドットで指す）",
  input: z.object({
    key: z.string().min(1).describe("項目。例: commit.mode"),
    value: z.unknown().describe("値"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const [top, ...rest] = input.key.split(".");
        if (!top) throw new OperationError("VALIDATION_FAILED", "key が空");
        let value: unknown = coerce(input.value);
        if (rest.length > 0) {
          const current = (ctx.store.config as Record<string, unknown>)[top];
          const base =
            typeof current === "object" && current !== null
              ? { ...(current as Record<string, unknown>) }
              : {};
          let cursor = base;
          for (const [i, k] of rest.entries()) {
            if (i === rest.length - 1) cursor[k] = value;
            else {
              const next =
                typeof cursor[k] === "object" && cursor[k] !== null
                  ? { ...(cursor[k] as Record<string, unknown>) }
                  : {};
              cursor[k] = next;
              cursor = next;
            }
          }
          value = base;
        }
        const probe = configSchema.safeParse({ ...ctx.store.config, [top]: value });
        if (!probe.success)
          throw new OperationError(
            "VALIDATION_FAILED",
            `${input.key} の値が正しくない`,
            z.prettifyError(probe.error),
          );
        return ctx.store.writeConfig({ [top]: value });
      },
      { message: `config の ${input.key} を変更` },
    );
    return ok(result.value, result.write);
  },
});

export const setupCommands = [init, sync, commit, validate, lint, configShow, configSet];
