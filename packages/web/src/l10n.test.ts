import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { askCandidates, buildAsk, type AskSubject } from "@deguboard/core";
import { afterEach, describe, expect, it } from "vitest";
import { format, languageOf, msg, setLanguage, tr, trCore } from "./l10n.js";
import { CORE_EN, EN, EN_ONE } from "./l10n-en.js";

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
    for (const table of [EN, CORE_EN]) {
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
