// config.yaml のスキーマ。項目の全体はここが正本（requirements.md 5.10）。
// 入れ子の既定は prefault で与える（Zod 4 の default は検証を短絡するため）。
// 各項目の説明は describe に書き、configFields が設定画面（config.show の fields）に渡す

import { z } from "zod";
import { slugSchema } from "./common.js";

const COMMIT_MODES = ["each", "batch", "manual"] as const;
export type CommitMode = (typeof COMMIT_MODES)[number];
const PUSH_MODES = ["auto", "manual"] as const;
export type PushMode = (typeof PUSH_MODES)[number];

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
          "run finish が Adapter で会話記録を読んで使用量を補うか。DEGUBOARD_NO_TRANSCRIPTS のマシンでは true でも読まない（MT-2）",
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
          "テスト実行の Action（run_tests）が呼ぶコマンドの引数配列（例 [mise, run, check]）。空なら run_tests は拒否する",
        ),
    })
    .prefault({}),
  auto: z
    .looseObject({
      merge: z
        .boolean()
        .default(false)
        .describe(
          "dg guide all --auto で、マージの前の条件を満たした PR を自動でマージするか。既定は人がマージする",
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

/** 設定の 1 項目（葉）。key は config.set に渡すドット区切りの名前 */
export interface ConfigField {
  key: string;
  type: ConfigFieldType;
  /** enum のときの選択肢 */
  options?: string[] | undefined;
  /** スキーマの describe */
  description: string;
  default: unknown;
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
  };
  if (inner instanceof z.ZodEnum) {
    field.type = "enum";
    field.options = inner.options.map(String);
  } else if (inner instanceof z.ZodBoolean) field.type = "boolean";
  else if (inner instanceof z.ZodArray) field.type = "list";
  return field;
}

/** config.yaml の全項目（葉）を、スキーマの並びのまま既定値と説明つきで出す */
export function configFields(): ConfigField[] {
  const defaults = defaultConfig() as Record<string, unknown>;
  const fields: ConfigField[] = [];
  for (const [top, schema] of Object.entries(configSchema.shape)) {
    const inner = unwrap(schema as z.ZodType);
    if (inner instanceof z.ZodObject) {
      const values = defaults[top] as Record<string, unknown>;
      for (const [leaf, child] of Object.entries(inner.shape))
        fields.push(fieldOf(`${top}.${leaf}`, child as z.ZodType, values[leaf]));
    } else fields.push(fieldOf(top, schema as z.ZodType, defaults[top]));
  }
  return fields;
}
