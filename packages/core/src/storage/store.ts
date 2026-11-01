// deguboard worktree を走査してメモリ上に索引を作り、読み書きの入口になる（ADR-007「索引はメモリ上に持つ」）。
// 自分の書き込みは即座に索引へ反映し（write-through）、Git の取り込みの後は rescan() で作り直す。
// rescan() はファイルごとの inode・大きさ・更新時刻（ns）・変更時刻（ns）を覚え、変わっていないファイルは読み直さずに前の結果を使う。
// ファイルシステムの時刻の刻みは粗く inode も使い回されるので、更新が新しい（RACY_WINDOW_NS の内の）ファイルは覚えずに毎回読む（git の racy-clean と同じ考え方）

import { readdir, readFile, rename, stat } from "node:fs/promises";
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
import { validateWorkflow, type WorkflowValidationOptions } from "../workflow/validate.js";
import { writeFileAtomic } from "./atomic.js";
import { createDoc, readDoc, writeDoc, type Doc, type DocFormat } from "./documents.js";
import { formatIssue, type Issue } from "./issue.js";
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
  // 完了時の集計だけ。実行中の詳細ログ（deguboard-local/runs/）は索引に入れない
  run: {
    dir: DIRS.runs,
    format: "json",
    schema: runSchema,
    idOf: (f) => (f.endsWith(".json") && isRunId(f.slice(0, -5)) ? f.slice(0, -5) : undefined),
    pathOf: runPath,
  } satisfies Collection<Run>,
};

export type EntityKind = keyof typeof collections;

/**
 * 1 ファイルの読みの結果を、読んだときの印（stat）と一緒に覚えておく。
 * 覚えた結果（Doc・config・Workflow・Issue）は次の rescan でもそのまま索引に戻すので、書き換えない（更新は複製して作る）
 */
interface CachedRead {
  stamp: string;
  value: unknown;
}

/**
 * 更新時刻・変更時刻が rescan を始めた時刻からこの幅の内にあるファイルは覚えない。
 * 同じ刻みの中で同じ大きさに書き直されると印が変わらないため。FAT・SMB の 2 秒刻みも見込んで 3 秒にする。
 * ファイルの時刻と Date.now が同じ時計であることが前提（NFS・SMB でサーバの時計が遅れていると効かない）
 */
const RACY_WINDOW_NS = 3_000_000_000n;

/** rescan() の中で、印が前回と同じなら覚えた結果を返し、違えば load() で読み直して覚える */
type CachedLoader = <T>(relPath: string, load: () => Promise<T>) => Promise<T>;

/** 直前の rescan() で、ファイルを読み直した数と前の結果を使った数（測定とテストのため） */
export interface ScanStats {
  read: number;
  reused: number;
}
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
  lastScan: ScanStats = { read: 0, reused: 0 };
  /** 相対パスごとの読みの結果。rescan() で見つからなくなったファイルの分は捨てる */
  private readonly readCache = new Map<string, CachedRead>();

  private constructor(
    readonly root: string,
    /** Workflow の検証に渡す。Action の一覧は入口が渡す（ADR-007） */
    private readonly workflowOptions: WorkflowValidationOptions,
  ) {}

  static async open(root: string, options: WorkflowValidationOptions = {}): Promise<Store> {
    const store = new Store(root, options);
    await store.rescan();
    return store;
  }

  /**
   * 索引を作り直す。ディレクトリは毎回一覧し、ファイルは印（stat）が前回と同じなら読み直さない。
   * 他のプロセス（CLI・git）の書き込みは印が変わるか、更新が新しくて覚えていないかのどちらかなので取り込まれる
   */
  async rescan(): Promise<void> {
    // この時刻より前に更新されたファイルだけを覚える。覚えた後の書き込みは、刻みが粗くても印の時刻が変わる
    const settledBefore = BigInt(Date.now()) * 1_000_000n - RACY_WINDOW_NS;
    const seen = new Set<string>();
    const stats: ScanStats = { read: 0, reused: 0 };
    const cached = async <T>(relPath: string, load: () => Promise<T>): Promise<T> => {
      seen.add(relPath);
      const stamp = await this.stampOf(relPath);
      const hit = stamp === undefined ? undefined : this.readCache.get(relPath);
      if (hit && hit.stamp === stamp?.key) {
        stats.reused++;
        return hit.value as T;
      }
      stats.read++;
      const value = await load();
      if (stamp && stamp.changedNs < settledBefore)
        this.readCache.set(relPath, { stamp: stamp.key, value });
      else this.readCache.delete(relPath);
      return value;
    };
    // Issue の順は並びの順に固定する（読み直すファイルの数で順が揺れないように）
    const issues = await Promise.all([
      this.readConfig(cached),
      this.readCollection("project", this.projects, cached),
      this.readCollection("ticket", this.tickets, cached),
      this.readDeletedTickets(),
      this.readCollection("epic", this.epics, cached),
      this.readCollection("iteration", this.iterations, cached),
      this.readCollection("plan", this.plans, cached),
      this.readCollection("run", this.runs, cached),
      this.readWorkflows(cached),
    ]);
    this.issues = issues.flat();
    for (const key of this.readCache.keys()) if (!seen.has(key)) this.readCache.delete(key);
    this.lastScan = stats;
  }

  /**
   * ファイルの印と、更新時刻・変更時刻の新しい方。読めなければ undefined（覚えずに毎回読み、読めない理由を Issue にする）。
   * 印は読む前に取るので、読んでいる間に書き換わっても次の rescan で読み直す
   */
  private async stampOf(relPath: string): Promise<{ key: string; changedNs: bigint } | undefined> {
    try {
      const s = await stat(path.join(this.root, relPath), { bigint: true });
      return {
        key: `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`,
        changedNs: s.mtimeNs > s.ctimeNs ? s.mtimeNs : s.ctimeNs,
      };
    } catch {
      return undefined;
    }
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

  /**
   * Workflow 定義を書く（なければ作り、あれば置き換える）。読み込み時と同じ検証（WF-3）に通らなければ書かない。
   * そのファイルの前の指摘は捨て、残った警告（未知の Action など）を issues に入れる
   */
  async writeWorkflow(
    definition: Record<string, unknown>,
    comment?: string,
  ): Promise<WorkflowEntry> {
    const relPath = workflowPath(String(definition["id"]));
    const result = validateWorkflow(definition, relPath, this.workflowOptions);
    if (
      !result.workflow ||
      !result.definition ||
      result.issues.some((i) => i.severity === "error")
    ) {
      throw new OperationError(
        "VALIDATION_FAILED",
        `Workflow ${String(definition["id"])} の定義に誤りがある`,
        result.issues
          .filter((i) => i.severity === "error")
          .map(formatIssue)
          .join("\n"),
      );
    }
    const doc = newYamlDocument(definition);
    if (comment) doc.commentBefore = ` ${comment}`;
    await writeFileAtomic(path.join(this.root, relPath), stringifyYaml(doc));
    const entry = { path: relPath, definition: result.definition, resolved: result.workflow };
    this.workflows.set(result.definition.id, entry);
    this.issues = [...this.issues.filter((i) => i.path !== relPath), ...result.issues];
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

  private async readConfig(cached: CachedLoader): Promise<Issue[]> {
    const { config, issues } = await cached(CONFIG_FILE, () => this.loadConfig());
    this.config = config;
    return issues;
  }

  private async loadConfig(): Promise<{ config: Config; issues: Issue[] }> {
    const { doc, errors } = await this.readConfigDocument();
    if (errors.length > 0) {
      return {
        config: configSchema.parse({}),
        issues: [
          {
            severity: "error",
            code: "yaml_error",
            path: CONFIG_FILE,
            message: "YAML を読めない",
            detail: errors.join("\n"),
          },
        ],
      };
    }
    const parsed = configSchema.safeParse(doc.toJS() ?? {});
    if (!parsed.success) {
      return {
        config: configSchema.parse({}),
        issues: [
          {
            severity: "error",
            code: "schema_error",
            path: CONFIG_FILE,
            message: "スキーマに合わない",
            detail: z.prettifyError(parsed.error),
          },
        ],
      };
    }
    return { config: parsed.data, issues: [] };
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
    cached: CachedLoader,
  ): Promise<Issue[]> {
    const c = collections[kind] as unknown as Collection<EntityOf<K>>;
    const issues: Issue[] = [];
    const files = await this.listFiles(c.dir);
    // 読みは並べて出す。索引と Issue はファイル名の順に積む
    const results = await Promise.all(
      files.map(async (file) => {
        const relPath = `${c.dir}/${file}`;
        const id = c.idOf(file);
        if (!id) return { file };
        const result = await cached(relPath, () =>
          readDoc(this.root, relPath, c.format, c.schema, id),
        );
        return { file, result };
      }),
    );
    target.clear();
    for (const { file, result } of results) {
      if (!result) {
        issues.push({
          severity: "warning",
          code: "unexpected_file",
          path: `${c.dir}/${file}`,
          message: "ID の形でないファイル",
        });
        continue;
      }
      if (result.ok) target.set(result.doc.id, result.doc);
      else issues.push(result.issue);
    }
    return issues;
  }

  private async readDeletedTickets(): Promise<Issue[]> {
    const files = await this.listFiles(DIRS.deletedTickets);
    this.deletedTicketNumbers.clear();
    for (const file of files) {
      const id = idFromFileName(file, "ticket");
      if (id) this.deletedTicketNumbers.add(idNumber(id));
    }
    return [];
  }

  private async readWorkflows(cached: CachedLoader): Promise<Issue[]> {
    const files = (await this.listFiles(DIRS.workflows)).filter((f) => f.endsWith(".yaml"));
    const results = await Promise.all(
      files.map((file) => {
        const relPath = `${DIRS.workflows}/${file}`;
        return cached(relPath, () => this.loadWorkflow(relPath, file.slice(0, -5)));
      }),
    );
    this.workflows.clear();
    const issues: Issue[] = [];
    for (const { id, entry, issues: found } of results) {
      issues.push(...found);
      if (entry) this.workflows.set(id, entry);
    }
    return issues;
  }

  /** Workflow の定義を 1 つ読んで検証する。誤りのある定義は entry を返さない */
  private async loadWorkflow(
    relPath: string,
    id: string,
  ): Promise<{ id: string; entry?: WorkflowEntry; issues: Issue[] }> {
    let text: string;
    try {
      text = await readFile(path.join(this.root, relPath), "utf8");
    } catch (error) {
      return {
        id,
        issues: [
          {
            severity: "error",
            code: "read_error",
            path: relPath,
            id,
            message: "ファイルを読めない",
            detail: String(error),
          },
        ],
      };
    }
    const { doc, errors } = parseYamlDocument(text);
    if (errors.length > 0) {
      return {
        id,
        issues: [
          {
            severity: "error",
            code: "yaml_error",
            path: relPath,
            id,
            message: "YAML を読めない",
            detail: errors.join("\n"),
          },
        ],
      };
    }
    const result = validateWorkflow(doc.toJS() ?? {}, relPath, this.workflowOptions);
    const issues = [...result.issues];
    if (!result.workflow || !result.definition) return { id, issues };
    if (result.definition.id !== id) {
      issues.push({
        severity: "error",
        code: "id_mismatch",
        path: relPath,
        id,
        message: `ファイル名の ID ${id} と中の id ${result.definition.id} が違う`,
      });
      return { id, issues };
    }
    // 誤りのある定義は索引に入れない（それを参照するチケットは integrity で指摘される）。警告だけなら入れる
    if (issues.some((i) => i.severity === "error")) return { id, issues };
    return {
      id,
      issues,
      entry: { path: relPath, definition: result.definition, resolved: result.workflow },
    };
  }
}
