// config.yaml のスキーマ。項目の全体はここが正本（requirements.md 5.10）。
// 入れ子の既定は prefault で与える（Zod 4 の default は検証を短絡するため）。
// 各項目の説明は describe に書き、configFields が設定画面（config.show の fields）に渡す。表示言語ごとの訳は web の l10n-core.ts（CONFIG_DESCRIPTIONS。鍵は説明の文）に置き、説明を書き換えたら訳の鍵も直す（web の l10n.test.ts が知らせる）。
// 項目ごとの範囲（scope）もここで決める：local の項目だけが、Git に入らない個人の設定（deguboard-local/config.yaml）で上書きできる

import { z } from "zod";
import { GUIDE_TOPICS } from "../guide/topics.js";
import { slugSchema } from "./common.js";

const COMMIT_MODES = ["each", "batch", "manual"] as const;
export type CommitMode = (typeof COMMIT_MODES)[number];
const PUSH_MODES = ["auto", "manual"] as const;
export type PushMode = (typeof PUSH_MODES)[number];
/** gh pr merge のマージの方法。auto.merge_method・dg pr merge・actions の merge_pr がここを読む */
export const PR_MERGE_METHODS = ["squash", "merge", "rebase"] as const;
/**
 * --auto で聞かずに選んでよい判断（流れの段階の名前）。人が決める判断（abandoned・閉じる・リリースの PR のマージ）は
 * ここに入らないので、config でも自動にできない（EX-7）。マージは auto.merge で決める
 */
export const AUTO_DECISIONS = ["assign", "check", "plan", "audit", "accept"] as const;
/** dg flow next が返さずに飛ばせる段階。stop は流れを止める段階なので飛ばせない（EX-8） */
export const FLOW_SKIPS = ["assign", "check", "plan", "work", "audit", "release"] as const;
/** actions.test を回す時間の上限（run_tests の既定と品質ゲートの検査）。リポジトリの検査の全体（テストを含む）を回すので長めにとる */
export const ACTIONS_TEST_TIMEOUT_MS = 30 * 60_000;

const noteField = z
  .string()
  .default("")
  .describe(
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  );

export const configSchema = z.looseObject({
  default_project: slugSchema.default("default").describe("Project used when none is given"),
  git: z
    .looseObject({
      remote: z
        .string()
        .min(1)
        .default("origin")
        .describe("Git remote that deguboard fetches from and pushes to"),
      base_branch: z
        .string()
        .min(1)
        .default("main")
        .describe("Base for work branches and for deciding what is merged"),
    })
    .prefault({}),
  worktree: z
    .looseObject({
      root: z
        .string()
        .min(1)
        .default("../<repo>.worktrees")
        .describe("Where work worktrees go. A path relative to the repository"),
      setup: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Argument array of the setup command run first in a work worktree that claim created (e.g. [mise, run, setup]). Empty runs nothing. If it fails, claim still succeeds and the warnings give the failure and the command to run by hand",
        ),
    })
    .prefault({}),
  commit: z
    .looseObject({
      mode: z
        .enum(COMMIT_MODES)
        .default("batch")
        .describe(
          "each: commit on every write / batch: leave changes in the working tree; dg commit, dg sync, and immediate operations commit them together / manual: only dg commit and immediate operations",
        ),
    })
    .prefault({}),
  push: z
    .looseObject({
      mode: z
        .enum(PUSH_MODES)
        .default("auto")
        .describe(
          "auto: push on every commit / manual: dg sync pushes (immediate operations push even in manual)",
        ),
    })
    .prefault({}),
  metrics: z
    .looseObject({
      read_transcripts: z
        .boolean()
        .default(false)
        .describe(
          "Whether run finish and run refresh read conversation transcripts through the Adapter to fill in usage. Machines with DEGUBOARD_NO_TRANSCRIPTS never read them, even when true (MT-2)",
        ),
    })
    .prefault({}),
  notify: z
    .looseObject({
      approvals: z
        .boolean()
        .default(true)
        .describe(
          "Whether the VS Code extension shows a notification when Plans awaiting approval or tickets in review increase (the count is always shown)",
        ),
    })
    .prefault({}),
  actions: z
    .looseObject({
      shell: z
        .boolean()
        .default(false)
        .describe(
          "Whether to allow the arbitrary shell Action (shell). Even when allowed, each run asks for confirmation (AG-7)",
        ),
      test: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Argument array of the command that the test Action (run_tests) and the quality gate's check (dg gate, dg pr ready, dg pr merge) run (e.g. [mise, run, check]). When empty, run_tests is rejected and the gate's check does not judge (the repo's own checks are confirmed instead)",
        ),
      light_test: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Argument array of the lighter check the quality gate's check runs instead of actions.test when every file in the work branch's diff against base falls under actions.light_paths (e.g. [mise, run, check:light]). When this or actions.light_paths is empty, actions.test always runs. When actions.test is empty, the lighter check does not run either",
        ),
      light_paths: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Globs of files the lighter check (actions.light_test) is enough for (relative to the repository top; * and ? do not cross /, ** crosses directories; e.g. docs/**). If even one file in the diff falls outside, actions.test runs",
        ),
    })
    .prefault({}),
  auto: z
    .looseObject({
      merge: z
        .boolean()
        .default(false)
        .describe(
          "Whether dg guide all --auto merges PRs that pass the quality gate (dg gate --for merge) automatically. By default a person merges",
        ),
      decisions: z
        .array(z.enum(AUTO_DECISIONS))
        .default(["assign", "check", "plan", "audit", "accept"])
        .describe(
          "Decisions --auto chooses without asking (assign: assignment / check: the fix line when only one fix fits / plan: Plan approval / audit: the review findings table / accept: confirming acceptance criteria after reconciling). Decisions a person makes cannot be added; PR merging is set by auto.merge",
        ),
    })
    .prefault({}),
  flow: z
    .looseObject({
      skip: z
        .array(z.enum(FLOW_SKIPS))
        .default([])
        .describe(
          "Stages that dg flow next never returns (assign, check, plan, work, audit, release). A skipped stage's rule is not read; the flow moves to the next rule",
        ),
    })
    .prefault({}),
  merge: z
    .looseObject({
      method: z
        .enum(PR_MERGE_METHODS)
        .default("squash")
        .describe(
          "Merge method dg pr merge uses when --method is omitted (squash, merge, or rebase)",
        ),
      delete_branch: z
        .boolean()
        .default(false)
        .describe(
          "Whether dg pr merge also deletes the remote and local work branch when --delete-branch is omitted",
        ),
    })
    .prefault({}),
  review: z
    .looseObject({
      heavy_categories: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Review finding categories (run review-result --findings-file) treated as heavy regardless of severity. Empty by default, so the reviewer's severity is kept",
        ),
    })
    .prefault({}),
  lint: z
    .looseObject({
      require_iteration: z
        .boolean()
        .default(false)
        .describe(
          "Whether dg lint flags tickets that moved past todo or abandoned without being in an Iteration (except done tickets in closed Epics). dg guide work asks to add the ticket to an Iteration before claim",
        ),
    })
    .prefault({}),
  models: z
    .looseObject({
      light: z
        .string()
        .default("")
        .describe(
          "Model for Plan tier light (docs, settings, and wording only) and for research within implementation. When empty, the parent's model",
        ),
      standard: z
        .string()
        .default("")
        .describe(
          "Model for Plan tier standard (anything that is not light or heavy). When empty, the parent's model",
        ),
      heavy: z
        .string()
        .default("")
        .describe(
          "Model for Plan tier heavy (design decisions, data shapes, multiple packages, bugs of unknown cause). When empty, the parent's model",
        ),
    })
    .prefault({}),
  actor: z
    .looseObject({
      human_only: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Command names rejected for agents (such as epic.close). Empty by default, allowing everything. Ticket transitions are restricted with the Workflow's by",
        ),
    })
    .prefault({}),
  guide: z
    .looseObject({
      notes: z
        .looseObject(Object.fromEntries(GUIDE_TOPICS.map((topic) => [topic, noteField])))
        .prefault({}),
    })
    .prefault({}),
  priority: z
    .looseObject({
      high: z
        .string()
        .default(
          "利用者に見える不具合・利用者を誤らせる文書・悪用できる脆弱性・ライセンスの漏れ・検査が通らない・ほかのチケットを止めている",
        )
        .describe(
          "Criteria for priority high. Used when creating and reviewing tickets, and by the priority marks and selection hints on screen",
        ),
      medium: z
        .string()
        .default(
          "機能の追加と改善・テストの抜けと不安定なテスト・内部の文書の食い違い・今は害のない規約違反・大きく古い依存",
        )
        .describe(
          "Criteria for priority medium (the default). Used when creating and reviewing tickets, and by the priority marks and selection hints on screen",
        ),
      low: z
        .string()
        .default("使われていないコードと依存・設定の重複・言い回しの揺れ・急がない調査と検討")
        .describe(
          "Criteria for priority low. Used when creating and reviewing tickets, and by the priority marks and selection hints on screen",
        ),
    })
    .prefault({}),
});
export type Config = z.output<typeof configSchema>;

/** 既定値だけの config */
export function defaultConfig(): Config {
  return configSchema.parse({});
}

/** 設定の 1 項目の型。画面はこれで入力欄（選択欄・チェック・テキスト・リスト）を選ぶ */
export type ConfigFieldType = "enum" | "boolean" | "string" | "list";

/**
 * 項目の範囲。team はチームの config.yaml だけで決まり、local は個人の設定（deguboard-local/config.yaml）で上書きできる。
 * 値は「個人 > チーム > 既定」の順に読む
 */
export type ConfigScope = "team" | "local";

/** 個人で上書きできる項目。マシンの配置・作業の好み・使えるモデル・自分のマシンで許すことのように、人ごとに違ってよいもの */
const LOCAL_KEYS: ReadonlySet<string> = new Set([
  "default_project",
  "git.remote",
  "worktree.root",
  "commit.mode",
  "push.mode",
  "models.light",
  "models.standard",
  "models.heavy",
  "actions.shell",
  "notify.approvals",
]);

/** 項目（ドット区切りの名前）の範囲。スキーマにない名前は team（個人のファイルでは無視する） */
export function configScopeOf(key: string): ConfigScope {
  return LOCAL_KEYS.has(key) ? "local" : "team";
}

/** 設定の 1 項目（葉）。key は config.set に渡すドット区切りの名前 */
export interface ConfigField {
  key: string;
  type: ConfigFieldType;
  /** enum のときの選択肢 */
  options?: string[] | undefined;
  /** スキーマの describe */
  description: string;
  default: unknown;
  scope: ConfigScope;
  /**
   * 空の値（空文字・null・省略）を渡すと、値を消して既定（--local ならチームの値）に戻す項目か。
   * 既定が空でない文字列の項目（priority.* など）だけ true。config.set の空の値の扱いと、設定画面の確認の文は、この値で決める
   * （既定が空の文字列は空のまま、配列は空の配列にし、選択肢は空を弾く）
   */
  clears_to_default: boolean;
}

/** default・prefault の包みを外した中身 */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  while (s instanceof z.ZodDefault || s instanceof z.ZodPrefault) s = s.unwrap() as z.ZodType;
  return s;
}

function fieldOf(key: string, schema: z.ZodType, fallback: unknown): ConfigField {
  const inner = unwrap(schema);
  const field: ConfigField = {
    key,
    type: "string",
    description: schema.description ?? "",
    default: fallback,
    scope: configScopeOf(key),
    clears_to_default: false,
  };
  if (inner instanceof z.ZodEnum) {
    field.type = "enum";
    field.options = inner.options.map(String);
  } else if (inner instanceof z.ZodBoolean) field.type = "boolean";
  else if (inner instanceof z.ZodArray) field.type = "list";
  else field.clears_to_default = typeof fallback === "string" && fallback !== "";
  return field;
}

/** config.yaml の全項目（葉）を、スキーマの並びのまま既定値・説明・範囲つきで出す */
export function configFields(): ConfigField[] {
  const defaults = defaultConfig() as Record<string, unknown>;
  const fields: ConfigField[] = [];
  // 入れ子は葉まで開く（guide.notes.<topic> は 2 段の下にある）
  const walk = (key: string, schema: z.ZodType, value: unknown): void => {
    const inner = unwrap(schema);
    if (inner instanceof z.ZodObject) {
      const values = (value ?? {}) as Record<string, unknown>;
      for (const [leaf, child] of Object.entries(inner.shape))
        walk(`${key}.${leaf}`, child as z.ZodType, values[leaf]);
    } else fields.push(fieldOf(key, schema, value));
  };
  for (const [top, schema] of Object.entries(configSchema.shape))
    walk(top, schema as z.ZodType, defaults[top]);
  return fields;
}

/** 入れ子の値を `commit.mode` のようなドット区切りの葉に開く。入れ子でない値（配列も）は葉 */
export function flattenConfig(value: unknown, prefix = ""): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return prefix ? { [prefix]: value } : {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, flattenConfig(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

/** 最上位の項目の新しい値を組み立てる。`commit.mode` のように入れ子なら、今の値を写して葉だけ置き換える。葉を undefined にすると、その葉と空になった入れ子を消す */
export function nestedConfigValue(current: unknown, keys: string[], leaf: unknown): unknown {
  if (keys.length === 0) return leaf;
  const [head, ...rest] = keys as [string, ...string[]];
  const base =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  const child = nestedConfigValue(base[head], rest, leaf);
  if (child === undefined) delete base[head];
  else base[head] = child;
  return Object.keys(base).length === 0 ? undefined : base;
}

/** スキーマの全項目の名前（最初に使うときに作る） */
let knownKeys: Set<string> | undefined;

/**
 * 個人の設定（deguboard-local/config.yaml の中身）をチームの値に重ねる。
 * 上書きできる項目（scope が local）で、スキーマに合う値だけを重ね、ほかは理由を集めて無視する
 */
export function overlayLocalConfig(
  team: Config,
  local: unknown,
): { config: Config; local: Record<string, unknown>; ignored: { key: string; reason: string }[] } {
  const ignored: { key: string; reason: string }[] = [];
  const applied: Record<string, unknown> = {};
  let config: Record<string, unknown> = { ...team };
  knownKeys ??= new Set(configFields().map((f) => f.key));
  for (const [key, value] of Object.entries(flattenConfig(local))) {
    if (!knownKeys.has(key)) {
      ignored.push({ key, reason: "スキーマにない項目" });
      continue;
    }
    if (configScopeOf(key) !== "local") {
      ignored.push({ key, reason: "チーム専用の項目（チームの config.yaml で変える）" });
      continue;
    }
    const [top, ...rest] = key.split(".") as [string, ...string[]];
    const probe = configSchema.safeParse({
      ...config,
      [top]: nestedConfigValue(config[top], rest, value),
    });
    if (!probe.success) {
      ignored.push({ key, reason: `値が正しくない: ${z.prettifyError(probe.error)}` });
      continue;
    }
    config = probe.data;
    applied[key] = value;
  }
  return { config: config as Config, local: applied, ignored };
}
