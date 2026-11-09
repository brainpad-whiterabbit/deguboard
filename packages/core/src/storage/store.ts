// deguboard worktree を走査してメモリ上に索引を作り、読み書きの入口になる（ADR-033）。
// 自分の書き込みは即座に索引へ反映し（write-through）、Git の取り込みの後は rescan() で作り直す。
// rescan() はファイルごとの inode・大きさ・更新時刻（ns）・変更時刻（ns）を覚え、変わっていないファイルは読み直さずに前の結果を使う。
// ファイルシステムの時刻の刻みは粗く inode も使い回されるので、更新が新しい（RACY_WINDOW_NS の内の）ファイルは覚えずに毎回読む（git の racy-clean と同じ考え方）。
// cacheDir を渡すと、覚えた結果をディスクに残して次のプロセスが開くときに使う（store-cache.ts）。印で確かめてから使うのはメモリのときと同じ

import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OperationError } from "../errors.js";
import {
  configSchema,
  nestedConfigValue,
  overlayLocalConfig,
  type Config,
} from "../model/config.js";
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
import { pendingDeps, ticketSchema, type Ticket } from "../model/ticket.js";
import type { WorkflowDefinition } from "../model/workflow.js";
import type { ResolvedWorkflow } from "../workflow/resolve.js";
import { validateWorkflow, type WorkflowValidationOptions } from "../workflow/validate.js";
import { writeFileAtomic } from "./atomic.js";
import { createDoc, readDoc, writeDoc, type Doc, type DocFormat } from "./documents.js";
import { formatIssue, type Issue } from "./issue.js";
import {
  CONFIG_FILE,
  DIRS,
  LOCAL_CONFIG_FILE,
  LOCAL_CONFIG_LABEL,
  deletedTicketPath,
  epicPath,
  iterationPath,
  planPath,
  projectPath,
  runPath,
  ticketPath,
  workflowPath,
} from "./paths.js";
import {
  loadStoreCache,
  saveStoreCache,
  storeCacheFile,
  storeCacheKey,
  type CachedRead,
} from "./store-cache.js";
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

/** Store.open の選択 */
export interface StoreOptions extends WorkflowValidationOptions {
  /**
   * 個人の設定（config.yaml）を置く deguboard-local/ の絶対パス。省くと個人の設定は読まない。
   * 上書きできる項目（model/config.ts の scope が local）だけをチームの値に重ねる
   */
  localDir?: string | undefined;
  /**
   * 読みの結果を残すディレクトリ（deguboard-local/store-cache/ の絶対パス）。省くとディスクに残さず、開くたびにすべて読む。
   * 残した結果は、ファイルの印が同じときだけ使う（store-cache.ts）
   */
  cacheDir?: string | undefined;
}

export class Store {
  /** 各コマンドが使う値。個人 > チーム > 既定 の順に重ねたもの */
  config: Config = configSchema.parse({});
  /** チームの config.yaml を既定で補った値（個人の上書きを含まない）。チームの値を書くときの元 */
  teamConfig: Config = configSchema.parse({});
  /** 重ねた個人の上書き（ドット区切りの項目名 → 値）。無視した項目は入らない */
  localConfig: Record<string, unknown> = {};
  /** 個人の config.yaml の中身（読めたとおり）。チームの値を書き直したときに重ね直すために持つ */
  private localRaw: unknown = undefined;
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
  /**
   * 相対パスごとの読みの結果。rescan() で見つからなくなったファイルの分は捨てる。
   * 覚えた結果（Doc・config・Workflow・Issue）は次の rescan でもそのまま索引に戻すので、書き換えない（更新は複製して作る）
   */
  private readCache = new Map<string, CachedRead>();
  /** ディスクのキャッシュの場所と鍵。cacheDir を渡されなければ undefined */
  private diskCache: { file: string; key: string; loaded: boolean } | undefined;

  private constructor(
    readonly root: string,
    /** Workflow の検証に渡す。Action の一覧は入口が渡す（AG-6） */
    private readonly workflowOptions: WorkflowValidationOptions,
    /** 個人の config.yaml の絶対パス。localDir を渡されなければ undefined */
    private readonly localConfigPath: string | undefined,
  ) {}

  static async open(root: string, options: StoreOptions = {}): Promise<Store> {
    const { localDir, cacheDir, ...workflowOptions } = options;
    const store = new Store(
      root,
      workflowOptions,
      localDir ? path.join(localDir, LOCAL_CONFIG_FILE) : undefined,
    );
    if (cacheDir) {
      const key = await storeCacheKey(root, workflowOptions.actions);
      const file = storeCacheFile(cacheDir, key);
      store.readCache = await loadStoreCache(file, key);
      store.diskCache = { file, key, loaded: store.readCache.size > 0 };
    }
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
    // 覚えた結果が変わったか（ディスクのキャッシュを書き直すか）
    let changed = false;
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
      if (stamp && stamp.changedNs < settledBefore) {
        this.readCache.set(relPath, { stamp: stamp.key, value });
        changed = true;
      } else if (this.readCache.delete(relPath)) changed = true;
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
    for (const key of this.readCache.keys()) {
      if (seen.has(key)) continue;
      this.readCache.delete(key);
      changed = true;
    }
    this.lastScan = stats;
    const disk = this.diskCache;
    if (disk && changed) {
      // 鍵の違う古いキャッシュの掃除は、読めるキャッシュが無かったとき（版を変えた後など）だけにする
      await saveStoreCache(disk.file, disk.key, this.readCache, !disk.loaded);
      disk.loaded = true;
    }
  }

  /**
   * ファイルの印と、更新時刻・変更時刻の新しい方。読めなければ undefined（覚えずに毎回読み、読めない理由を Issue にする）。
   * 印は読む前に取るので、読んでいる間に書き換わっても次の rescan で読み直す。絶対パス（個人の config.yaml）もそのまま受ける
   */
  private async stampOf(relPath: string): Promise<{ key: string; changedNs: bigint } | undefined> {
    try {
      const s = await stat(path.resolve(this.root, relPath), { bigint: true });
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

  /** 終わっていない依存先（WF-2）。done・abandoned でない依存先を depends_on の順で返す。別の Project も見て、見つからない依存先も含める */
  pendingDeps(ticket: Ticket): TicketId[] {
    return pendingDeps(ticket, (id) => this.tickets.get(id)?.data.status);
  }

  /** deps_done（WF-2）。依存先がすべて done か abandoned なら真。やめたチケットは待たない */
  depsDone(ticket: Ticket): boolean {
    return this.pendingDeps(ticket).length === 0;
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

  /** チームの config.yaml を書き換える（最上位の項目ごと。undefined は消す）。返すのは書いたチームの値（個人の上書きを重ねない。画面と CLI が書いた値をそのまま見せるため） */
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
    this.teamConfig = parsed.data;
    this.overlay();
    return this.teamConfig;
  }

  /**
   * 個人の config.yaml（deguboard-local/）の 1 項目（ドット区切り）を書き換える。葉を undefined にすると消し、上書きが残らなければファイルも消す。
   * Git 管理外なのでコミットも push もしない。上書きできる項目かどうかは呼び出し側（config.set）が確かめ、ここでは
   * この書き込みで無視される項目が増えないことだけを確かめる。返すのは重ねた値
   */
  async writeLocalConfig(key: string, leaf: unknown): Promise<Config> {
    if (!this.localConfigPath)
      throw new OperationError("VALIDATION_FAILED", "個人の設定の置き場所が分からない");
    const { doc } = await this.readLocalConfigDocument(this.localConfigPath);
    const current = (doc.toJS() ?? {}) as Record<string, unknown>;
    // 書く前から無視されていた項目はそのまま残し、この書き込みで増える無視だけを拒む
    const before = new Set(overlayLocalConfig(this.teamConfig, current).ignored.map((i) => i.key));
    const [top, ...rest] = key.split(".") as [string, ...string[]];
    patchYamlDocument(doc, { [top]: nestedConfigValue(current[top], rest, leaf) });
    const raw = (doc.toJS() ?? {}) as Record<string, unknown>;
    const rejected = overlayLocalConfig(this.teamConfig, raw).ignored.filter(
      (i) => !before.has(i.key),
    );
    if (rejected.length > 0) {
      throw new OperationError(
        "VALIDATION_FAILED",
        "個人の設定に書けない項目",
        rejected.map((i) => `${i.key}: ${i.reason}`).join("\n"),
      );
    }
    if (Object.keys(raw).length === 0) {
      // 上書きが残らなければファイルを消す（空のファイルを残さない）
      await rm(this.localConfigPath, { force: true });
    } else await writeFileAtomic(this.localConfigPath, stringifyYaml(doc));
    this.localRaw = raw;
    this.overlay();
    return this.config;
  }

  /** チームの値に個人の上書きを重ね、config と localConfig を作り直す。無視した項目の警告は返す */
  private overlay(): Issue[] {
    const { config, local, ignored } = overlayLocalConfig(this.teamConfig, this.localRaw);
    this.config = config;
    this.localConfig = local;
    return ignored.map((i) => ({
      severity: "warning",
      code: "local_config_ignored",
      path: LOCAL_CONFIG_LABEL,
      message: `個人の設定の ${i.key} を無視した`,
      detail: i.reason,
    }));
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

  private async readLocalConfigDocument(file: string) {
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch {
      // なければ上書きなし
    }
    return parseYamlDocument(text);
  }

  /**
   * チームの config.yaml と個人の config.yaml を読み、個人 > チーム > 既定 の順に重ねる。
   * 個人のファイルはたいてい無いので、無ければ読まない（読み直した数にも数えない）
   */
  private async readConfig(cached: CachedLoader): Promise<Issue[]> {
    const localPath = this.localConfigPath;
    const none = { raw: undefined, issues: [] as Issue[] };
    const [team, local] = await Promise.all([
      cached(CONFIG_FILE, () => this.loadConfig()),
      localPath && (await this.stampOf(localPath))
        ? cached(localPath, () => this.loadLocalConfig(localPath))
        : none,
    ]);
    this.teamConfig = team.config;
    this.localRaw = local.raw;
    return [...team.issues, ...local.issues, ...this.overlay()];
  }

  /** 個人の config.yaml を読む。YAML として読めなければ警告にして上書きなしで続ける（チームの値で動く） */
  private async loadLocalConfig(file: string): Promise<{ raw: unknown; issues: Issue[] }> {
    const { doc, errors } = await this.readLocalConfigDocument(file);
    if (errors.length > 0) {
      return {
        raw: undefined,
        issues: [
          {
            severity: "warning",
            code: "yaml_error",
            path: LOCAL_CONFIG_LABEL,
            message: "YAML を読めないので個人の設定を無視した",
            detail: errors.join("\n"),
          },
        ],
      };
    }
    const raw: unknown = doc.toJS() ?? {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        raw: undefined,
        issues: [
          {
            severity: "warning",
            code: "schema_error",
            path: LOCAL_CONFIG_LABEL,
            message: "項目の対応（マップ）でないので個人の設定を無視した",
          },
        ],
      };
    }
    return { raw, issues: [] };
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
