import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  askCandidates,
  buildAsk,
  configFields,
  DEFAULT_WORKFLOW,
  defaultConfig,
  flattenConfig,
  NO_PR_ERROR,
  OPEN_AT_SESSION_END_ERROR,
  RECONCILE_TAKEN_ERROR,
  RECONCILE_TODO_ERROR,
  REVIEW_UNRECORDED,
  RUN_STEPS,
  STALE_SESSION_ERROR,
  UNCLAIMED_ERROR,
  validateWorkflow,
  type AskSubject,
} from "@deguboard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configDescription,
  format,
  languageOf,
  msg,
  setLanguage,
  isDefaultPerspective,
  shownDefault,
  shownDefaultText,
  shownWorkflow,
  storedDefault,
  tr,
  trCore,
  trCoreMessage,
  type Language,
} from "./l10n.js";
import {
  CONFIG_DESCRIPTIONS,
  CORE_LABELS,
  CORE_MESSAGES,
  DEFAULT_VALUES,
  type CoreTextTable,
} from "./l10n-core.js";
import { EN, EN_ONE } from "./l10n-en.js";
import type { Status, WorkflowView } from "./types.js";

const srcDir = dirname(fileURLToPath(import.meta.url));

/** 日本語の文字（かな・漢字・全角の記号。「・」「（」「、」なども含む） */
const JAPANESE = /[　-ヿ一-鿿＀-￯]/;

/** 文言でない日本語（チケットの本文の書式を読むための語）。画面に出さないので訳さない */
const NOT_MESSAGES = [
  // 受け入れ条件の節の日本語の名前（core の本文の書式と同じ語で探す）
  'markdown.tsx: ja: "受け入れ条件",',
  // 設定画面の振り返りの節で、指標の数え方の最初の文を要約として切り出す区切り（画面に出す文言ではない）
  'pages/config.tsx: const ends = [definition.indexOf("。"), definition.indexOf(". ")].filter((i) => i >= 0);',
];

/** 鍵を書く関数の呼び出しの、最初の引数の文字列リテラル */
const KEY_CALL = /\b(tr|trNode|msg)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

/** 画面のソース（テスト・テストの道具・訳の表を除く）を、コメントを落として読む */
function sourceCode(): { file: string; code: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = resolve(dir, name);
      if (statSync(path).isDirectory()) return name === "__snapshots__" ? [] : walk(path);
      return [path];
    });
  return walk(srcDir)
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith(".d.ts"))
    .filter((p) => !/[/\\](l10n\.ts|l10n-en\.ts|l10n-core\.ts|test-helpers\.ts)$/.test(p))
    .map((path) => {
      const code = readFileSync(path, "utf8")
        // ブロックのコメント（JSX の {/* */} を含む）と、行のコメント（前が空白か行頭の //）を落とす
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
      return { file: relative(srcDir, path), code };
    });
}

/** ソースの鍵。鍵は文字列リテラルで書く約束（l10n.ts） */
function sourceKeys(): Set<string> {
  const keys = new Set<string>();
  for (const { code } of sourceCode()) {
    for (const m of code.matchAll(KEY_CALL)) {
      const literal = m[2]!;
      keys.add(
        literal.startsWith("'")
          ? literal.slice(1, -1).replace(/\\'/g, "'")
          : (JSON.parse(literal) as string),
      );
    }
  }
  return keys;
}

/** 文の中の {0}・{1} の並び */
const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();

afterEach(() => setLanguage("ja"));

describe("表示言語の決め方と訳し方", () => {
  it("data-language がなければ（dg serve）日本語、ja で始まれば日本語、ほかは英語", () => {
    expect(languageOf(undefined)).toBe("ja");
    expect(languageOf("")).toBe("ja");
    expect(languageOf("ja")).toBe("ja");
    expect(languageOf("en")).toBe("en");
    expect(languageOf("en-us")).toBe("en");
    expect(languageOf("zh-cn")).toBe("en");
  });
  it("日本語では鍵の {0} を埋めただけのもの（テンプレートリテラルと同じ文字）を出し、日本語の core の文は訳さずそのまま出す", () => {
    expect(tr("{0} 件", 3)).toBe("3 件");
    expect(tr("ほか {0} 件", 0)).toBe(`ほか ${0} 件`);
    expect(tr("{0}（{1}）", null, undefined)).toBe(`${null}（${undefined}）`);
    expect(format("{0} と {1}", ["a"])).toBe("a と {1}");
    expect(msg("カンバン")).toBe("カンバン");
    expect(trCoreMessage("commit.mode の値が正しくない")).toBe("commit.mode の値が正しくない");
  });
  it("英語では訳の表で出し、表にない鍵は鍵のまま出す", () => {
    setLanguage("en");
    expect(tr("{0} 件", 3)).toBe("3 items");
    expect(tr("カンバン")).toBe("Board");
    expect(tr("表にない {0}", 1)).toBe("表にない 1");
  });
  it("英語では数の引数が 1 なら単数の形で出し、日本語は数で形を変えない", () => {
    expect(tr("{0} 件", 1)).toBe("1 件");
    setLanguage("en");
    expect(tr("{0} 件", 1)).toBe("1 item");
    expect(tr("{0} 件", 2)).toBe("2 items");
    expect(tr("{0} / {1} 件", 1, 1)).toBe("1 / 1 item");
  });
  it("core の候補の名前（英語）は、日本語では ID を埋めた訳で、英語ではそのまま出す", () => {
    expect(trCore("Create tickets in s3")).toBe("起票して s3 に入れる");
    expect(trCore("Remove from Iteration/Epic")).toBe("Iteration・Epic から外す");
    expect(trCore("Reopen")).toBe("再開する");
    expect(trCore("todo")).toBe("todo");
    setLanguage("en");
    expect(trCore("Create tickets in s3")).toBe("Create tickets in s3");
    expect(trCore("Remove from Iteration/Epic")).toBe("Remove from Iteration/Epic");
  });
});

describe("画面の文言の置き場所", () => {
  it("ソースの鍵と EN の鍵が過不足なく揃う", () => {
    const keys = [...sourceKeys()].sort();
    expect(keys.length).toBeGreaterThan(0);
    expect(Object.keys(EN).sort()).toEqual(keys);
  });
  it("英語の訳は日本語を含まず、{0} の並びを保つ", () => {
    for (const [key, value] of Object.entries(EN)) {
      expect(value, key).not.toMatch(JAPANESE);
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
  it("core の文の訳の表（CORE_LABELS・CORE_MESSAGES）は、鍵が core の英語の文で、どの文も表示言語（ja・en）の訳だけを持ち、日本語の訳（ja）が揃う", () => {
    const tables: Record<string, CoreTextTable> = {
      CORE_LABELS,
      CORE_MESSAGES,
    };
    for (const [name, table] of Object.entries(tables)) {
      expect(Object.keys(table).length, name).toBeGreaterThan(0);
      for (const [key, entry] of Object.entries(table)) {
        const where = `${name}: ${key}`;
        expect(
          Object.keys(entry).every((l) => l === "ja" || l === "en"),
          where,
        ).toBe(true);
        expect(key, where).not.toMatch(JAPANESE);
        expect(entry.ja, where).toBeDefined();
        for (const text of Object.values(entry)) {
          expect(placeholders(text), where).toEqual(placeholders(key));
        }
      }
    }
  });
  it("設定の項目の文（説明・要約・空のときの動き・選択肢ごとの説明）の表は、鍵が英語の文で、どの鍵も日本語の訳（ja）を持つ", () => {
    expect(Object.keys(CONFIG_DESCRIPTIONS).length).toBeGreaterThan(0);
    for (const [key, entry] of Object.entries(CONFIG_DESCRIPTIONS)) {
      expect(key, key).not.toMatch(JAPANESE);
      expect(Object.keys(entry), key).toEqual(["ja"]);
      expect(entry.ja, key).toMatch(JAPANESE);
    }
  });
  it("単数の形（EN_ONE）は EN にある鍵だけに置き、日本語を含まず {0} の並びと数の引数の番号が合う", () => {
    for (const [key, { arg, text }] of Object.entries(EN_ONE)) {
      expect(EN[key], key).toBeDefined();
      expect(text, key).not.toMatch(JAPANESE);
      expect(placeholders(text), key).toEqual(placeholders(key));
      expect(placeholders(key), key).toContain(`{${arg}}`);
    }
  });
  it("コメントを除いたソースに、鍵の外で日本語の文言を直書きしない", () => {
    const found = sourceCode().flatMap(({ file, code }) =>
      code
        .replace(KEY_CALL, "$1(")
        .split("\n")
        .filter((line) => JAPANESE.test(line))
        .map((line) => `${file}: ${line.trim()}`)
        .filter((line) => !NOT_MESSAGES.includes(line)),
    );
    expect(found).toEqual([]);
  });
});

/** core の候補の名前を出し尽くすための対象。Status・状態・組み合わせを変える */
function subjectSets(): { subjects: AskSubject[]; within?: string }[] {
  const ticket = (id: string, over: Partial<AskSubject & { kind: "ticket" }> = {}): AskSubject => ({
    kind: "ticket",
    id,
    title: "x",
    status: "todo",
    iteration: "s1",
    iteration_status: "active",
    epic: "e1",
    deps_done: true,
    running: false,
    ...over,
  });
  const tickets: AskSubject[] = [];
  for (const status of ["todo", "in_progress", "review", "done", "abandoned"]) {
    for (const running of [false, true]) {
      for (const deps_done of [true, false]) {
        for (const iteration of ["s1", null]) {
          tickets.push(
            ticket(`t${tickets.length + 1}`, {
              status,
              running,
              deps_done,
              iteration,
              iteration_status: iteration ? "active" : null,
            }),
          );
        }
      }
    }
  }
  const iterations: AskSubject[] = ["planned", "active", "closed"].flatMap((status) =>
    [false, true].map((complete): AskSubject => ({
      kind: "iteration",
      id: "s1",
      title: "x",
      status,
      complete,
    })),
  );
  const epics: AskSubject[] = ["open", "closed"].map((status) => ({
    kind: "epic",
    id: "e1",
    title: "x",
    status,
  }));
  const plans: AskSubject[] = (["pending_approval", "approved", "closed"] as const).flatMap(
    (status) =>
      [false, true].map((complete): AskSubject => ({
        kind: "plan",
        id: "p1",
        status,
        tickets: ["t1"],
        complete,
      })),
  );
  const singles = [...tickets, ...iterations, ...epics, ...plans];
  return [
    { subjects: [] },
    ...singles.map((s) => ({ subjects: [s] })),
    ...tickets.map((s) => ({ subjects: [s, tickets[0]!] })),
    ...tickets.map((s) => ({ subjects: [s], within: "s1" })),
    ...tickets.map((s) => ({ subjects: [s], within: "e1" })),
    { subjects: [tickets[0]!, iterations[0]!] },
  ];
}

describe("core が返す決まった文の訳", () => {
  it("エージェントに頼むの候補の名前は、core が英語で返し、どの対象でも日本語に訳せる。CORE_LABELS の鍵は候補の名前と Plan の承認の状態に過不足なく揃う", () => {
    const untranslated = new Set<string>();
    // 出し尽くした候補の名前と Plan の承認の状態の、ID を {0} にした鍵
    const reached = new Set<string>();
    const keyOf = (text: string) => {
      let n = 0;
      return text.replace(/\b[tsep]\d+\b/g, () => `{${n++}}`);
    };
    const candidates = [
      ...subjectSets().flatMap(({ subjects, within }) => askCandidates(subjects, within)),
      // 振り返るは履歴の行（historyRow）の閉じた Iteration にだけ出るので、その場所の候補も足す
      ...askCandidates(
        [{ kind: "iteration", id: "s1", title: "x", status: "closed", complete: true }],
        undefined,
        "ja",
        "historyRow",
      ),
    ];
    for (const c of candidates) {
      expect(c.label, c.action).not.toMatch(JAPANESE);
      reached.add(keyOf(c.label));
      if (!JAPANESE.test(trCore(c.label))) untranslated.add(`${c.action}: ${c.label}`);
    }
    for (const status of ["pending_approval", "approved", "closed"] as const)
      reached.add(
        buildAsk({
          subjects: [{ kind: "plan", id: "p1", status, tickets: ["t1"], complete: false }],
        }).targets[0]!.sub,
      );
    // 「Iteration/Epic」は外す場所がないときの既定の文で、外すの候補の名前の {0} に入る（鍵の文ではない）
    expect(Object.keys(CORE_LABELS).sort()).toEqual([...reached, "Iteration/Epic"].sort());
    expect([...untranslated]).toEqual([]);
  });
  it("札の下の 1 文と Skill の 1 文は、英語の画面では core が英語で組む", () => {
    const untranslated = new Set<string>();
    for (const { subjects, within } of subjectSets()) {
      // 札の下の 1 文（meaning）は core が言語ごとに組むので、英語の画面では英語の文になる
      for (const c of askCandidates(subjects, within, "en")) {
        if (JAPANESE.test(c.meaning)) untranslated.add(`${c.action}: ${c.meaning}`);
        // Skill の 1 文（skill_summary）も英語の画面では英語（札とボタンのツールチップに出る）
        if (c.skill_summary && JAPANESE.test(c.skill_summary))
          untranslated.add(`${c.action}: ${c.skill_summary}`);
      }
    }
    expect([...untranslated]).toEqual([]);
  });
  it("札の添え字の Plan の承認の状態は、core の ask が英語で返し、日本語の画面ではどれも日本語に訳す", () => {
    // 添え字は core の ask の出力（targets[].sub）から取る。core の文言が変われば訳せなくなって気づく
    const subs = (["pending_approval", "approved", "closed"] as const).map(
      (status) =>
        buildAsk({
          subjects: [{ kind: "plan", id: "p1", status, tickets: ["t1"], complete: false }],
        }).targets[0]!.sub,
    );
    for (const sub of subs) {
      expect(sub).not.toMatch(JAPANESE);
      expect(trCore(sub), sub).toMatch(JAPANESE);
    }
    setLanguage("en");
    for (const sub of subs) expect(trCore(sub)).toBe(sub);
  });
});

/** packages/<name>/src のソース（テストを除く）。CORE_MESSAGES の鍵が core と server の文に合うかを確かめる */
function packageSource(name: "core" | "server"): string {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = resolve(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return walk(resolve(srcDir, `../../${name}/src`))
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
}

function coreSource(): string {
  return packageSource("core");
}

describe("core が返すエラー・警告の文の訳（UI-11）", () => {
  it("鍵の {0} 以外の部分はどれも core か server のソースにあり、{0}・{1} は現れる順に書く", () => {
    // core と server の文言を書き換えたら、ここで訳の鍵が合わなくなって気づく
    const source = `${coreSource()}\n${packageSource("server")}`;
    for (const key of Object.keys(CORE_MESSAGES)) {
      const numbers = [...key.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
      expect(numbers, key).toEqual(numbers.map((_, i) => i));
      for (const part of key.split(/\{\d+\}/).filter((p) => p.trim() !== ""))
        expect(source.includes(part), `${key}: ${part}`).toBe(true);
    }
  });
  it("日本語の表示では可変の部分を埋めた訳を出し、入れ子の文も訳す。英語の表示では core の英語の文のまま出す", () => {
    setLanguage("ja");
    expect(trCoreMessage("priority.high cannot be set in personal settings")).toBe(
      "priority.high は個人の設定に書けない",
    );
    expect(trCoreMessage("t3 not found (deleted)")).toBe("t3 が見つからない（削除された）");
    expect(trCoreMessage("deguboard-local/runs/r1.json: Cannot parse JSON")).toBe(
      "deguboard-local/runs/r1.json: JSON を読めない",
    );
    setLanguage("en");
    expect(trCoreMessage("t3 not found (deleted)")).toBe("t3 not found (deleted)");
    expect(trCoreMessage("deguboard-local/runs/r1.json: Cannot parse JSON")).toBe(
      "deguboard-local/runs/r1.json: Cannot parse JSON",
    );
  });
  it("英語の表示でも、表にない文は core の文のまま出す", () => {
    setLanguage("en");
    expect(trCoreMessage("訳のない文")).toBe("訳のない文");
    expect(trCoreMessage("")).toBe("");
  });
  it("core が Run の error に書く定数は、どれも CORE_MESSAGES の鍵にあって日本語の訳を持つ（t950）", () => {
    // 上の検査は表の鍵が core にあるかの向きだけなので、定数を足したり文を書き換えたりして表を直し忘れると、
    // 日本語の画面に英語の error が出る。core のソースで error に渡す定数の名前を拾い、ここの一覧と突き合わせて足し忘れにも気づく
    const constants: Record<string, string> = {
      NO_PR_ERROR,
      OPEN_AT_SESSION_END_ERROR,
      RECONCILE_TAKEN_ERROR,
      RECONCILE_TODO_ERROR,
      REVIEW_UNRECORDED,
      STALE_SESSION_ERROR,
      UNCLAIMED_ERROR,
    };
    const source = coreSource();
    const used = new Set([...source.matchAll(/\berror: ([A-Z][A-Z0-9_]+)\b/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(Object.keys(constants).sort());
    // 定数の名前しか拾わないので、error に文を直書きすると上の突き合わせをすり抜ける（t974）。直書きを残さない
    expect([...source.matchAll(/\berror: ["'`][^"'`]*["'`]/g)].map((m) => m[0])).toEqual([]);
    for (const [name, text] of Object.entries(constants)) {
      expect(CORE_MESSAGES[text]?.ja, `${name}: ${text}`).toMatch(JAPANESE);
    }
  });
  it("dg serve が JSON で返すエラーの文は英語で、どれも CORE_MESSAGES の鍵にあって日本語の画面では訳す（t948）", () => {
    // server のソースの message: の文字列と new Error・エラーの型の super の文を拾う（可変の部分 ${…} は {0}・{1} にする）。
    // 文を足したり書き換えたりして表を直し忘れると、日本語の画面に英語のエラーが出るので気づく
    const source = packageSource("server");
    const texts = [
      ...source.matchAll(/\bmessage: (?:"([^"]*)"|`([^`]*)`)/g),
      ...source.matchAll(/(?:new Error|super)\("([^"]*)"\)/g),
    ].map((m) => {
      let n = 0;
      return (m[1] ?? m[2]!).replace(/\$\{[^}]*\}/g, () => `{${n++}}`);
    });
    // 拾い方が壊れて 0 件で通らないように、Host を断る文と大きすぎる本文の文が入っていることを確かめる
    expect(texts).toContain("The request body is too large");
    expect(texts.some((t) => t.startsWith("Refused a request for the host name"))).toBe(true);
    for (const text of texts) {
      expect(text).not.toMatch(JAPANESE);
      expect(CORE_MESSAGES[text]?.ja, text).toMatch(JAPANESE);
    }
    setLanguage("ja");
    expect(trCoreMessage("No API at /api/nope")).toBe("/api/nope という API はない");
    expect(trCoreMessage('Refused a request whose URL cannot be read: "/a:b"')).toBe(
      'URL を読めない要求を断った: "/a:b"',
    );
    setLanguage("en");
    expect(trCoreMessage("No API at /api/nope")).toBe("No API at /api/nope");
  });
});

describe("設定の項目の説明の訳", () => {
  it("core の項目の文（説明・要約・空のときの動き・選択肢ごとの説明）と CONFIG_DESCRIPTIONS の鍵が過不足なく揃う（core の文を書き換えたら訳の鍵と訳も直す）", () => {
    // 例（example）は値なので訳さない
    const texts = configFields().flatMap((f) => [
      f.description,
      f.summary,
      ...(f.empty === undefined ? [] : [f.empty]),
      ...Object.values(f.option_descriptions ?? {}),
    ]);
    expect(Object.keys(CONFIG_DESCRIPTIONS).sort()).toEqual([...new Set(texts)].sort());
  });
  it("要約・空のときの動き・選択肢ごとの説明も、日本語では表の ja の訳を出す（t812）", () => {
    const byKey = new Map(configFields().map((f) => [f.key, f]));
    const commit = byKey.get("commit.mode");
    expect(configDescription(commit?.summary ?? "")).toBe("チケットの書き込みをいつコミットするか");
    expect(configDescription(commit?.option_descriptions?.each ?? "")).toBe(
      "書き込みのたびにコミットする",
    );
    expect(configDescription(byKey.get("models.light")?.empty ?? "")).toBe("親のモデル");
    expect(configDescription(byKey.get("guide.notes.work")?.summary ?? "")).toBe(
      "guide の題名の直後に差し込む文書。リポジトリの最上位からの相対パス",
    );
  });
  it("日本語では表の ja の訳を出し、英語では core の説明（英語の文）のまま出し、表にない説明は core の説明のまま出す", () => {
    const description =
      "Git remote of the code (work branches and pull requests). The kanban data also syncs with it unless git.data_remote is set";
    expect(configDescription(description)).toBe(
      "コードのリモート（作業ブランチと PR）。git.data_remote を設定しなければ、カンバンのデータもここと同期する",
    );
    setLanguage("en");
    expect(configDescription(description)).toBe(description);
    expect(configDescription("New item")).toBe("New item");
    setLanguage("ja");
    expect(configDescription("新しい項目")).toBe("新しい項目");
  });
});

describe("core の文の訳の表の引き方（t649）", () => {
  it("日本語の表示では、設定の説明は表の訳を、表にない文は core の文と同じ字で出す。英語の表示では、候補の名前は core の文と同じ字で出す", () => {
    for (const { description } of configFields())
      expect(configDescription(description)).toBe(
        CONFIG_DESCRIPTIONS[description]?.ja ?? description,
      );
    for (const text of [
      "priority.high は個人の設定に書けない",
      "deguboard-local/runs/r1.json: JSON を読めない",
      "Iteration・Epic から外す",
    ]) {
      expect(trCoreMessage(text)).toBe(text);
      expect(trCore(text)).toBe(text);
    }
    setLanguage("en");
    for (const { subjects, within } of subjectSets()) {
      for (const c of askCandidates(subjects, within)) expect(trCore(c.label)).toBe(c.label);
    }
  });
  it("日本語の表示でも表を引き、ja の訳があれば出し、訳のない言語は core の文のまま出す", async () => {
    // 訳のない鍵（Fix）を含む、鍵が英語の文で ja の訳を持つ形の表に差し替えて引く
    vi.resetModules();
    vi.doMock("./l10n-core.js", () => ({
      CORE_LABELS: {
        "Remove from {0}": { ja: "{0} から外す" },
        Fix: {},
      },
      CORE_MESSAGES: {
        "{0} not found (deleted)": { ja: "{0} が見つからない（削除された）" },
        "deguboard-local/{0}: {1}": {},
        "Cannot parse JSON": { ja: "JSON を読めない" },
      },
      CONFIG_DESCRIPTIONS: { "Git remote to sync with": { ja: "同期先のリモート" } },
      DEFAULT_VALUES: { "Default text": { ja: "既定の文" } },
    }));
    try {
      const l = await import("./l10n.js");
      expect(l.language()).toBe("ja");
      expect(l.trCore("Remove from s3")).toBe("s3 から外す");
      expect(l.trCore("Fix")).toBe("Fix");
      expect(l.trCoreMessage("t3 not found (deleted)")).toBe("t3 が見つからない（削除された）");
      expect(l.trCoreMessage("deguboard-local/runs/r1.json: Cannot parse JSON")).toBe(
        "deguboard-local/runs/r1.json: JSON を読めない",
      );
      expect(l.configDescription("Git remote to sync with")).toBe("同期先のリモート");
      // 既定の値も同じ引き方：英語で持つ既定は、既定のままのときだけ日本語の訳で出し、訳の文は既定に戻して保存する
      expect(l.shownDefault("Default text", "Default text")).toBe("既定の文");
      expect(l.shownDefault("Rewritten", "Default text")).toBe("Rewritten");
      expect(l.shownDefault("既定の文", "Default text")).toBe("既定の文");
      expect(l.storedDefault("既定の文", "Default text")).toBe("Default text");
      l.setLanguage("en");
      expect(l.shownDefault("Default text", "Default text")).toBe("Default text");
      expect(l.storedDefault("既定の文", "Default text")).toBe("既定の文");
      expect(l.trCore("Remove from s3")).toBe("Remove from s3");
      expect(l.trCoreMessage("t3 not found (deleted)")).toBe("t3 not found (deleted)");
      expect(l.configDescription("Git remote to sync with")).toBe("Git remote to sync with");
    } finally {
      vi.doUnmock("./l10n-core.js");
      vi.resetModules();
    }
  });
});

describe("既定の値の訳（UI-11）", () => {
  /** 優先度の判断基準の既定（core が英語で持つ）。DEFAULT_VALUES に日本語の訳がある */
  const HIGH = configFields().find((f) => f.key === "priority.high")!.default as string;
  const HIGH_JA = DEFAULT_VALUES[HIGH]!.ja!;
  /** 表示言語を順に切り替えて確かめる */
  const inEach = (check: (language: Language) => void) => {
    for (const language of ["ja", "en"] as const) {
      setLanguage(language);
      check(language);
    }
  };

  it("DEFAULT_VALUES の鍵はどれも core の既定の文で、表示言語（ja・en）の訳だけを持つ（既定を書き換えたら鍵と訳も直す）", () => {
    // core の既定の文：config の既定（葉の項目と、振り返りの観点の名前と問い）と、Run の step の表示名と、Status の既定の表示名
    const coreDefaults = new Set<unknown>([
      ...Object.values(flattenConfig(defaultConfig())).filter((v) => typeof v === "string"),
      ...RUN_STEPS.map((s) => s.label),
      ...Object.values(DEFAULT_WORKFLOW.labels),
    ]);
    expect(Object.keys(DEFAULT_VALUES).length).toBeGreaterThan(0);
    for (const [key, entry] of Object.entries(DEFAULT_VALUES)) {
      expect(coreDefaults.has(key), key).toBe(true);
      expect(Object.keys(entry).length, key).toBeGreaterThan(0);
      for (const [language, text] of Object.entries(entry)) {
        expect(["ja", "en"], key).toContain(language);
        // 訳は鍵（core の文）と違う言語で書く。同じ言語の訳は要らない（訳がなければ既定の文のまま出す）
        expect(JAPANESE.test(text), key).toBe(language === "ja");
        expect(JAPANESE.test(key), key).toBe(language !== "ja");
      }
    }
  });
  it("優先度の判断基準の既定は 3 つとも英語で、日本語の訳を持つ", () => {
    for (const level of ["high", "medium", "low"]) {
      const value = configFields().find((f) => f.key === `priority.${level}`)!.default as string;
      expect(JAPANESE.test(value), level).toBe(false);
      expect(DEFAULT_VALUES[value]?.ja, level).toBeDefined();
    }
  });
  it("既定のままの値は、今の言語の訳があれば訳で、なければ既定の文のまま出す", () => {
    expect(shownDefault(HIGH, HIGH)).toBe(HIGH_JA);
    // 既定が英語なので、英語の表示では訳さない
    setLanguage("en");
    expect(shownDefault(HIGH, HIGH)).toBe(HIGH);
    // 訳のない既定は、既定と同じでも値のまま
    inEach(() => expect(shownDefault("origin", "origin")).toBe("origin"));
  });
  it("既定を書き換えた値は、どちらの表示言語でも書いたまま出す。ほかの既定と同じ文・訳と同じ文・古い既定の写しも人の値として扱う", () => {
    const medium = configFields().find((f) => f.key === "priority.medium")!.default as string;
    inEach((language) => {
      for (const written of ["独自の基準", "Our own criteria", ""]) {
        expect(shownDefault(written, HIGH), `${language}: ${written}`).toBe(written);
      }
      // 訳の表にある文でも、この項目の既定と違えば訳さない（ほかの項目の既定と、訳の文そのもの）
      expect(shownDefault(medium, HIGH), language).toBe(medium);
      // 日本語の既定を config.yaml に書いたリポジトリ（前の既定の写し）も、書いたまま出す
      expect(shownDefault(HIGH_JA, HIGH), language).toBe(HIGH_JA);
      // 既定が変わった後に残る、前の既定の写し（表に訳が残っていても、今の既定と違うので書いたまま）
      expect(shownDefault(HIGH, "New default"), language).toBe(HIGH);
    });
  });
  it("文字列でない値（リスト・真偽・数）と、既定のない値は値のまま出す", () => {
    const list = ["a"];
    inEach(() => {
      expect(shownDefault(list, list)).toBe(list);
      expect(shownDefault(true, true)).toBe(true);
      expect(shownDefault(3, 3)).toBe(3);
      expect(shownDefault(undefined, undefined)).toBeUndefined();
      expect(shownDefault(HIGH, undefined)).toBe(HIGH);
    });
  });
  it("既定そのものの文は比べずに、今の言語の訳があれば訳で、なければ既定の値のまま出す", () => {
    expect(shownDefaultText(HIGH)).toBe(HIGH_JA);
    setLanguage("en");
    expect(shownDefaultText(HIGH)).toBe(HIGH);
    inEach(() => {
      expect(shownDefaultText("origin")).toBe("origin");
      expect(shownDefaultText(undefined)).toBeUndefined();
    });
  });
  it("観点は名前と問いの両方が既定と同じときだけ既定のままとみなす", () => {
    const d = { name: "Spec", question: "Is it clear?" };
    expect(isDefaultPerspective({ ...d }, d)).toBe(true);
    expect(isDefaultPerspective({ ...d, name: "Ours" }, d)).toBe(false);
    expect(isDefaultPerspective({ ...d, question: "Ours?" }, d)).toBe(false);
  });
  it("入力欄の訳の文は保存するとき既定の値に戻し、ほかの文はそのまま保存する", () => {
    expect(storedDefault(HIGH_JA, HIGH)).toBe(HIGH);
    expect(storedDefault("独自の基準", HIGH)).toBe("独自の基準");
    // 訳のない既定は、何を打ってもそのまま
    expect(storedDefault("upstream", "origin")).toBe("upstream");
    expect(storedDefault("", undefined)).toBe("");
    // 訳を出していない言語では、訳と同じ文も人の値
    setLanguage("en");
    expect(storedDefault(HIGH_JA, HIGH)).toBe(HIGH_JA);
  });
  it("出した文をそのまま保存に戻すと、どちらの表示言語でも元の値になる（欄を書き換えずに離れても値が変わらない）", () => {
    inEach((language) => {
      for (const value of [HIGH, HIGH_JA, "独自の基準", "origin"]) {
        for (const defaultValue of [HIGH, "origin"]) {
          const shown = shownDefault(value, defaultValue);
          // 訳と同じ文を人が書いていた値は、欄を離れても書き換えない（画面は出した文のままなら値を渡す）ので、ここでは除く
          if (value !== defaultValue && shown === shownDefaultText(defaultValue)) continue;
          expect(storedDefault(shown, defaultValue), `${language}: ${value}`).toBe(value);
        }
      }
    });
  });
});

describe("Workflow の表示名の表示（UI-11）", () => {
  /** Status の日本語の訳（core の既定の表示名を既定のまま置いたとき） */
  const LABELS_JA = {
    todo: "未着手",
    in_progress: "作業中",
    review: "見直し",
    done: "完了",
    abandoned: "中止",
  };
  /**
   * workflow.show の出力の形（core が 1 つの workflow.yaml から組むもの）。labels は states の label に core の既定を補ったもの、
   * default_labels は core の既定、steps は core が固定で持つ Run の step
   */
  const viewOf = (states: Partial<Record<Status, { label: string }>> = {}): WorkflowView => {
    const { workflow } = validateWorkflow({ states }, "workflow.yaml");
    return {
      labels: workflow!.labels,
      transitions: [],
      default_labels: DEFAULT_WORKFLOW.labels,
      steps: RUN_STEPS,
    };
  };

  it("日本語の表示では、states を書いていない Workflow の Status の表示名と、Run の step の表示名を日本語で出す", () => {
    const shown = shownWorkflow(viewOf());
    expect(shown.labels).toEqual(LABELS_JA);
    expect(shown.steps?.map((s) => [s.id, s.label])).toEqual([
      ["investigate", "調査"],
      ["implement", "実装"],
      ["review", "見直し"],
      ["fix", "手直し"],
      ["merge", "マージ"],
    ]);
  });
  it("Review の Status の表示名は、Review の step の表示名と同じ訳で出す", () => {
    const shown = shownWorkflow(viewOf());
    expect(shown.labels.review).toBe(shown.steps?.find((s) => s.id === "review")?.label);
  });
  it("英語の表示では、core の文のまま出す", () => {
    setLanguage("en");
    const view = viewOf();
    expect(shownWorkflow(view)).toEqual(view);
  });
  it("states の label で書き換えた表示名は書いたまま出し、書いていない Status と既定と同じ文の Status だけを訳す", () => {
    const shown = shownWorkflow(
      viewOf({
        // 既定と同じ文を書いた Status（todo）は既定のままとみなす。ほかの Status の既定と同じ文（review に Done）は書いたまま
        todo: { label: "Todo" },
        in_progress: { label: "Doing" },
        review: { label: "Done" },
        done: { label: "完了済み" },
      }),
    );
    expect(shown.labels).toEqual({
      todo: "未着手",
      in_progress: "Doing",
      review: "Done",
      done: "完了済み",
      abandoned: "中止",
    });
  });
  it("default_labels と steps のない Workflow（前の版の画面が残した cache）は、Status の表示名を訳さず、steps のないまま返す", () => {
    const { default_labels: _labels, steps: _steps, ...view } = viewOf();
    const shown = shownWorkflow(view);
    expect(shown.labels).toEqual(view.labels);
    expect(shown).not.toHaveProperty("steps");
  });
});
