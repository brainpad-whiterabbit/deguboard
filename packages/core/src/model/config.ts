// config.yaml のスキーマ。項目の全体はここが正本（requirements.md 5.10）。
// 入れ子の既定は prefault で与える（Zod 4 の default は検証を短絡するため）。
// 各項目の説明は describe に書き、configFields が設定画面（config.show の fields）に渡す。英語の訳は web の l10n-en.ts（CONFIG_DESCRIPTIONS_EN）に置き、説明を書き換えたら訳も直す（web の l10n.test.ts が知らせる）。
// 項目ごとの範囲（scope）もここで決める：local の項目だけが、Git に入らない個人の設定（deguboard-local/config.yaml）で上書きできる

import { z } from "zod";
import { slugSchema } from "./common.js";

const COMMIT_MODES = ["each", "batch", "manual"] as const;
export type CommitMode = (typeof COMMIT_MODES)[number];
const PUSH_MODES = ["auto", "manual"] as const;
export type PushMode = (typeof PUSH_MODES)[number];
/** gh pr merge のマージの方法（actions の merge_pr と同じ。Core の汎用部分は actions に依存しないので別に持つ） */
export const PR_MERGE_METHODS = ["squash", "merge", "rebase"] as const;
/**
 * --auto で聞かずに選んでよい判断（流れの段階の名前）。人が決める判断（abandoned・閉じる・リリースの PR のマージ）は
 * ここに入らないので、config でも自動にできない（EX-7）。マージは auto.merge で決める
 */
export const AUTO_DECISIONS = ["assign", "check", "plan", "audit", "accept"] as const;
/** dg flow next が返さずに飛ばせる段階。stop は流れを止める段階なので飛ばせない（ADR-030） */
export const FLOW_SKIPS = ["assign", "check", "plan", "work", "audit", "release"] as const;

/** guide.notes で文書を差し込めるトピック（guide の GUIDE_TOPICS と同じ。ずれは guide のテストが知らせる） */
export const NOTE_TOPICS = [
  "overview",
  "import",
  "assign",
  "check",
  "plan",
  "work",
  "run",
  "parallel",
  "review",
  "audit",
  "release",
  "done",
  "all",
] as const;
const noteField = z
  .string()
  .default("")
  .describe(
    "guide の題名の直後（節を出すときは節の見出しの直後）に差し込む文書のパス。リポジトリの最上位からの相対パスで、リポジトリの外は読まない。空なら差し込まない。見出し（#）を含む文書は差し込まない",
  );

export const configSchema = z.looseObject({
  default_project: slugSchema.default("default").describe("省略時の Project"),
  git: z
    .looseObject({
      remote: z.string().min(1).default("origin").describe("同期先のリモート"),
      base_branch: z
        .string()
        .min(1)
        .default("main")
        .describe("作業ブランチの元と「マージ済み」の判定の基準"),
    })
    .prefault({}),
  worktree: z
    .looseObject({
      root: z
        .string()
        .min(1)
        .default("../<repo>.worktrees")
        .describe("作業 worktree の置き場所。リポジトリからの相対パス"),
      setup: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "claim が作った作業 worktree で最初に回す準備のコマンドの引数配列（例 [mise, run, setup]）。空なら何も回さない。失敗しても claim は成功し、warnings に失敗と手で回すコマンドを出す",
        ),
    })
    .prefault({}),
  commit: z
    .looseObject({
      mode: z
        .enum(COMMIT_MODES)
        .default("batch")
        .describe(
          "each: 書き込みのたびにコミット / batch: 作業ツリーに残し、dg commit・dg sync・即時の操作がまとめてコミット / manual: dg commit と即時の操作だけ",
        ),
    })
    .prefault({}),
  push: z
    .looseObject({
      mode: z
        .enum(PUSH_MODES)
        .default("auto")
        .describe(
          "auto: コミットのたびに push / manual: dg sync が push する（即時の操作は manual でも push する）",
        ),
    })
    .prefault({}),
  metrics: z
    .looseObject({
      read_transcripts: z
        .boolean()
        .default(false)
        .describe(
          "run finish・run refresh が Adapter で会話記録を読んで使用量を補うか。DEGUBOARD_NO_TRANSCRIPTS のマシンでは true でも読まない（MT-2）",
        ),
    })
    .prefault({}),
  notify: z
    .looseObject({
      approvals: z
        .boolean()
        .default(true)
        .describe(
          "承認待ちの Plan や review のチケットが増えたとき、VS Code 拡張が通知を出すか（件数の表示は常に出る）",
        ),
    })
    .prefault({}),
  actions: z
    .looseObject({
      shell: z
        .boolean()
        .default(false)
        .describe("任意のシェルの Action（shell）を許すか。許しても実行のたびに確認する（AG-7）"),
      test: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "テスト実行の Action（run_tests）と、品質ゲート（dg gate・dg pr ready・dg pr merge）の検査が呼ぶコマンドの引数配列（例 [mise, run, check]）。空なら run_tests は拒否し、品質ゲートの検査は判定しない（リポジトリの規約の検査で確かめる）",
        ),
    })
    .prefault({}),
  auto: z
    .looseObject({
      merge: z
        .boolean()
        .default(false)
        .describe(
          "dg guide all --auto で、品質ゲート（dg gate --for merge）を満たした PR を自動でマージするか。既定は人がマージする",
        ),
      decisions: z
        .array(z.enum(AUTO_DECISIONS))
        .default(["assign", "check", "plan", "audit", "accept"])
        .describe(
          "--auto で聞かずに選ぶ判断（assign: 割り当て・check: 直し方が 1 つに決まる直す行・plan: Plan の承認・audit: 見直しの指摘の表・accept: 照合の後の受け入れ条件の確認）。人が決める判断は入れられず、PR のマージは auto.merge",
        ),
    })
    .prefault({}),
  flow: z
    .looseObject({
      skip: z
        .array(z.enum(FLOW_SKIPS))
        .default([])
        .describe(
          "dg flow next が返さない段階（assign・check・plan・work・audit・release）。飛ばした段階の規則は読まず、次の規則に進む",
        ),
    })
    .prefault({}),
  merge: z
    .looseObject({
      method: z
        .enum(PR_MERGE_METHODS)
        .default("squash")
        .describe("dg pr merge が --method を省いたときのマージの方法（squash・merge・rebase）"),
      delete_branch: z
        .boolean()
        .default(false)
        .describe(
          "dg pr merge が --delete-branch を省いたとき、リモートとローカルの作業ブランチも消すか",
        ),
    })
    .prefault({}),
  review: z
    .looseObject({
      heavy_categories: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "見直しの指摘（run review-result --findings-file）のうち、severity によらず重いとみなす category。既定は空で、見直し役の severity のまま",
        ),
    })
    .prefault({}),
  lint: z
    .looseObject({
      require_iteration: z
        .boolean()
        .default(false)
        .describe(
          "dg lint が、Iteration に入らずに todo・abandoned 以外に進んだチケットを指摘するか（閉じた Epic の done は除く）。dg guide work は claim の前に Iteration に入れるよう案内する",
        ),
    })
    .prefault({}),
  models: z
    .looseObject({
      light: z
        .string()
        .default("")
        .describe(
          "Plan の段階 light（文書・設定・文言だけ）と、実装の中の調べものに使うモデル。空なら親のモデル",
        ),
      standard: z
        .string()
        .default("")
        .describe(
          "Plan の段階 standard（light・heavy に当たらないもの）に使うモデル。空なら親のモデル",
        ),
      heavy: z
        .string()
        .default("")
        .describe(
          "Plan の段階 heavy（設計の判断・データの形・複数パッケージ・原因の分からない不具合）に使うモデル。空なら親のモデル",
        ),
    })
    .prefault({}),
  actor: z
    .looseObject({
      human_only: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "agent からは拒否するコマンド名（epic.close など）。既定は空で、すべて許す。チケットの遷移は Workflow の by で縛る",
        ),
    })
    .prefault({}),
  guide: z
    .looseObject({
      notes: z
        .looseObject(Object.fromEntries(NOTE_TOPICS.map((topic) => [topic, noteField])))
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
        .describe("優先度 high の判断基準。起票・見直しと画面の優先度の印・選択の説明が使う"),
      medium: z
        .string()
        .default(
          "機能の追加と改善・テストの抜けと不安定なテスト・内部の文書の食い違い・今は害のない規約違反・大きく古い依存",
        )
        .describe(
          "優先度 medium（既定）の判断基準。起票・見直しと画面の優先度の印・選択の説明が使う",
        ),
      low: z
        .string()
        .default("使われていないコードと依存・設定の重複・言い回しの揺れ・急がない調査と検討")
        .describe("優先度 low の判断基準。起票・見直しと画面の優先度の印・選択の説明が使う"),
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
