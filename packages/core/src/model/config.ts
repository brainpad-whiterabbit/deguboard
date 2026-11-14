// config.yaml のスキーマ。項目の全体はここが正本（requirements.md 5.10）。
// 葉でない項目は振り返りの観点（retro.perspectives）だけで、下の「各項目の文」と scope は葉の項目の話。
// 入れ子の既定は prefault で与える（Zod 4 の default は検証を短絡するため）。
// 各項目の文は described に書く：description（詳しい説明。スキーマの describe になる）と、設定画面が短く出すための
// summary（1 行の要約）・example（例の値）・empty（空のときの動き）・options（選択肢ごとの説明）。configFields が設定画面（config.show の fields）に渡す。
// 表示言語ごとの訳は web の l10n-core.ts（CONFIG_DESCRIPTIONS。鍵は文そのもの）に置き、文を書き換えたら訳の鍵も直す（web の l10n.test.ts が知らせる）。
// 項目ごとの範囲（scope）もここで決める：local の項目だけが、Git に入らない個人の設定（deguboard-local/config.yaml）で上書きできる

import { z } from "zod";
import { detectableAgentNames } from "../agents/index.js";
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
/**
 * 人がマージを承認したとき（dg pr merge --approved-by）に、満たさなくても越えてよい品質ゲートの条件（merge.approval_overrides の選択肢）。
 * PR が開いていること（pr）・衝突（mergeable）・判定した先端（head）は入れない：越えると gh がマージできないか、
 * 判定していないコミットをマージすることになるので、config でも越えられない
 */
export const APPROVAL_OVERRIDES = ["check", "review", "fix_rounds", "acceptance"] as const;
/** dg flow next が返さずに飛ばせる段階。stop は流れを止める段階なので飛ばせない（EX-8） */
export const FLOW_SKIPS = ["assign", "check", "plan", "work", "audit", "release"] as const;
/** actions.test を回す時間の上限（run_tests の既定と品質ゲートの検査）。リポジトリの検査の全体（テストを含む）を回すので長めにとる */
export const ACTIONS_TEST_TIMEOUT_MS = 30 * 60_000;

/** 設定の 1 項目の文。description は CLI とスキーマ向けの詳しい説明（全文）で、ほかは設定画面が短く出すための文 */
interface FieldTexts {
  /** 1 行の要約 */
  summary: string;
  /** 詳しい説明。スキーマの describe になる */
  description: string;
  /** 例の値（項目の値と同じ形。配列の項目は配列） */
  example?: unknown;
  /** 空の値のときの動き。既定が空でない文字列の項目は書かない（EMPTY_RETURNS_TO_DEFAULT になる） */
  empty?: string;
  /** 選択肢ごとの説明（選択肢 → 説明） */
  options?: Record<string, string>;
}

/** スキーマ（describe を付けた後の実体）から、その項目の文を引く表。Zod の meta に入れると JSON Schema に出てしまうので、外に持つ */
const fieldTexts = new WeakMap<z.ZodType, FieldTexts>();

/** スキーマに項目の文を付ける。description は describe に入れ、残りは configFields が読む */
function described<T extends z.ZodType>(schema: T, texts: FieldTexts): T {
  const out = schema.describe(texts.description);
  fieldTexts.set(out, texts);
  return out;
}

/** 既定が空でない文字列の項目（clears_to_default）を空にしたときの動き */
const EMPTY_RETURNS_TO_DEFAULT =
  "Returns to the default (in personal settings, to the team's value)";

const LIGHT_CHECK_UNUSED = "The lighter check is not used (actions.test runs)";
const PARENT_MODEL = "The parent's model";

/** guide.notes.<topic> の項目。どの topic も同じ実体なので、要約と詳しい説明をここ 1 か所で持つ */
const noteField = described(z.string().default(""), {
  summary: "Document inserted just after the guide title. A path relative to the repository root",
  description:
    "Path of a document inserted just after the guide title (just after the section heading when a section is shown). A path relative to the repository root; paths outside the repository are not read. Empty inserts nothing. A document with headings (#) is not inserted.",
  example: "docs/notes.md",
  empty: "Inserts nothing",
});

/** Plan の難しさの段階（PL-1）。models.<tier> と models.<agent>.<tier> の鍵 */
const MODEL_TIERS = ["light", "standard", "heavy"] as const;

/**
 * models.<agent>.<tier> の項目。モデル名は製品ごとに違うので、dg next を呼んだ agent ごとに models.<tier> を上書きできる。
 * どの agent も同じ実体なので、文は段階ごとに 1 つだけ持つ（agent の名前は鍵が示す）
 */
const agentModelsSchema = z
  .looseObject(
    Object.fromEntries(
      MODEL_TIERS.map((tier) => [
        tier,
        described(z.string().default(""), {
          summary: `Model for Plan tier ${tier} when this agent calls dg next`,
          description: `Model for Plan tier ${tier} when the agent in this key calls dg next (it overrides models.${tier} for that agent). When empty, models.${tier}`,
          empty: `models.${tier} is used`,
        }),
      ]),
    ) as Record<(typeof MODEL_TIERS)[number], z.ZodDefault<z.ZodString>>,
  )
  .prefault({});

/**
 * 振り返りの指標の定義（1 つ）。dg が実行する式ではなく、エージェントが読んで計算する数え方の文と、
 * 数字の出どころのコマンド。人が承認したものだけを `dg retro metric` が書く
 */
export const retroMetricSchema = z.looseObject({
  definition: z
    .string()
    .min(1)
    .describe("How to count the metric, as a sentence the agent reads and computes from"),
  sources: z
    .array(z.string().min(1))
    .min(1)
    .describe("Commands the numbers come from (such as dg metrics show --iteration <S>)"),
  unmeasured: z
    .string()
    .min(1)
    .optional()
    .describe("The part of the perspective's question this metric cannot measure"),
});
export type RetroMetric = z.output<typeof retroMetricSchema>;

/** 振り返りの観点（1 つ）。名前と問いと、承認した指標の定義（指標の ID → 定義。空なら定義のない観点） */
export const retroPerspectiveSchema = z.looseObject({
  name: z.string().min(1).describe("Name of the perspective"),
  question: z.string().min(1).describe("The question the perspective answers"),
  metrics: z
    .record(slugSchema, retroMetricSchema)
    .default({})
    .describe("Approved metric definitions (metric ID → definition)"),
});
export type RetroPerspective = z.output<typeof retroPerspectiveSchema>;

/**
 * 振り返りの観点の既定。Agentic-Agile の評価の枠組み（microsoft/agentic-agile-template の docs/evaluation-framework.md）にもとづく 7 つで、
 * どれも指標の定義は空（測りたいものと測れるものは利用者ごとに違うので、指標は決め打ちしない）。
 * 名前と問いは priority.* の既定と同じく日本語で持ち、書いたまま出す（CL-8）
 */
const DEFAULT_RETRO_PERSPECTIVES: Record<string, RetroPerspective> = {
  outcome: {
    name: "成果",
    question: "目標は達成できたか。終えたもの・やめたもの・持ち越したものは何か",
    metrics: {},
  },
  review: {
    name: "見直しの効き目",
    question: "見直しは不具合をマージの前に見つけ、少ない回数で収束したか",
    metrics: {},
  },
  spec: {
    name: "仕様の質",
    question: "チケット（受け入れ条件と範囲）は、作り直しなしで通る成果を引き出せたか",
    metrics: {},
  },
  slicing: {
    name: "分け方",
    question: "作業は、互いにぶつからずに並べて進められる大きさと境目に分けられたか",
    metrics: {},
  },
  stability: {
    name: "エージェントの安定",
    question: "エージェントの働きは、失敗・中断・やり直しなく安定して終わったか",
    metrics: {},
  },
  cost: {
    name: "コスト",
    question: "時間とトークンはどこに使われ、成果に見合っていたか",
    metrics: {},
  },
  improvement: {
    name: "改善の追跡",
    question: "前の振り返りの Try は終わり、ねらった数字は動いたか",
    metrics: {},
  },
};

export const configSchema = z.looseObject({
  default_project: described(slugSchema.default("default"), {
    summary: "Project used when none is given",
    description: "Project used when none is given",
  }),
  git: z
    .looseObject({
      remote: described(z.string().min(1).default("origin"), {
        summary: "Git remote that deguboard fetches from and pushes to",
        description: "Git remote that deguboard fetches from and pushes to",
      }),
      base_branch: described(z.string().min(1).default("main"), {
        summary: "Base for work branches and for deciding what is merged",
        description: "Base for work branches and for deciding what is merged",
      }),
    })
    .prefault({}),
  worktree: z
    .looseObject({
      root: described(z.string().min(1).default("../<repo>.worktrees"), {
        summary: "Where work worktrees go",
        description: "Where work worktrees go. A path relative to the repository",
      }),
      setup: described(z.array(z.string().min(1)).default([]), {
        summary: "Setup command run first in a new work worktree",
        description:
          "Argument array of the setup command run first in a work worktree that claim created (e.g. [mise, run, setup]). Empty runs nothing. If it fails, claim still succeeds and the warnings give the failure and the command to run by hand",
        example: ["mise", "run", "setup"],
        empty: "Runs nothing",
      }),
    })
    .prefault({}),
  commit: z
    .looseObject({
      mode: described(z.enum(COMMIT_MODES).default("batch"), {
        summary: "When ticket writes are committed",
        description:
          "each: commit on every write / batch: leave changes in the working tree; dg commit, dg sync, and immediate operations commit them together / manual: only dg commit and immediate operations",
        options: {
          each: "Commit on every write",
          batch:
            "Leave changes in the working tree; dg commit, dg sync, and immediate operations commit them together",
          manual: "Commit only on dg commit and immediate operations",
        },
      }),
    })
    .prefault({}),
  push: z
    .looseObject({
      mode: described(z.enum(PUSH_MODES).default("auto"), {
        summary: "When commits are pushed",
        description:
          "auto: push on every commit / manual: dg sync pushes (immediate operations push even in manual)",
        options: {
          auto: "Push on every commit",
          manual: "dg sync pushes (immediate operations push even in manual)",
        },
      }),
    })
    .prefault({}),
  metrics: z
    .looseObject({
      // 会話記録を読んで使用量を補う設定（MT-2）
      read_transcripts: described(z.boolean().default(false), {
        summary: "Read conversation transcripts to fill in usage",
        description:
          "Whether run finish and run refresh read conversation transcripts through the Adapter to fill in usage. Machines with DEGUBOARD_NO_TRANSCRIPTS never read them, even when true",
      }),
    })
    .prefault({}),
  notify: z
    .looseObject({
      approvals: described(z.boolean().default(true), {
        summary: "Notify in VS Code when Plans awaiting approval or tickets in review increase",
        description:
          "Whether the VS Code extension shows a notification when Plans awaiting approval or tickets in review increase (the count is always shown)",
      }),
    })
    .prefault({}),
  actions: z
    .looseObject({
      // 任意のシェルの Action を許す設定（AG-7）
      shell: described(z.boolean().default(false), {
        summary: "Allow the arbitrary shell Action",
        description:
          "Whether to allow the arbitrary shell Action (shell). Even when allowed, each run asks for confirmation",
      }),
      test: described(z.array(z.string().min(1)).default([]), {
        summary: "Command run by the quality gate's check and the test Action",
        description:
          "Argument array of the command that the test Action (run_tests) and the quality gate's check (dg gate, dg pr ready, dg pr merge) run (e.g. [mise, run, check]). When empty, run_tests is rejected and the gate's check does not judge (the repo's own checks are confirmed instead)",
        example: ["mise", "run", "check"],
        empty: "The gate's check does not judge, and run_tests is rejected",
      }),
      light_test: described(z.array(z.string().min(1)).default([]), {
        summary: "Lighter check run instead of actions.test when only light paths changed",
        description:
          "Argument array of the lighter check the quality gate's check runs instead of actions.test when every file changed since the last commit whose actions.test passed (the diff against base when there is none) falls under actions.light_paths (e.g. [mise, run, check:light]). When this or actions.light_paths is empty, actions.test always runs. When actions.test is empty, the lighter check does not run either",
        example: ["mise", "run", "check:light"],
        empty: LIGHT_CHECK_UNUSED,
      }),
      light_paths: described(z.array(z.string().min(1)).default([]), {
        summary: "Globs of files the lighter check is enough for",
        description:
          "Globs of files the lighter check (actions.light_test) is enough for (relative to the repository top; * and ? do not cross /, ** crosses directories; e.g. docs/**). If even one file changed since the last commit whose actions.test passed (or against base, when there is none) falls outside, actions.test runs",
        example: ["docs/**"],
        empty: LIGHT_CHECK_UNUSED,
      }),
    })
    .prefault({}),
  auto: z
    .looseObject({
      merge: described(z.boolean().default(false), {
        summary: "Merge PRs that pass the quality gate automatically with --auto",
        description:
          "Whether dg guide all --auto merges PRs that pass the quality gate (dg gate --for merge) without asking. Otherwise the agent asks a person and merges only when approved",
      }),
      decisions: described(
        z.array(z.enum(AUTO_DECISIONS)).default(["assign", "check", "plan", "audit", "accept"]),
        {
          summary: "Decisions --auto chooses without asking",
          description:
            "Decisions --auto chooses without asking (assign: assignment / check: the fix line when only one fix fits / plan: Plan approval / audit: the review findings table / accept: confirming acceptance criteria after reconciling). Decisions a person makes cannot be added; PR merging is set by auto.merge",
          empty: "--auto chooses nothing without asking",
          options: {
            assign: "Assignment",
            check: "The fix line when only one fix fits",
            plan: "Plan approval",
            audit: "The review findings table",
            accept: "Confirming acceptance criteria after reconciling",
          },
        },
      ),
    })
    .prefault({}),
  flow: z
    .looseObject({
      skip: described(z.array(z.enum(FLOW_SKIPS)).default([]), {
        summary: "Stages that dg flow next skips",
        description:
          "Stages that dg flow next never returns (assign, check, plan, work, audit, release). A skipped stage's rule is not read; the flow moves to the next rule",
        empty: "No stage is skipped",
        options: {
          assign: "Assignment",
          check: "Check",
          plan: "Planning",
          work: "Work",
          audit: "Audit",
          release: "Release",
        },
      }),
    })
    .prefault({}),
  work: z
    .looseObject({
      parallel: described(z.number().int().min(1).max(10).default(3), {
        summary: "Most tickets of a Plan advanced at the same time (1 to 10)",
        description:
          "Most tickets of a Plan advanced at the same time with a subagent each (dg guide parallel). An integer from 1 to 10",
      }),
    })
    .prefault({}),
  merge: z
    .looseObject({
      method: described(z.enum(PR_MERGE_METHODS).default("squash"), {
        summary: "Merge method dg pr merge uses by default",
        description:
          "Merge method dg pr merge uses when --method is omitted (squash, merge, or rebase)",
        options: {
          squash: "Squash the PR's commits into one commit",
          merge: "Make a merge commit",
          rebase: "Rebase the PR's commits onto the base branch",
        },
      }),
      delete_branch: described(z.boolean().default(false), {
        summary: "Delete the work branch when dg pr merge merges",
        description:
          "Whether dg pr merge also deletes the remote and local work branch when --delete-branch is omitted, and whether dg sync deletes the worktree and work branch that remain when it moves a ticket to done",
      }),
      approval_overrides: described(
        z.array(z.enum(APPROVAL_OVERRIDES)).default([...APPROVAL_OVERRIDES]),
        {
          summary: "Quality gate conditions a person's approval of the merge may override",
          description:
            "Quality gate conditions that dg pr merge may leave unmet when a person approved the merge (--approved-by): check, review, fix_rounds, acceptance (all four by default). An unmet condition that is not listed keeps the merge at GATE_FAILED even with an approval. An open PR that is not a draft (pr), conflicts (mergeable), and the judged head (head) cannot be listed. Without an approval, nothing is overridden",
          empty: "An approval overrides nothing: every condition of the gate must be met",
          options: {
            check: "The check (actions.test)",
            review: "The review of the last push",
            fix_rounds: "The limit on fix rounds",
            acceptance: "The marks on the acceptance criteria",
          },
        },
      ),
    })
    .prefault({}),
  review: z
    .looseObject({
      heavy_categories: described(z.array(z.string().min(1)).default([]), {
        summary: "Review finding categories always treated as heavy",
        description:
          "Review finding categories (run review-result --findings-file) treated as heavy regardless of severity. Empty by default, so the reviewer's severity is kept",
        empty: "The reviewer's severity is kept",
      }),
    })
    .prefault({}),
  lint: z
    .looseObject({
      require_iteration: described(z.boolean().default(false), {
        summary: "Have dg lint flag tickets worked on outside an Iteration",
        description:
          "Whether dg lint flags tickets that moved past todo or abandoned without being in an Iteration (except done tickets in closed Epics). dg guide work asks to add the ticket to an Iteration before claim",
      }),
    })
    .prefault({}),
  models: z
    .looseObject({
      light: described(z.string().default(""), {
        summary: "Model for Plan tier light and for research",
        description:
          "Model for Plan tier light (docs, settings, and wording only) and for research within implementation. When empty, the parent's model",
        example: "haiku",
        empty: PARENT_MODEL,
      }),
      standard: described(z.string().default(""), {
        summary: "Model for Plan tier standard",
        description:
          "Model for Plan tier standard (anything that is not light or heavy). When empty, the parent's model",
        example: "sonnet",
        empty: PARENT_MODEL,
      }),
      heavy: described(z.string().default(""), {
        summary: "Model for Plan tier heavy",
        description:
          "Model for Plan tier heavy (design decisions, data shapes, multiple packages, bugs of unknown cause). When empty, the parent's model",
        example: "opus",
        empty: PARENT_MODEL,
      }),
      // agent ごとの上書き（models.<agent>.<tier>）。鍵は、呼んだ agent を判定できる Adapter だけから作る。
      // 判定できない agent（Copilot CLI など）の鍵は dg next が決して引かず、設定しても黙って無視されるため
      ...Object.fromEntries(detectableAgentNames().map((agent) => [agent, agentModelsSchema])),
    })
    .prefault({}),
  actor: z
    .looseObject({
      human_only: described(z.array(z.string().min(1)).default([]), {
        summary: "Command names rejected for agents",
        description:
          "Command names rejected for agents (such as epic.close). Empty by default, allowing everything. Ticket transitions are restricted with the Workflow's by",
        example: ["epic.close"],
        empty:
          "Every command is allowed. Ticket transitions are still restricted with the Workflow's by",
      }),
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
      high: described(
        z
          .string()
          .default(
            "利用者に見える不具合・利用者を誤らせる文書・悪用できる脆弱性・ライセンスの漏れ・検査が通らない・ほかのチケットを止めている",
          ),
        {
          summary: "Criteria for priority high",
          description:
            "Criteria for priority high. Used when creating and reviewing tickets, and by the priority marks and selection hints on screen",
        },
      ),
      medium: described(
        z
          .string()
          .default(
            "機能の追加と改善・テストの抜けと不安定なテスト・内部の文書の食い違い・今は害のない規約違反・大きく古い依存",
          ),
        {
          summary: "Criteria for priority medium (the default)",
          description:
            "Criteria for priority medium (the default). Used when creating and reviewing tickets, and by the priority marks and selection hints on screen",
        },
      ),
      low: described(
        z
          .string()
          .default("使われていないコードと依存・設定の重複・言い回しの揺れ・急がない調査と検討"),
        {
          summary: "Criteria for priority low",
          description:
            "Criteria for priority low. Used when creating and reviewing tickets, and by the priority marks and selection hints on screen",
        },
      ),
    })
    .prefault({}),
  retro: z
    .looseObject({
      // 観点ごとの入れ子で、葉の項目ではない。configFields（設定画面と config.set の項目）には出さず、
      // dg retro perspective・dg retro metric・dg retro remove が書く。
      // 既定は観点の一覧ごと（チームが 1 つでも書けば、書いた一覧がそのまま全体になる）
      perspectives: z
        .record(slugSchema, retroPerspectiveSchema)
        .default(() => structuredClone(DEFAULT_RETRO_PERSPECTIVES))
        .describe(
          "Perspectives of the retrospective (perspective ID → name, question, and approved metric definitions). Written by dg retro perspective, dg retro metric, and dg retro remove",
        ),
    })
    .prefault({}),
});
export type Config = z.output<typeof configSchema>;

/** 既定値だけの config */
export function defaultConfig(): Config {
  return configSchema.parse({});
}

/** 設定の 1 項目の型。画面はこれで入力欄（選択欄・チェック・数・テキスト・リスト）を選ぶ */
export type ConfigFieldType = "enum" | "boolean" | "number" | "string" | "list";

/**
 * 項目の範囲。team はチームの config.yaml だけで決まり、local は個人の設定（deguboard-local/config.yaml）で上書きできる。
 * 値は「個人 > チーム > 既定」の順に読む
 */
export type ConfigScope = "team" | "local";

/**
 * 個人で上書きできる項目。マシンの配置・作業の好み・使えるモデル・自分のマシンで許すことのように、人ごとに違ってよいもの。
 * 逆に、PR のマージ・エージェントに自動で選ばせる判断（auto.*）・記録に関わる項目はここに入れず、チーム専用にする。
 * 個人で外せると、同じチームでも PR の流れと記録の形が人ごとに変わり、チームで揃わなくなるため
 */
const LOCAL_KEYS: ReadonlySet<string> = new Set([
  "default_project",
  "git.remote",
  "worktree.root",
  "commit.mode",
  "push.mode",
  ...MODEL_TIERS.map((tier) => `models.${tier}`),
  // agent ごとのモデル名も、使えるモデルが人ごとに違うので個人で上書きできる
  ...detectableAgentNames().flatMap((agent) =>
    MODEL_TIERS.map((tier) => `models.${agent}.${tier}`),
  ),
  "actions.shell",
  "notify.approvals",
  // 同時に回せる数はマシンの重さと契約の上限で人ごとに違う
  "work.parallel",
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
  /** 選択肢ごとの説明（選択肢 → 説明）。選択肢のある項目（enum と、選択肢の配列）が持つ */
  option_descriptions?: Record<string, string> | undefined;
  /** 1 行の要約。設定画面が常に出す */
  summary: string;
  /** スキーマの describe（詳しい説明の全文） */
  description: string;
  /** 例の値（項目の値と同じ形）。例のある項目だけ */
  example?: unknown;
  /** 空の値のときの動き。空にできる項目（配列と文字列）だけ */
  empty?: string | undefined;
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
  const texts = fieldTexts.get(schema);
  const field: ConfigField = {
    key,
    type: "string",
    summary: texts?.summary ?? "",
    description: schema.description ?? "",
    default: fallback,
    scope: configScopeOf(key),
    clears_to_default: false,
  };
  if (inner instanceof z.ZodEnum) {
    field.type = "enum";
    field.options = inner.options.map(String);
  } else if (inner instanceof z.ZodBoolean) field.type = "boolean";
  else if (inner instanceof z.ZodNumber) field.type = "number";
  else if (inner instanceof z.ZodArray) field.type = "list";
  else field.clears_to_default = typeof fallback === "string" && fallback !== "";
  if (texts?.options) field.option_descriptions = texts.options;
  if (texts?.example !== undefined) field.example = texts.example;
  const empty = texts?.empty ?? (field.clears_to_default ? EMPTY_RETURNS_TO_DEFAULT : undefined);
  if (empty !== undefined) field.empty = empty;
  return field;
}

/**
 * config.yaml の葉の項目を、スキーマの並びのまま既定値・説明・範囲つきで出す。
 * 鍵が利用者の決める入れ子（retro.perspectives）は 1 つの入力欄に収まらないので出さない（専用のコマンドが書く）
 */
export function configFields(): ConfigField[] {
  const defaults = defaultConfig() as Record<string, unknown>;
  const fields: ConfigField[] = [];
  // 入れ子は葉まで開く（guide.notes.<topic> は 2 段の下にある）
  const walk = (key: string, schema: z.ZodType, value: unknown): void => {
    const inner = unwrap(schema);
    if (inner instanceof z.ZodRecord) return;
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
      ignored.push({ key, reason: "Not in the schema" });
      continue;
    }
    if (configScopeOf(key) !== "local") {
      ignored.push({ key, reason: "Team-only setting (change it in the team's config.yaml)" });
      continue;
    }
    const [top, ...rest] = key.split(".") as [string, ...string[]];
    const probe = configSchema.safeParse({
      ...config,
      [top]: nestedConfigValue(config[top], rest, value),
    });
    if (!probe.success) {
      ignored.push({ key, reason: `Invalid value: ${z.prettifyError(probe.error)}` });
      continue;
    }
    config = probe.data;
    applied[key] = value;
  }
  return { config: config as Config, local: applied, ignored };
}
