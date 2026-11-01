// deguboard worktree を走査してメモリ上に索引を作り、読み書きの入口になる（ADR-007「索引はメモリ上に持つ」）。
// 自分の書き込みは即座に索引へ反映し（write-through）、Git の取り込みの後は rescan() で作り直す

import { readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OperationError } from "../errors.js";
import { configSchema, type Config } from "../model/config.js";
import { epicSchema, type Epic } from "../model/epic.js";
import {
  idFromFileName,
  idNumber,
  nextNumber,
  parseId,
  type EpicId,
  type IdKind,
  type IdOf,
  type IterationId,
  type PlanId,
  type TicketId,
} from "../model/id.js";
import { iterationSchema, type Iteration } from "../model/iteration.js";
import { planSchema, type Plan } from "../model/plan.js";
import { projectSchema, type Project } from "../model/project.js";
import { isRunId, runSchema, type Run, type RunId } from "../model/run.js";
import { ticketSchema, type Ticket } from "../model/ticket.js";
import type { WorkflowDefinition } from "../model/workflow.js";
import type { ResolvedWorkflow } from "../workflow/resolve.js";
import { validateWorkflow } from "../workflow/validate.js";
import { writeFileAtomic } from "./atomic.js";
import { createDoc, readDoc, writeDoc, type Doc, type DocFormat } from "./documents.js";
import type { Issue } from "./issue.js";
import {
  CONFIG_FILE,
  DIRS,
  deletedTicketPath,
  epicPath,
  iterationPath,
  planPath,
  projectPath,
  runPath,
  ticketPath,
  workflowPath,
} from "./paths.js";
import { newYamlDocument, parseYamlDocument, patchYamlDocument, stringifyYaml } from "./yaml.js";

export interface WorkflowEntry {
  path: string;
  definition: WorkflowDefinition;
  resolved: ResolvedWorkflow;
}

interface Collection<T extends { id: string }> {
  dir: string;
  format: DocFormat;
  schema: z.ZodType<T>;
  /** ファイル名から ID を取り出す。対象外のファイルなら undefined */
  idOf(fileName: string): string | undefined;
  pathOf(id: string): string;
}

const collections = {
  project: {
    dir: DIRS.projects,
    format: "yaml",
    schema: projectSchema,
    idOf: (f) => (f.endsWith(".yaml") ? f.slice(0, -5) : undefined),
    pathOf: projectPath,
  } satisfies Collection<Project>,
  ticket: {
    dir: DIRS.tickets,
    format: "markdown",
    schema: ticketSchema,
    idOf: (f) => idFromFileName(f, "ticket"),
    pathOf: ticketPath,
  } satisfies Collection<Ticket>,
  epic: {
    dir: DIRS.epics,
    format: "markdown",
    schema: epicSchema,
    idOf: (f) => idFromFileName(f, "epic"),
    pathOf: epicPath,
  } satisfies Collection<Epic>,
  iteration: {
    dir: DIRS.iterations,
    format: "yaml",
    schema: iterationSchema,
    idOf: (f) => idFromFileName(f, "iteration"),
    pathOf: iterationPath,
  } satisfies Collection<Iteration>,
  plan: {
    dir: DIRS.plans,
    format: "yaml",
    schema: planSchema,
    idOf: (f) => idFromFileName(f, "plan"),
    pathOf: planPath,
  } satisfies Collection<Plan>,
  // 完了時の集計だけ。実行中の記録（deguboard-local/runs/）は索引に入れない
  run: {
    dir: DIRS.runs,
    format: "json",
    schema: runSchema,
    idOf: (f) => (f.endsWith(".json") && isRunId(f.slice(0, -5)) ? f.slice(0, -5) : undefined),
    pathOf: runPath,
  } satisfies Collection<Run>,
};

export type EntityKind = keyof typeof collections;
type EntityOf<K extends EntityKind> = z.output<(typeof collections)[K]["schema"]>;

export class Store {
  config: Config = configSchema.parse({});
  /** 走査で見つかった、読めないファイルや定義の誤り */
  issues: Issue[] = [];
  readonly projects = new Map<string, Doc<Project>>();
  readonly tickets = new Map<TicketId, Doc<Ticket>>();
  /** 墓標（tickets/deleted/）の番号。採番で再利用しないために読む */
  readonly deletedTicketNumbers = new Set<number>();
  readonly epics = new Map<EpicId, Doc<Epic>>();
  readonly iterations = new Map<IterationId, Doc<Iteration>>();
  readonly plans = new Map<PlanId, Doc<Plan>>();
  readonly runs = new Map<RunId, Doc<Run>>();
  readonly workflows = new Map<string, WorkflowEntry>();

  private constructor(readonly root: string) {}

  static async open(root: string): Promise<Store> {
    const store = new Store(root);
    await store.rescan();
    return store;
  }

  /** 全部読み直して索引を作り直す */
  async rescan(): Promise<void> {
    this.issues = [];
    await this.readConfig();
    await Promise.all([
      this.readCollection("project", this.projects),
      this.readCollection("ticket", this.tickets),
      this.readDeletedTickets(),
      this.readCollection("epic", this.epics),
      this.readCollection("iteration", this.iterations),
      this.readCollection("plan", this.plans),
      this.readCollection("run", this.runs),
      this.readWorkflows(),
    ]);
  }

  // ---- 参照 ----

  private map<K extends EntityKind>(kind: K): Map<string, Doc<EntityOf<K>>> {
    return this[`${kind}s`] as unknown as Map<string, Doc<EntityOf<K>>>;
  }

  /** `t12` でも `12` でも引ける */
  resolve<K extends IdKind>(kind: K, ref: string): Doc<EntityOf<K>> | undefined {
    const id = parseId(ref, kind);
    return id ? this.map(kind).get(id) : undefined;
  }

  /** 見つからなければ NOT_FOUND */
  require<K extends IdKind>(kind: K, ref: string): Doc<EntityOf<K>> {
    const doc = this.resolve(kind, ref);
    if (!doc) throw new OperationError("NOT_FOUND", `${kind} ${ref} が見つからない`);
    return doc;
  }

  requireProject(slug: string): Doc<Project> {
    const doc = this.projects.get(slug);
    if (!doc) throw new OperationError("NOT_FOUND", `project ${slug} が見つからない`);
    return doc;
  }

  /** チケットの Workflow（省略時は Project の既定）。定義が読めていなければ undefined */
  workflowFor(ticket: Ticket): WorkflowEntry | undefined {
    const id = ticket.workflow ?? this.projects.get(ticket.project)?.data.workflow;
    return id ? this.workflows.get(id) : undefined;
  }

  requireWorkflowFor(ticket: Ticket): WorkflowEntry {
    const wf = this.workflowFor(ticket);
    if (!wf) {
      throw new OperationError("NOT_FOUND", `${ticket.id} の Workflow が見つからないか読めない`);
    }
    return wf;
  }

  /** 採番：既存（チケットは墓標も）の最大 + 1 */
  nextId<K extends IdKind>(kind: K): IdOf<K> {
    const used = [...this.map(kind).keys()].map(idNumber);
    if (kind === "ticket") used.push(...this.deletedTicketNumbers);
    return `${{ ticket: "t", epic: "e", iteration: "s", plan: "p" }[kind]}${nextNumber(used)}` as IdOf<K>;
  }

  /** deps_done（WF-2）。依存先がすべて done か abandoned なら真。やめたチケットは待たない */
  depsDone(ticket: Ticket): boolean {
    return ticket.depends_on.every((id) => {
      const status = this.tickets.get(id)?.data.status;
      return status === "done" || status === "abandoned";
    });
  }

  // ---- 書き込み（write-through）----

  async create<K extends EntityKind>(
    kind: K,
    data: Record<string, unknown>,
    body = "",
  ): Promise<Doc<EntityOf<K>>> {
    const c = collections[kind] as unknown as Collection<EntityOf<K>>;
    const id = String(data["id"]);
    if (this.map(kind).has(id))
      throw new OperationError("ALREADY_EXISTS", `${kind} ${id} は既にある`);
    const doc = await createDoc(this.root, c.pathOf(id), c.format, c.schema, data, body);
    this.map(kind).set(id, doc);
    return doc;
  }

  async update<K extends EntityKind>(
    kind: K,
    id: string,
    patch: Partial<Record<string, unknown>>,
    body?: string,
  ): Promise<Doc<EntityOf<K>>> {
    const c = collections[kind] as unknown as Collection<EntityOf<K>>;
    const doc = this.map(kind).get(id);
    if (!doc) throw new OperationError("NOT_FOUND", `${kind} ${id} が見つからない`);
    const next = await writeDoc(this.root, doc, c.schema, patch, body);
    this.map(kind).set(id, next);
    return next;
  }

  /** チケットは消さずに墓標へ移す（番号を再利用しない） */
  async deleteTicket(id: TicketId): Promise<void> {
    const doc = this.tickets.get(id);
    if (!doc) throw new OperationError("NOT_FOUND", `ticket ${id} が見つからない`);
    const to = path.join(this.root, deletedTicketPath(id));
    await writeFileAtomic(to, "");
    await rename(path.join(this.root, doc.path), to);
    this.tickets.delete(id);
    this.deletedTicketNumbers.add(idNumber(id));
  }

  async writeConfig(patch: Record<string, unknown>): Promise<Config> {
    const { doc } = await this.readConfigDocument();
    patchYamlDocument(doc, patch);
    const parsed = configSchema.safeParse(doc.toJS() ?? {});
    if (!parsed.success) {
      throw new OperationError(
        "VALIDATION_FAILED",
        "config の更新がスキーマに合わない",
        z.prettifyError(parsed.error),
      );
    }
    await writeFileAtomic(path.join(this.root, CONFIG_FILE), stringifyYaml(doc));
    this.config = parsed.data;
    return parsed.data;
  }

  /** Workflow 定義を書く。検証に通らなければ書かない */
  async writeWorkflow(
    definition: Record<string, unknown>,
    comment?: string,
  ): Promise<WorkflowEntry> {
    const relPath = workflowPath(String(definition["id"]));
    const result = validateWorkflow(definition, relPath);
    if (!result.workflow || !result.definition || result.issues.length > 0) {
      throw new OperationError(
        "VALIDATION_FAILED",
        `Workflow ${String(definition["id"])} の定義に誤りがある`,
        result.issues.map((i) => i.message).join("\n"),
      );
    }
    const doc = newYamlDocument(definition);
    if (comment) doc.commentBefore = ` ${comment}`;
    await writeFileAtomic(path.join(this.root, relPath), stringifyYaml(doc));
    const entry = { path: relPath, definition: result.definition, resolved: result.workflow };
    this.workflows.set(result.definition.id, entry);
    return entry;
  }

  // ---- 走査 ----

  private async readConfigDocument() {
    let text = "";
    try {
      text = await readFile(path.join(this.root, CONFIG_FILE), "utf8");
    } catch {
      // なければ既定値だけの config
    }
    return parseYamlDocument(text);
  }

  private async readConfig(): Promise<void> {
    const { doc, errors } = await this.readConfigDocument();
    if (errors.length > 0) {
      this.issues.push({
        severity: "error",
        code: "yaml_error",
        path: CONFIG_FILE,
        message: "YAML を読めない",
        detail: errors.join("\n"),
      });
      this.config = configSchema.parse({});
      return;
    }
    const parsed = configSchema.safeParse(doc.toJS() ?? {});
    if (!parsed.success) {
      this.issues.push({
        severity: "error",
        code: "schema_error",
        path: CONFIG_FILE,
        message: "スキーマに合わない",
        detail: z.prettifyError(parsed.error),
      });
      this.config = configSchema.parse({});
      return;
    }
    this.config = parsed.data;
  }

  private async listFiles(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(path.join(this.root, dir), { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async readCollection<K extends EntityKind>(
    kind: K,
    target: Map<string, Doc<EntityOf<K>>>,
  ): Promise<void> {
    const c = collections[kind] as unknown as Collection<EntityOf<K>>;
    target.clear();
    for (const file of await this.listFiles(c.dir)) {
      const id = c.idOf(file);
      if (!id) {
        this.issues.push({
          severity: "warning",
          code: "unexpected_file",
          path: `${c.dir}/${file}`,
          message: "ID の形でないファイル",
        });
        continue;
      }
      const result = await readDoc(this.root, `${c.dir}/${file}`, c.format, c.schema, id);
      if (result.ok) target.set(id, result.doc);
      else this.issues.push(result.issue);
    }
  }

  private async readDeletedTickets(): Promise<void> {
    this.deletedTicketNumbers.clear();
    for (const file of await this.listFiles(DIRS.deletedTickets)) {
      const id = idFromFileName(file, "ticket");
      if (id) this.deletedTicketNumbers.add(idNumber(id));
    }
  }

  private async readWorkflows(): Promise<void> {
    this.workflows.clear();
    for (const file of await this.listFiles(DIRS.workflows)) {
      if (!file.endsWith(".yaml")) continue;
      const relPath = `${DIRS.workflows}/${file}`;
      const id = file.slice(0, -5);
      let text: string;
      try {
        text = await readFile(path.join(this.root, relPath), "utf8");
      } catch (error) {
        this.issues.push({
          severity: "error",
          code: "read_error",
          path: relPath,
          id,
          message: "ファイルを読めない",
          detail: String(error),
        });
        continue;
      }
      const { doc, errors } = parseYamlDocument(text);
      if (errors.length > 0) {
        this.issues.push({
          severity: "error",
          code: "yaml_error",
          path: relPath,
          id,
          message: "YAML を読めない",
          detail: errors.join("\n"),
        });
        continue;
      }
      const result = validateWorkflow(doc.toJS() ?? {}, relPath);
      this.issues.push(...result.issues);
      if (!result.workflow || !result.definition) continue;
      if (result.definition.id !== id) {
        this.issues.push({
          severity: "error",
          code: "id_mismatch",
          path: relPath,
          id,
          message: `ファイル名の ID ${id} と中の id ${result.definition.id} が違う`,
        });
        continue;
      }
      // 誤りのある定義は索引に入れない（それを参照するチケットは integrity で指摘される）
      if (result.issues.length > 0) continue;
      this.workflows.set(id, {
        path: relPath,
        definition: result.definition,
        resolved: result.workflow,
      });
    }
  }
}
