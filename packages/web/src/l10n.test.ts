import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { askCandidates, buildAsk, configFields, type AskSubject } from "@deguboard/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  configDescription,
  format,
  languageOf,
  msg,
  setLanguage,
  shownConfigValue,
  storedConfigValue,
  tr,
  trCore,
  trCoreMessage,
} from "./l10n.js";
import {
  CONFIG_DESCRIPTIONS_EN,
  CORE_EN,
  CORE_MESSAGES_EN,
  EN,
  EN_ONE,
  PRIORITY_CRITERIA_EN,
} from "./l10n-en.js";

const srcDir = dirname(fileURLToPath(import.meta.url));

/** 日本語の文字（かな・漢字・全角の記号。「・」「（」「、」なども含む） */
const JAPANESE = /[　-ヿ一-鿿＀-￯]/;

/** 文言でない日本語（チケットの本文の書式を読むための語）。画面に出さないので訳さない */
const NOT_MESSAGES = [
  // 受け入れ条件の節の見出し（core の本文の書式と同じ語で探す）
  "markdown.tsx: const ACCEPTANCE_HEADING = /^## 受け入れ条件[ \\t]*$/;",
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
    .filter((p) => !/[/\\](l10n\.ts|l10n-en\.ts|test-helpers\.ts)$/.test(p))
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
  it("日本語では鍵の {0} を埋めただけのもの（テンプレートリテラルと同じ文字）を出す", () => {
    expect(tr("{0} 件", 3)).toBe("3 件");
    expect(tr("未 push {0}", 0)).toBe(`未 push ${0}`);
    expect(tr("{0}（{1}）", null, undefined)).toBe(`${null}（${undefined}）`);
    expect(format("{0} と {1}", ["a"])).toBe("a と {1}");
    expect(msg("カンバン")).toBe("カンバン");
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
  it("core の候補の名前は、日本語ではそのまま、英語では ID を埋めた訳で出し、頼むことで訳を分ける", () => {
    expect(trCore("起票して s3 に入れる")).toBe("起票して s3 に入れる");
    setLanguage("en");
    expect(trCore("起票して s3 に入れる")).toBe("Create tickets in s3");
    expect(trCore("Iteration・Epic から外す")).toBe("Remove from Iteration/Epic");
    expect(trCore("再開する", "reopen")).toBe("Reopen");
    expect(trCore("再開する", "resume")).toBe("Resume");
    expect(trCore("todo")).toBe("todo");
  });
});

describe("画面の文言の置き場所", () => {
  it("ソースの鍵と EN の鍵が過不足なく揃う", () => {
    const keys = [...sourceKeys()].sort();
    expect(keys.length).toBeGreaterThan(0);
    expect(Object.keys(EN).sort()).toEqual(keys);
  });
  it("英語の訳は日本語を含まず、{0} の並びを保つ", () => {
    for (const table of [EN, CORE_EN, CORE_MESSAGES_EN]) {
      for (const [key, value] of Object.entries(table)) {
        expect(value, key).not.toMatch(JAPANESE);
        expect(placeholders(value), key).toEqual(placeholders(key.replace(/^\w+:/, "")));
      }
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
    [false, true].flatMap((complete) =>
      [false, true].map((overdue): AskSubject => ({
        kind: "iteration",
        id: "s1",
        title: "x",
        status,
        complete,
        overdue,
      })),
    ),
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
  it("エージェントに頼むの候補の名前は、どの対象でも英語に訳せる", () => {
    setLanguage("en");
    const untranslated = new Set<string>();
    let count = 0;
    for (const { subjects, within } of subjectSets()) {
      for (const c of askCandidates(subjects, within)) {
        count++;
        const text = trCore(c.label, c.action);
        if (JAPANESE.test(text)) untranslated.add(`${c.action}: ${c.label}`);
      }
    }
    expect(count).toBeGreaterThan(0);
    expect([...untranslated]).toEqual([]);
  });
  it("札の添え字の Plan の承認の状態は、core の ask が返す sub のどれも英語に訳せる", () => {
    // 添え字は core の ask の出力（targets[].sub）から取る。core の文言が変われば訳せなくなって気づく
    const subs = (["pending_approval", "approved", "closed"] as const).map(
      (status) =>
        buildAsk({
          subjects: [{ kind: "plan", id: "p1", status, tickets: ["t1"], complete: false }],
        }).targets[0]!.sub,
    );
    expect(subs.every((sub) => JAPANESE.test(sub))).toBe(true);
    setLanguage("en");
    for (const sub of subs) expect(trCore(sub), sub).not.toMatch(JAPANESE);
  });
});

/** core のソース（テストを除く）。CORE_MESSAGES_EN の鍵が core の文に合うかを確かめる */
function coreSource(): string {
  const coreDir = resolve(srcDir, "../../core/src");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = resolve(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return walk(coreDir)
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
}

describe("core が返すエラー・警告の文の訳（UI-11）", () => {
  it("鍵の {0} 以外の部分はどれも core のソースにあり、{0}・{1} は現れる順に書く", () => {
    // core の文言を書き換えたら、ここで訳の鍵が合わなくなって気づく
    const source = coreSource();
    for (const key of Object.keys(CORE_MESSAGES_EN)) {
      const numbers = [...key.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
      expect(numbers, key).toEqual(numbers.map((_, i) => i));
      for (const part of key.split(/\{\d+\}/).filter((p) => p.trim() !== ""))
        expect(source.includes(part), `${key}: ${part}`).toBe(true);
    }
  });
  it("日本語の表示では core の文のまま出す", () => {
    expect(trCoreMessage("commit.mode の値が正しくない")).toBe("commit.mode の値が正しくない");
  });
  it("英語の表示では可変の部分を埋めた訳を出し、入れ子の文も訳す", () => {
    setLanguage("en");
    expect(trCoreMessage("priority.high は個人の設定に書けない")).toBe(
      "priority.high cannot be set in personal settings",
    );
    expect(trCoreMessage("t3 が見つからない（削除された）")).toBe("t3 not found (deleted)");
    expect(trCoreMessage("deguboard-local/runs/r1.json: JSON を読めない")).toBe(
      "deguboard-local/runs/r1.json: Cannot parse JSON",
    );
  });
  it("英語の表示でも、表にない文は core の文のまま出す", () => {
    setLanguage("en");
    expect(trCoreMessage("訳のない文")).toBe("訳のない文");
    expect(trCoreMessage("")).toBe("");
  });
});

describe("設定の項目の説明の訳", () => {
  it("core の項目と CONFIG_DESCRIPTIONS_EN の鍵が過不足なく揃い、訳は日本語を含まない", () => {
    const keys = configFields()
      .map((f) => f.key)
      .sort();
    expect(Object.keys(CONFIG_DESCRIPTIONS_EN).sort()).toEqual(keys);
    for (const [key, value] of Object.entries(CONFIG_DESCRIPTIONS_EN)) {
      expect(value, key).not.toMatch(JAPANESE);
    }
  });
  it("core の説明が変わったら訳を見直す（説明を書き換えたらスナップショットと CONFIG_DESCRIPTIONS_EN を一緒に直す）", () => {
    const descriptions = Object.fromEntries(configFields().map((f) => [f.key, f.description]));
    expect(descriptions).toMatchSnapshot();
  });
  it("日本語では core の説明のまま、英語では訳を出し、訳のない項目は core の説明のまま出す", () => {
    expect(configDescription("git.remote", "同期先のリモート")).toBe("同期先のリモート");
    setLanguage("en");
    expect(configDescription("git.remote", "同期先のリモート")).toBe(
      "Git remote that deguboard fetches from and pushes to",
    );
    expect(configDescription("new.item", "新しい項目")).toBe("新しい項目");
  });
});

describe("優先度の判断基準の既定の訳（UI-11）", () => {
  const defaults = Object.fromEntries(
    configFields()
      .filter((f) => f.key.startsWith("priority."))
      .map((f) => [f.key, f.default as string]),
  );
  const KEY = "priority.high";

  it("core の既定の判断基準は、訳を書いたときの文のまま（既定を書き換えたら PRIORITY_CRITERIA_EN の訳も直す）", () => {
    expect(defaults).toEqual({
      "priority.high":
        "利用者に見える不具合・利用者を誤らせる文書・悪用できる脆弱性・ライセンスの漏れ・検査が通らない・ほかのチケットを止めている",
      "priority.medium":
        "機能の追加と改善・テストの抜けと不安定なテスト・内部の文書の食い違い・今は害のない規約違反・大きく古い依存",
      "priority.low": "使われていないコードと依存・設定の重複・言い回しの揺れ・急がない調査と検討",
    });
  });
  it("英語の訳は 3 つの値を持ち、日本語を含まない", () => {
    expect(Object.keys(PRIORITY_CRITERIA_EN).sort()).toEqual(["high", "low", "medium"]);
    for (const [level, text] of Object.entries(PRIORITY_CRITERIA_EN)) {
      expect(text, level).not.toMatch(JAPANESE);
    }
  });
  it("日本語の表示では既定の値をそのまま出す", () => {
    expect(shownConfigValue(KEY, defaults[KEY], defaults[KEY])).toBe(defaults[KEY]);
  });
  it("英語の表示で既定のままなら英語の訳を出し、書き換えた値は書いた言葉のまま出す", () => {
    setLanguage("en");
    expect(shownConfigValue(KEY, defaults[KEY], defaults[KEY])).toBe(PRIORITY_CRITERIA_EN.high);
    expect(shownConfigValue(KEY, "独自の基準", defaults[KEY])).toBe("独自の基準");
    // 優先度以外の項目は、既定と同じでも訳さない
    expect(shownConfigValue("git.remote", "origin", "origin")).toBe("origin");
  });
  it("入力欄の訳の文は保存するとき既定の値に戻し、ほかの文はそのまま保存する", () => {
    setLanguage("en");
    expect(storedConfigValue(KEY, PRIORITY_CRITERIA_EN.high, defaults[KEY])).toBe(defaults[KEY]);
    expect(storedConfigValue(KEY, "独自の基準", defaults[KEY])).toBe("独自の基準");
    setLanguage("ja");
    expect(storedConfigValue(KEY, PRIORITY_CRITERIA_EN.high, defaults[KEY])).toBe(
      PRIORITY_CRITERIA_EN.high,
    );
  });
});
